// 取得物（data/）が、今の接続先（.env の CYBOZU_BASE_URL）のものかを判定する。
// 別のドメインの .env を使ったまま実行すると、別ドメインのアプリを「環境に無い」と誤認して deleted/ へ移したり、
// 別ドメインのアプリへ push してしまう。取得時に app.json へ書いた domain（host）と比べて防ぐ。

import fs from "node:fs";
import path from "node:path";

import { getEnv } from "../env.js";
import { parseJsonText } from "../fsutil.js";

// 今の接続先（host。ポート番号を含む）。
function currentHost(): string {
  return new URL(getEnv().baseUrl).host;
}

function currentUsername(): string {
  return getEnv().username;
}

export function describeConnection(): string {
  return `${currentHost()}（ユーザー: ${currentUsername()}）`;
}

// アプリのフォルダの app.json またはスペースのフォルダの space.json に書かれた取得元の host。無い・読めない場合は undefined（判定できない）。
export function recordedHost(dir: string): string | undefined {
  const appFile = path.join(dir, "app.json");
  const spaceFile = path.join(dir, "space.json");
  const file = fs.existsSync(appFile) ? appFile : fs.existsSync(spaceFile) ? spaceFile : "";
  if (!file) return undefined;
  try {
    const value = parseJsonText(fs.readFileSync(file, "utf8"), file) as { domain?: unknown } | null;
    return typeof value?.domain === "string" && value.domain ? value.domain : undefined;
  } catch {
    return undefined;
  }
}

// 取得元が今の接続先と違うか。取得元が分からない（pull index が書いた索引項目だけの app.json・取得失敗のスタブ）ときは false（判定できないので止めない）。
export function isOtherTenant(appDir: string, host = currentHost()): boolean {
  const recorded = recordedHost(appDir);
  return recorded !== undefined && recorded.toLowerCase() !== host.toLowerCase();
}

export function otherTenantMessage(appDir: string): string {
  return (
    `このアプリの取得元（${recordedHost(appDir)}）と、今の接続先（${currentHost()}）が違います。` +
    "別のドメインの .env で実行していないか確認してください（シェルの環境変数 CYBOZU_BASE_URL が .env より優先されることがあります）。"
  );
}
