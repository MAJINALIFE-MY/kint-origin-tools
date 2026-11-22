import fs from "node:fs";
import path from "node:path";
import { parseJsonText } from "../fsutil.js";
import { sortByNameThenId } from "../normalize.js";
import { log, progress, setProgressTotal } from "../log.js";
import { kintoneAppRootPath, kintoneSpacesRootPath } from "../paths.js";
import { syncCustomize } from "./customize.js";
import { isPermissionError, KintoneClient, type KintoneApp } from "./client.js";
import type { CybozuError } from "../http.js";
import { moveMissingLocalKintoneEntries, type DeletedSummary } from "./deletedEntries.js";
import {
  APP_ADMIN_KEYS,
  CUSTOMIZE_EXPORT_KEY,
  EXPORT_ITEMS,
  PERMISSION_PROBE_KEY,
  isAppAdminKey,
  sortAdminKeys,
  type ExportItem
} from "./exportItems.js";
import { readDeniedKeys, recordDeniedKeys, type PermissionSkip } from "./permissionDenies.js";
import { classify, hashJson, hashLocalJson, readPullState, writePullState } from "./pullState.js";
import { PUSHABLE_FILES, isErrorStub } from "./pushItems.js";
import { writeAppExport, writeSpaceExport, type AppResource } from "./serializers.js";
import {
  guestSpaceIdsOf,
  markPullIncompleteInIndex,
  markPulledInIndex,
  mergeRemoteAppsIntoIndex,
  needsPull,
  normalizeRemoteApps,
  readAppIndex,
  withGuestSpaceIds,
  type IndexedApp
} from "./appIndex.js";
import { appIdOf, stringify } from "./ids.js";
import { mapWithLimit, DEFAULT_CONCURRENCY } from "../limit.js";
import { exportPluginConfigs, type PluginConfigSummary } from "./pluginConfigs.js";

// ローカル編集を保持して取り込まなかったファイル（`folder/file`。customize は `customize/`）。
export interface LocalEdit {
  file: string;
  /** 環境側も変更されている（pull では取り込めず、diff で確認が必要） */
  conflict: boolean;
}

export interface LocalEditSkip {
  appId: string;
  edits: LocalEdit[];
}

export interface PullResourceFailure {
  appId: string;
  key: string;
  message: string;
}

export interface AppSummary {
  appId: string;
  name: string;
  guestSpaceId: string;
  spaceId: string;
  pluginConfigs?: PluginConfigSummary;
  // アプリ管理権限が無く取得しなかった管理系キー（権限リストの denied と同じ並び）。無ければ省略。
  denied?: string[];
  /** 取得失敗したリソース。部分取得として記録し、次回 pull で自動再試行する。 */
  resourceFailures?: Array<{ key: string; message: string }>;
  // ローカル編集を保持したファイル。無ければ省略。
  localEdits?: LocalEdit[];
}

// 取得結果。denied は管理系キーの 403 / CB_NO02（payload は書かない）。
type FetchedResource = AppResource & { denied?: boolean };

export interface PullFailure {
  appId: string;
  name: string;
  message: string;
}

// 差分対象アプリ群を取得し、成功分を索引に記録、失敗は failures に集約して続行する。
// 管理系の権限不足は失敗ではなく permissionSkips に集める（ログは最後に 1 行）。
// pulledAt 省略時は markPulledInIndex 既定（アプリ毎の now）になる。
export async function pullTargets({
  targets,
  appById,
  resolveLocation,
  pulledAt,
  force = false
}: {
  targets: IndexedApp[];
  appById: Map<string, KintoneApp>;
  resolveLocation: (app: IndexedApp) => { guestSpaceId: string; spaceId: string };
  pulledAt?: string;
  force?: boolean;
}): Promise<{ pulled: number; failures: PullFailure[]; permissionSkips: PermissionSkip[]; localEdits: LocalEditSkip[]; resourceFailures: PullResourceFailure[] }> {
  setProgressTotal(targets.length);
  let pulled = 0;
  const failures: PullFailure[] = [];
  const permissionSkips: PermissionSkip[] = [];
  const localEdits: LocalEditSkip[] = [];
  const resourceFailures: PullResourceFailure[] = [];
  for (const app of targets) {
    const rawApp = appById.get(app.appId);
    if (!rawApp) continue;
    const { guestSpaceId, spaceId } = resolveLocation(app);
    try {
      const summary = await pullApp({ appId: app.appId, app: rawApp, guestSpaceId, spaceId, force });
      if (summary.denied) permissionSkips.push({ appId: app.appId, denied: summary.denied });
      if (summary.localEdits) localEdits.push({ appId: app.appId, edits: summary.localEdits });
      for (const failure of summary.resourceFailures ?? []) resourceFailures.push({ appId: app.appId, ...failure });
      if (summary.resourceFailures?.length) markPullIncompleteInIndex(app.appId);
      else markPulledInIndex([rawApp], pulledAt);
      pulled += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`アプリ ${app.appId} 取得失敗: ${message}`);
      failures.push({ appId: app.appId, name: app.name, message });
    }
  }
  if (permissionSkips.length) {
    log(`権限がないためスキップ: ${permissionSkips.length} apps（権限付与後は -f で再判定）`);
  }
  if (localEdits.length) {
    log(
      `ローカル編集を保持: ${localEdits.length} apps（確認は kint-origin diff app --id <id>。` +
        "破棄して取り直すなら pull app --id <id> --discard-local）"
    );
  }
  return { pulled, failures, permissionSkips, localEdits, resourceFailures };
}

interface FetchedAppResources {
  /** 取得できたリソース（EXPORT_ITEMS の順。権限不足は含めない） */
  resources: AppResource[];
  /** 権限不足で取得しなかった管理系キー（前回までに記録済みのものを含む） */
  denied: Set<string>;
}

// アプリの設定リソースを運用環境から取得する。管理系の 403 / CB_NO02 は失敗にせず denied に集める（書き込みはしない）。
async function fetchAppResources({
  client,
  appId,
  guestSpaceId = "",
  force = false
}: {
  client: KintoneClient;
  appId: string | number;
  guestSpaceId?: string;
  force?: boolean;
}): Promise<FetchedAppResources> {
  // 権限リストにあるキーは要求しない（--force のときだけ取り直して再判定する）。
  const skipped = force ? new Set<string>() : readDeniedKeys(appId);
  const pending = EXPORT_ITEMS.filter((item) => !skipped.has(item.key));
  const pendingAdmin = pending.filter((item) => isAppAdminKey(item.key));
  const probe = pendingAdmin.find((item) => item.key === PERMISSION_PROBE_KEY) ?? pendingAdmin[0];

  // リソース取得は制限付き並列（結果は入力順で返る）。
  const fetchItems = (list: ExportItem[]) =>
    mapWithLimit(list, DEFAULT_CONCURRENCY, async (item): Promise<FetchedResource> => {
      try {
        return { ...item, payload: await client.getAppResource(item.endpoint, appId, { guestSpaceId }) };
      } catch (error) {
        // 管理系の 403 / CB_NO02 は失敗にせず拒否として扱う。それ以外（401/404/429/5xx/ネットワーク/操作制限）は _error スタブにする。
        if (isAppAdminKey(item.key) && isPermissionError(error)) return { ...item, payload: null, denied: true };
        return { ...item, payload: { _error: (error as Error).message } };
      }
    });

  // 閲覧系と代表キーを先に取り、代表が拒否なら残りの管理系はこの実行では要求しない。
  const fetched = new Map<string, FetchedResource>();
  for (const r of await fetchItems(pending.filter((item) => !isAppAdminKey(item.key) || item === probe))) fetched.set(r.key, r);
  const probeDenied = Boolean(probe && fetched.get(probe.key)?.denied);
  if (!probeDenied) {
    for (const r of await fetchItems(pendingAdmin.filter((item) => item !== probe))) fetched.set(r.key, r);
  }

  const denied = new Set<string>(skipped);
  if (probeDenied) for (const key of APP_ADMIN_KEYS) denied.add(key);
  for (const r of fetched.values()) if (r.denied) denied.add(r.key);
  if (denied.has("customize")) denied.add(CUSTOMIZE_EXPORT_KEY);

  // 出力順・plugins の検索を変えないよう EXPORT_ITEMS の順に並べ直す。
  const resources: AppResource[] = EXPORT_ITEMS.flatMap((item) => {
    const r = fetched.get(item.key);
    return r && !r.denied ? [{ ...item, payload: r.payload }] : [];
  });
  return { resources, denied };
}

// ローカルに、取得失敗のスタブではない実在の JSON があるか。壊れた JSON も「実データ」として扱う（上書きしない）。
function hasRealLocalJson(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  try {
    return !isErrorStub(parseJsonText(fs.readFileSync(file, "utf8"), file));
  } catch {
    return true;
  }
}

export async function pullApp({
  appId,
  guestSpaceId = "",
  spaceId = "",
  app: prefetchedApp = null,
  pluginConfigs = false,
  force = false,
  discardLocal = false
}: {
  appId: string | number;
  guestSpaceId?: string;
  spaceId?: string;
  app?: KintoneApp | null;
  pluginConfigs?: boolean;
  force?: boolean;
  /** ローカル編集を破棄して環境の内容で取り直す */
  discardLocal?: boolean;
}): Promise<AppSummary> {
  const client = new KintoneClient();
  // ゲストスペースのアプリ等では app.json（概要）が権限不足で読めなくても、
  // 設定リソース（fields/views/settings 等）は取得できることがあるため、最小情報で続行する。
  let app: KintoneApp;
  let appInfoFailure: string | undefined;
  if (prefetchedApp) {
    app = prefetchedApp;
  } else {
    try {
      app = await client.getAppInfo(appId, { guestSpaceId });
    } catch (error) {
      const err = error as CybozuError;
      // GAIA_IL23: ゲストスペース内のアプリに /k/v1/... でアクセスした際のエラー。
      // guestSpaceId 未指定のままだと後続のリソース取得も customize 取得も全て失敗するため、
      // ここで中断し、--guestspace の指定方法を日本語で案内する。
      if (!guestSpaceId && err.code === "GAIA_IL23") {
        throw new Error(
          [
            `アプリ ${appId} はゲストスペース内のアプリです。ゲストスペース ID を指定して再実行してください。`,
            `  例: kint-origin pull app --id ${appId} --guestspace <ゲストスペースID>`,
            `  （ゲストスペース ID はアプリ URL の /k/guest/<ここ>/<アプリID>/ で確認できます）`
          ].join("\n")
        );
      }
      // 続行してよいのは権限不足（403 / CB_NO02）だけ。認証失敗・存在しないアプリ・一時障害で続行すると、
      // 取得失敗のスタブや存在しないアプリのフォルダを書いてしまう。
      if (!isPermissionError(error)) throw error;
      log(`アプリ ${appId}: app.json を取得できませんでした (${err.message})。設定リソースのみ取得します。`);
      appInfoFailure = err.message;
      app = { appId: String(appId) };
    }
  }
  const resolvedSpaceId = spaceId || stringify(app.spaceId);
  progress(`app-${appId}${app.name ? ` ${app.name}` : ""}`);

  const { resources, denied } = await fetchAppResources({ client, appId, guestSpaceId, force });
  const resourceFailures = resources.flatMap((resource) => isErrorStub(resource.payload)
    ? [{ key: resource.key, message: String((resource.payload as any)._error ?? "取得に失敗しました") }]
    : []);
  if (appInfoFailure) resourceFailures.unshift({ key: "app", message: appInfoFailure });
  const targetSpaceId = guestSpaceId ? "" : resolvedSpaceId;

  // ローカル編集の保持: 前回 pull 以降に data/ を編集した push 対象ファイルは上書きしない（pull 状態が無い初回は比較せず全て書く）。
  const existingDir = kintoneAppRootPath({ guestSpaceId, spaceId: targetSpaceId, appId });
  const previous = readPullState(existingDir);
  const keep = new Set<string>();
  const localEdits: LocalEdit[] = [];
  // 環境から取得できなかったリソースは、ローカルに実データがあれば取得失敗のスタブで上書きしない
  // （一過性のエラーで、作業コピーや過去の取得物を壊さない）。
  for (const resource of resources) {
    if (!isErrorStub(resource.payload)) continue;
    if (!hasRealLocalJson(path.join(existingDir, resource.folder, resource.file))) continue;
    keep.add(`${resource.folder}/${resource.file}`);
    log(`アプリ ${appId}: ${resource.folder}/${resource.file} を環境から取得できなかったため、ローカルの内容を残しました。`);
  }
  if (previous && !discardLocal) {
    for (const entry of PUSHABLE_FILES) {
      const resource = resources.find((r) => r.key === entry.key);
      if (!resource) continue;
      const rel = `${entry.folder}/${entry.file}`;
      const localHash = hashLocalJson(path.join(existingDir, entry.folder, entry.file));
      // 取得できなかったリソースは、上で（ローカルに実データがあれば）保持済み。比較の対象にしない。
      if (isErrorStub(resource.payload)) continue;
      const state = classify({ base: previous.files[rel], local: localHash, remote: hashJson(resource.payload) });
      if (state === "local" || state === "conflict") {
        keep.add(rel);
        localEdits.push({ file: rel, conflict: state === "conflict" });
      }
    }
  }

  const appDir = writeAppExport({
    app: { ...app, appId: String(appId) },
    guestSpaceId,
    spaceId: targetSpaceId,
    resources,
    denied: EXPORT_ITEMS.filter((item) => denied.has(item.key)),
    keep,
    writeAppMetadata: !appInfoFailure || !fs.existsSync(path.join(existingDir, "app.json"))
  });
  // customize export 等の後段が失敗しても判定結果は残す。空なら条目を外す（--force で取れた場合）。
  recordDeniedKeys({ appId, guestSpaceId, denied });

  // 書いたファイルは環境の内容を新しい base にする。保持したファイルと取得しなかったファイルは前回の base のまま。
  const files: Record<string, string> = {};
  for (const entry of PUSHABLE_FILES) {
    const rel = `${entry.folder}/${entry.file}`;
    const resource = resources.find((r) => r.key === entry.key);
    if (keep.has(rel) || !resource) {
      if (previous?.files[rel]) files[rel] = previous.files[rel];
    } else if (!isErrorStub(resource.payload)) {
      files[rel] = hashJson(resource.payload);
    }
  }
  writePullState(appDir, { schemaVersion: 1, files, customize: previous?.customize });

  if (!denied.has("customize") && !denied.has(CUSTOMIZE_EXPORT_KEY)) {
    const sync = await syncCustomize({
      appId,
      appDir,
      guestSpaceId,
      base: previous?.customize,
      tracked: Boolean(previous),
      discardLocal
    });
    if (sync.kept) localEdits.push({ file: "customize/", conflict: sync.conflict });
    writePullState(appDir, { schemaVersion: 1, files, customize: sync.hash });
  }
  let pluginConfigSummary: PluginConfigSummary | undefined;
  if (pluginConfigs) {
    if (denied.has("plugins")) {
      log(`アプリ ${appId}: plugins の権限がないため、プラグイン設定の取得をスキップします。`);
    } else {
      const pluginsResource = resources.find((resource) => resource.key === "plugins");
      pluginConfigSummary = await exportPluginConfigs({ client, appId, appDir, guestSpaceId, pluginsPayload: pluginsResource?.payload });
    }
  }
  const deniedKeys = sortAdminKeys(denied);

  return {
    appId: String(appId),
    name: app.name || "",
    guestSpaceId,
    spaceId: guestSpaceId ? "" : resolvedSpaceId,
    pluginConfigs: pluginConfigSummary,
    ...(deniedKeys.length ? { denied: deniedKeys } : {}),
    ...(resourceFailures.length ? { resourceFailures } : {}),
    ...(localEdits.length ? { localEdits } : {})
  };
}

export interface SpaceSummary {
  id: string;
  name: string;
  guestSpaceId: string;
  appCount: number;
  pulled: number;
  skipped: number;
  failed: number;
  failures: PullFailure[];
  resourceFailures: PullResourceFailure[];
  permissionSkips: PermissionSkip[];
  localEdits: LocalEditSkip[];
  spaceLocalEdits?: LocalEdit[];
}

export async function pullSpace({
  spaceId = "",
  guestSpaceId = "",
  force = false,
  discardLocal = false
}: {
  spaceId?: string;
  guestSpaceId?: string;
  force?: boolean;
  discardLocal?: boolean;
}): Promise<SpaceSummary> {
  const client = new KintoneClient();
  const effectiveSpaceId = String(spaceId || guestSpaceId);
  const space = await client.getSpace(effectiveSpaceId, { guestSpaceId });
  const apps = await client.listApps({ guestSpaceId, spaceId: guestSpaceId ? "" : effectiveSpaceId });

  // ゲストスペースのアプリは guest 用 apps.json に guestSpaceId が無いことがあるため、
  // 既知の guestSpaceId を注入して索引へ正しく（guestspace として）登録できるようにする。
  const normalizedApps = sortByNameThenId(
    apps.map((app) => ({
      ...app,
      appId: appIdOf(app),
      spaceId: stringify(app.spaceId),
      guestSpaceId: guestSpaceId || stringify(app.guestSpaceId)
    })),
    "name",
    "appId"
  );

  const spaceLabel = guestSpaceId ? `guestspace-${effectiveSpaceId}` : `space-${effectiveSpaceId}`;
  log(`${spaceLabel}${space?.name ? ` ${space.name}` : ""}: ${normalizedApps.length} apps`);
  const previousIndex = readAppIndex();
  const indexedApps = normalizeRemoteApps(normalizedApps, previousIndex);
  const targets = indexedApps.filter((app) => needsPull({ remote: app, previous: previousIndex.get(app.appId), force }));
  const appById = new Map(normalizedApps.map((app) => [appIdOf(app), app]));
  log(`差分取得対象: ${targets.length} apps / skipped: ${indexedApps.length - targets.length}`);
  mergeRemoteAppsIntoIndex(normalizedApps);

  const { localEdits: spaceLocalEdits } = writeSpaceExport({
    space,
    apps: normalizedApps,
    guestSpaceId,
    spaceId: guestSpaceId ? "" : effectiveSpaceId,
    discardLocal
  });
  if (spaceLocalEdits.length > 0) {
    log(
      `${spaceLabel}: スペース設定・本文のローカル編集を保持: ${spaceLocalEdits.map((e) => e.file).join(", ")}` +
        `（確認は kint-origin diff space --id ${effectiveSpaceId}${guestSpaceId ? ` --guestspace ${guestSpaceId}` : ""}。` +
        `破棄して取り直すなら pull ${guestSpaceId ? "guestspaces" : "spaces"} --id ${effectiveSpaceId} --discard-local）`
    );
  }

  const { pulled, failures, permissionSkips, localEdits, resourceFailures } = await pullTargets({
    targets,
    appById,
    resolveLocation: () => ({ guestSpaceId, spaceId: guestSpaceId ? "" : effectiveSpaceId }),
    force
  });

  return {
    id: effectiveSpaceId,
    name: space?.name || "",
    guestSpaceId,
    appCount: normalizedApps.length,
    pulled,
    skipped: indexedApps.length - targets.length,
    failed: failures.length,
    failures,
    resourceFailures,
    permissionSkips,
    localEdits,
    ...(spaceLocalEdits.length ? { spaceLocalEdits } : {})
  };
}

function listTrackedSpaceTargets(): Array<{ spaceId?: string; guestSpaceId?: string }> {
  const spacesRoot = kintoneSpacesRootPath();
  const targets: Array<{ spaceId?: string; guestSpaceId?: string }> = [];
  if (fs.existsSync(spacesRoot)) {
    for (const name of fs.readdirSync(spacesRoot)) {
      if (/^space-\d+$/.test(name)) targets.push({ spaceId: name.slice("space-".length) });
      else if (/^guestspace-\d+$/.test(name)) targets.push({ guestSpaceId: name.slice("guestspace-".length) });
    }
  }
  return targets;
}

export async function pullTrackedSpaces({
  force = false
}: { force?: boolean } = {}): Promise<{
  count: number;
  deleted: DeletedSummary;
  failures: Array<{ space: string; message: string }>;
  resourceFailures: PullResourceFailure[];
  permissionSkips: PermissionSkip[];
  localEdits: LocalEditSkip[];
}> {
  const initialTargets = listTrackedSpaceTargets();
  if (initialTargets.length === 0) {
    throw new Error("No tracked spaces found under data/kintone/spaces/");
  }

  const client = new KintoneClient();
  log(`追跡スペース ${initialTargets.length} 件。削除判定中...`);
  // /apps.json はゲストアプリに guestSpaceId を付けない。索引と追跡中の guestspace-<id> から判明済みのゲストを反映し、
  // ゲストアプリのローカル実体を所属違いとして deleted/ へ移さないようにする。
  const guestSpaceIds = guestSpaceIdsOf(readAppIndex().values());
  for (const target of initialTargets) if (target.guestSpaceId) guestSpaceIds.add(target.guestSpaceId);
  const allApps = withGuestSpaceIds(await client.listAllApps(), guestSpaceIds);
  const deleted = await moveMissingLocalKintoneEntries({ client, allApps });
  if (deleted.apps.length || deleted.spaces.length) {
    log(`deleted へ移動: ${deleted.apps.length} apps, ${deleted.spaces.length} spaces`);
  }
  // 削除判定で deleted/ へ移したスペース（ゲストと判明した space-<id> 等）は対象から外す。
  const targets = listTrackedSpaceTargets();
  // 非メンバーのゲストスペース等で個別に失敗しても続行し、failures に集約する。
  const failures: Array<{ space: string; message: string }> = [];
  const resourceFailures: PullResourceFailure[] = [];
  const permissionSkips: PermissionSkip[] = [];
  const localEdits: LocalEditSkip[] = [];
  for (const target of targets) {
    try {
      const summary = await pullSpace({ ...target, force });
      permissionSkips.push(...summary.permissionSkips);
      localEdits.push(...summary.localEdits);
      resourceFailures.push(...summary.resourceFailures);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const label = target.guestSpaceId ? `guestspace-${target.guestSpaceId}` : `space-${target.spaceId}`;
      log(`${label} 取得失敗: ${message}`);
      failures.push({ space: label, message });
    }
  }

  return { count: targets.length, deleted, failures, resourceFailures, permissionSkips, localEdits };
}
