import { spawnSync } from "node:child_process";
import { recordRunEvent } from "./runLog.js";

export function runGit(root: string, args: string[], { logOutput = true }: { logOutput?: boolean } = {}) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  recordRunEvent("child_start", { childType: "git", command: "git", args, cwd: root });
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, env });
  if (logOutput && result.stdout) recordRunEvent("child_output", { childType: "git", stream: "stdout", text: result.stdout });
  if (result.stderr) recordRunEvent("child_output", { childType: "git", stream: "stderr", text: result.stderr });
  recordRunEvent("child_end", {
    childType: "git",
    command: "git",
    cwd: root,
    exitCode: result.status ?? 1,
    signal: result.signal ?? "",
    ...(result.error ? { text: result.error.message } : {})
  });
  return result;
}
