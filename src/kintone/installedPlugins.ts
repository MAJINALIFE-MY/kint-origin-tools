import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { KintoneClient } from "./client.js";
import { PLUGIN_INSTALLED, PLUGINS_DIR, type InstalledPlugin } from "../pluginSources.js";
import { log } from "../log.js";
import { recordLocalAction } from "../runLog.js";

// 一覧 API は 1 回に最大 100 件。途中の不正な応答も全体の失敗として扱う。
export async function listInstalledPlugins(client: KintoneClient): Promise<{ plugins: InstalledPlugin[]; apiCalls: number }> {
  const plugins: InstalledPlugin[] = [];
  const ids = new Set<string>();
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const payload = await client.request("/plugins.json", { query: { limit, offset } });
    if (!Array.isArray(payload?.plugins) || payload.plugins.length > limit) {
      throw new Error("プラグイン一覧 API の応答に有効な plugins 配列がありません。");
    }
    for (const item of payload.plugins) {
      if (!item || typeof item.id !== "string" || !/^[a-z]{32}$/.test(item.id)
        || typeof item.name !== "string" || typeof item.description !== "string"
        || typeof item.isMarketPlugin !== "boolean" || typeof item.version !== "string" || ids.has(item.id)) {
        throw new Error("プラグイン一覧 API の応答に不正または重複したプラグインがあります。");
      }
      ids.add(item.id);
      // REST API の全レスポンス項目を保存する。現在の仕様では5項目。
      plugins.push({ ...item } as InstalledPlugin);
    }
    if (payload.plugins.length < limit) return { plugins, apiCalls: offset / limit + 1 };
  }
}

// 完全なページ取得後に呼び、同じディレクトリの一時ファイルから置き換える。
// 途中失敗や不正な既存パスでは、取得済み installed.json を残す。
export function writeInstalledPlugins(plugins: InstalledPlugin[]): void {
  const domainRoot = process.cwd();
  const pluginRoot = path.join(domainRoot, PLUGINS_DIR);
  const target = path.join(domainRoot, PLUGIN_INSTALLED);
  recordLocalAction("write-installed-plugins", target, { count: plugins.length });
  const rootStat = fs.lstatSync(pluginRoot, { throwIfNoEntry: false });
  if (rootStat && !rootStat.isDirectory()) throw new Error(`${PLUGINS_DIR}/ が通常のディレクトリではありません。`);
  if (!rootStat) fs.mkdirSync(pluginRoot, { recursive: true });

  const targetStat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (targetStat && !targetStat.isFile()) throw new Error(`${PLUGIN_INSTALLED} は通常ファイルではありません。`);

  const temporary = path.join(pluginRoot, `.installed-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ plugins }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export interface InstalledPluginsSummary {
  plugins: number;
  apiCalls: number;
  written: string[];
}

// プラグイン一覧だけを更新する。sources.json やアプリ索引には触れない。
export async function pullInstalledPlugins(): Promise<InstalledPluginsSummary> {
  const client = new KintoneClient();
  const { plugins, apiCalls } = await listInstalledPlugins(client);
  writeInstalledPlugins(plugins);
  log(`プラグイン: ${plugins.length} 件を ${PLUGIN_INSTALLED} に保存しました。`);
  return { plugins: plugins.length, apiCalls, written: [PLUGIN_INSTALLED] };
}
