import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ドメインの .gitignore の雛形と、kint-origin が保守する管理ブロック（init / update で共有）。
const TEMPLATE_GITIGNORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "template", "gitignore");

const PULL_IGNORE_BEGIN = "# BEGIN kint-origin pull safety";
const PULL_IGNORE_END = "# END kint-origin pull safety";
const MANAGED_BEGIN_PREFIX = "# BEGIN kint-origin ";
const MANAGED_END_PREFIX = "# END kint-origin ";
const INIT_APPEND_HEADER = "# kint-origin init: 雛形の除外のうち、既存の .gitignore に無かったもの";

export function readTemplateGitignore(): string {
  return fs.readFileSync(TEMPLATE_GITIGNORE, "utf8");
}

export function managedPullIgnoreBlock(template: string): string {
  const start = template.indexOf(PULL_IGNORE_BEGIN);
  const end = template.indexOf(PULL_IGNORE_END, start);
  if (start < 0 || end < start) throw new Error("template/gitignore に pull safety の管理ブロックがありません。");
  const lineStart = template.lastIndexOf("\n", start - 1) + 1;
  const lineBreak = template.indexOf("\n", end + PULL_IGNORE_END.length);
  const lineEnd = lineBreak < 0 ? template.length : lineBreak;
  return template.slice(lineStart, lineEnd).replace(/\r$/, "");
}

export function mergePullIgnoreBlock(existing: string, block: string): string {
  const beginCount = existing.split(PULL_IGNORE_BEGIN).length - 1;
  const endCount = existing.split(PULL_IGNORE_END).length - 1;
  const lineEnding = existing.includes("\r\n") ? "\r\n" : "\n";
  const replacement = block.replaceAll("\n", lineEnding);
  if (beginCount === 0 && endCount === 0) {
    const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}${lineEnding}`;
    const spacer = prefix.length > 0 && !prefix.endsWith(`${lineEnding}${lineEnding}`) ? lineEnding : "";
    return `${prefix}${spacer}${replacement}${lineEnding}`;
  }
  if (beginCount !== 1 || endCount !== 1) throw new Error(".gitignore の kint-origin pull safety 管理ブロックが不正です。手動で確認してください。");
  const start = existing.indexOf(PULL_IGNORE_BEGIN);
  const end = existing.indexOf(PULL_IGNORE_END, start);
  if (start < 0 || end < start) throw new Error(".gitignore の kint-origin pull safety 管理ブロックの順序が不正です。");
  const lineStart = existing.lastIndexOf("\n", start - 1) + 1;
  const lineBreak = existing.indexOf("\n", end + PULL_IGNORE_END.length);
  const lineEnd = lineBreak < 0 ? existing.length : lineBreak;
  if (existing.slice(lineStart, start).length !== 0 || existing.slice(end + PULL_IGNORE_END.length, lineEnd).replace(/\r$/, "").length !== 0) {
    throw new Error(".gitignore の kint-origin pull safety 管理ブロックが行の途中にあります。手動で確認してください。");
  }
  return `${existing.slice(0, lineStart)}${replacement}${existing.slice(lineEnd)}`;
}

// 雛形の除外（管理ブロックの外の規則）のうち、既存の .gitignore に無いもの。否定（!規則）が既にあれば足さない。
function missingTemplateRules(existing: string, template: string): string[] {
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing: string[] = [];
  let inManaged = false;
  for (const raw of template.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(MANAGED_BEGIN_PREFIX)) {
      inManaged = true;
      continue;
    }
    if (line.startsWith(MANAGED_END_PREFIX)) {
      inManaged = false;
      continue;
    }
    if (inManaged || line === "" || line.startsWith("#")) continue;
    if (present.has(line) || present.has(`!${line}`) || missing.includes(line)) continue;
    missing.push(line);
  }
  return missing;
}

// init 用: 既存の行を変えずに、管理ブロックと、雛形の除外のうち無い行を足した内容（壊れた管理ブロックは throw）。
export function initGitignoreContent(existing: string, template: string): string {
  const merged = mergePullIgnoreBlock(existing, managedPullIgnoreBlock(template));
  const missing = missingTemplateRules(merged, template);
  if (missing.length === 0) return merged;
  const eol = merged.includes("\r\n") ? "\r\n" : "\n";
  const prefix = merged.length === 0 || merged.endsWith(eol) ? merged : `${merged}${eol}`;
  const spacer = prefix.length > 0 && !prefix.endsWith(`${eol}${eol}`) ? eol : "";
  return `${prefix}${spacer}${[INIT_APPEND_HEADER, ...missing].join(eol)}${eol}`;
}
