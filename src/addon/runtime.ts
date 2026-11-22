import { spawn } from "node:child_process";
import path from "node:path";

import type { AddonContext } from "./types.js";
import { assertRunLogWritable, recordRunEvent } from "../runLog.js";

export function runAddon(entry: string, args: string[], context: AddonContext): Promise<number> {
  return new Promise((resolve, reject) => {
    // 外部 addon に親プロセスの API 認証情報や無関係な秘密情報が渡るのを防ぐ。
    const safeEnv: NodeJS.ProcessEnv = {};
    const inherited = process.platform === "win32"
      ? ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "PATHEXT"]
      : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
    for (const name of inherited) {
      if (process.env[name] !== undefined) safeEnv[name] = process.env[name];
    }
    const childEnv: NodeJS.ProcessEnv = {
      ...safeEnv,
      KINT_ORIGIN_DOMAIN_ROOT: context.domainRoot,
      KINT_ORIGIN_ADDON_ROOT: context.addonDirectory,
      KINT_ORIGIN_ADDON_STATE_DIR: context.stateDirectory,
      KINT_ORIGIN_CLI_PATH: context.cliPath
    };
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: context.domainRoot,
      shell: false,
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
      env: childEnv
    });
    recordRunEvent("child_start", { childType: "addon", name: path.basename(path.dirname(entry)), command: path.basename(entry), args, pid: child.pid });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!process.stdout.write(chunk)) {
        child.stdout?.pause();
        process.stdout.once("drain", () => child.stdout?.resume());
      }
      recordRunEvent("child_output", { stream: "stdout", text: chunk.toString("utf8") });
      try { assertRunLogWritable(); } catch { child.kill(); }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!process.stderr.write(chunk)) {
        child.stderr?.pause();
        process.stderr.once("drain", () => child.stderr?.resume());
      }
      recordRunEvent("child_output", { stream: "stderr", text: chunk.toString("utf8") });
      try { assertRunLogWritable(); } catch { child.kill(); }
    });
    let interrupted: NodeJS.Signals | undefined;
    const forwardInterrupt = (signal: NodeJS.Signals) => {
      interrupted = signal;
      child.kill(signal);
    };
    const onSigint = () => forwardInterrupt("SIGINT");
    const onSigterm = () => forwardInterrupt("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    const cleanup = () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
    child.once("error", (error) => {
      cleanup();
      recordRunEvent("child_end", { childType: "addon", pid: child.pid, exitCode: 1, text: error.message });
      reject(new Error(`ADDON_COMMAND_FAILED: could not start addon command: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      cleanup();
      const exitCode = interrupted === "SIGINT" || signal === "SIGINT" ? 130 : interrupted === "SIGTERM" || signal === "SIGTERM" ? 143 : code ?? 1;
      recordRunEvent("child_end", { childType: "addon", pid: child.pid, exitCode, signal: signal ?? "" });
      if (interrupted === "SIGINT" || signal === "SIGINT") resolve(130);
      else if (interrupted === "SIGTERM" || signal === "SIGTERM") resolve(143);
      else resolve(code ?? 1);
    });
  });
}
