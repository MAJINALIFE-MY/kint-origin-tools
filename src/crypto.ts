import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
import { Writable } from "node:stream";

import { log } from "./log.js";
import { recordRunEvent } from "./runLog.js";

export const ENCRYPTED_PREFIX = "enc:v1:";
const ANY_ENC_PREFIX = "enc:";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const SCRYPT_PARAMS: crypto.ScryptOptions = { N: 16384, r: 8, p: 1 };
const AAD = Buffer.from("kint-origin:cybozu-password:v1", "utf8");
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

let cachedIdentity: string | undefined;
let cachedResolved: { raw: string; identity: string; plain: string } | undefined;

// OS の識別子を読む。これは秘密鍵ではなく、別のマシンでの復号を防ぐための環境識別子。
function readOsMachineId(): string {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("reg.exe", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000
      });
      const match = result.status === 0 && !result.error
        ? /MachineGuid\s+REG_SZ\s+([^\r\n]+)/i.exec(result.stdout || "")
        : null;
      if (match?.[1]?.trim()) return match[1].trim();
    } else if (process.platform === "darwin") {
      const result = spawnSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
        timeout: 5000
      });
      const match = result.status === 0 && !result.error
        ? /"IOPlatformUUID"\s*=\s*"([^"]+)"/i.exec(result.stdout || "")
        : null;
      if (match?.[1]?.trim()) return match[1].trim();
    } else if (process.platform === "linux") {
      for (const filePath of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, "utf8").trim();
          if (content) return content;
        }
      }
    }
  } catch {
    // 識別子を取得できない環境では下のフォールバックを使う。
  }
  return "fallback-" + os.platform() + "-" + os.arch() + "-" + os.hostname();
}

function readOsUsername(): string {
  try {
    const name = os.userInfo().username;
    if (name) return name;
  } catch {
    // コンテナ等で uid に対応するユーザー情報が無い場合。
  }
  return process.env.USER || process.env.USERNAME || "unknown-user";
}

export function getMachineIdentity(): string {
  if (!cachedIdentity) {
    cachedIdentity = "kint-origin:machine-v1:" + process.platform + ":" + readOsMachineId() + ":" + readOsUsername();
  }
  return cachedIdentity;
}

// enc: で始まる値は暗号化形式として扱い、未対応のバージョンも平文扱いしない。
export function isEncryptedPassword(value: string): boolean {
  return value.startsWith(ANY_ENC_PREFIX);
}

function deriveKey(identity: string, salt: Buffer): Buffer {
  return crypto.scryptSync(identity, salt, KEY_BYTES, SCRYPT_PARAMS);
}

function decodeBase64Url(value: string): Buffer {
  if (!value || !BASE64URL_RE.test(value)) {
    throw new Error(
      "CYBOZU_PASSWORD の暗号化文字列が破損しています（形式が不正です）。「kint-origin secret」を実行して暗号化パスワードを再発行してください。"
    );
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error(
      "CYBOZU_PASSWORD の暗号化文字列が破損しています（形式が不正です）。「kint-origin secret」を実行して暗号化パスワードを再発行してください。"
    );
  }
  return decoded;
}

// 平文パスワードをマシン識別値から導出した鍵で AES-256-GCM 暗号化する。
export function encryptPassword(plainText: string, identityOverride?: string): string {
  if (!plainText) {
    throw new Error("パスワードが空です。1 文字以上のパスワードを指定してください。");
  }
  const identity = identityOverride ?? getMachineIdentity();
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(identity, salt);

  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ENCRYPTED_PREFIX + [
      salt.toString("base64url"),
      iv.toString("base64url"),
      tag.toString("base64url"),
      encrypted.toString("base64url")
    ].join(".");
  } finally {
    key.fill(0);
  }
}

export function decryptPassword(token: string, identityOverride?: string): string {
  if (!token.startsWith(ENCRYPTED_PREFIX)) {
    throw new Error(
      "CYBOZU_PASSWORD の暗号化形式が未対応または不正です（enc:v1: のみ対応）。「kint-origin secret」を実行して暗号化パスワードを再発行してください。"
    );
  }

  const parts = token.slice(ENCRYPTED_PREFIX.length).split(".");
  if (parts.length !== 4) {
    throw new Error(
      "CYBOZU_PASSWORD の暗号化文字列が破損しています（形式が不正です）。「kint-origin secret」を実行して暗号化パスワードを再発行してください。"
    );
  }

  const [saltPart, ivPart, tagPart, encryptedPart] = parts;
  const salt = decodeBase64Url(saltPart);
  const iv = decodeBase64Url(ivPart);
  const tag = decodeBase64Url(tagPart);
  const encrypted = decodeBase64Url(encryptedPart);

  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || tag.length !== TAG_BYTES || encrypted.length === 0) {
    throw new Error(
      "CYBOZU_PASSWORD の暗号化文字列が破損しています（長さが不正です）。「kint-origin secret」を実行して暗号化パスワードを再発行してください。"
    );
  }

  const identity = identityOverride ?? getMachineIdentity();
  const key = deriveKey(identity, salt);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    throw new Error(
      "CYBOZU_PASSWORD の復号に失敗しました。別のマシンまたは別ユーザーで発行された暗号化値か、値が改ざん・破損しています。「kint-origin secret」を実行してこの環境用の暗号化パスワードを再発行してください。"
    );
  } finally {
    key.fill(0);
  }
}

// CYBOZU_PASSWORD の値を解決する。暗号化値の復号結果はプロセス内でキャッシュする。
export function resolvePassword(raw: string, identityOverride?: string): string {
  if (!isEncryptedPassword(raw)) return raw;
  const identity = identityOverride ?? getMachineIdentity();
  if (cachedResolved && cachedResolved.raw === raw && cachedResolved.identity === identity) {
    return cachedResolved.plain;
  }
  const plain = decryptPassword(raw, identity);
  cachedResolved = { raw, identity, plain };
  return plain;
}

// 対話（TTY・エコーバックなし）または標準入力（パイプ）からパスワードを 1 行読み取る。
function promptPassword(
  promptText = "パスワードを入力してください（入力は画面に表示されません）:"
): Promise<string> {
  recordRunEvent("sensitive_input", { text: promptText, valueRecorded: false });
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
      process.stdin.on("error", reject);
      process.stdin.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.split(/\r?\n/, 1)[0] ?? "");
      });
    });
  }

  return new Promise((resolve, reject) => {
    let muted = false;
    const output = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) process.stderr.write(chunk, encoding);
        callback();
      }
    });
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
    let answered = false;
    rl.once("close", () => {
      if (!answered) {
        process.stderr.write("\n");
        resolve("");
      }
    });
    rl.once("SIGINT", () => {
      answered = true;
      process.stderr.write("\n");
      rl.close();
      reject(new Error("パスワードの入力が中断されました。"));
    });
    rl.question(promptText + " ", (answer) => {
      answered = true;
      process.stderr.write("\n");
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

export interface SecretResult {
  encrypted: string;
  envLine: string;
}

export async function runSecretCommand(): Promise<SecretResult> {
  const plain = await promptPassword();
  if (!plain) throw new Error("パスワードが空のため中断しました。");
  const encrypted = encryptPassword(plain);
  const envLine = "CYBOZU_PASSWORD=" + encrypted;
  log("暗号化値を stdout に出力します。.env の CYBOZU_PASSWORD に設定してください（このマシンの現在のログインユーザーでのみ復号できます）。");
  return { encrypted, envLine };
}
