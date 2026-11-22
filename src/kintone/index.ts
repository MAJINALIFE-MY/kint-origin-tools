import fs from "node:fs";
import path from "node:path";

import { ensureDir, writeJson } from "../fsutil.js";
import { log } from "../log.js";
import { PLUGIN_INSTALLED } from "../pluginSources.js";
import { planPluginTemplate } from "../pluginTemplate.js";
import { KintoneClient } from "./client.js";
import { listInstalledPlugins, writeInstalledPlugins } from "./installedPlugins.js";
import {
  buildSpaces,
  listAllAppsForIndex,
  mergeRemoteAppsIntoIndex,
  spaceAppsFor,
  type IndexedSpace
} from "./appIndex.js";
import { kintoneAppRootPath, kintoneSpaceRootPath } from "../paths.js";
import { ensureSpaceThreadsDirectory } from "./serializers.js";
import { recordCompleteAppIndex } from "./bulkIndex.js";

export interface IndexSummary {
  apps: number;
  spaces: number;
  guestSpaces: number;
  domainApps: number;
  apiCalls: number;
  bulkSource: { version: 1; origin: string; fetchedAt: string; appsSha256: string };
  written: string[];
  skipped: string[];
}

function writeJsonIfAbsent(filePath: string, value: unknown, displayPath: string, summary: Pick<IndexSummary, "written" | "skipped">): void {
  if (fs.existsSync(filePath)) {
    summary.skipped.push(displayPath);
    return;
  }
  writeJson(filePath, value);
  summary.written.push(displayPath);
}

function countSpaces(spaces: IndexedSpace[], type: IndexedSpace["type"]): number {
  return spaces.filter((space) => space.type === type).length;
}

export async function pullIndex(): Promise<IndexSummary> {
  const client = new KintoneClient();
  log("アプリ索引とインストール済みプラグインの一覧を取得します。詳細 API とスペース詳細 API は実行しません。");
  const { apps: rawApps, apiCalls: appApiCalls } = await listAllAppsForIndex(client);
  const { plugins, apiCalls: pluginApiCalls } = await listInstalledPlugins(client);
  const apiCalls = appApiCalls + pluginApiCalls;
  const apps = mergeRemoteAppsIntoIndex(rawApps, { replaceAll: true });
  const bulkSource = recordCompleteAppIndex();
  const spaces = buildSpaces(apps);
  const domainApps = apps.filter((app) => !app.spaceId && !app.guestSpaceId);

  const pluginFiles = planPluginTemplate(process.cwd()).apply();
  writeInstalledPlugins(plugins);
  log(`プラグイン: ${plugins.length} 件を ${PLUGIN_INSTALLED} に保存しました。`);
  const written: string[] = ["data/kintone/index/apps.json", "data/kintone/index/spaces.json", "data/kintone/index/.bulk-source.json", ...pluginFiles, PLUGIN_INSTALLED];
  const skipped: string[] = [];

  for (const app of domainApps) {
    const appDir = kintoneAppRootPath({ appId: app.appId });
    ensureDir(appDir);
    writeJsonIfAbsent(path.join(appDir, "app.json"), app, `data/kintone/apps/app-${app.appId}/app.json`, { written, skipped });
  }

  for (const space of spaces) {
    const spaceDir = kintoneSpaceRootPath({ guestSpaceId: space.guestSpaceId, spaceId: space.spaceId });
    ensureDir(path.join(spaceDir, "apps"));
    if (ensureSpaceThreadsDirectory(spaceDir)) written.push(`data/kintone/spaces/${space.type}-${space.id}/threads/.gitkeep`);
    writeJsonIfAbsent(path.join(spaceDir, "apps.json"), spaceAppsFor(apps, space), `data/kintone/spaces/${space.type}-${space.id}/apps.json`, {
      written,
      skipped
    });
  }

  log(`索引作成: apps=${apps.length}, spaces=${countSpaces(spaces, "space")}, guestSpaces=${countSpaces(spaces, "guestspace")}, API=${apiCalls}`);

  return {
    apps: apps.length,
    spaces: countSpaces(spaces, "space"),
    guestSpaces: countSpaces(spaces, "guestspace"),
    domainApps: domainApps.length,
    apiCalls,
    bulkSource,
    written,
    skipped
  };
}
