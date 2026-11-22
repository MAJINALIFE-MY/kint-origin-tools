import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDir, listFilesRecursive } from "./fsutil.js";
import { recordLocalAction } from "./runLog.js";

// グローバルリンク経由でもテンプレートはパッケージ内から読む。
const AGENTS_TEMPLATE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "template",
  "agents"
);
const COMMON_ROOT = path.join(AGENTS_TEMPLATE_ROOT, "common");

interface Placeholders {
  rulesDir: string;
  skillsDir: string;
  doc: string;
  name: string;
}

interface AgentTarget {
  rulesDir: string;
  skillsDir: string;
  /** ドメインルートに置くドキュメント名 */
  doc: string;
  name: string;
  /** ツール固有の追加ファイル置き場（template/agents/<extras>/）。配列順にドメインルートへ展開する */
  extras?: string[];
}

const TARGETS: AgentTarget[] = [
  {
    rulesDir: ".claude",
    skillsDir: ".claude",
    doc: "CLAUDE.md",
    name: "Claude",
    extras: ["claude"]
  },
  {
    rulesDir: ".agents",
    skillsDir: ".agents",
    doc: "AGENTS.md",
    name: "Codex / Cursor",
    // cursor（push を止める hook）と codex（push を確認にする rules）はツール別。
    extras: ["cursor", "codex"]
  }
];

export interface AgentsResult {
  written: string[];
  skipped: string[];
}

export interface PlannedWrite {
  /** ドメインルートからの相対パス（/ 区切り） */
  path: string;
  status: "new" | "changed" | "same" | "append";
  content: string;
}

function applyPlaceholders(text: string, ph: Placeholders): string {
  return text
    .replaceAll("{{AGENT_RULES_DIR}}", ph.rulesDir)
    .replaceAll("{{AGENT_SKILLS_DIR}}", ph.skillsDir)
    .replaceAll("{{AGENT_DOC}}", ph.doc)
    .replaceAll("{{AGENT_NAME}}", ph.name);
}

function placeholdersForTarget(target: AgentTarget): Placeholders {
  return {
    rulesDir: target.rulesDir,
    skillsDir: target.skillsDir,
    doc: target.doc,
    name: target.name
  };
}

function display(targetRoot: string, targetFile: string): string {
  return path.relative(targetRoot, targetFile).replaceAll(path.sep, "/");
}

function emit(
  targetRoot: string,
  targetFile: string,
  content: string,
  result: AgentsResult | PlannedWrite[]
): void {
  const shown = display(targetRoot, targetFile);
  const exists = fs.existsSync(targetFile);
  if (Array.isArray(result)) {
    const status = !exists ? "new" : fs.readFileSync(targetFile, "utf8") === content ? "same" : "changed";
    result.push({ path: shown, status, content });
    return;
  }
  if (exists) {
    result.skipped.push(shown);
    return;
  }
  ensureDir(path.dirname(targetFile));
  recordLocalAction("write-agent-file", targetFile, { bytes: Buffer.byteLength(content, "utf8") });
  fs.writeFileSync(targetFile, content, "utf8");
  result.written.push(shown);
}

function emitCommonTree(
  targetRoot: string,
  ph: Placeholders,
  sub: string,
  outputDir: string,
  result: AgentsResult | PlannedWrite[]
): void {
  const sourceRoot = path.join(COMMON_ROOT, sub);
  if (!fs.existsSync(sourceRoot)) return;
  for (const rel of listFilesRecursive(sourceRoot)) {
    const source = path.join(sourceRoot, rel);
    const content = applyPlaceholders(fs.readFileSync(source, "utf8"), ph);
    const targetFile = path.join(targetRoot, outputDir, sub, rel);
    emit(targetRoot, targetFile, content, result);
  }
}

function emitExtras(
  targetRoot: string,
  target: AgentTarget,
  ph: Placeholders,
  result: AgentsResult | PlannedWrite[]
): void {
  for (const extras of target.extras ?? []) {
    const extrasRoot = path.join(AGENTS_TEMPLATE_ROOT, extras);
    if (!fs.existsSync(extrasRoot)) continue;
    for (const rel of listFilesRecursive(extrasRoot)) {
      if (path.basename(rel) === ".gitkeep") continue;
      const source = path.join(extrasRoot, rel);
      const content = applyPlaceholders(fs.readFileSync(source, "utf8"), ph);
      const targetFile = path.join(targetRoot, rel);
      emit(targetRoot, targetFile, content, result);
    }
  }
}

function runGenerate(targetRoot: string, result: AgentsResult | PlannedWrite[]): void {
  if (!fs.existsSync(COMMON_ROOT)) {
    throw new Error(`Agents template directory not found: ${COMMON_ROOT}`);
  }
  const docTemplate = fs.readFileSync(path.join(COMMON_ROOT, "AGENT_DOC.md"), "utf8");

  // 共通ランタイムは1回だけ、依存する各ツールの入口より先に配置する。
  emitCommonTree(targetRoot, placeholdersForTarget(TARGETS[1]), "hooks", ".agents", result);

  for (const target of TARGETS) {
    const ph = placeholdersForTarget(target);
    emit(targetRoot, path.join(targetRoot, target.doc), applyPlaceholders(docTemplate, ph), result);
    emitCommonTree(targetRoot, ph, "rules", target.rulesDir, result);
    emitCommonTree(targetRoot, ph, "skills", target.skillsDir, result);
    emitExtras(targetRoot, target, ph, result);
  }
}

// update は確認用に書き込み計画を作り、承認後にその計画を applyPlannedWrites に渡す。
export function planAgents({ targetRoot = process.cwd() }: { targetRoot?: string } = {}): PlannedWrite[] {
  const planned: PlannedWrite[] = [];
  runGenerate(targetRoot, planned);
  return planned;
}

export function applyPlannedWrites(targetRoot: string, planned: PlannedWrite[]): string[] {
  const written: string[] = [];
  for (const item of planned) {
    if (item.status === "same") continue;
    const target = path.resolve(targetRoot, item.path);
    ensureDir(path.dirname(target));
    recordLocalAction("write-agent-file", target, { bytes: Buffer.byteLength(item.content, "utf8") });
    fs.writeFileSync(target, item.content, "utf8");
    written.push(item.path);
  }
  return written;
}

export function distributedSkillNames(): string[] {
  const root = path.join(COMMON_ROOT, "skills");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export const SKILL_ROOTS = TARGETS.map((target) => `${target.skillsDir}/skills`);

// init 用: 既存ファイルを保持し、未作成のファイルだけを生成する。
export function generateAgents({
  targetRoot = process.cwd()
}: {
  targetRoot?: string;
} = {}): AgentsResult {
  const result: AgentsResult = { written: [], skipped: [] };
  runGenerate(targetRoot, result);
  return result;
}
