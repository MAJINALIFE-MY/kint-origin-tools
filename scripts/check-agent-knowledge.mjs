import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMON = "template/agents/common/skills";
const posix = (value) => value.split(path.sep).join("/");

function filesIn(root, relative) {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  if (fs.statSync(directory).isFile()) return [relative];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const next = path.posix.join(relative, entry.name);
    // Generated links, addon sources and user files are outside this inspection.
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return filesIn(root, next);
    return entry.isFile() ? [next] : [];
  });
}

const markdownFiles = (root, relative) => filesIn(root, relative).filter((file) => file.endsWith(".md"));

export function markdownTargets(root, relative) {
  const bytes = fs.readFileSync(path.join(root, relative));
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.startsWith("\uFEFF") || text.includes("\r")) throw new Error(`UTF-8 BOMなし・LFで保存してください: ${relative}`);
  for (const [variable] of text.matchAll(/\{\{AGENT_[A-Z_]+\}\}/g)) {
    if (!relative.startsWith("template/agents/") || !/^\{\{AGENT_(?:RULES_DIR|SKILLS_DIR|DOC|NAME)\}\}$/.test(variable)) {
      throw new Error(`未置換の参照変数: ${relative}`);
    }
  }
  const prose = text.replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm, "");
  const targets = [];
  for (const match of prose.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\)/g)) {
    const href = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(href)) continue;
    const local = decodeURIComponent(href.split("#")[0]);
    const absolute = path.resolve(root, path.dirname(relative), local);
    const target = posix(path.relative(root, absolute));
    if (target === ".." || target.startsWith("../") || path.isAbsolute(target) || !fs.existsSync(absolute)) {
      throw new Error(`参照先がありません: ${relative} -> ${href}`);
    }
    targets.push(target);
  }
  return targets;
}

export function checkSkillReferences(root, skillRoot) {
  const files = markdownFiles(root, skillRoot);
  const entry = `${skillRoot}/SKILL.md`;
  if (!files.includes(entry)) throw new Error(`スキルの入口がありません: ${entry}`);
  const graph = new Map(files.map((file) => [file, markdownTargets(root, file)]));
  const reached = new Set();
  const pending = [entry];
  while (pending.length) {
    const current = pending.pop();
    if (reached.has(current)) continue;
    reached.add(current);
    for (const next of graph.get(current) ?? []) if (graph.has(next)) pending.push(next);
  }
  for (const file of files) {
    if (file.startsWith(`${skillRoot}/references/`) && !reached.has(file)) throw new Error(`スキルから辿れない参照資料: ${file}`);
  }
  return files.length;
}

function checkSkills(root, relative, names) {
  let count = 0;
  for (const name of names) count += checkSkillReferences(root, `${relative}/${name}`);
  return count;
}

function distributedNames(root) {
  return fs.readdirSync(path.join(root, COMMON), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

export function checkRepositoryKnowledge(root = ROOT) {
  for (const file of ["README.md", "SECURITY.md", "AGENTS.md"]) markdownTargets(root, file);
  const config = JSON.parse(fs.readFileSync(path.join(root, ".agents/dev-config.json"), "utf8"));
  const count = checkSkills(root, ".agents/skills", config.skills) + checkSkills(root, COMMON, distributedNames(root));
  // Check the declared package boundary without building or running npm. Verify
  // the real npm file list separately with pack --dry-run --ignore-scripts.
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const packaged = ["README.md", "LICENSE", "package.json", ...manifest.files.flatMap((relative) => filesIn(root, relative))];
  checkPackagedKnowledge(root, packaged);
  return { skillMarkdown: count };
}

// Run against init/update fixtures: template README links are domain-relative.
export function checkDomainKnowledge(root, names) {
  for (const file of ["README.md", "AGENTS.md", "CLAUDE.md"]) markdownTargets(root, file);
  for (const directory of [".agents/skills", ".claude/skills"]) checkSkills(root, directory, names);
}

export function checkPackagedKnowledge(root, paths) {
  const included = new Set(paths);
  const files = ["README.md", "SECURITY.md", ...markdownFiles(root, COMMON)];
  for (const file of files) {
    if (!included.has(file)) throw new Error(`パッケージに資料がありません: ${file}`);
    for (const target of markdownTargets(root, file)) {
      if (!included.has(target)) throw new Error(`パッケージに参照先がありません: ${file} -> ${target}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`agents:knowledge: ${checkRepositoryKnowledge().skillMarkdown} Markdown files checked`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
