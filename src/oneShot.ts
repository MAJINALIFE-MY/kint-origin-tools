import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ENV_PATH, parseEnvFile } from "./env.js";
import { assertRunLogWritable, recordLocalAction, recordRunEvent } from "./runLog.js";

export type OneShotKey = "KINT_ORIGIN_ALLOW_PULL_RECORDS_ALL_ONCE" | "KINT_ORIGIN_ALLOW_PULL_COMMENTS_ALL_ONCE";

function lineParts(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function replaceOneShotTrue(bytes: Buffer, key: OneShotKey): Buffer {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(".env が有効な UTF-8 ではないため、安全に1回限り設定を消費できません。");
  const lines = lineParts(text);
  const keyPattern = new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=`);
  const assignments: number[] = [];
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r?\n$/, "");
    if (keyPattern.test(line)) assignments.push(index);
  });
  if (assignments.length !== 1) throw new Error(`${key} は .env に1行だけ設定してください（現在 ${assignments.length} 行）。`);
  const index = assignments[0];
  const raw = lines[index];
  const lineEnding = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
  const line = lineEnding ? raw.slice(0, -lineEnding.length) : raw;
  const match = line.match(new RegExp(`^([\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=[\\t ]*)(.*?)([\\t ]*)$`));
  if (!match) throw new Error(`${key} の設定行を解析できません。`);
  const originalValue = match[2];
  const trimmed = originalValue.trim();
  const quote = (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")) ? trimmed[0] : "";
  const innerValue = quote ? trimmed.slice(1, -1) : trimmed;
  if (innerValue.toLowerCase() !== "true") throw new Error(`${key}=true が .env にありません。`);
  const leading = originalValue.match(/^[\t ]*/)?.[0] ?? "";
  const trailing = originalValue.match(/[\t ]*$/)?.[0] ?? "";
  const nextValue = `${leading}${quote ? `${quote}false${quote}` : "false"}${trailing}`;
  lines[index] = `${match[1]}${nextValue}${lineEnding}`;
  return Buffer.from(lines.join(""), "utf8");
}

function runPowerShell(script: string, envPath: string, tempPath: string): void {
  const executable = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  recordRunEvent("child_start", { childType: "powershell", command: executable, args });
  assertRunLogWritable();
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, KINT_ORIGIN_ENV_PATH: envPath, KINT_ORIGIN_TEMP_PATH: tempPath }
  });
  if (result.stdout) recordRunEvent("child_output", { childType: "powershell", stream: "stdout", text: result.stdout });
  if (result.stderr) recordRunEvent("child_output", { childType: "powershell", stream: "stderr", text: result.stderr });
  recordRunEvent("child_end", { childType: "powershell", command: executable, exitCode: result.status ?? 1, ...(result.error ? { text: result.error.message } : {}) });
  assertRunLogWritable();
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr ?? "").trim();
    throw new Error(`.env のアクセス制御または置換に失敗しました。${detail ? ` ${detail}` : ""}`);
  }
}

/**
 * 全件取得の one-shot 許可を、実行直前に原子的に false にする。
 * 元の .env スナップショットが変わっていた場合や、同じディレクトリのロックを取れない場合は fail-closed。
 */
export function consumeOneShotSetting(key: OneShotKey, originalSnapshot: Buffer): void {
  const directory = path.dirname(ENV_PATH);
  const lockPath = path.join(directory, ".env.kint-origin-all.lock");
  const tempPath = path.join(directory, `.env.kint-origin-all.${randomUUID()}.tmp`);
  let lockFd: number | undefined;
  let lockCreated = false;
  let tempFd: number | undefined;
  let tempCreated = false;
  try {
    recordLocalAction("consume-one-shot-policy", ENV_PATH, { key });
    try {
      lockFd = fs.openSync(lockPath, "wx", 0o600);
      lockCreated = true;
      fs.writeFileSync(lockFd, `${JSON.stringify({ pid: process.pid, key, startedAt: new Date().toISOString() })}\n`, "utf8");
      fs.fsyncSync(lockFd);
    } catch {
      throw new Error(`全件取得のロックを取得できません: ${lockPath}。別の実行が終了していることを確認してから stale lock を削除してください。`);
    }
    const stat = fs.lstatSync(ENV_PATH);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(".env が通常ファイルではないため、安全に1回限り設定を変更できません。");
    const current = fs.readFileSync(ENV_PATH);
    if (!current.equals(originalSnapshot)) throw new Error("確認中に .env が変更されました。実行を中断しました。内容を確認して再実行してください。");
    const next = replaceOneShotTrue(current, key);

    tempFd = fs.openSync(tempPath, "wx", 0o600);
    tempCreated = true;
    fs.closeSync(tempFd);
    tempFd = undefined;
    if (process.platform === "win32") {
      runPowerShell("Get-Acl -LiteralPath $env:KINT_ORIGIN_ENV_PATH | Set-Acl -LiteralPath $env:KINT_ORIGIN_TEMP_PATH", ENV_PATH, tempPath);
    } else {
      fs.chownSync(tempPath, stat.uid, stat.gid);
    }

    tempFd = fs.openSync(tempPath, "r+");
    fs.writeFileSync(tempFd, next);
    fs.ftruncateSync(tempFd, next.length);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;

    if (process.platform === "win32") {
      // Node の Windows rename は同一ボリュームで既存ファイルを置き換える。temp に先に ACL を複製済み。
      if (!fs.readFileSync(ENV_PATH).equals(originalSnapshot)) throw new Error("確認中に .env が変更されました。実行を中断し、編集内容を保ちました。");
      fs.renameSync(tempPath, ENV_PATH);
      tempCreated = false;
    } else {
      fs.chmodSync(tempPath, stat.mode & 0o7777);
      if (!fs.readFileSync(ENV_PATH).equals(originalSnapshot)) throw new Error("確認中に .env が変更されました。実行を中断し、編集内容を保ちました。");
      fs.renameSync(tempPath, ENV_PATH);
      tempCreated = false;
      const dirFd = fs.openSync(directory, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }

    const verified = fs.readFileSync(ENV_PATH);
    if (!verified.equals(next) || parseEnvFile(verified.toString("utf8"))[key] !== "false") {
      throw new Error(`${key} を false にしたことを確認できませんでした。データ API は実行していません。`);
    }
  } finally {
    if (tempFd !== undefined) fs.closeSync(tempFd);
    if (tempCreated && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    if (lockFd !== undefined) fs.closeSync(lockFd);
    if (lockCreated && fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  }
}

export function readOneShotSnapshot(): Buffer {
  return fs.readFileSync(ENV_PATH);
}
