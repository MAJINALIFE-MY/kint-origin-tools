import fs from "node:fs";
import path from "node:path";
import { readJsonIfExists } from "../fsutil.js";
import {
  KINTONE_DATA_ROOT,
  CYBOZU_COMMON_DATA_ROOT,
  kintoneAppsRootPath,
  kintoneSpacesRootPath,
  kintoneDeletedAppsRootPath,
  kintoneDeletedSpacesRootPath
} from "../paths.js";

// data/ の走査結果（HTML 生成の入力）。ディレクトリ走査を正とし、index/apps.json は名前等の補完のみに使う。

export interface AppEntry {
  appId: string;
  name: string;
  code: string;
  // 所属スペース（ディレクトリ位置から判定。ドメイン直下アプリは両方空）。
  spaceId: string;
  guestSpaceId: string;
  deleted: boolean;
  // アプリディレクトリ（絶対パス）。
  appDir: string;
  // data/ からの相対パス（"/" 区切り。href 組み立て用）。
  dataRelPath: string;
  hasRecordsCsv: boolean;
  // index/apps.json 由来の補足（あれば）。
  modifiedAt: string;
}

export interface SpaceEntry {
  id: string;
  isGuest: boolean;
  dirName: string;
  name: string;
  deleted: boolean;
  spaceDir: string;
  dataRelPath: string;
  apps: AppEntry[];
}

export interface SiteModel {
  domain: string;
  apps: AppEntry[]; // ドメイン直下＋スペース配下＋削除済みの全アプリ（フラット）
  spaces: SpaceEntry[];
  hasUsers: boolean;
  warnings: string[];
}

interface IndexedAppLite {
  appId?: string;
  name?: string;
  code?: string;
  modifiedAt?: string;
  spaceId?: string;
  guestSpaceId?: string;
}

function listDirNames(root: string, prefix: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

// space-* / guestspace-* だけを対象にする（想定外のディレクトリは無視）。
function listSpaceDirNames(root: string): string[] {
  return [...listDirNames(root, "space-"), ...listDirNames(root, "guestspace-")];
}

// JSON 読み込み失敗（手作業破損等）はページ生成を止めず warning に落とす。
function readJsonSafe(filePath: string, warnings: string[]): unknown | undefined {
  try {
    return readJsonIfExists(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    warnings.push(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function toRelPath(fromRoot: string, target: string): string {
  return path.relative(fromRoot, target).split(path.sep).join("/");
}

export function discoverSite(): SiteModel {
  const warnings: string[] = [];
  const dataRoot = path.resolve(KINTONE_DATA_ROOT, "..");

  const indexById = new Map<string, IndexedAppLite>();
  const indexPayload = readJsonSafe(path.join(KINTONE_DATA_ROOT, "index", "apps.json"), warnings);
  if (Array.isArray(indexPayload)) {
    for (const entry of indexPayload as IndexedAppLite[]) {
      if (entry && typeof entry === "object" && entry.appId) indexById.set(String(entry.appId), entry);
    }
  }

  let domain = "";

  const readAppEntry = (appDir: string, opts: { spaceId: string; guestSpaceId: string; deleted: boolean }): AppEntry => {
    const appId = path.basename(appDir).replace(/^app-/, "");
    const appJson = readJsonSafe(path.join(appDir, "app.json"), warnings) as Record<string, unknown> | undefined;
    const indexed = indexById.get(appId);
    if (!domain && appJson && typeof appJson.domain === "string") domain = appJson.domain;
    return {
      appId,
      name: String(appJson?.name || indexed?.name || ""),
      code: String(appJson?.code || indexed?.code || ""),
      spaceId: opts.spaceId,
      guestSpaceId: opts.guestSpaceId,
      deleted: opts.deleted,
      appDir,
      dataRelPath: toRelPath(dataRoot, appDir),
      hasRecordsCsv: fs.existsSync(path.join(appDir, "records", "records.csv")),
      modifiedAt: String(indexed?.modifiedAt || "")
    };
  };

  const readSpaceEntry = (spaceDir: string, deleted: boolean): SpaceEntry => {
    const dirName = path.basename(spaceDir);
    const isGuest = dirName.startsWith("guestspace-");
    const id = dirName.replace(/^guestspace-|^space-/, "");
    const spaceJson = readJsonSafe(path.join(spaceDir, "space.json"), warnings) as Record<string, unknown> | undefined;
    const apps = listDirNames(path.join(spaceDir, "apps"), "app-").map((name) =>
      readAppEntry(path.join(spaceDir, "apps", name), {
        spaceId: isGuest ? "" : id,
        guestSpaceId: isGuest ? id : "",
        deleted
      })
    );
    return {
      id,
      isGuest,
      dirName,
      name: String(spaceJson?.name || ""),
      deleted,
      spaceDir,
      dataRelPath: toRelPath(dataRoot, spaceDir),
      apps
    };
  };

  const domainApps = listDirNames(kintoneAppsRootPath(), "app-").map((name) =>
    readAppEntry(path.join(kintoneAppsRootPath(), name), { spaceId: "", guestSpaceId: "", deleted: false })
  );
  const spaces = listSpaceDirNames(kintoneSpacesRootPath()).map((name) =>
    readSpaceEntry(path.join(kintoneSpacesRootPath(), name), false)
  );
  const deletedApps = listDirNames(kintoneDeletedAppsRootPath(), "app-").map((name) =>
    readAppEntry(path.join(kintoneDeletedAppsRootPath(), name), { spaceId: "", guestSpaceId: "", deleted: true })
  );
  const deletedSpaces = listSpaceDirNames(kintoneDeletedSpacesRootPath()).map((name) =>
    readSpaceEntry(path.join(kintoneDeletedSpacesRootPath(), name), true)
  );

  const spaceCandidates = [...spaces, ...deletedSpaces];
  const spaceGroups = new Map<string, SpaceEntry[]>();
  for (const space of spaceCandidates) spaceGroups.set(space.dirName, [...(spaceGroups.get(space.dirName) ?? []), space]);
  const allSpaces: SpaceEntry[] = [];
  for (const [dirName, candidates] of spaceGroups) {
    candidates.sort((a, b) => Number(a.deleted) - Number(b.deleted) || a.spaceDir.localeCompare(b.spaceDir, "en"));
    if (candidates.length > 1) warnings.push(`${dirName}: 同じHTML出力先のスペースが複数あるため、現行データを優先して1件だけ表示します。`);
    allSpaces.push(candidates[0]);
  }
  const appCandidates = [...domainApps, ...allSpaces.flatMap((space) => space.apps), ...deletedApps];
  const appGroups = new Map<string, AppEntry[]>();
  for (const app of appCandidates) appGroups.set(app.appId, [...(appGroups.get(app.appId) ?? []), app]);
  const apps: AppEntry[] = [];
  for (const [appId, candidates] of appGroups) {
    const indexed = indexById.get(appId);
    candidates.sort((a, b) => {
      const rank = (item: AppEntry): number => {
        if (item.deleted) return 2;
        const matchesIndex = indexed && String(indexed.guestSpaceId ?? "") === item.guestSpaceId && String(indexed.spaceId ?? "") === item.spaceId;
        return matchesIndex ? 0 : 1;
      };
      return rank(a) - rank(b) || a.appDir.localeCompare(b.appDir, "en");
    });
    if (candidates.length > 1) warnings.push(`app-${appId}: 同じHTML出力先のアプリが複数あるため、索引上の現行配置を優先して1件だけ表示します。`);
    apps.push(candidates[0]);
  }
  apps.sort((a, b) => a.appId.localeCompare(b.appId, "en", { numeric: true }));

  return {
    domain,
    apps,
    spaces: allSpaces,
    hasUsers: fs.existsSync(path.join(CYBOZU_COMMON_DATA_ROOT, "users", "users.json")),
    warnings
  };
}
