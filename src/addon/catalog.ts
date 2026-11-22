import fs from "node:fs";
import path from "node:path";

import { parseJsonText } from "../fsutil.js";
import { getAddonDirectory } from "../env.js";
import { ADDON_SKILL_PREFIX } from "./state.js";
import type { AddonCandidate, AddonManifest } from "./types.js";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ADDON_DIRS = ["commands", "skills", "rules", "templates"] as const;

function fail(message: string): never {
  throw new Error(`ADDON_MANIFEST_INVALID: ${message}`);
}

function requirePlainDirectory(file: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail(`${label} がありません: ${file}`);
  }
  if (!stat!.isDirectory() || stat!.isSymbolicLink()) fail(`${label} は通常のディレクトリにしてください: ${file}`);
}

function scanTree(root: string): void {
  if (!fs.existsSync(root)) return;
  requirePlainDirectory(root, "アドオンの管理ディレクトリ");
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail(`リンクまたは特殊ファイルは使えません: ${file}`);
    if (stat.isDirectory()) scanTree(file);
  }
}

function validateSkill(skillRoot: string, addonName: string): string {
  const name = path.basename(skillRoot);
  const prefix = `${ADDON_SKILL_PREFIX}${addonName}`;
  if (name !== prefix && !name.startsWith(`${prefix}-`)) fail(`スキル名は ${prefix} または ${prefix}-<用途> にしてください: ${name}`);
  if (name.length > 64 || !NAME_RE.test(name)) fail(`スキル名が不正です: ${name}`);
  const skillFile = path.join(skillRoot, "SKILL.md");
  if (!fs.existsSync(skillFile) || !fs.lstatSync(skillFile).isFile()) fail(`SKILL.md がありません: ${skillFile}`);
  const raw = fs.readFileSync(skillFile, "utf8");
  if (raw.charCodeAt(0) === 0xfeff || raw.includes("\r")) fail(`SKILL.md はUTF-8 BOMなし・LFにしてください: ${skillFile}`);
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) fail(`SKILL.md にfrontmatterがありません: ${skillFile}`);
  const skillName = match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = match[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (skillName !== name) fail(`SKILL.md の name とフォルダ名が一致しません: ${skillFile}`);
  if (!description || description.length > 1024) fail(`SKILL.md の description は1〜1024文字にしてください: ${skillFile}`);
  return name;
}

function markdownFiles(root: string, base = root): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(absolute, base));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(path.relative(base, absolute).replaceAll(path.sep, "/"));
  }
  return files.sort((a, b) => a.localeCompare(b, "en"));
}

function validateManifest(addonRoot: string, expectedName: string): AddonCandidate {
  requirePlainDirectory(addonRoot, "アドオンフォルダ");
  const manifestPath = path.join(addonRoot, "addon.json");
  if (!fs.lstatSync(manifestPath).isFile()) fail(`addon.json は通常ファイルにしてください: ${manifestPath}`);
  const manifest = parseJsonText(fs.readFileSync(manifestPath, "utf8"), manifestPath) as Partial<AddonManifest> | null;
  if (!manifest || manifest.schemaVersion !== 1) fail("schemaVersion は 1 にしてください。");
  if (manifest.name !== expectedName || !NAME_RE.test(expectedName) || expectedName.length > 48) fail("addon.json の name はフォルダ名と同じ小文字英数字・ハイフンにしてください。");
  if (typeof manifest.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) fail("version は 0.1.0 形式にしてください。");
  if (typeof manifest.description !== "string" || !manifest.description.trim() || manifest.description.length > 1024 || /[\r\n]/.test(manifest.description)) fail("description は空でない1024文字以内の1行にしてください。");
  if (manifest.commands == null || typeof manifest.commands !== "object" || Array.isArray(manifest.commands)) fail("commands はオブジェクトにしてください。");
  for (const [command, entry] of Object.entries(manifest.commands)) {
    if (!NAME_RE.test(command) || command.length > 64) fail(`コマンド名が不正です: ${command}`);
    if (typeof entry !== "string" || !entry.startsWith("commands/") || !entry.endsWith(".mjs") || entry.includes("\\") || entry.split("/").includes("..")) fail(`コマンドのentryはcommands/配下の.mjsにしてください: ${String(entry)}`);
    const entryPath = path.resolve(addonRoot, entry);
    if (!entryPath.startsWith(`${path.resolve(addonRoot)}${path.sep}`) || !fs.existsSync(entryPath) || !fs.lstatSync(entryPath).isFile()) fail(`コマンドのentryがありません: ${entry}`);
  }
  for (const dir of ADDON_DIRS) scanTree(path.join(addonRoot, dir));
  const skillsRoot = path.join(addonRoot, "skills");
  const skills = fs.existsSync(skillsRoot)
    ? fs.readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => validateSkill(path.join(skillsRoot, entry.name), expectedName)).sort()
    : [];
  return {
    name: expectedName,
    root: fs.realpathSync(addonRoot),
    manifest: manifest as AddonManifest,
    skills,
    rules: markdownFiles(path.join(addonRoot, "rules"), addonRoot)
  };
}

export function resolveAddonDirectory(domainRoot: string): string | undefined {
  const configured = getAddonDirectory(domainRoot);
  if (!configured) return undefined;
  if (!path.isAbsolute(configured)) throw new Error(`ADDON_MANIFEST_INVALID: KINT_ORIGIN_ADDON_DIR は絶対パスで指定してください: ${configured}`);
  const resolved = path.resolve(configured);
  if (!fs.existsSync(resolved) || !fs.lstatSync(resolved).isDirectory()) throw new Error(`ADDON_SOURCE_MISSING: アドオンフォルダがありません: ${resolved}`);
  return fs.realpathSync(resolved);
}

export function discoverAddons(addonDirectory: string): Map<string, AddonCandidate | Error> {
  const out = new Map<string, AddonCandidate | Error>();
  for (const entry of fs.readdirSync(addonDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const root = path.join(addonDirectory, entry.name);
    if (!fs.existsSync(path.join(root, "addon.json"))) continue;
    try {
      out.set(entry.name, validateManifest(root, entry.name));
    } catch (error) {
      out.set(entry.name, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return out;
}
