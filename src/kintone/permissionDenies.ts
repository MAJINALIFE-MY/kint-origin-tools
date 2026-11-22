import fs from "node:fs";
import path from "node:path";
import { getEnv } from "../env.js";
import { readJsonIfExists, writeJson } from "../fsutil.js";
import { KINTONE_DATA_ROOT } from "../paths.js";
import { sortAdminKeys } from "./exportItems.js";
import { recordLocalAction } from "../runLog.js";

interface PermissionDenyAccount {
  baseUrlHost: string;
  username: string;
}

interface PermissionDenyEntry {
  appId: string;
  guestSpaceId: string;
  denied: string[];
}

export interface PermissionSkip {
  appId: string;
  denied: string[];
}

export function permissionDeniesPath(): string {
  return path.join(KINTONE_DATA_ROOT, "index", "permission-denies.json");
}

// 照合用のアカウント。パスワード・API トークン・セッションは保存しない。
function currentAccount(): PermissionDenyAccount {
  const env = getEnv();
  return { baseUrlHost: new URL(env.baseUrl).host, username: env.username };
}

// 現在のアカウントのリストなら appId → 条目を返す。別アカウント・形式違いは null（そのリストは使わない）。
// 管理系以外のキー（手で足した fields 等）は捨て、閲覧系をスキップしないようにする。
function ownEntries(raw: unknown, account: PermissionDenyAccount): Map<string, PermissionDenyEntry> | null {
  if (!raw || typeof raw !== "object") return null;
  const file = raw as { account?: Partial<PermissionDenyAccount>; apps?: unknown };
  if (file.account?.baseUrlHost !== account.baseUrlHost || file.account?.username !== account.username) return null;
  const entries = new Map<string, PermissionDenyEntry>();
  for (const item of Array.isArray(file.apps) ? file.apps : []) {
    const appId = String(item?.appId ?? "");
    const denied = sortAdminKeys(Array.isArray(item?.denied) ? item.denied.map(String) : []);
    if (appId && denied.length) entries.set(appId, { appId, guestSpaceId: String(item?.guestSpaceId ?? ""), denied });
  }
  return entries;
}

function compareAppId(a: PermissionDenyEntry, b: PermissionDenyEntry): number {
  return Number(a.appId) - Number(b.appId) || a.appId.localeCompare(b.appId, "en");
}

// 次回の pull でスキップするキー。別アカウントのリスト・ファイル無しは空。
export function readDeniedKeys(appId: string | number): Set<string> {
  const entries = ownEntries(readJsonIfExists(permissionDeniesPath()), currentAccount());
  return new Set(entries?.get(String(appId))?.denied ?? []);
}

// 1 アプリ分の判定結果で書き換える。denied が空なら条目を消し、0 件ならファイルを消す。
// 別アカウントのリストは、今回記録するものが無ければ触らず、あれば現在のアカウント用に作り直す。
export function recordDeniedKeys({
  appId,
  guestSpaceId = "",
  denied
}: {
  appId: string | number;
  guestSpaceId?: string;
  denied: Iterable<string>;
}): void {
  const filePath = permissionDeniesPath();
  const account = currentAccount();
  const raw = readJsonIfExists(filePath);
  const own = ownEntries(raw, account);
  const keys = sortAdminKeys(denied);
  if (!own && raw !== undefined && keys.length === 0) return;
  const entries = own ?? new Map<string, PermissionDenyEntry>();
  const id = String(appId);
  if (keys.length) entries.set(id, { appId: id, guestSpaceId: String(guestSpaceId || ""), denied: keys });
  else entries.delete(id);
  if (entries.size === 0) {
    recordLocalAction("remove-permission-denies", filePath);
    fs.rmSync(filePath, { force: true });
    return;
  }
  writeJson(filePath, { account, apps: [...entries.values()].sort(compareAppId) });
}
