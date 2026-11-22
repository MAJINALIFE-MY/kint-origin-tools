import fs from "node:fs";
import path from "node:path";

import { parseJsonText, writeJson } from "../fsutil.js";
import { log } from "../log.js";
import { sortByNameThenId } from "../normalize.js";
import { KINTONE_DATA_ROOT, kintoneAppRootPath, kintoneSpacesRootPath } from "../paths.js";
import { KintoneClient, type KintoneApp } from "./client.js";
import { appIdOf, stringify } from "./ids.js";

export interface IndexedApp {
  appId: string;
  code: string;
  name: string;
  spaceId: string;
  guestSpaceId: string;
  modifiedAt: string;
  lastPulledModifiedAt?: string;
  lastPulledAt?: string;
}

export interface IndexedSpace {
  id: string;
  spaceId: string;
  guestSpaceId: string;
  type: "space" | "guestspace";
  appCount: number;
}

export async function listAllAppsForIndex(client: KintoneClient): Promise<{ apps: KintoneApp[]; apiCalls: number }> {
  const limit = 100;
  let apiCalls = 0;
  let offset = 0;
  const apps: KintoneApp[] = [];
  const seen = new Set<string>();
  for (let page = 1; ; page += 1) {
    log(`apps.json 取得中: offset=${offset}, limit=${limit} (API ${page})`);
    const payload = await client.request("/apps.json", { method: "GET", query: { limit, offset } });
    apiCalls = page;
    if (!payload || !Array.isArray(payload.apps)) throw new Error(`apps.json API ${page} の応答に apps 配列がありません。完全なアプリ索引を確認できません。`);
    const batch = payload.apps as unknown[];
    if (batch.length > limit) throw new Error(`apps.json API ${page} が limit=${limit} を超える応答を返しました。`);
    for (const raw of batch) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`apps.json API ${page} に不正なアプリ項目があります。`);
      const app = raw as KintoneApp;
      const appId = appIdOf(app);
      if (!/^[1-9]\d*$/.test(appId)) throw new Error(`apps.json API ${page} のアプリ ID が不正です: ${JSON.stringify(appId)}`);
      if (seen.has(appId)) throw new Error(`apps.json API にアプリ ID ${appId} が重複しています。完全な索引を確認できません。`);
      seen.add(appId);
      for (const key of ["spaceId", "guestSpaceId"] as const) {
        const value = app[key];
        if (value != null && value !== "" && !/^[1-9]\d*$/.test(String(value))) {
          throw new Error(`apps.json API のアプリ ${appId} の ${key} が不正です: ${JSON.stringify(value)}`);
        }
      }
      apps.push(app);
    }
    if (batch.length < limit) break;
    offset += limit;
  }
  return { apps, apiCalls };
}

function indexAppsPath(): string {
  return path.join(KINTONE_DATA_ROOT, "index", "apps.json");
}

function indexSpacesPath(): string {
  return path.join(KINTONE_DATA_ROOT, "index", "spaces.json");
}

export function readAppIndex(): Map<string, IndexedApp> {
  const filePath = indexAppsPath();
  if (!fs.existsSync(filePath)) return new Map();
  const parsed = parseJsonText(fs.readFileSync(filePath, "utf8"), filePath);
  if (!Array.isArray(parsed)) return new Map();

  const entries = new Map<string, IndexedApp>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const app = item as Partial<IndexedApp>;
    if (app.appId) entries.set(String(app.appId), app as IndexedApp);
  }
  return entries;
}

export function lookupIndexedApp(appId: string | number): IndexedApp | undefined {
  return readAppIndex().get(String(appId));
}

export function normalizeRemoteApp(app: KintoneApp, previous?: IndexedApp): IndexedApp {
  const spaceId = stringify(app.spaceId);
  // /apps.json はゲストスペースのアプリにも guestSpaceId を付けない。判定済みで同じスペースに居るなら引き継ぐ。
  const guestSpaceId =
    stringify(app.guestSpaceId) || (previous?.guestSpaceId && previous.guestSpaceId === spaceId ? previous.guestSpaceId : "");
  const previousPulledModifiedAt = previous?.lastPulledModifiedAt || "";
  return {
    appId: appIdOf(app),
    code: stringify(app.code),
    name: stringify(app.name),
    spaceId,
    guestSpaceId,
    modifiedAt: stringify(app.modifiedAt),
    ...(previousPulledModifiedAt ? { lastPulledModifiedAt: previousPulledModifiedAt } : {}),
    ...(previous?.lastPulledAt ? { lastPulledAt: previous.lastPulledAt } : {})
  };
}

export function normalizeRemoteApps(rawApps: KintoneApp[], previousIndex: Map<string, IndexedApp> = readAppIndex()): IndexedApp[] {
  return sortByNameThenId(
    rawApps.map((app) => normalizeRemoteApp(app, previousIndex.get(appIdOf(app)))).filter((app) => app.appId),
    "name",
    "appId"
  );
}

// /apps.json はゲストスペースのアプリにも guestSpaceId を付けず spaceId だけ返す。判明済みのゲストスペース ID を注入する。
export function withGuestSpaceIds(rawApps: KintoneApp[], guestSpaceIds: ReadonlySet<string>): KintoneApp[] {
  if (guestSpaceIds.size === 0) return rawApps;
  return rawApps.map((app) => {
    const spaceId = stringify(app.spaceId);
    return !stringify(app.guestSpaceId) && guestSpaceIds.has(spaceId) ? { ...app, guestSpaceId: spaceId } : app;
  });
}

export function guestSpaceIdsOf(apps: Iterable<IndexedApp>): Set<string> {
  const ids = new Set<string>();
  for (const app of apps) if (app.guestSpaceId) ids.add(app.guestSpaceId);
  return ids;
}

export function buildSpaces(apps: IndexedApp[]): IndexedSpace[] {
  const spaces = new Map<string, IndexedSpace>();
  for (const app of apps) {
    if (!app.spaceId && !app.guestSpaceId) continue;
    const type = app.guestSpaceId ? "guestspace" : "space";
    const id = app.guestSpaceId || app.spaceId;
    const key = `${type}:${id}`;
    const current =
      spaces.get(key) ||
      ({
        id,
        spaceId: app.guestSpaceId ? "" : app.spaceId,
        guestSpaceId: app.guestSpaceId,
        type,
        appCount: 0
      } satisfies IndexedSpace);
    current.appCount += 1;
    spaces.set(key, current);
  }
  return [...spaces.values()].sort((a, b) => a.type.localeCompare(b.type, "en") || a.id.localeCompare(b.id, "en"));
}

function compactIndexedApp(app: IndexedApp): IndexedApp {
  return {
    appId: app.appId,
    code: app.code,
    name: app.name,
    spaceId: app.spaceId,
    guestSpaceId: app.guestSpaceId,
    modifiedAt: app.modifiedAt,
    ...(app.lastPulledModifiedAt ? { lastPulledModifiedAt: app.lastPulledModifiedAt } : {}),
    ...(app.lastPulledAt ? { lastPulledAt: app.lastPulledAt } : {})
  };
}

function existingTrackedSpaceIndex(): IndexedSpace[] {
  const filePath = indexSpacesPath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = parseJsonText(fs.readFileSync(filePath, "utf8"), filePath);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item: any) => {
      if (!item || !/^[1-9]\d*$/.test(String(item.id ?? "")) || !["space", "guestspace"].includes(item.type)) return [];
      const dir = `${item.type}-${item.id}`;
      return fs.existsSync(path.join(kintoneSpacesRootPath(), dir))
        ? [{ id: String(item.id), type: item.type, spaceId: item.type === "space" ? String(item.id) : "", guestSpaceId: item.type === "guestspace" ? String(item.id) : "", appCount: Number.isSafeInteger(item.appCount) && item.appCount >= 0 ? item.appCount : 0 } as IndexedSpace]
        : [];
    });
  } catch {
    return [];
  }
}

export function writeAppIndex(apps: IndexedApp[], additionalSpaces: IndexedSpace[] = []): void {
  writeJson(indexAppsPath(), apps.map(compactIndexedApp));
  const spaces = new Map<string, IndexedSpace>();
  for (const space of existingTrackedSpaceIndex()) {
    const key = `${space.type}:${space.id}`;
    spaces.set(key, space);
  }
  for (const space of [...additionalSpaces, ...buildSpaces(apps)]) spaces.set(`${space.type}:${space.id}`, space);
  writeJson(indexSpacesPath(), [...spaces.values()].sort((a, b) => a.type.localeCompare(b.type, "en") || a.id.localeCompare(b.id, "en")));
}

export function mergeRemoteAppsIntoIndex(rawApps: KintoneApp[], { replaceAll = false }: { replaceAll?: boolean } = {}): IndexedApp[] {
  const previous = readAppIndex();
  const merged = replaceAll ? new Map<string, IndexedApp>() : new Map(previous);
  for (const rawApp of rawApps) {
    const appId = appIdOf(rawApp);
    if (!appId) continue;
    merged.set(appId, normalizeRemoteApp(rawApp, previous.get(appId)));
  }
  const apps = sortByNameThenId([...merged.values()], "name", "appId");
  writeAppIndex(apps);
  return apps;
}

export function markPulledInIndex(rawApps: KintoneApp[], pulledAt: string = new Date().toISOString()): IndexedApp[] {
  const previous = readAppIndex();
  const merged = new Map(previous);
  for (const rawApp of rawApps) {
    const appId = appIdOf(rawApp);
    if (!appId) continue;
    const indexed = normalizeRemoteApp(rawApp, previous.get(appId));
    indexed.lastPulledModifiedAt = indexed.modifiedAt;
    indexed.lastPulledAt = pulledAt;
    merged.set(appId, indexed);
  }
  const apps = sortByNameThenId([...merged.values()], "name", "appId");
  writeAppIndex(apps);
  return apps;
}

export function markPullIncompleteInIndex(appId: string | number): void {
  const previous = readAppIndex();
  const app = previous.get(String(appId));
  if (!app) return;
  const updated = { ...app };
  delete updated.lastPulledModifiedAt;
  const merged = new Map(previous);
  merged.set(updated.appId, updated);
  writeAppIndex(sortByNameThenId([...merged.values()], "name", "appId"));
}

function hasLocalAppDetail(app: IndexedApp): boolean {
  const appDir = kintoneAppRootPath({
    appId: app.appId,
    guestSpaceId: app.guestSpaceId,
    spaceId: app.guestSpaceId ? "" : app.spaceId
  });
  return fs.existsSync(path.join(appDir, "app_settings", "settings.json"));
}

export function needsPull({
  remote,
  previous,
  force
}: {
  remote: IndexedApp;
  previous?: IndexedApp;
  force: boolean;
}): boolean {
  if (force) return true;
  if (!hasLocalAppDetail(remote)) return true;
  if (!previous?.lastPulledModifiedAt) return true;
  return previous.lastPulledModifiedAt !== remote.modifiedAt;
}

export function spaceKeyOf(app: IndexedApp): string {
  if (app.guestSpaceId) return `guest:${app.guestSpaceId}`;
  if (app.spaceId) return app.spaceId;
  return "";
}

export function spaceAppsFor(apps: IndexedApp[], target: IndexedSpace): KintoneApp[] {
  return apps
    .filter((app) =>
      target.type === "guestspace" ? app.guestSpaceId === target.guestSpaceId : app.spaceId === target.spaceId && !app.guestSpaceId
    )
    .map((app) => ({
      appId: app.appId,
      code: app.code,
      name: app.name,
      spaceId: app.spaceId,
      guestSpaceId: app.guestSpaceId
    }));
}
