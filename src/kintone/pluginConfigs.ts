import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeJson } from "../fsutil.js";
import { normalizeDynamicValues } from "../normalize.js";
import { recordLocalAction } from "../runLog.js";
import type { KintoneClient } from "./client.js";

export interface PluginConfigSummary {
  count: number;
  files: string[];
}

interface PluginEntry {
  id?: unknown;
}

function pluginIds(payload: unknown): string[] {
  const error = (payload as { _error?: unknown })?._error;
  if (error) throw new Error(`追加済みプラグイン一覧を取得できないため、プラグイン設定を取得できません: ${String(error)}`);
  const raw = (payload as { plugins?: unknown })?.plugins;
  const plugins = Array.isArray(raw) ? (raw as PluginEntry[]) : [];
  const ids = plugins.map((plugin) => String(plugin?.id || "")).filter(Boolean);
  for (const id of ids) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`不正なプラグイン ID です: ${id}`);
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b, ["ja", "en"]));
}

// API ラボの運用環境 API から、追加済みプラグインの設定を ID 別に保存する。
export async function exportPluginConfigs({
  client,
  appId,
  appDir,
  pluginsPayload,
  guestSpaceId = ""
}: {
  client: Pick<KintoneClient, "getPluginConfig">;
  appId: string | number;
  appDir: string;
  pluginsPayload: unknown;
  guestSpaceId?: string;
}): Promise<PluginConfigSummary> {
  const outDir = path.join(appDir, "customize", "plugin-configs");
  ensureDir(outDir);

  const ids = pluginIds(pluginsPayload);
  const expected = new Set(ids.map((id) => `${id}.json`));
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json") && !expected.has(entry.name)) {
      const stalePath = path.join(outDir, entry.name);
      recordLocalAction("remove-stale-plugin-config", stalePath);
      fs.rmSync(stalePath);
    }
  }

  const files: string[] = [];
  for (const id of ids) {
    const file = path.join(outDir, `${id}.json`);
    try {
      const payload = await client.getPluginConfig(appId, id, { guestSpaceId });
      writeJson(file, normalizeDynamicValues(payload));
    } catch (error) {
      writeJson(file, { _error: error instanceof Error ? error.message : String(error) });
    }
    files.push(file);
  }
  return { count: ids.length, files };
}
