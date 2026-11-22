#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = ".agents/generated.json";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exists = (file) => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const inside = (root, target) => target === root || target.startsWith(root + path.sep);

function location(root, relative) {
  const target = path.resolve(root, relative);
  if (!inside(root, target) || target === root) throw new Error(`管理対象外のパス: ${relative}`);
  return target;
}

function plainAncestors(root, target) {
  for (let parent = path.dirname(target); inside(root, parent); parent = path.dirname(parent)) {
    if (exists(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error(`管理先の祖先がリンクです: ${path.relative(root, parent)}`);
    if (parent === root) break;
  }
}

function textFile(file) {
  return decodeText(fs.readFileSync(file), file);
}

function decodeText(bytes, file) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.startsWith("\uFEFF") || text.includes("\r")) throw new Error(`UTF-8 BOMなし・LFで保存してください: ${file}`);
  return text;
}

function metadata(file, name, raw = textFile(file)) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`frontmatterがありません: ${file}`);
  const scalar = (key) => {
    const value = match[1].match(new RegExp(`^${key}: (.+)$`, "m"))?.[1];
    if (!value) throw new Error(`${key}がありません: ${file}`);
    return value.startsWith('"') ? JSON.parse(value) : value;
  };
  if (scalar("name") !== name) throw new Error(`フォルダ/ファイル名とnameが一致しません: ${file}`);
  const description = scalar("description");
  if (typeof description !== "string" || !description.trim() || description.length > 1024 || description === ">-" || description === "|") throw new Error(`descriptionは空でない1024文字以内の1行で指定してください: ${file}`);
  return { raw, description, body: match[2].trim() };
}

function validateLinks(root, file, text) {
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = match[1];
    if (/^(?:https?:|#)/.test(href)) continue;
    const resolved = path.resolve(path.dirname(file), href.split("#")[0]);
    if (!inside(root, resolved) || !fs.existsSync(resolved)) throw new Error(`参照先がありません: ${path.relative(root, file)} -> ${href}`);
  }
}

function tree(directory, prefix = "") {
  const files = new Map();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const relative = prefix + entry.name;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`スキル内のリンクは管理対象にできません: ${file}`);
    if (entry.isDirectory()) for (const [name, bytes] of tree(file, relative + "/")) files.set(name, bytes);
    else if (entry.isFile()) files.set(relative, fs.readFileSync(file));
    else throw new Error(`通常ファイルではありません: ${file}`);
  }
  return files;
}

function atomicWrite(root, relative, bytes) {
  const target = location(root, relative);
  plainAncestors(root, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + `.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function validateNames(value, key, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || new Set(value).size !== value.length) {
    const requirement = allowEmpty ? "配列" : "空でない配列";
    throw new Error(`${key}は重複のない${requirement}が必要です。`);
  }
  for (const name of value) if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`不正な名前: ${name}`);
}

export function syncDevAgents({ root = ROOT, check = false, copy = false } = {}) {
  root = path.resolve(root);
  for (const relative of ["AGENTS.md", "CLAUDE.md", ".claude/settings.json"]) {
    const file = location(root, relative);
    plainAncestors(root, file);
    if (!exists(file) || !fs.lstatSync(file).isFile()) throw new Error(`共通指示・共有設定がありません: ${relative}`);
    const text = textFile(file);
    if (relative === "CLAUDE.md" && !/^@AGENTS\.md\s*(?:\n|$)/.test(text)) throw new Error("CLAUDE.mdからAGENTS.mdをimportしてください。");
    if (relative.endsWith(".json")) JSON.parse(text);
    else validateLinks(root, file, text);
  }
  const configFile = location(root, ".agents/dev-config.json");
  plainAncestors(root, configFile);
  if (fs.lstatSync(configFile).isSymbolicLink()) throw new Error("dev-config.jsonをリンクにはできません。");
  const config = JSON.parse(textFile(configFile));
  validateNames(config.skills, "skills");
  validateNames(config.roles, "roles", { allowEmpty: true });
  if (config.schemaVersion !== 1) throw new Error("未対応のdev-configスキーマです。");
  for (const entry of fs.readdirSync(location(root, ".agents/skills"), { withFileTypes: true })) {
    if (fs.existsSync(path.join(root, ".agents/skills", entry.name, "SKILL.md")) && !config.skills.includes(entry.name)) throw new Error(`未登録のスキルです: ${entry.name}`);
  }
  const rolesDir = location(root, ".agents/roles");
  if (exists(rolesDir)) {
    for (const entry of fs.readdirSync(rolesDir, { withFileTypes: true })) {
      if (entry.name.endsWith(".md") && !config.roles.includes(entry.name.slice(0, -3))) throw new Error(`未登録の役割です: ${entry.name}`);
    }
  }

  const stateFile = location(root, STATE);
  if (exists(stateFile) && fs.lstatSync(stateFile).isSymbolicLink()) throw new Error("生成台帳をリンクにはできません。");
  const previous = fs.existsSync(stateFile) ? JSON.parse(textFile(stateFile)) : null;
  if (previous && (previous.schemaVersion !== 1 || !["link", "copy"].includes(previous.skillMode))) throw new Error("生成台帳が不正です。");
  const mode = copy ? "copy" : previous?.skillMode ?? "link";
  const changingMode = previous && previous.skillMode !== mode;
  if (changingMode && (previous.skills ?? []).some((name) => exists(location(root, `.claude/skills/${name}`)))) throw new Error("既存配置の方式を自動変更しません。.agents/skills/kint-origin-agent-config/references/sync.mdの移行手順を参照してください。");
  const outputs = new Map();
  const links = [];
  const errors = [];

  // 正本と全参照先を先に検査し、失敗時は生成物に書き込まない。
  for (const name of config.skills) {
    const source = location(root, `.agents/skills/${name}`);
    plainAncestors(root, path.join(source, "SKILL.md"));
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error(`正本をリンクにはできません: ${name}`);
    const files = tree(source);
    const texts = new Map();
    for (const relative of files.keys()) {
      if (/\.(md|yaml|yml|json)$/.test(relative)) {
        const sourceFile = path.join(source, relative);
        const text = decodeText(files.get(relative), sourceFile);
        texts.set(relative, text);
        if (/\{\{AGENT_[A-Z_]+\}\}/.test(text)) throw new Error(`未置換のテンプレート変数: ${sourceFile}`);
        if (relative.endsWith(".md")) validateLinks(root, sourceFile, text);
      }
    }
    metadata(path.join(source, "SKILL.md"), name, texts.get("SKILL.md"));
    const destination = `.claude/skills/${name}`;
    if (mode === "link") links.push({ source, destination });
    else {
      const targetDir = location(root, destination);
      plainAncestors(root, path.join(targetDir, "SKILL.md"));
      if (exists(targetDir)) {
        for (const relative of tree(targetDir).keys()) if (!files.has(relative)) errors.push(`生成コピー内の追加ファイルを保護します: ${destination}/${relative}`);
      }
      for (const [relative, bytes] of files) outputs.set(`${destination}/${relative}`, bytes);
    }
    for (const tool of [".codex", ".cursor"]) {
      if (fs.existsSync(path.join(root, tool, "skills", name, "SKILL.md"))) errors.push(`共通スキルの重複配置: ${tool}/skills/${name}`);
    }
  }

  for (const name of config.roles) {
    const source = location(root, `.agents/roles/${name}.md`);
    plainAncestors(root, source);
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error(`役割正本をリンクにはできません: ${name}`);
    const meta = metadata(source, name);
    validateLinks(root, source, meta.raw);
    const body = `Generated by scripts/sync-dev-agents.mjs; edit .agents/roles/${name}.md`;
    const markdown = `---\nname: ${name}\ndescription: ${JSON.stringify(meta.description)}\n---\n\n<!-- ${body} -->\n\n${meta.body}\n`;
    outputs.set(`.claude/agents/${name}.md`, Buffer.from(markdown));
    outputs.set(`.cursor/agents/${name}.md`, Buffer.from(markdown));
    // JSONの文字列エスケープはここで使用する文字列ではTOML基本文字列としても有効。
    const toml = `# ${body}\nname = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(meta.description)}\ndeveloper_instructions = ${JSON.stringify(meta.body + "\n")}\n`;
    outputs.set(`.codex/agents/${name}.toml`, Buffer.from(toml));
  }

  const desired = { schemaVersion: 1, skillMode: mode, skills: [...config.skills], files: {} };
  for (const [relative, bytes] of [...outputs].sort(([a], [b]) => a.localeCompare(b, "en"))) desired.files[relative] = hash(bytes);
  if (previous) {
    for (const name of previous.skills ?? []) if (!config.skills.includes(name)) errors.push(`旧スキルの配置を保護します。移行先を確認してください: ${name}`);
    for (const relative of Object.keys(previous.files ?? {})) {
      if (outputs.has(relative)) continue;
      if (changingMode && relative.startsWith(".claude/skills/") && !exists(location(root, relative))) continue;
      errors.push(`旧生成物を保護します。移行先を確認してください: ${relative}`);
    }
  }

  const writes = [];
  for (const [relative, bytes] of outputs) {
    const target = location(root, relative);
    plainAncestors(root, target);
    if (!exists(target)) {
      if (check) errors.push(`生成物がありません: ${relative}`);
      else writes.push([relative, bytes]);
      continue;
    }
    if (!fs.lstatSync(target).isFile()) { errors.push(`通常ファイルではありません: ${relative}`); continue; }
    const current = fs.readFileSync(target);
    if (current.equals(bytes)) continue;
    if (check) errors.push(`同期が必要です: ${relative}`);
    else if (previous?.files?.[relative] === hash(current)) writes.push([relative, bytes]);
    else errors.push(`生成物の独自変更を保護します。正本へ取り込んでください: ${relative}`);
  }

  const newLinks = [];
  for (const link of links) {
    const target = location(root, link.destination);
    plainAncestors(root, target);
    if (!exists(target)) {
      if (check) errors.push(`スキルのリンクがありません: ${link.destination}`);
      else newLinks.push(link);
    } else if (!fs.lstatSync(target).isSymbolicLink() || path.resolve(path.dirname(target), fs.readlinkSync(target)) !== fs.realpathSync(link.source)) {
      errors.push(`異なる配置を保護します: ${link.destination}`);
    }
  }
  if (check && (!previous || !json(previous).equals(json(desired)))) errors.push("生成台帳が未同期です: .agents/generated.json");
  if (errors.length) throw new Error(errors.join("\n") + "\n正本と独自変更を確認し、npm run agents:sync を実行してください。");

  if (!check) {
    for (const link of newLinks) {
      const target = location(root, link.destination);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // junctionはWindowsで管理者権限なしに作成でき、リンク先は同じcheckout内だけ。
      fs.symlinkSync(process.platform === "win32" ? link.source : path.relative(path.dirname(target), link.source), target, process.platform === "win32" ? "junction" : "dir");
    }
    for (const [relative, bytes] of writes) atomicWrite(root, relative, bytes);
    if (!previous || !json(previous).equals(json(desired))) atomicWrite(root, STATE, json(desired));
  }
  return { skills: config.skills.length, roles: config.roles.length, mode, written: writes.map(([relative]) => relative), linked: newLinks.map((link) => link.destination) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => !["--check", "--copy"].includes(arg))) throw new Error("Usage: node scripts/sync-dev-agents.mjs [--check] [--copy]");
    const result = syncDevAgents({ check: args.includes("--check"), copy: args.includes("--copy") });
    console.log(`agents:${args.includes("--check") ? "check" : "sync"}: ${result.skills} skills, ${result.roles} role, mode=${result.mode}, ${result.written.length} files written, ${result.linked.length} links created`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
