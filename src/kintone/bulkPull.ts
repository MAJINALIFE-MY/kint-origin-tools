import fs from "node:fs";
import path from "node:path";

import { confirmYes } from "../confirm.js";
import { ENV_PATH, getEnv, parseEnvFile } from "../env.js";
import { parseJsonText } from "../fsutil.js";
import { log } from "../log.js";
import { kintoneAppRootPath, kintoneSpaceRootPath } from "../paths.js";
import { consumeOneShotSetting, readOneShotSnapshot, type OneShotKey } from "../oneShot.js";
import { isGuestSpaceRequiredError, KintoneClient } from "./client.js";
import { pullRecordComments } from "./comments.js";
import { pullFavorites, type FavoriteGroup, type FavoriteTargets } from "./favorites.js";
import { readCompleteAppIndex, type BulkIndexEntry, type BulkIndexSource } from "./bulkIndex.js";
import { pullRecords } from "./records.js";
import { lookupIndexedApp } from "./appIndex.js";
import { sanitizeName } from "../normalize.js";

type Mode = "records" | "comments" | "favorite";

interface Target extends BulkIndexEntry {
  name: string;
  locationKnown: boolean;
}

interface ReadyTarget extends Target {
  path: string;
}

export interface BulkPullOptions {
  mode: Mode;
  expectedHost: string;
  allIndexed?: boolean;
  source?: { groups: FavoriteGroup[]; targets: FavoriteTargets };
  withRecords?: boolean;
  withComments?: boolean;
  attachments?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

export interface BulkPullResult {
  mode: Mode;
  status: "dry-run" | "aborted" | "completed" | "partial";
  host: string;
  selection: { kind: "all-indexed" | "favorite"; source?: BulkIndexSource; groups?: string[]; includes: string[] };
  settingsTargets?: { apps: string[]; spaces: string[]; guestSpaces: string[] };
  targets: Array<{ appId: string; name: string; path: string; guestSpaceId: string; spaceId: string }>;
  results: Array<Record<string, unknown>>;
  failures: Array<{ appId?: string; message: string }>;
  oneShotConsumed: boolean;
  settings?: unknown;
}

function normalizeHost(raw: string): string {
  if (!raw || raw.includes("/") || raw.includes("@") || raw.includes("?") || raw.includes("#") || raw.includes("://")) {
    throw new Error("--expect-host には hostname または hostname:port を指定してください（例: example.cybozu.com）。");
  }
  let parsed: URL;
  try { parsed = new URL(`https://${raw}`); } catch { throw new Error("--expect-host の形式が正しくありません。hostname または hostname:port を指定してください。"); }
  if (!parsed.hostname || parsed.pathname !== "/" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("--expect-host の形式が正しくありません。hostname または hostname:port を指定してください。");
  }
  return parsed.host.toLowerCase();
}

function assertExpectedHost(rawExpectedHost: string): string {
  const expected = normalizeHost(rawExpectedHost);
  if (!fs.existsSync(ENV_PATH)) throw new Error(`.env がありません: ${ENV_PATH}`);
  const fileText = fs.readFileSync(ENV_PATH, "utf8").replace(/^\uFEFF/, "");
  const fileValues = parseEnvFile(fileText);
  const fileBaseUrl = fileValues.CYBOZU_BASE_URL;
  if (!fileBaseUrl) throw new Error("全件取得の前提として .env に CYBOZU_BASE_URL が必要です。");
  let fileHost: string;
  try { fileHost = new URL(fileBaseUrl).host.toLowerCase(); } catch { throw new Error(".env の CYBOZU_BASE_URL を hostname として検証できません。"); }
  const effectiveHost = new URL(getEnv().baseUrl).host.toLowerCase();
  if (fileHost !== expected || effectiveHost !== expected) {
    throw new Error(`接続先確認に失敗しました。--expect-host=${expected}、.env=${fileHost}、実効接続先=${effectiveHost}。3つが一致する環境で再実行してください。`);
  }
  return expected;
}

function numericOrder(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function appDirFor(target: Target): string {
  return kintoneAppRootPath({ appId: target.appId, guestSpaceId: target.guestSpaceId, spaceId: target.guestSpaceId ? "" : target.spaceId });
}

function assertRecordedDomain(filePath: string, host: string): void {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`取得先の記録ファイルが通常ファイルではありません: ${filePath}`);
  let parsed: unknown;
  try { parsed = parseJsonText(fs.readFileSync(filePath, "utf8"), filePath); } catch (error) { throw new Error(`取得先の記録ファイルを検証できません: ${error instanceof Error ? error.message : String(error)}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`取得先の記録ファイルが不正です: ${filePath}`);
  const domain = (parsed as Record<string, unknown>).domain;
  if (typeof domain === "string" && domain && domain.toLowerCase() !== host.toLowerCase()) {
    throw new Error(`保存先の取得元 ${domain} と実行先 ${host} が異なります: ${filePath}`);
  }
}

type ManagedPathKind = "directory" | "file";

function assertSafeManagedPath(filePath: string, kind: ManagedPathKind, label: string): void {
  const root = path.resolve(process.cwd());
  const absolute = path.resolve(filePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label}: 作業ディレクトリの外を指す保存先です: ${filePath}`);
  }
  const parts = relative.split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`${label}: 保存先にシンボリックリンクは使えません: ${current}`);
    const leaf = index === parts.length - 1;
    if (stat && !leaf && !stat.isDirectory()) throw new Error(`${label}: 保存先の親がディレクトリではありません: ${current}`);
    if (stat && leaf && kind === "directory" && !stat.isDirectory()) throw new Error(`${label}: 保存先は通常ディレクトリである必要があります: ${current}`);
    if (stat && leaf && kind === "file" && !stat.isFile()) throw new Error(`${label}: 保存先は通常ファイルである必要があります: ${current}`);
  }
}

function assertSafeDataOutputs(target: Target, options: { records?: boolean; comments?: boolean; attachments?: boolean }): void {
  const appDir = appDirFor(target);
  assertSafeManagedPath(appDir, "directory", `アプリ ${target.appId}`);
  if (options.records) {
    const recordsDir = path.join(appDir, "records");
    assertSafeManagedPath(recordsDir, "directory", `アプリ ${target.appId} records`);
    assertSafeManagedPath(path.join(recordsDir, "records.csv"), "file", `アプリ ${target.appId} records.csv`);
    if (options.attachments) assertSafeManagedPath(path.join(recordsDir, "attachments"), "directory", `アプリ ${target.appId} attachments`);
  }
  if (options.comments) {
    const commentsDir = path.join(appDir, "comments");
    assertSafeManagedPath(commentsDir, "directory", `アプリ ${target.appId} comments`);
    const stat = fs.lstatSync(commentsDir, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      for (const entry of fs.readdirSync(commentsDir, { withFileTypes: true })) {
        const entryPath = path.join(commentsDir, entry.name);
        const entryStat = fs.lstatSync(entryPath);
        if (entryStat.isSymbolicLink() || !entryStat.isFile()) throw new Error(`アプリ ${target.appId} comments に通常ファイル以外があります: ${entryPath}`);
      }
    }
  }
}

async function verifyFavoriteSpaceOutput(client: KintoneClient, id: string, guestSpaceId: string, host: string): Promise<void> {
  const label = `${guestSpaceId ? "guestspace" : "space"}-${id}`;
  const directory = kintoneSpaceRootPath({ spaceId: guestSpaceId ? "" : id, guestSpaceId });
  assertSafeManagedPath(directory, "directory", label);
  const spaceFile = path.join(directory, "space.json");
  assertSafeManagedPath(spaceFile, "file", label);
  assertRecordedDomain(spaceFile, host);
  const space = await client.getSpace(id, { guestSpaceId });
  if (!space || (space.id != null && String(space.id) !== id) || typeof space.isGuest !== "boolean") {
    throw new Error(`${label} の詳細 API 応答が不正です。`);
  }
  if (space.isGuest !== Boolean(guestSpaceId)) throw new Error(`${label} の通常 / ゲスト区分と favorites の定義が一致しません。`);
  for (const name of ["settings.json", "body.html", "apps.json", "README.md"]) {
    assertSafeManagedPath(path.join(directory, name), "file", `${label}/${name}`);
  }
  if (space.name) assertSafeManagedPath(path.join(directory, `${sanitizeName(space.name)}.md`), "file", `${label} README`);
  assertSafeManagedPath(path.join(directory, "threads"), "directory", `${label}/threads`);
  assertSafeManagedPath(path.join(directory, "threads", ".gitkeep"), "file", `${label}/threads/.gitkeep`);
}

function assertLocalTenant(target: Target, host: string): string {
  const appDir = appDirFor(target);
  assertSafeManagedPath(appDir, "directory", `アプリ ${target.appId}`);
  const appFile = path.join(appDir, "app.json");
  assertSafeManagedPath(appFile, "file", `アプリ ${target.appId}`);
  assertRecordedDomain(appFile, host);
  if (target.guestSpaceId || target.spaceId) {
    const spaceDir = kintoneSpaceRootPath({ guestSpaceId: target.guestSpaceId, spaceId: target.guestSpaceId ? "" : target.spaceId });
    assertSafeManagedPath(spaceDir, "directory", `スペース ${target.guestSpaceId || target.spaceId}`);
    const spaceFile = path.join(spaceDir, "space.json");
    assertSafeManagedPath(spaceFile, "file", `スペース ${target.guestSpaceId || target.spaceId}`);
    assertRecordedDomain(spaceFile, host);
  }
  return appDir;
}

function appIdFromInfo(info: Record<string, unknown>): string {
  const raw = info.appId;
  const id = String(raw ?? "");
  if (!/^[1-9]\d*$/.test(id)) throw new Error("アプリ詳細 API の応答に有効な appId がありません。");
  return id;
}

async function verifyTarget(
  client: KintoneClient,
  original: Target,
  host: string,
  outputOptions: { records?: boolean; comments?: boolean; attachments?: boolean } = {}
): Promise<ReadyTarget> {
  let target = { ...original };
  if (!target.guestSpaceId && target.spaceId) {
    try {
      const space = await client.getSpace(target.spaceId);
      if (!space || (space.id != null && String(space.id) !== target.spaceId) || typeof space.isGuest !== "boolean") {
        throw new Error(`space-${target.spaceId} の詳細 API 応答が不正です。`);
      }
      if (space.isGuest) target = { ...target, guestSpaceId: target.spaceId };
    } catch (error) {
      if (isGuestSpaceRequiredError(error)) target = { ...target, guestSpaceId: target.spaceId };
      else throw new Error(`アプリ ${target.appId} の所属スペースを確認できません: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let appInfo: Record<string, unknown>;
  try {
    appInfo = await client.getAppInfo(target.appId, { guestSpaceId: target.guestSpaceId }) as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (!target.guestSpaceId && code === "GAIA_IL23") {
      throw new Error(`アプリ ${target.appId} はゲストスペース内です。favorites に { "id": ${target.appId}, "guestSpaceId": <id> } を指定してください。`);
    }
    throw error;
  }
  if (appIdFromInfo(appInfo) !== target.appId) throw new Error(`アプリ ${target.appId} の詳細 API が別 ID を返しました。`);
  if (!Object.hasOwn(appInfo, "spaceId")) throw new Error(`アプリ ${target.appId} の詳細 API に spaceId がありません。現在位置を検証できません。`);
  const currentSpaceId = appInfo.spaceId == null ? "" : String(appInfo.spaceId);
  if (currentSpaceId && !/^[1-9]\d*$/.test(currentSpaceId)) throw new Error(`アプリ ${target.appId} の現在位置が不正です: ${currentSpaceId}`);
  if (target.locationKnown && currentSpaceId !== (target.guestSpaceId || target.spaceId)) {
    throw new Error(`アプリ ${target.appId} は索引上の位置 ${(target.guestSpaceId || target.spaceId) || "ドメイン"} から ${currentSpaceId || "ドメイン"} へ移動しています。pull index をやり直してください。`);
  }
  if (target.guestSpaceId && currentSpaceId && currentSpaceId !== target.guestSpaceId) throw new Error(`アプリ ${target.appId} の guestSpaceId と現在位置が一致しません。`);
  if (target.spaceId && currentSpaceId !== target.spaceId && !target.guestSpaceId) throw new Error(`アプリ ${target.appId} は space-${target.spaceId} から移動しています。pull index をやり直してください。`);
  if (!target.guestSpaceId && currentSpaceId) {
    try {
      const space = await client.getSpace(currentSpaceId);
      if (!space || (space.id != null && String(space.id) !== currentSpaceId)) throw new Error(`space-${currentSpaceId} の詳細 API 応答が不正です。`);
      if (space.isGuest === true) target = { ...target, guestSpaceId: currentSpaceId, spaceId: currentSpaceId };
      else target = { ...target, guestSpaceId: "", spaceId: currentSpaceId };
    } catch (error) {
      if (isGuestSpaceRequiredError(error)) target = { ...target, guestSpaceId: currentSpaceId, spaceId: currentSpaceId };
      else throw new Error(`アプリ ${target.appId} の所属スペースを検証できません: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (target.guestSpaceId && !currentSpaceId) throw new Error(`アプリ ${target.appId} に spaceId がなく、ゲストスペースの所属を確認できません。`);
  const appDir = assertLocalTenant(target, host);
  assertSafeDataOutputs(target, outputOptions);
  return { ...target, name: String(appInfo.name ?? target.name ?? ""), path: path.relative(process.cwd(), appDir).replaceAll("\\", "/") };
}

export async function verifyCurrentAppTarget(
  appId: string,
  guestSpaceOverride = "",
  outputOptions: { records?: boolean; comments?: boolean; attachments?: boolean } = {}
): Promise<ReadyTarget> {
  const indexed = lookupIndexedApp(appId);
  const target: Target = {
    appId,
    name: indexed?.name ?? "",
    spaceId: indexed?.spaceId ?? "",
    guestSpaceId: guestSpaceOverride || indexed?.guestSpaceId || "",
    locationKnown: Boolean(indexed || guestSpaceOverride)
  };
  return verifyTarget(new KintoneClient(), target, new URL(getEnv().baseUrl).host.toLowerCase(), outputOptions);
}

function previewText(result: BulkPullResult): string {
  const destinations = result.selection.includes.filter((item) => item !== "attachments");
  const lines = [
    `全件取得の実行確認: ${result.host}`,
    `対象アプリ: ${result.targets.length} 件 (${result.selection.kind === "all-indexed" ? `完全索引 ${result.selection.source?.fetchedAt ?? ""}` : `お気に入り ${result.selection.groups?.join(", ") ?? ""}`})`,
    `取得内容: ${result.selection.includes.join(", ")}`,
    ...result.targets.map((target) => `  app ${target.appId}${target.name ? ` ${target.name}` : ""} -> ${destinations.map((item) => `${target.path}/${item === "records" ? "records/records.csv" : "comments/"}`).join("; ")}`),
    ...(result.settingsTargets ? [`お気に入り設定対象: apps=${result.settingsTargets.apps.join(",") || "なし"}; spaces=${result.settingsTargets.spaces.join(",") || "なし"}; guestSpaces=${result.settingsTargets.guestSpaces.join(",") || "なし"}`] : []),
    "Git 管理対象を確認してください。records.csv と records/attachments は既定で ignore、comments/ は現在の Git 設定に従います。"
  ];
  return lines.join("\n");
}

export async function runBulkPull(options: BulkPullOptions): Promise<BulkPullResult> {
  const host = assertExpectedHost(options.expectedHost);
  const allIndexed = Boolean(options.allIndexed);
  const selectionKind = allIndexed ? "all-indexed" : "favorite";
  let source: BulkIndexSource | undefined;
  let targets: Target[];
  let favoriteTargets: FavoriteTargets | undefined;

  if (allIndexed) {
    const verified = readCompleteAppIndex(host);
    source = verified.source;
    targets = verified.apps.map((app) => ({ ...app, name: "", locationKnown: true }));
  } else {
    if (!options.source) throw new Error("お気に入りグループがありません。");
    favoriteTargets = options.source.targets;
    targets = favoriteTargets.apps.map((entry) => {
      const fromIndex = lookupIndexedApp(entry.appId);
      const guestSpaceId = entry.guestSpaceId || fromIndex?.guestSpaceId || "";
      const spaceId = fromIndex?.spaceId || "";
      return { appId: entry.appId, guestSpaceId, spaceId, name: fromIndex?.name || "", locationKnown: Boolean(entry.guestSpaceId || fromIndex) };
    });
    if (targets.length === 0) throw new Error("お気に入りグループに apps がありません。レコード・コメント取得ではアプリを明示してください。");
  }
  if (targets.length === 0) throw new Error("取得対象アプリがありません。");
  targets.sort((a, b) => numericOrder(a.appId, b.appId));

  const oneShotKey: OneShotKey | undefined = allIndexed && !options.dryRun
    ? options.mode === "comments" ? "KINT_ORIGIN_ALLOW_PULL_COMMENTS_ALL_ONCE" : "KINT_ORIGIN_ALLOW_PULL_RECORDS_ALL_ONCE"
    : undefined;
  if (!options.dryRun && !process.stdin.isTTY) throw new Error("全件取得には対話確認が必要です。対話ターミナルから実行してください。");
  const snapshot = oneShotKey ? readOneShotSnapshot() : undefined;
  const client = new KintoneClient();
  const outputOptions = {
    records: options.mode === "records" || Boolean(options.withRecords),
    comments: options.mode === "comments" || Boolean(options.withComments),
    attachments: Boolean(options.attachments)
  };
  if (favoriteTargets) {
    for (const spaceId of favoriteTargets.spaces) await verifyFavoriteSpaceOutput(client, spaceId, "", host);
    for (const guestSpaceId of favoriteTargets.guestSpaces) await verifyFavoriteSpaceOutput(client, guestSpaceId, guestSpaceId, host);
  }
  const readyTargets: ReadyTarget[] = [];
  for (const target of targets) readyTargets.push(await verifyTarget(client, target, host, outputOptions));

  const result: BulkPullResult = {
    mode: options.mode,
    status: options.dryRun ? "dry-run" : "aborted",
    host,
    selection: {
      kind: selectionKind,
      ...(source ? { source } : {}),
      ...(!allIndexed && options.source ? { groups: options.source.groups.map((group) => group.name) } : {}),
      includes: allIndexed
        ? [options.mode === "comments" ? "comments" : "records", ...(options.attachments ? ["attachments"] : [])]
        : [
            ...(options.withRecords ? ["records"] : []),
            ...(options.withComments ? ["comments"] : []),
            ...(options.attachments ? ["attachments"] : [])
          ]
    },
    ...(!allIndexed && favoriteTargets ? { settingsTargets: { apps: favoriteTargets.apps.map((app) => app.appId), spaces: favoriteTargets.spaces, guestSpaces: favoriteTargets.guestSpaces } } : {}),
    targets: readyTargets.map(({ appId, name, path: targetPath, guestSpaceId, spaceId }) => ({ appId, name, path: targetPath, guestSpaceId, spaceId })),
    results: [],
    failures: [],
    oneShotConsumed: false
  };

  log(previewText(result));
  if (options.dryRun) return result;
  const approved = await confirmYes("表示した対象に対して取得を開始しますか？ [y/N]");
  if (!approved) return result;

  if (oneShotKey && snapshot) {
    if (source) {
      const latest = readCompleteAppIndex(host);
      if (latest.source.appsSha256 !== source.appsSha256 || latest.source.fetchedAt !== source.fetchedAt) {
        throw new Error("確認中に完全索引が変更されました。全件取得を中断しました。pull index を実行し直してください。");
      }
    }
    consumeOneShotSetting(oneShotKey, snapshot);
    result.oneShotConsumed = true;
  }

  result.status = "completed";
  if (options.mode === "favorite" && favoriteTargets) {
    try {
      result.settings = await pullFavorites({ targets: favoriteTargets, force: Boolean(options.force) });
      const settings = result.settings as { failures?: unknown[]; spaceFailures?: unknown[]; permissionSkips?: unknown[]; missing?: unknown[]; apps?: { failed?: number }; spaces?: Array<{ failures?: unknown[]; permissionSkips?: unknown[] }> };
      const settingsFailures = (settings.failures?.length ?? 0) + (settings.spaceFailures?.length ?? 0) + (settings.permissionSkips?.length ?? 0) + (settings.missing?.length ?? 0) + (settings.apps?.failed ?? 0) + (settings.spaces?.reduce((sum, space) => sum + (space.failures?.length ?? 0) + (space.permissionSkips?.length ?? 0), 0) ?? 0);
      if (settingsFailures > 0) result.failures.push({ message: `お気に入りの設定取得に ${settingsFailures} 件の失敗・スキップがあります。` });
    } catch (error) {
      result.failures.push({ message: `お気に入りの設定取得に失敗しました: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  for (const target of readyTargets) {
    const item: Record<string, unknown> = { appId: target.appId, name: target.name, status: "completed" };
    if (options.withRecords || options.mode === "records") {
      try {
        const records = await pullRecords({ appId: target.appId, guestSpaceId: target.guestSpaceId, spaceId: target.guestSpaceId ? "" : target.spaceId, attachments: Boolean(options.attachments), confirmed: true });
        item.records = records;
        if ((records.attachmentFailures ?? 0) > 0) {
          item.status = "partial";
          result.failures.push({ appId: target.appId, message: `添付ファイル取得失敗: ${records.attachmentFailures} 件` });
        }
      } catch (error) {
        item.status = "failed";
        result.failures.push({ appId: target.appId, message: `レコード取得失敗: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    if (options.withComments || options.mode === "comments") {
      try {
        const comments = await pullRecordComments({ appId: target.appId, guestSpaceId: target.guestSpaceId, spaceId: target.guestSpaceId ? "" : target.spaceId });
        item.comments = comments;
        if (comments.failures.length > 0) {
          item.status = "partial";
          result.failures.push(...comments.failures.map((failure) => ({ appId: target.appId, message: `コメント レコード ${failure.recordId}: ${failure.message}` })));
        }
      } catch (error) {
        item.status = "failed";
        result.failures.push({ appId: target.appId, message: `コメント取得失敗: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    result.results.push(item);
  }

  if (result.failures.length > 0) result.status = "partial";
  return result;
}

