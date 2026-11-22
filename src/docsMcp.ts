import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ENV_PATH, parseEnvFile } from "./env.js";
import { log } from "./log.js";

// kintone documentation MCP（公式のリモート版 https://mcp.cybozu.dev/mcp）は、このツールで AI エージェントを使う前提。
// 設定は AI ツール側にあり CLI からは一部しか見えないため、見えるファイルに無ければ警告だけ出す（実行は止めない）。
const DOCS_MCP_HOST = "mcp.cybozu.dev";
const DOCS_MCP_GUIDE_URL = "https://cybozu.dev/ja/kintone/ai/kintone-documentation-mcp-overview/";
const DOCS_MCP_WARNING_KEY = "KINT_ORIGIN_DOCS_MCP_WARNING";

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson(file: string): unknown {
  const text = readText(file);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// mcpServers のいずれかの定義が kintone documentation MCP を指すか（名前は問わない。url 直指定も mcp-remote 経由も拾う）。
function serversIncludeDocs(servers: unknown): boolean {
  if (!servers || typeof servers !== "object") return false;
  return Object.values(servers as Record<string, unknown>).some((server) => JSON.stringify(server ?? "").includes(DOCS_MCP_HOST));
}

function mcpJsonHasDocs(file: string): boolean {
  const json = readJson(file) as { mcpServers?: unknown } | undefined;
  return serversIncludeDocs(json?.mcpServers);
}

function tomlHasDocs(file: string): boolean {
  return (readText(file) ?? "").includes(DOCS_MCP_HOST);
}

function samePath(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// Claude Code のユーザー設定（~/.claude.json）。user スコープはトップの mcpServers、local スコープは projects[<フォルダ>].mcpServers。
function claudeUserConfigHasDocs(file: string, cwd: string): boolean {
  const json = readJson(file) as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> } | undefined;
  if (!json) return false;
  if (serversIncludeDocs(json.mcpServers)) return true;
  return Object.entries(json.projects ?? {}).some(([key, project]) => samePath(key, cwd) && serversIncludeDocs(project?.mcpServers));
}

// いずれかの設定ファイルに kintone documentation MCP があれば true。読めない・壊れたファイルは「無し」として扱う。
function hasDocsMcpConfig(): boolean {
  const cwd = process.cwd();
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const checks: Array<[string, (file: string) => boolean]> = [
    [path.join(cwd, ".mcp.json"), mcpJsonHasDocs],
    [path.join(cwd, ".cursor", "mcp.json"), mcpJsonHasDocs],
    [path.join(cwd, ".codex", "config.toml"), tomlHasDocs],
    [path.join(home, ".claude.json"), (file) => claudeUserConfigHasDocs(file, cwd)],
    [path.join(home, ".cursor", "mcp.json"), mcpJsonHasDocs],
    [path.join(codexHome, "config.toml"), tomlHasDocs]
  ];
  return checks.some(([file, has]) => has(file));
}

// .env の KINT_ORIGIN_DOCS_MCP_WARNING=false で警告を止める（コネクタ・ChatGPT のアプリなど CLI から見えない設定向け）。
// 操作制限と同じく .env だけを見る（プロセス環境変数は見ない）。
function docsMcpWarningDisabled(): boolean {
  const text = readText(ENV_PATH);
  if (text === null) return false;
  return (parseEnvFile(text)[DOCS_MCP_WARNING_KEY] ?? "").trim().toLowerCase() === "false";
}

export function warnIfDocsMcpMissing(): void {
  if (docsMcpWarningDisabled() || hasDocsMcpConfig()) return;
  log(
    `注意: kintone documentation MCP の設定が見つかりません。AI エージェントが kintone の公式仕様を参照できるよう、使っている AI ツールに追加してください（${DOCS_MCP_GUIDE_URL}）。` +
      `Claude のコネクタや ChatGPT のアプリで設定済みなど kint-origin から見えない場合は、.env に ${DOCS_MCP_WARNING_KEY}=false を書くとこの警告を出しません。`
  );
}
