// init / update を、ツール本体のリポジトリで実行しないための判定。
// 本体のルートで実行すると、本体自身の README.md・AGENTS.md・CLAUDE.md・.claude/settings.json などを、
// ドメイン用の配布物で上書きしてしまう（ドメインの設定生成は、隔離した別のフォルダで行う）。

import fs from "node:fs";
import path from "node:path";

import { parseJsonText } from "./fsutil.js";

// ツール本体（kint-origin-tools）のソースツリーか。package.json の name と、ソース・配布テンプレートの存在で判定する。
export function isToolRepository(dir: string): boolean {
  const packageJson = path.join(dir, "package.json");
  if (fs.existsSync(packageJson)) {
    try {
      const pkg = parseJsonText(fs.readFileSync(packageJson, "utf8"), packageJson) as { name?: unknown } | null;
      if (pkg?.name === "kint-origin-tools") return true;
    } catch {
      // 読めない package.json は判定材料にしない（下の構成による判定に任せる）。
    }
  }
  // package.json が無い・別名でも、本体のソースと配布テンプレートが揃っているフォルダは本体とみなす。
  return fs.existsSync(path.join(dir, "src", "cli.ts")) && fs.existsSync(path.join(dir, "template", "agents", "common"));
}

export function assertNotToolRepository(dir: string, command: "init" | "update"): void {
  if (!isToolRepository(dir)) return;
  throw new Error(
    `${command} はツール本体（kint-origin-tools）のフォルダでは実行できません: ${dir}\n` +
      "本体の README.md・AGENTS.md・CLAUDE.md・.claude/settings.json などを、ドメイン用の配布物で上書きしてしまうためです。\n" +
      "ドメイン用のフォルダ（取得データと .env を置く別のフォルダ）に移動して実行してください。"
  );
}
