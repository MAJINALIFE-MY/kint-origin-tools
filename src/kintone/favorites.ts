// お気に入り（監視グループ）: favorites/<グループ名>.json に定義したアプリ・スペースだけを差分取得する（pull favorite）。
// 定義は cwd の favorites/（data/ の外。ユーザー/AI が編集する）。取得はアプリ設定のみ（レコード・添付・users は取得しない）。
// 削除判定（deleted/ への移動）は行わない（範囲を絞った取得のため。削除判定は pull kintone / pull tracked-spaces）。

import fs from "node:fs";
import path from "node:path";

import { readJsonIfExists } from "../fsutil.js";
import { log } from "../log.js";
import { favoritesRootPath } from "../paths.js";
import { fetchSpaceDetails, type SpaceFailure } from "./apps.js";
import {
  buildSpaces,
  guestSpaceIdsOf,
  mergeRemoteAppsIntoIndex,
  needsPull,
  normalizeRemoteApps,
  readAppIndex,
  withGuestSpaceIds,
  type IndexedApp
} from "./appIndex.js";
import { appIdOf, stringify } from "./ids.js";
import { isGuestSpaceRequiredError, KintoneClient, type KintoneApp } from "./client.js";
import type { PermissionSkip } from "./permissionDenies.js";
import { pullSpace, pullTargets, type LocalEditSkip, type PullFailure, type SpaceSummary } from "./pull.js";

// guestSpaceId が "" のときは索引から自動判定する。
interface FavoriteAppEntry {
  appId: string;
  guestSpaceId: string;
}

export interface FavoriteGroup {
  name: string;
  description: string;
  apps: FavoriteAppEntry[];
  spaces: string[];
  guestSpaces: string[];
}

// 1 つ以上のグループを合算した取得対象（重複は除いてある）。
export interface FavoriteTargets {
  groups: string[];
  apps: FavoriteAppEntry[];
  spaces: string[];
  guestSpaces: string[];
}

export interface FavoritePullSummary {
  groups: string[];
  spaces: SpaceSummary[];
  spaceFailures: SpaceFailure[];
  apps: { requested: number; total: number; pulled: number; skipped: number; failed: number };
  coveredBySpace: string[];
  missing: string[];
  guestSpacesDetected: string[];
  failures: PullFailure[];
  permissionSkips: PermissionSkip[];
  localEdits: LocalEditSkip[];
}

const GROUP_KEYS: readonly string[] = ["description", "apps", "spaces", "guestSpaces"];
const LIST_KEYS: readonly string[] = ["apps", "spaces", "guestSpaces"];
const APP_ENTRY_KEYS: readonly string[] = ["id", "guestSpaceId"];
// GET /apps.json の ids は 1 回 100 件まで。
const LIST_APPS_IDS_LIMIT = 100;
const INVALID_NAME_RE = /[\\/:*?"<>|]/;

const ID_HINT = "正の整数の ID を書いてください";

const E_NAME_EMPTY = "--name にグループ名を指定してください（例: kint-origin pull favorite --name group1）。";
const E_NO_GROUPS =
  "お気に入りグループが定義されていません。favorites/<グループ名>.json を作成してください" +
  '（書き方は favorites/_example.json。例: {"apps": [303], "spaces": [26], "guestSpaces": [10]}）。';

function eNoSelection(names: string[]): string {
  return `pull favorite は --name <グループ名> か --all のどちらか一方を指定してください。（定義済み: ${names.join(", ") || "なし"}）`;
}

function eBadName(raw: string): string {
  return (
    `グループ名「${raw}」は使えません。favorites/ 直下のファイル名（拡張子 .json を除く）を指定してください` +
    "（/ \\ : * ? \" < > | と、先頭の _ や . は使えません）。"
  );
}

function eUnknownGroup(name: string, names: string[]): string {
  return `お気に入りグループ「${name}」がありません（favorites/${name}.json が見つかりません）。定義済み: ${names.join(", ")}`;
}

type Failure = (detail: string) => Error;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 正の整数の ID（数値または数字の文字列）を先頭の 0 なしの文字列へ正規化する。不正は null。
function toId(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const digits = value.trim().replace(/^0+/, "");
    return digits === "" ? null : digits;
  }
  return null;
}

// グループ名の検証・正規化。ファイル名として使うため、パス区切りや先頭の _ / . は拒否する（パストラバーサル対策）。
export function normalizeFavoriteGroupName(raw: string): string {
  const name = String(raw).trim().replace(/\.json$/i, "");
  if (name === "" || INVALID_NAME_RE.test(name) || /^[_.]/.test(name)) throw new Error(eBadName(raw));
  return name;
}

function addAppEntry(map: Map<string, FavoriteAppEntry>, entry: FavoriteAppEntry, failure: Failure): void {
  const current = map.get(entry.appId);
  if (!current) {
    map.set(entry.appId, entry);
    return;
  }
  if (current.guestSpaceId && entry.guestSpaceId && current.guestSpaceId !== entry.guestSpaceId) {
    throw failure(`アプリ ${entry.appId} の guestSpaceId が食い違っています（${current.guestSpaceId} と ${entry.guestSpaceId}）。`);
  }
  // 片方だけ guestSpaceId があれば、それを採用する（Map は既存キーの位置を保つ）。
  if (!current.guestSpaceId && entry.guestSpaceId) map.set(entry.appId, { ...current, guestSpaceId: entry.guestSpaceId });
}

function assertNoSpaceOverlap(spaces: string[], guestSpaces: string[], failure: Failure): void {
  const overlap = spaces.find((id) => guestSpaces.includes(id));
  if (overlap !== undefined) {
    throw failure(`スペース ${overlap} が spaces と guestSpaces の両方にあります（ゲストスペースなら guestSpaces だけに書いてください）。`);
  }
}

function spaceIdList(key: string, value: unknown, failure: Failure): string[] {
  const ids: string[] = [];
  for (const [index, item] of (Array.isArray(value) ? value : []).entries()) {
    const id = toId(item);
    if (id === null) throw failure(`${key}[${index}] が不正です（${ID_HINT}）: ${JSON.stringify(item)}`);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

// 純関数: 定義 1 件（JSON.parse 済み）を検証して正規化する。
export function parseFavoriteGroup(name: string, raw: unknown): FavoriteGroup {
  const failure: Failure = (detail) => new Error(`お気に入り定義 favorites/${name}.json: ${detail}`);
  if (!isPlainObject(raw)) {
    throw failure('オブジェクト（{"apps": [...], "spaces": [...], "guestSpaces": [...]}）で書いてください。');
  }
  const unknownKeys = Object.keys(raw).filter((key) => !GROUP_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw failure(`不明なキーがあります: ${unknownKeys.join(", ")}（使えるキー: ${GROUP_KEYS.join(", ")}）`);
  }
  if (raw.description !== undefined && typeof raw.description !== "string") throw failure("description は文字列で書いてください。");
  for (const key of LIST_KEYS) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) throw failure(`${key} は配列で書いてください。`);
  }

  const appMap = new Map<string, FavoriteAppEntry>();
  for (const [index, item] of (Array.isArray(raw.apps) ? raw.apps : []).entries()) {
    if (isPlainObject(item)) {
      const extra = Object.keys(item).filter((key) => !APP_ENTRY_KEYS.includes(key));
      if (extra.length > 0) {
        throw failure(`apps[${index}] に不明なキーがあります: ${extra.join(", ")}（使えるキー: ${APP_ENTRY_KEYS.join(", ")}）`);
      }
      const appId = toId(item.id);
      if (appId === null) throw failure(`apps[${index}].id が不正です（${ID_HINT}）: ${JSON.stringify(item.id)}`);
      let guestSpaceId = "";
      if (item.guestSpaceId !== undefined) {
        const parsed = toId(item.guestSpaceId);
        if (parsed === null) throw failure(`apps[${index}].guestSpaceId が不正です（${ID_HINT}）: ${JSON.stringify(item.guestSpaceId)}`);
        guestSpaceId = parsed;
      }
      addAppEntry(appMap, { appId, guestSpaceId }, failure);
      continue;
    }
    const appId = toId(item);
    if (appId === null) throw failure(`apps[${index}] が不正です（${ID_HINT}）: ${JSON.stringify(item)}`);
    addAppEntry(appMap, { appId, guestSpaceId: "" }, failure);
  }

  const spaces = spaceIdList("spaces", raw.spaces, failure);
  const guestSpaces = spaceIdList("guestSpaces", raw.guestSpaces, failure);
  assertNoSpaceOverlap(spaces, guestSpaces, failure);
  if (appMap.size === 0 && spaces.length === 0 && guestSpaces.length === 0) {
    throw failure("取得対象がありません（apps / spaces / guestSpaces のいずれかに ID を書いてください）。");
  }
  return {
    name,
    description: typeof raw.description === "string" ? raw.description : "",
    apps: [...appMap.values()],
    spaces,
    guestSpaces
  };
}

// 純関数: 複数グループをグループの順に合算し、重複を除く。
export function mergeFavoriteGroups(groups: FavoriteGroup[]): FavoriteTargets {
  const names = groups.map((group) => group.name);
  const failure: Failure = (detail) => new Error(`お気に入りグループ ${names.join(", ")}: ${detail}`);
  const appMap = new Map<string, FavoriteAppEntry>();
  const spaces: string[] = [];
  const guestSpaces: string[] = [];
  for (const group of groups) {
    for (const entry of group.apps) addAppEntry(appMap, entry, failure);
    for (const id of group.spaces) if (!spaces.includes(id)) spaces.push(id);
    for (const id of group.guestSpaces) if (!guestSpaces.includes(id)) guestSpaces.push(id);
  }
  assertNoSpaceOverlap(spaces, guestSpaces, failure);
  return { groups: names, apps: [...appMap.values()], spaces, guestSpaces };
}

// favorites/ 直下の定義済みグループ名（_ と . で始まるファイルは対象外。ja の並び）。
export function listFavoriteGroupNames(root: string = favoritesRootPath()): string[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !/^[_.]/.test(entry.name))
    .map((entry) => entry.name.slice(0, -".json".length))
    .sort((a, b) => a.localeCompare(b, "ja"));
}

// name は listFavoriteGroupNames に実在する名前だけを渡す。
function readFavoriteGroup(name: string, root: string = favoritesRootPath()): FavoriteGroup {
  return parseFavoriteGroup(name, readJsonIfExists(path.join(root, `${name}.json`)));
}

// --name / --all から対象グループを読み込む。検証はここで済ませる（API・認証値の読み込みより前に呼ぶ）。
export function selectFavoriteGroups(
  { name, all }: { name?: string | boolean; all?: boolean },
  root: string = favoritesRootPath()
): FavoriteGroup[] {
  if (name === true) throw new Error(E_NAME_EMPTY);
  const names = listFavoriteGroupNames(root);
  const hasName = typeof name === "string" && name.trim() !== "";
  if (hasName === Boolean(all)) throw new Error(eNoSelection(names));
  if (all) {
    if (names.length === 0) throw new Error(E_NO_GROUPS);
    return names.map((groupName) => readFavoriteGroup(groupName, root));
  }
  const normalized = normalizeFavoriteGroupName(name as string);
  if (names.length === 0) throw new Error(E_NO_GROUPS);
  // Windows ではファイル名の大文字小文字を区別しないため、完全一致→大文字小文字無視の順で照合する。
  const actual = names.find((n) => n === normalized) ?? names.find((n) => n.toLowerCase() === normalized.toLowerCase());
  if (!actual) throw new Error(eUnknownGroup(normalized, names));
  return [readFavoriteGroup(actual, root)];
}

interface FavoriteAppsResult {
  total: number;
  pulled: number;
  skipped: number;
  failed: number;
  failures: PullFailure[];
  permissionSkips: PermissionSkip[];
  localEdits: LocalEditSkip[];
  coveredBySpace: string[];
  missing: string[];
  guestSpacesDetected: string[];
  spaceFailures: SpaceFailure[];
}

function emptyAppsResult(): FavoriteAppsResult {
  return {
    total: 0,
    pulled: 0,
    skipped: 0,
    failed: 0,
    failures: [],
    permissionSkips: [],
    localEdits: [],
    coveredBySpace: [],
    missing: [],
    guestSpacesDetected: [],
    spaceFailures: []
  };
}

// 個別アプリ（apps）の取得。/apps.json?ids で対象だけを列挙し、スペースで取得済みのアプリは除き、差分取得する。
async function pullFavoriteApps({
  entries,
  pulledSpaceIds,
  pulledGuestSpaceIds,
  declaredGuestSpaceIds,
  force
}: {
  entries: FavoriteAppEntry[];
  pulledSpaceIds: ReadonlySet<string>;
  pulledGuestSpaceIds: ReadonlySet<string>;
  declaredGuestSpaceIds: readonly string[];
  force: boolean;
}): Promise<FavoriteAppsResult> {
  if (entries.length === 0) return emptyAppsResult();
  const client = new KintoneClient();
  // スペース取得後・索引追記前の索引。差分判定（needsPull）とゲスト判定の基準にする。
  const previousIndex = readAppIndex();
  const requestedIds = entries.map((entry) => entry.appId);

  // 1) 所在（通常 / ゲスト）ごとに ids で列挙する。
  const idsByGuest = new Map<string, string[]>();
  for (const entry of entries) {
    const guestSpaceId = entry.guestSpaceId || previousIndex.get(entry.appId)?.guestSpaceId || "";
    idsByGuest.set(guestSpaceId, [...(idsByGuest.get(guestSpaceId) ?? []), entry.appId]);
  }
  const requested = new Set(requestedIds);
  const listedById = new Map<string, KintoneApp>();
  for (const [guestSpaceId, ids] of idsByGuest) {
    for (let i = 0; i < ids.length; i += LIST_APPS_IDS_LIMIT) {
      const listed = await client.listApps({ guestSpaceId, ids: ids.slice(i, i + LIST_APPS_IDS_LIMIT) });
      for (const app of listed) {
        const appId = appIdOf(app);
        if (!requested.has(appId) || listedById.has(appId)) continue;
        // ゲスト用の apps.json は guestSpaceId を付けないことがあるため、列挙に使った ID を注入する（pullSpace と同じ）。
        listedById.set(appId, {
          ...app,
          appId,
          spaceId: stringify(app.spaceId),
          guestSpaceId: guestSpaceId || stringify(app.guestSpaceId)
        });
      }
    }
  }
  const missing = requestedIds.filter((id) => !listedById.has(id));
  if (missing.length > 0) {
    log(
      `一覧に見つからないアプリ: ${missing.join(", ")}` +
        "（ID の誤り・削除済み・閲覧権限なし・ゲストスペースの指定違いの可能性。削除判定は pull kintone で行います）"
    );
  }

  // 2) 指定したスペースで取得済みのアプリは除く（-f でも二重に取得しない）。
  const knownGuestSpaceIds = new Set<string>([
    ...guestSpaceIdsOf(previousIndex.values()),
    ...declaredGuestSpaceIds,
    ...entries.map((entry) => entry.guestSpaceId).filter(Boolean)
  ]);
  const provisional = normalizeRemoteApps(withGuestSpaceIds([...listedById.values()], knownGuestSpaceIds), previousIndex);
  const isCovered = (app: IndexedApp): boolean =>
    app.guestSpaceId ? pulledGuestSpaceIds.has(app.guestSpaceId) : app.spaceId !== "" && pulledSpaceIds.has(app.spaceId);
  const coveredSet = new Set(provisional.filter(isCovered).map((app) => app.appId));
  const coveredBySpace = requestedIds.filter((id) => coveredSet.has(id));

  // 3) ゲスト判定（pull kintone と同じ）。差分対象で、ゲストと判明していないスペースのアプリだけ GAIA_IL25 を確かめる。
  const spacesToCheck = buildSpaces(
    provisional.filter(
      (app) =>
        !coveredSet.has(app.appId) &&
        !app.guestSpaceId &&
        app.spaceId !== "" &&
        needsPull({ remote: app, previous: previousIndex.get(app.appId), force })
    )
  );
  const spaceResult = await fetchSpaceDetails({ client, spaces: spacesToCheck });
  const guestSpaceIds = new Set<string>([...knownGuestSpaceIds, ...spaceResult.detectedGuestSpaceIds]);
  const rawApps = withGuestSpaceIds(
    [...listedById.values()].filter((app) => !coveredSet.has(appIdOf(app))),
    guestSpaceIds
  );
  const apps = normalizeRemoteApps(rawApps, previousIndex);

  // 4) 索引へ追記する（他のアプリの索引は残す）→ 差分取得。
  mergeRemoteAppsIntoIndex(rawApps);
  const targets = apps.filter((app) => needsPull({ remote: app, previous: previousIndex.get(app.appId), force }));
  log(`お気に入りのアプリ: 差分取得対象 ${targets.length} apps / skipped: ${apps.length - targets.length}`);
  const { pulled, failures, permissionSkips, localEdits } = await pullTargets({
    targets,
    appById: new Map(rawApps.map((app) => [appIdOf(app), app])),
    resolveLocation: (app) => ({ guestSpaceId: app.guestSpaceId, spaceId: app.guestSpaceId ? "" : app.spaceId }),
    force
  });
  return {
    total: apps.length,
    pulled,
    skipped: apps.length - targets.length,
    failed: failures.length,
    failures,
    permissionSkips,
    localEdits,
    coveredBySpace,
    missing,
    guestSpacesDetected: spaceResult.detectedGuestSpaceIds,
    spaceFailures: spaceResult.failures
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function pullFavorites({
  targets,
  force = false
}: {
  targets: FavoriteTargets;
  force?: boolean;
}): Promise<FavoritePullSummary> {
  log(
    `お気に入り ${targets.groups.join(", ")}: アプリ ${targets.apps.length} 件・` +
      `スペース ${targets.spaces.length} 件・ゲストスペース ${targets.guestSpaces.length} 件`
  );
  const spaces: SpaceSummary[] = [];
  const spaceFailures: SpaceFailure[] = [];
  const pulledSpaceIds = new Set<string>();
  const pulledGuestSpaceIds = new Set<string>();

  // スペースは 1 件ずつ取得し、失敗しても続行する（pull tracked-spaces と同じ）。
  for (const spaceId of targets.spaces) {
    try {
      spaces.push(await pullSpace({ spaceId, force }));
      pulledSpaceIds.add(spaceId);
    } catch (error) {
      const message = isGuestSpaceRequiredError(error)
        ? `space-${spaceId} はゲストスペースです。favorites の guestSpaces に書いてください。`
        : errorMessage(error);
      log(`space-${spaceId} 取得失敗: ${message}`);
      spaceFailures.push({ space: `space-${spaceId}`, message });
    }
  }
  for (const guestSpaceId of targets.guestSpaces) {
    try {
      spaces.push(await pullSpace({ guestSpaceId, force }));
      pulledGuestSpaceIds.add(guestSpaceId);
    } catch (error) {
      const message = errorMessage(error);
      log(`guestspace-${guestSpaceId} 取得失敗: ${message}`);
      spaceFailures.push({ space: `guestspace-${guestSpaceId}`, message });
    }
  }

  const appResult = await pullFavoriteApps({
    entries: targets.apps,
    pulledSpaceIds,
    pulledGuestSpaceIds,
    declaredGuestSpaceIds: targets.guestSpaces,
    force
  });
  return {
    groups: targets.groups,
    spaces,
    spaceFailures: [...spaceFailures, ...appResult.spaceFailures],
    apps: {
      requested: targets.apps.length,
      total: appResult.total,
      pulled: appResult.pulled,
      skipped: appResult.skipped,
      failed: appResult.failed
    },
    coveredBySpace: appResult.coveredBySpace,
    missing: appResult.missing,
    guestSpacesDetected: appResult.guestSpacesDetected,
    failures: [...spaces.flatMap((space) => space.failures), ...appResult.failures],
    permissionSkips: [...spaces.flatMap((space) => space.permissionSkips), ...appResult.permissionSkips],
    localEdits: [...spaces.flatMap((space) => space.localEdits), ...appResult.localEdits]
  };
}
