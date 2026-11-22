import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../fsutil.js";
import { log } from "../log.js";
import {
  AGENT_DATA_DIR,
  getAppDirName,
  kintoneAppsRootPath,
  kintoneDeletedAppsRootPath,
  kintoneDeletedSpacesRootPath,
  kintoneSpacesRootPath
} from "../paths.js";
import { isGuestSpaceRequiredError, isPermissionError, type KintoneApp, type KintoneClient } from "./client.js";
import type { CybozuError } from "../http.js";
import { appIdOf, stringify, type AppScope } from "./ids.js";
import { isOtherTenant, otherTenantMessage } from "./tenant.js";
import { recordLocalAction } from "../runLog.js";

interface LocalApp {
  appId: string;
  name: string;
  sourcePath: string;
  guestSpaceId: string;
  spaceId: string;
  scope: AppScope;
}

interface LocalSpace {
  name: string;
  sourcePath: string;
  guestSpaceId: string;
  spaceId: string;
}

function isDirectory(dirPath: string): boolean {
  return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
}

function listDirectories(dirPath: string): string[] {
  if (!isDirectory(dirPath)) return [];
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function listAppDirNames(dirPath: string): string[] {
  return listDirectories(dirPath).filter((entry) => /^app-\d+$/.test(entry));
}

function listSpaceEntries(): string[] {
  return listDirectories(kintoneSpacesRootPath()).filter(
    (name) => /^space-\d+$/.test(name) || /^guestspace-\d+$/.test(name)
  );
}

function isNotFoundError(error: unknown): boolean {
  return (error as CybozuError | undefined)?.status === 404;
}

function assertInside(childPath: string, parentPath: string): void {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
  if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return;
  }
  throw new Error(`Refusing to move path outside expected root: ${childPath}`);
}

function moveDirectory({
  sourcePath,
  targetRoot,
  targetName
}: {
  sourcePath: string;
  targetRoot: string;
  targetName: string;
}): string | null {
  if (!isDirectory(sourcePath)) return null;
  ensureDir(targetRoot);
  const targetPath = path.join(targetRoot, targetName);
  assertInside(targetPath, targetRoot);
  if (fs.existsSync(targetPath)) {
    log(`deleted/ の移動先が既にあるため上書きせず保留します: ${targetPath}`);
    return null;
  }
  recordLocalAction("move-entry-to-deleted", targetPath, { sourcePath });
  fs.renameSync(sourcePath, targetPath);
  return targetPath;
}

function listLocalSpaces(): LocalSpace[] {
  return listSpaceEntries().map((name) => ({
    name,
    sourcePath: path.join(kintoneSpacesRootPath(), name),
    guestSpaceId: name.startsWith("guestspace-") ? name.slice("guestspace-".length) : "",
    spaceId: name.startsWith("space-") ? name.slice("space-".length) : ""
  }));
}

function listLocalApps(): LocalApp[] {
  const apps: LocalApp[] = [];
  for (const name of listAppDirNames(kintoneAppsRootPath())) {
    apps.push({
      appId: name.slice("app-".length),
      name,
      sourcePath: path.join(kintoneAppsRootPath(), name),
      guestSpaceId: "",
      spaceId: "",
      scope: "domain"
    });
  }
  for (const space of listLocalSpaces()) {
    const appsRoot = path.join(space.sourcePath, "apps");
    for (const name of listAppDirNames(appsRoot)) {
      apps.push({
        appId: name.slice("app-".length),
        name,
        sourcePath: path.join(appsRoot, name),
        guestSpaceId: space.guestSpaceId,
        spaceId: space.spaceId,
        scope: space.guestSpaceId ? "guestspace" : "space"
      });
    }
  }
  return apps;
}

function appLocationKey({ guestSpaceId = "", spaceId = "" }: { guestSpaceId?: string; spaceId?: string }): string {
  if (guestSpaceId) return `guestspace:${guestSpaceId}`;
  if (spaceId) return `space:${spaceId}`;
  return "domain";
}

function moveLocalAppToDeleted(app: LocalApp): string | null {
  assertInside(app.sourcePath, app.scope === "domain" ? kintoneAppsRootPath() : kintoneSpacesRootPath());
  // _agentdata（バックアップ・検討メモ）はアプリディレクトリごと deleted/ へ移動される。
  if (fs.existsSync(path.join(app.sourcePath, AGENT_DATA_DIR))) {
    log(
      `注意: app-${app.appId} の ${AGENT_DATA_DIR}（バックアップ・検討メモ等）も deleted/ へ移動します。必要なら Git 履歴から復元してください。`
    );
  }
  return moveDirectory({
    sourcePath: app.sourcePath,
    targetRoot: kintoneDeletedAppsRootPath(),
    targetName: getAppDirName(app.appId)
  });
}

function moveLocalSpaceToDeleted(space: LocalSpace): string | null {
  assertInside(space.sourcePath, kintoneSpacesRootPath());
  return moveDirectory({
    sourcePath: space.sourcePath,
    targetRoot: kintoneDeletedSpacesRootPath(),
    targetName: space.name
  });
}

function buildActiveAppIdSet(allApps: KintoneApp[]): Set<string> {
  return new Set(allApps.map((app) => appIdOf(app)).filter(Boolean));
}

function buildActiveAppLocationMap(allApps: KintoneApp[]): Map<string, string> {
  const locations = new Map<string, string>();
  for (const app of allApps) {
    const appId = appIdOf(app);
    if (!appId) continue;
    locations.set(
      appId,
      appLocationKey({
        guestSpaceId: stringify(app.guestSpaceId),
        spaceId: stringify(app.spaceId)
      })
    );
  }
  return locations;
}

function buildActiveSpaceSets(allApps: KintoneApp[]): { spaceIds: Set<string>; guestSpaceIds: Set<string> } {
  const spaceIds = new Set<string>();
  const guestSpaceIds = new Set<string>();
  for (const app of allApps) {
    if (app.guestSpaceId) {
      guestSpaceIds.add(String(app.guestSpaceId));
      continue;
    }
    if (app.spaceId) spaceIds.add(String(app.spaceId));
  }
  return { spaceIds, guestSpaceIds };
}

async function appExists(client: KintoneClient, app: LocalApp): Promise<boolean> {
  try {
    await client.getAppInfo(app.appId, { guestSpaceId: app.guestSpaceId });
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    if (isPermissionError(error)) return true; // 検証不可 → 削除しない
    throw error;
  }
}

async function spaceExists(client: KintoneClient, space: LocalSpace): Promise<boolean> {
  try {
    await client.getSpace(space.guestSpaceId || space.spaceId, { guestSpaceId: space.guestSpaceId });
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    // GAIA_IL25: 通常 URL で参照した space-<id> は実はゲストスペース。正本は guestspace-<id> なので通常スペースとしては不在扱い。
    if (!space.guestSpaceId && isGuestSpaceRequiredError(error)) return false;
    if (isPermissionError(error)) return true; // 検証不可 → 削除しない
    throw error;
  }
}

async function shouldKeepLocalApp({
  client,
  app,
  activeAppIds,
  activeAppLocations
}: {
  client: KintoneClient;
  app: LocalApp;
  activeAppIds: Set<string>;
  activeAppLocations: Map<string, string>;
}): Promise<boolean> {
  const activeLocation = activeAppLocations.get(app.appId);
  if (activeLocation && activeLocation === appLocationKey(app)) return true;
  // リモート一覧で ID が生存しているアプリは、所属変更やゲスト分類の確認待ちであっても削除扱いにしない。
  if (activeAppIds.has(app.appId)) return true;
  return !activeAppIds.has(app.appId) && (await appExists(client, app));
}

async function shouldKeepLocalSpace({
  client,
  space,
  activeSpaces
}: {
  client: KintoneClient;
  space: LocalSpace;
  activeSpaces: { spaceIds: Set<string>; guestSpaceIds: Set<string> };
}): Promise<boolean> {
  const activeSet = space.guestSpaceId ? activeSpaces.guestSpaceIds : activeSpaces.spaceIds;
  const id = space.guestSpaceId || space.spaceId;
  return activeSet.has(id) || (await spaceExists(client, space));
}

export interface DeletedSummary {
  apps: Array<{ appId: string; from: string; to: string }>;
  spaces: Array<{ id: string; guestSpaceId: string; spaceId: string; from: string; to: string }>;
}

export async function moveMissingLocalKintoneEntries({
  client,
  allApps
}: {
  client: KintoneClient;
  allApps: KintoneApp[];
}): Promise<DeletedSummary> {
  const activeAppIds = buildActiveAppIdSet(allApps);
  const activeAppLocations = buildActiveAppLocationMap(allApps);
  const activeSpaces = buildActiveSpaceSets(allApps);
  const deleted: DeletedSummary = { apps: [], spaces: [] };

  for (const app of listLocalApps()) {
    // 取得元が今の接続先と違うアプリは、環境に無くても削除済みとは限らない（別のドメインで取得したもの）。動かさない。
    if (isOtherTenant(app.sourcePath)) {
      log(`app-${app.appId}: ${otherTenantMessage(app.sourcePath)} deleted/ へは移動しません。`);
      continue;
    }
    if (await shouldKeepLocalApp({ client, app, activeAppIds, activeAppLocations })) continue;
    const targetPath = moveLocalAppToDeleted(app);
    if (targetPath) deleted.apps.push({ appId: app.appId, from: app.sourcePath, to: targetPath });
  }

  for (const space of listLocalSpaces()) {
    // 取得元が今の接続先と違うスペースは、環境に無くても削除済みとは限らない（別のドメインで取得したもの）。動かさない。
    if (isOtherTenant(space.sourcePath)) {
      log(`${space.name}: ${otherTenantMessage(space.sourcePath)} deleted/ へは移動しません。`);
      continue;
    }
    const id = space.guestSpaceId || space.spaceId;
    if (await shouldKeepLocalSpace({ client, space, activeSpaces })) continue;
    const targetPath = moveLocalSpaceToDeleted(space);
    if (targetPath) {
      deleted.spaces.push({
        id,
        guestSpaceId: space.guestSpaceId,
        spaceId: space.spaceId,
        from: space.sourcePath,
        to: targetPath
      });
    }
  }

  return deleted;
}
