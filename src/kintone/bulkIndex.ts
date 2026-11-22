import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensureDir, parseJsonText, writeJson } from "../fsutil.js";
import { KINTONE_DATA_ROOT } from "../paths.js";
import { getEnv } from "../env.js";

export interface BulkIndexEntry {
  appId: string;
  spaceId: string;
  guestSpaceId: string;
}

export interface BulkIndexSource {
  version: 1;
  origin: string;
  fetchedAt: string;
  appsSha256: string;
}

const APPS_FILE = path.join(KINTONE_DATA_ROOT, "index", "apps.json");
const SOURCE_FILE = path.join(KINTONE_DATA_ROOT, "index", ".bulk-source.json");

function canonicalId(value: unknown, label: string, allowEmpty = false): string {
  if (allowEmpty && value === "") return "";
  const text = String(value ?? "");
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`索引の ${label} が正の整数ではありません: ${JSON.stringify(value)}`);
  return text;
}

function readIndexEntries(): BulkIndexEntry[] {
  if (!fs.existsSync(APPS_FILE)) throw new Error(`アプリ索引がありません: ${path.relative(process.cwd(), APPS_FILE)}。先に kint-origin pull index または pull kintone を実行してください。`);
  let parsed: unknown;
  try {
    parsed = parseJsonText(fs.readFileSync(APPS_FILE, "utf8"), APPS_FILE);
  } catch (error) {
    throw new Error(`アプリ索引を検証できません: ${error instanceof Error ? error.message : String(error)}。pull index をやり直してください。`);
  }
  if (!Array.isArray(parsed)) throw new Error("アプリ索引 apps.json が配列ではありません。pull index をやり直してください。");
  const seen = new Set<string>();
  return parsed.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`アプリ索引 apps.json の ${index + 1} 件目がオブジェクトではありません。pull index をやり直してください。`);
    const value = raw as Record<string, unknown>;
    const appId = canonicalId(value.appId, `apps.json[${index}].appId`);
    if (seen.has(appId)) throw new Error(`アプリ索引にアプリ ID ${appId} が重複しています。pull index をやり直してください。`);
    seen.add(appId);
    const spaceId = canonicalId(value.spaceId ?? "", `apps.json[${index}].spaceId`, true);
    const guestSpaceId = canonicalId(value.guestSpaceId ?? "", `apps.json[${index}].guestSpaceId`, true);
    return { appId, spaceId, guestSpaceId };
  });
}

function fingerprintApps(apps: BulkIndexEntry[]): string {
  const tuples = apps
    .map(({ appId, spaceId, guestSpaceId }) => [appId, spaceId, guestSpaceId])
    .sort((a, b) => BigInt(a[0]) < BigInt(b[0]) ? -1 : BigInt(a[0]) > BigInt(b[0]) ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(tuples), "utf8").digest("hex");
}

export function recordCompleteAppIndex(): BulkIndexSource {
  const apps = readIndexEntries();
  const source: BulkIndexSource = {
    version: 1,
    origin: new URL(getEnv().baseUrl).host.toLowerCase(),
    fetchedAt: new Date().toISOString(),
    appsSha256: fingerprintApps(apps)
  };
  ensureDir(path.dirname(SOURCE_FILE));
  writeJson(SOURCE_FILE, source);
  return source;
}

export function readCompleteAppIndex(expectedOrigin: string): { source: BulkIndexSource; apps: BulkIndexEntry[] } {
  if (!fs.existsSync(SOURCE_FILE)) {
    throw new Error("全件取得に使える完全索引がありません。先に kint-origin pull index または pull kintone を実行してください。");
  }
  let source: unknown;
  try {
    source = parseJsonText(fs.readFileSync(SOURCE_FILE, "utf8"), SOURCE_FILE);
  } catch (error) {
    throw new Error(`完全索引の記録が壊れています: ${error instanceof Error ? error.message : String(error)}。pull index をやり直してください。`);
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("完全索引の記録が不正です。pull index をやり直してください。");
  const marker = source as Partial<BulkIndexSource>;
  if (marker.version !== 1 || typeof marker.origin !== "string" || typeof marker.fetchedAt !== "string" || Number.isNaN(Date.parse(marker.fetchedAt)) || !/^[a-f0-9]{64}$/.test(String(marker.appsSha256 ?? ""))) {
    throw new Error("完全索引の記録形式が不正です。pull index をやり直してください。");
  }
  if (marker.origin.toLowerCase() !== expectedOrigin.toLowerCase()) throw new Error(`完全索引は ${marker.origin} から取得されていますが、接続先は ${expectedOrigin} です。pull index を実行し直してください。`);
  const apps = readIndexEntries();
  const digest = fingerprintApps(apps);
  if (digest !== marker.appsSha256) throw new Error("アプリ索引が完全取得後に変更されています。安全のため全件取得を止めました。pull index を実行し直してください。");
  return { source: marker as BulkIndexSource, apps };
}
