import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getEnv } from "../env.js";
import { ensureDir, readJsonIfExists, writeJson, writeText } from "../fsutil.js";
import { getSpaceDirName, kintoneAppRootPath, kintoneSpaceRootPath } from "../paths.js";
import { dynamicPlaceholder, normalizeDynamicValues, sanitizeName } from "../normalize.js";
import { CUSTOMIZE_DIRECTORIES } from "./customize.js";
import { EXPORT_FOLDERS, type ExportItem } from "./exportItems.js";
import { appIdOf, stringify } from "./ids.js";
import type { KintoneApp, KintoneSpace } from "./client.js";
import { classify, hashJson, hashLocalJson, readPullState, sha256, writePullState } from "./pullState.js";
import { collapseSpaceHtml, formatSpaceHtml } from "./htmlFormat.js";
import { recordLocalAction } from "../runLog.js";

export interface AppResource extends ExportItem {
  payload: unknown;
}

const GENERATED_NAME_MANIFEST = ".kint-origin-generated-name.json";

function markdownSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function syncGeneratedNameMarkdown(dir: string, fileName: string, content: string): void {
  const manifestPath = path.join(dir, GENERATED_NAME_MANIFEST);
  const manifestStat = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
  if (manifestStat && (manifestStat.isSymbolicLink() || !manifestStat.isFile())) {
    throw new Error(`生成Markdownの管理ファイルが通常ファイルではありません: ${manifestPath}`);
  }
  let previous: { file?: string; sha256?: string } | undefined;
  if (manifestStat) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (parsed?.schemaVersion === 1 && typeof parsed.file === "string" && /^[^\\/]+\.md$/i.test(parsed.file) && /^[a-f0-9]{64}$/.test(parsed.sha256)) {
        previous = parsed;
      } else {
        return; // 不明なメタデータから所有権を推測して既存ファイルを触らない。
      }
    } catch {
      return;
    }
  }
  const oldPath = previous ? path.join(dir, previous.file!) : "";
  let oldIsUnmodified = false;
  if (previous && fs.existsSync(oldPath)) {
    const oldStat = fs.lstatSync(oldPath);
    oldIsUnmodified = oldStat.isFile() && !oldStat.isSymbolicLink() && markdownSha256(fs.readFileSync(oldPath, "utf8")) === previous.sha256;
  }
  if (!fileName) {
    if (oldIsUnmodified) fs.rmSync(oldPath, { force: true });
    if (previous) fs.rmSync(manifestPath, { force: true });
    return;
  }
  const matchingName = fs.existsSync(dir)
    ? fs.readdirSync(dir).find((entry) => entry.toLocaleLowerCase() === fileName.toLocaleLowerCase())
    : undefined;
  const destinationName = matchingName ?? fileName;
  const destination = path.join(dir, destinationName);
  const isManagedDestination = Boolean(previous && oldIsUnmodified && previous.file!.toLocaleLowerCase() === destinationName.toLocaleLowerCase());
  if (matchingName) {
    const stat = fs.lstatSync(destination);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`生成Markdownの保存先が通常ファイルではありません: ${destination}`);
    const existingText = fs.readFileSync(destination, "utf8");
    if (!isManagedDestination && existingText !== content) {
      if (oldIsUnmodified && oldPath !== destination) fs.rmSync(oldPath, { force: true });
      if (previous) fs.rmSync(manifestPath, { force: true });
      return; // 同名の利用者ファイルは維持する。
    }
  }
  if (oldIsUnmodified && oldPath !== destination) fs.rmSync(oldPath, { force: true });
  if (!matchingName || isManagedDestination || fs.readFileSync(destination, "utf8") !== content) writeText(destination, content);
  writeJson(manifestPath, { schemaVersion: 1, file: destinationName, sha256: markdownSha256(content) });
}

function initAppTree(appDir: string): void {
  ensureDir(appDir);
  for (const folder of EXPORT_FOLDERS) ensureDir(path.join(appDir, folder));
  for (const folder of CUSTOMIZE_DIRECTORIES) ensureDir(path.join(appDir, folder));
  ensureDir(path.join(appDir, "records"));
}

// 中身が { "_error": ... } だけの取得失敗スタブか。正常な JSON・パースできないファイルは false（消さない）。
function isErrorStubFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && "_error" in value;
  } catch {
    return false;
  }
}

// 権限不足で取得しないキーの _error スタブを消す。正常な JSON は残す。
function removeDeniedStubs(appDir: string, denied: ExportItem[]): void {
  for (const item of denied) {
    const filePath = path.join(appDir, item.folder, item.file);
    if (isErrorStubFile(filePath)) {
      recordLocalAction("remove-denied-error-stub", filePath);
      fs.rmSync(filePath);
    }
  }
}

export function writeAppExport({
  app,
  guestSpaceId = "",
  spaceId = "",
  resources,
  denied = [],
  keep = new Set<string>(),
  writeAppMetadata = true
}: {
  app: KintoneApp;
  guestSpaceId?: string;
  spaceId?: string;
  resources: AppResource[];
  denied?: ExportItem[];
  /** app-info 権限不足時、既存 app.json は前回取得内容のまま保持する。 */
  writeAppMetadata?: boolean;
  /** ローカル編集を保持するため書かないファイル（`folder/file`） */
  keep?: Set<string>;
}): string {
  const appId = appIdOf(app);
  const appDir = kintoneAppRootPath({ guestSpaceId, spaceId, appId });
  initAppTree(appDir);
  const appName = app.name || "";
  const domain = new URL(getEnv().baseUrl).host;

  if (writeAppMetadata) {
    writeJson(path.join(appDir, "app.json"), {
      exportedAt: dynamicPlaceholder(),
      domain,
      appId,
      code: app.code || "",
      name: appName,
      spaceId: stringify(app.spaceId),
      guestSpaceId: guestSpaceId ? String(guestSpaceId) : "",
      type: guestSpaceId ? "guestspace-app" : spaceId ? "space-app" : "domain-app"
    });
  }

  for (const item of resources) {
    if (keep.has(`${item.folder}/${item.file}`)) continue;
    writeJson(path.join(appDir, item.folder, item.file), normalizeDynamicValues(item.payload));
  }
  removeDeniedStubs(appDir, denied);

  syncGeneratedNameMarkdown(appDir, appName ? `${sanitizeName(appName)}.md` : "", appName ? `# ${appName}\n\n- App ID: ${appId}\n- Domain: ${domain}\n` : "");

  return appDir;
}

export const SPACE_SETTINGS_KEYS = [
  "name",
  "isPrivate",
  "fixedMember",
  "useMultiThread",
  "showAnnouncement",
  "showThreadList",
  "showAppList",
  "showMemberList",
  "showRelatedLinkList",
  "permissions"
] as const;

export type SpaceSettingKey = (typeof SPACE_SETTINGS_KEYS)[number];

export interface SpaceSettings {
  name: string;
  isPrivate: boolean;
  fixedMember: boolean;
  useMultiThread: boolean;
  showAnnouncement: boolean;
  showThreadList: boolean;
  showAppList: boolean;
  showMemberList: boolean;
  showRelatedLinkList: boolean;
  permissions: { createApp: string } | null;
}

export function serializeSpaceSettings(space: KintoneSpace | null | undefined): SpaceSettings {
  const perms = space?.permissions;
  const createApp = perms && typeof perms === "object" && typeof (perms as any).createApp === "string" ? (perms as any).createApp : null;
  return {
    name: typeof space?.name === "string" ? space.name : "",
    isPrivate: Boolean(space?.isPrivate),
    fixedMember: Boolean(space?.fixedMember),
    useMultiThread: Boolean(space?.useMultiThread),
    showAnnouncement: Boolean(space?.showAnnouncement),
    showThreadList: Boolean(space?.showThreadList),
    showAppList: Boolean(space?.showAppList),
    showMemberList: Boolean(space?.showMemberList),
    showRelatedLinkList: Boolean(space?.showRelatedLinkList),
    permissions: createApp ? { createApp } : null
  };
}

// スペース本文 HTML の比較用正規化（UTF-8 BOM 除去、ブロック境界の空白除去・1行化）。
export function normalizeSpaceBody(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  return collapseSpaceHtml(text);
}

// body.html へ書き出すテキスト（ブロック要素を 2 スペースインデントで整形、末尾 LF 1つ、空なら空文字列）。
export function formatSpaceBodyFile(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  return formatSpaceHtml(text);
}

export function hashSpaceBody(raw: unknown): string {
  return sha256(normalizeSpaceBody(raw));
}

export function hashLocalSpaceBody(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  return hashSpaceBody(fs.readFileSync(file, "utf8"));
}

export function ensureSpaceThreadsDirectory(spaceDir: string): boolean {
  const threadsDir = path.join(spaceDir, "threads");
  const directoryStat = fs.lstatSync(threadsDir, { throwIfNoEntry: false });
  if (directoryStat?.isSymbolicLink()) throw new Error(`threads の手動保管先にシンボリックリンクは使えません: ${threadsDir}`);
  if (directoryStat && !directoryStat.isDirectory()) throw new Error(`threads の手動保管先は通常ディレクトリである必要があります: ${threadsDir}`);
  if (!directoryStat) {
    recordLocalAction("create-space-threads-directory", threadsDir);
    fs.mkdirSync(threadsDir);
  }
  const marker = path.join(threadsDir, ".gitkeep");
  const markerStat = fs.lstatSync(marker, { throwIfNoEntry: false });
  if (markerStat?.isSymbolicLink() || (markerStat && !markerStat.isFile())) {
    throw new Error(`threads の手動保管先マーカーは通常ファイルである必要があります: ${marker}`);
  }
  if (markerStat) return false;
  try {
    recordLocalAction("create-space-threads-marker", marker);
    fs.writeFileSync(marker, "", { flag: "wx" });
    return true;
  } catch (error) {
    const current = fs.lstatSync(marker, { throwIfNoEntry: false });
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && current?.isFile() && !current.isSymbolicLink()) return false;
    throw error;
  }
}

export interface SpaceExportResult {
  localEdits: Array<{ file: string; conflict: boolean }>;
}

export function writeSpaceExport({
  space,
  apps,
  guestSpaceId = "",
  spaceId = "",
  discardLocal = false,
  adoptRemote = new Set<string>()
}: {
  space: KintoneSpace;
  apps?: KintoneApp[];
  guestSpaceId?: string;
  spaceId?: string;
  discardLocal?: boolean;
  adoptRemote?: ReadonlySet<string>;
}): SpaceExportResult {
  const spaceDirName = getSpaceDirName({ guestSpaceId, spaceId });
  const spaceDir = kintoneSpaceRootPath({ guestSpaceId, spaceId });
  const spaceName = space?.name || "";
  const domain = new URL(getEnv().baseUrl).host;
  ensureDir(spaceDir);
  ensureDir(path.join(spaceDir, "apps"));
  // threads/ は API で取得できないスレッド内容の手動保管場所。
  ensureSpaceThreadsDirectory(spaceDir);

  const previous = readPullState(spaceDir);
  const remoteSettings = serializeSpaceSettings(space);
  const remoteSettingsHash = hashJson(remoteSettings);
  const remoteBodyHash = hashSpaceBody(space?.body);
  const keep = new Set<string>();
  const localEdits: Array<{ file: string; conflict: boolean }> = [];

  if (previous && !discardLocal) {
    if (!adoptRemote.has("settings")) {
      const localSettingsHash = hashLocalJson(path.join(spaceDir, "settings.json"));
      const settingsState = classify({ base: previous.files["settings.json"], local: localSettingsHash, remote: remoteSettingsHash });
      if (settingsState === "local" || settingsState === "conflict") {
        keep.add("settings.json");
        localEdits.push({ file: "settings.json", conflict: settingsState === "conflict" });
      }
    }
    if (!adoptRemote.has("body")) {
      const localBodyHash = hashLocalSpaceBody(path.join(spaceDir, "body.html"));
      const bodyState = classify({ base: previous.files["body.html"], local: localBodyHash, remote: remoteBodyHash });
      if (bodyState === "local" || bodyState === "conflict") {
        keep.add("body.html");
        localEdits.push({ file: "body.html", conflict: bodyState === "conflict" });
      }
    }
  }

  writeJson(path.join(spaceDir, "space.json"), {
    exportedAt: dynamicPlaceholder(),
    domain,
    id: String(guestSpaceId || spaceId),
    guestSpaceId: guestSpaceId ? String(guestSpaceId) : "",
    spaceId: guestSpaceId ? "" : String(spaceId),
    type: guestSpaceId ? "guestspace" : "space",
    name: space?.name || "",
    body: space?.body || "",
    isPrivate: Boolean(space?.isPrivate),
    isGuest: Boolean(guestSpaceId),
    raw: space
  });

  if (!keep.has("settings.json")) {
    writeJson(path.join(spaceDir, "settings.json"), remoteSettings);
  }
  if (!keep.has("body.html")) {
    writeText(path.join(spaceDir, "body.html"), formatSpaceBodyFile(space?.body));
  }

  let appCount = 0;
  if (apps) {
    appCount = apps.length;
    writeJson(
      path.join(spaceDir, "apps.json"),
      apps.map((app) => ({
        appId: appIdOf(app),
        code: app.code || "",
        name: app.name || "",
        spaceId: stringify(app.spaceId)
      }))
    );
  } else {
    const existingApps = readJsonIfExists(path.join(spaceDir, "apps.json"));
    appCount = Array.isArray(existingApps) ? existingApps.length : 0;
  }

  const readmePath = path.join(spaceDir, "README.md");
  if (!fs.existsSync(readmePath)) {
    writeText(
      readmePath,
      [
        `# ${spaceName || spaceDirName}`,
        "",
        `- ID: ${guestSpaceId || spaceId}`,
        `- Type: ${guestSpaceId ? "guestspace" : "space"}`,
        `- Apps: ${appCount}`,
        `- Exported At: ${dynamicPlaceholder()}`,
        ""
      ].join("\n")
    );
  }

  syncGeneratedNameMarkdown(
    spaceDir,
    spaceName && `${sanitizeName(spaceName)}.md` !== "README.md" ? `${sanitizeName(spaceName)}.md` : "",
    spaceName ? `# ${spaceName}\n\n- Space ID: ${guestSpaceId || spaceId}\n- Type: ${guestSpaceId ? "guestspace" : "space"}\n` : ""
  );

  const files: Record<string, string> = {
    "settings.json": keep.has("settings.json") && previous?.files["settings.json"] ? previous.files["settings.json"] : remoteSettingsHash,
    "body.html": keep.has("body.html") && previous?.files["body.html"] ? previous.files["body.html"] : remoteBodyHash
  };
  writePullState(spaceDir, { schemaVersion: 1, files });

  return { localEdits };
}
