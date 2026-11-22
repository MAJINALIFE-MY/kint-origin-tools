import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { parseJsonText } from "../fsutil.js";
import type { AddonLink, AddonState } from "./types.js";

export const ADDON_STATE_REL = ".kint-origin/addons/installed.json";
export const ADDON_INDEX_REL = ".kint-origin/addons/INDEX.md";
/** 外部addonのスキル名と生成ファイルの接頭辞（ドメイン独自の kint-origin-local- や配布スキルと区別する）。 */
export const ADDON_SKILL_PREFIX = "kint-origin-addon-";
export const CURSOR_INDEX_REL = `.cursor/rules/${ADDON_SKILL_PREFIX}index.mdc`;
export const IGNORE_BEGIN = "# BEGIN kint-origin addons";
export const IGNORE_END = "# END kint-origin addons";
export const IGNORE_BLOCK = [IGNORE_BEGIN, "/.kint-origin/addons/", `/.agents/skills/${ADDON_SKILL_PREFIX}*`, `/.claude/skills/${ADDON_SKILL_PREFIX}*`, `/.cursor/rules/${ADDON_SKILL_PREFIX}*`, IGNORE_END].join("\n");

export function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function defaultState(): AddonState {
  return { schemaVersion: 1, addons: {}, generated: {} };
}

export function serializeState(state: AddonState): string {
  const normalized: AddonState = {
    schemaVersion: 1,
    addons: Object.fromEntries(
      Object.entries(state.addons)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([name, installed]) => [name, {
          ...(installed.version ? { version: installed.version } : {}),
          links: [...installed.links].sort((a, b) => a.path.localeCompare(b.path, "en")),
          ...(installed.rules ? { rules: [...installed.rules].sort((a, b) => a.localeCompare(b, "en")) } : {})
        }])
    ),
    generated: Object.fromEntries(Object.entries(state.generated).sort(([a], [b]) => a.localeCompare(b, "en")))
  };
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

function isSemver(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((part) =>
    part.length > 0 && (part === "0" || !part.startsWith("0")) && [...part].every((char) => char >= "0" && char <= "9")
  );
}

export function loadState(domainRoot: string): AddonState {
  const statePath = path.join(domainRoot, ADDON_STATE_REL);
  if (!fs.existsSync(statePath)) return defaultState();
  if (fs.lstatSync(statePath).isSymbolicLink() || !fs.lstatSync(statePath).isFile()) throw new Error("ADDON_STATE_INVALID: installed.json は通常ファイルにしてください。");
  const value = parseJsonText(fs.readFileSync(statePath, "utf8"), statePath) as AddonState;
  if (!value || value.schemaVersion !== 1 || !value.addons || typeof value.addons !== "object" || Array.isArray(value.addons) || !value.generated || typeof value.generated !== "object" || Array.isArray(value.generated)) {
    throw new Error("ADDON_STATE_INVALID: installed.json の形式に対応していません。");
  }
  for (const [name, installed] of Object.entries(value.addons)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !installed || !Array.isArray(installed.links) || (installed.version !== undefined && (typeof installed.version !== "string" || !isSemver(installed.version)))) throw new Error("ADDON_STATE_INVALID: invalid addon entry");
    for (const link of installed.links) validateLink(domainRoot, name, link);
    if (installed.rules !== undefined && (!Array.isArray(installed.rules) || installed.rules.some((file) => typeof file !== "string" || !file.startsWith("rules/") || !file.endsWith(".md") || file.includes("\\") || file.split("/").includes("..")))) throw new Error("ADDON_STATE_INVALID: invalid addon rules list");
  }
  for (const [file, digest] of Object.entries(value.generated)) {
    if (![ADDON_INDEX_REL, CURSOR_INDEX_REL].includes(file) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("ADDON_STATE_INVALID: generated の値が不正です。");
  }
  return value;
}

function validateLink(domainRoot: string, name: string, link: AddonLink): void {
  if (!link || typeof link.path !== "string" || typeof link.target !== "string" || !path.isAbsolute(link.target)) throw new Error("ADDON_STATE_INVALID: links の値が不正です。");
  const skillPrefix = `${ADDON_SKILL_PREFIX}${name}`;
  const allowed = link.path === `.kint-origin/addons/linked/${name}` ||
    link.path === `.agents/skills/${skillPrefix}` || link.path === `.claude/skills/${skillPrefix}` ||
    ((link.path.startsWith(`.agents/skills/${skillPrefix}-`) || link.path.startsWith(`.claude/skills/${skillPrefix}-`)) && link.path.split("/").length === 3);
  const target = path.resolve(domainRoot, link.path);
  if (!allowed || target === path.resolve(domainRoot) || !target.startsWith(`${path.resolve(domainRoot)}${path.sep}`)) throw new Error("ADDON_STATE_INVALID: links が許可された配置先の範囲外です。");
}

export function readLinkTarget(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isSymbolicLink()) return undefined;
    const raw = fs.readlinkSync(file);
    return path.resolve(path.dirname(file), raw.replace(/^\\\?\\/, ""));
  } catch {
    return undefined;
  }
}

export function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value).replaceAll("\\", "/").replace(/^\\\?\//, "");
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(a) === normalize(b);
}

export function isManagedLink(domainRoot: string, link: AddonLink): boolean {
  return samePath(readLinkTarget(path.join(domainRoot, link.path)) ?? "", link.target);
}

export function checkIndexIntegrity(domainRoot: string, state: AddonState): void {
  for (const [relative, expected] of Object.entries(state.generated)) {
    const file = path.join(domainRoot, relative);
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile() || hash(fs.readFileSync(file)) !== expected) {
      throw new Error(`ADDON_CONFLICT: 生成した索引が独自に変更されています: ${relative}`);
    }
  }
}
