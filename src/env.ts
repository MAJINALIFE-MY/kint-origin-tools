import fs from "node:fs";
import path from "node:path";

import { resolvePassword } from "./crypto.js";
import { log } from "./log.js";
import { registerSensitiveValue } from "./runLog.js";

// .env は「コマンドを実行したディレクトリ(cwd)」= 対象ドメインのフォルダから読む。
export const ENV_PATH = path.resolve(process.cwd(), ".env");

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^export\s+/, "");
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// addon機構の設定だけを取得する。.env の認証値を process.env に取り込まない。
export function getAddonDirectory(targetRoot = process.cwd()): string | undefined {
  const fromProcess = process.env.KINT_ORIGIN_ADDON_DIR;
  if (fromProcess != null && fromProcess.trim() !== "") return fromProcess.trim();
  const envPath = path.resolve(targetRoot, ".env");
  if (!fs.existsSync(envPath)) return undefined;
  const parsed = parseEnvFile(fs.readFileSync(envPath, "utf8"));
  const value = parsed.KINT_ORIGIN_ADDON_DIR;
  return value && value.trim() ? value.trim() : undefined;
}

// process.env へ取り込むキー。.env にあっても、これ以外（NODE_OPTIONS・NODE_TLS_REJECT_UNAUTHORIZED・PATH など）は
// 取り込まない。取り込むと cli-kintone の子プロセスや tool 自身の実行に影響してしまうため。
// cli-kintone の KINTONE_* は .env から取り込まず、cliKintoneEnv が CYBOZU_* から毎回作る。
const LOADABLE_ENV_KEY = /^(CYBOZU_|KINT_ORIGIN_)[A-Z0-9_]*$/;

export function isLoadableEnvKey(key: string): boolean {
  return LOADABLE_ENV_KEY.test(key);
}

const CONNECTION_ENV_KEYS = ["CYBOZU_BASE_URL", "CYBOZU_USERNAME"];

// 環境変数が設定済みで、.env の値と食い違っている接続先のキー。シェルに残った別ドメインの値が、
// このフォルダの .env より優先されると、意図しないドメインへ接続してしまう。
export function conflictingConnectionKeys(): string[] {
  if (!fs.existsSync(ENV_PATH)) return [];
  const parsed = parseEnvFile(fs.readFileSync(ENV_PATH, "utf8"));
  return CONNECTION_ENV_KEYS.filter((key) => {
    const fromEnv = process.env[key];
    const fromFile = parsed[key];
    return Boolean(fromEnv) && Boolean(fromFile) && fromEnv !== fromFile;
  });
}

export function loadEnv(): void {
  if (!fs.existsSync(ENV_PATH)) return;
  const parsed = parseEnvFile(fs.readFileSync(ENV_PATH, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (!isLoadableEnvKey(key)) continue;
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value) return value;
  throw new Error(`Missing required environment variable: ${name}`);
}

export interface CybozuEnv {
  baseUrl: string;
  username: string;
  password: string;
  language: string;
  /** API 実行ごとの最小間隔（ミリ秒）。0 は間隔なし（既定）。CYBOZU_API_INTERVAL_MS で設定。 */
  apiIntervalMs: number;
}

// getEnv() は複数箇所から呼ばれるため、不正値の警告は初回のみ出す。
let warnedInvalidApiInterval = false;

export function parseApiIntervalMs(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return 0;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (!warnedInvalidApiInterval) {
    warnedInvalidApiInterval = true;
    log(`CYBOZU_API_INTERVAL_MS の値「${raw}」はミリ秒として不正です（0 以上の数値のみ）。間隔なし（0）で実行します。`);
  }
  return 0;
}

// 接続先は https のみ。http で認証情報（ユーザー名・パスワード）を送らないため。
// 例外はループバック（127.0.0.1・localhost・::1）で、テスト用のモックサーバーを使えるようにする。
export function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`CYBOZU_BASE_URL「${value}」を URL として解釈できません。https://<サブドメイン>.cybozu.com の形式で指定してください。`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      `CYBOZU_BASE_URL は https:// で始まる URL にしてください（${url.protocol}// では認証情報を平文で送ってしまうため）。`
    );
  }
  if (url.username || url.password) {
    throw new Error("CYBOZU_BASE_URL にユーザー名・パスワードを含めないでください（CYBOZU_USERNAME / CYBOZU_PASSWORD に書きます）。");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("CYBOZU_BASE_URL にパス・クエリ・フラグメントは指定できません。https://<サブドメイン>.cybozu.com の形式で指定してください。");
  }
  return url.origin;
}

export function getEnv(): CybozuEnv {
  loadEnv();
  const baseUrl = validateBaseUrl(requiredEnv("CYBOZU_BASE_URL"));
  const username = requiredEnv("CYBOZU_USERNAME");
  const rawPassword = requiredEnv("CYBOZU_PASSWORD");
  const password = resolvePassword(rawPassword);
  registerSensitiveValue(rawPassword);
  registerSensitiveValue(password);
  registerSensitiveValue(Buffer.from(`${username}:${password}`, "utf8").toString("base64"));
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|PRIVATE_KEY|AUTHORIZATION|COOKIE)/i.test(key)) registerSensitiveValue(value);
  }
  return {
    baseUrl,
    username,
    password,
    language: process.env.CYBOZU_LANGUAGE || "ja",
    apiIntervalMs: parseApiIntervalMs(process.env.CYBOZU_API_INTERVAL_MS)
  };
}
