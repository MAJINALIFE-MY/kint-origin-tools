import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getEnv } from "../env.js";
import { assertCliKintoneAllowed } from "../policy.js";
import { assertRunLogWritable, currentRunLog, recordLocalAction, recordRunEvent, runLogUnavailable } from "../runLog.js";

// @kintone/cli はこのツールに同梱された node_modules から解決する（cwd ではない）。
// これにより、別フォルダのドメイン dir から（グローバル link でも）cli-kintone を見つけられる。
// dist/kintone/cliKintone.js -> ../../ = パッケージ root
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUN_LOG_PRELOAD = path.join(PACKAGE_ROOT, "dist", "runLogChild.js");

function startLoggedCliKintone(nodeArgs: string[], cwd: string, env: NodeJS.ProcessEnv) {
  assertRunLogWritable();
  const child = spawn(process.execPath, ["--import", pathToFileURL(RUN_LOG_PRELOAD).href, ...nodeArgs], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    serialization: "advanced"
  });
  recordRunEvent("child_start", { childType: "cli-kintone", pid: child.pid, command: nodeArgs.slice(1).join(" ") });
  child.once("close", (code, signal) => {
    recordRunEvent("child_end", { childType: "cli-kintone", pid: child.pid, exitCode: code ?? 1, signal: signal ?? "" });
  });
  return child;
}

function logChildMessage(child: ReturnType<typeof startLoggedCliKintone>, message: unknown): void {
  const value = message as { type?: string; id?: string; event?: Record<string, unknown> };
  if (value?.type !== "kintOriginLogEvent" || !value.id || !value.event) return;
  recordRunEvent(String(value.event.type ?? "child_event"), value.event);
  try {
    child.send({ type: "kintOriginLogAck", id: value.id, ok: !runLogUnavailable() });
  } catch {
    // 子プロセス側のACKタイムアウトで、次の変更リクエストを停止する。
  }
}

function logChildOutput(kind: "stdout" | "stderr", chunk: Buffer): void {
  if (!currentRunLog()) return;
  recordRunEvent("child_output", { stream: kind, text: chunk.toString("utf8") });
}

// UTF-8 BOM。Excel が UTF-8 CSV を文字化けせず開けるよう先頭に付与する。
export const UTF8_BOM = "﻿";

function cliKintoneArgs(args: string[]): string[] {
  // 操作制限: 許可リスト外の cli-kintone 操作、グラントの無い record export は起動前に遮断する。
  assertCliKintoneAllowed(args);
  const localCliPath = path.join(PACKAGE_ROOT, "node_modules", "@kintone", "cli", "cli.js");
  if (!fs.existsSync(localCliPath)) {
    throw new Error(`cli-kintone が見つかりません: ${localCliPath}。kint-origin-tools で "npm install" を実行してください。`);
  }
  return [localCliPath, ...args];
}

function cliKintoneEnv(guestSpaceId = ""): NodeJS.ProcessEnv {
  const env = getEnv();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    KINTONE_BASE_URL: env.baseUrl,
    KINTONE_USERNAME: env.username,
    KINTONE_PASSWORD: env.password
  };
  // cli-kintone prefers an API token when present. Do not inherit a token or Basic Auth credentials
  // from the agent shell; this process must use the connection selected by this folder's .env.
  delete childEnv.KINTONE_API_TOKEN;
  delete childEnv.KINTONE_BASIC_AUTH_USERNAME;
  delete childEnv.KINTONE_BASIC_AUTH_PASSWORD;
  delete childEnv.KINTONE_GUEST_SPACE_ID;
  if (guestSpaceId) childEnv.KINTONE_GUEST_SPACE_ID = String(guestSpaceId);
  return childEnv;
}

export function runCliKintone(
  args: string[],
  { cwd, guestSpaceId = "" }: { cwd: string; guestSpaceId?: string }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let nodeArgs: string[];
    try {
      assertRunLogWritable();
      nodeArgs = cliKintoneArgs(args);
    } catch (error) {
      reject(error);
      return;
    }
    const child = startLoggedCliKintone(nodeArgs, cwd, cliKintoneEnv(guestSpaceId));
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      logChildOutput("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      logChildOutput("stderr", chunk);
    });
    child.on("message", (message) => logChildMessage(child, message));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      try {
        assertRunLogWritable();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
        return;
      }
      reject(
        new Error(
          [`cli-kintone ${args.join(" ")} が終了コード ${code} で失敗しました。`, err || out || "cli-kintone からの出力はありません。"].join("\n")
        )
      );
    });
  });
}

// cli-kintone の stdout(CSV) を、メモリに溜めずにファイルへ書き出す版。
// 先頭に UTF-8 BOM を書き込んでから子プロセスの stdout を pipe する（大量レコードでも安全）。
// 書き込み先は outFile の隣の一時ファイルで、成功したときだけ outFile へ置き換える。
// 失敗（cli-kintone の異常終了・ネットワーク断・ディスク不足）で、前回取得した正常な CSV を途中で切れたファイルに置き換えない。
export function runCliKintoneCsvToFile(
  args: string[],
  { cwd, guestSpaceId = "", outFile }: { cwd: string; guestSpaceId?: string; outFile: string }
): Promise<{ bytes: number }> {
  let nodeArgs: string[];
  try {
    recordLocalAction("stage-cli-kintone-csv", outFile, { label: args.join(" ") });
    nodeArgs = cliKintoneArgs(args);
  } catch (error) {
    return Promise.reject(error);
  }
  return streamCsvToFile(nodeArgs, { cwd, env: cliKintoneEnv(guestSpaceId), outFile, label: args.join(" "), apiLogPreload: RUN_LOG_PRELOAD });
}

// node の引数（スクリプトのパス + 引数）を実行し、stdout を BOM 付きで outFile へ置き換え書き込みする（テストからも直接呼ぶ）。
export function streamCsvToFile(
  nodeArgs: string[],
  { cwd, env, outFile, label, apiLogPreload }: { cwd: string; env: NodeJS.ProcessEnv; outFile: string; label: string; apiLogPreload?: string }
): Promise<{ bytes: number }> {
  return new Promise((resolve, reject) => {
    const partFile = `${outFile}.${process.pid}.part`;
    const out = fs.createWriteStream(partFile, { encoding: "utf8" });
    out.write(UTF8_BOM);
    let bytes = Buffer.byteLength(UTF8_BOM);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      out.destroy();
      fs.rmSync(partFile, { force: true });
      reject(error);
    };

    const child = apiLogPreload
      ? startLoggedCliKintone(nodeArgs, cwd, env)
      : spawn(process.execPath, nodeArgs, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (!childStdout || !childStderr) {
      child.kill();
      fail(new Error("cli-kintone の標準出力を捕捉できません。"));
      return;
    }
    const stderr: Buffer[] = [];
    childStderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      logChildOutput("stderr", chunk);
    });
    childStdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    if (apiLogPreload) child.on("message", (message) => logChildMessage(child as ReturnType<typeof startLoggedCliKintone>, message));
    childStdout.pipe(out, { end: false });
    child.on("error", (error) => {
      // 子プロセスが残っているときは止める（書き込み先を失うため）。
      child.kill();
      fail(error);
    });
    out.on("error", (error) => {
      child.kill();
      fail(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        fail(
          new Error(
            [`cli-kintone ${label} が終了コード ${code} で失敗しました。`, err || "cli-kintone からの出力はありません。"].join("\n")
          )
        );
        return;
      }
      try {
        assertRunLogWritable();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      try {
        recordLocalAction("commit-cli-kintone-csv", outFile, { bytes });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      out.end(() => {
        if (settled) return;
        try {
          fs.renameSync(partFile, outFile);
        } catch (renameError) {
          fail(renameError instanceof Error ? renameError : new Error(String(renameError)));
          return;
        }
        settled = true;
        resolve({ bytes });
      });
    });
  });
}
