import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { confirmYes } from "../confirm.js";
import { recordLocalAction } from "../runLog.js";
import { isToolRepository } from "../domainGuard.js";
import { runGit } from "../git.js";
import { log } from "../log.js";
import { discoverAddons, resolveAddonDirectory } from "./catalog.js";
import {
  checkIndexIntegrity,
  CURSOR_INDEX_REL,
  hash,
  IGNORE_BEGIN,
  IGNORE_BLOCK,
  IGNORE_END,
  isManagedLink,
  loadState,
  ADDON_INDEX_REL,
  ADDON_STATE_REL,
  readLinkTarget,
  serializeState,
  samePath
} from "./state.js";
import type {
  InstalledAddon,
  AddonCandidate,
  AddonChangeResult,
  AddonContext,
  AddonLink,
  AddonListResult,
  AddonOperationPlan,
  AddonState
} from "./types.js";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATE_DIR_REL = ".kint-origin/addons";

function toolRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function safeDomainRoot(root: string): string {
  if (!path.isAbsolute(root)) throw new Error("ADDON_CONFLICT: domain root must be absolute");
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("ADDON_CONFLICT: domain root must be a real directory");
  const real = fs.realpathSync(root);
  if (isToolRepository(real)) throw new Error("ADDON_CONFLICT: addons cannot be managed in the kint-origin package root");
  return real;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function assertRootsSeparated(domainRoot: string, addonRoot: string): void {
  const packageRoot = toolRoot();
  if (
    isInside(packageRoot, addonRoot) || isInside(packageRoot, domainRoot) ||
    isInside(domainRoot, addonRoot) || isInside(addonRoot, domainRoot)
  ) {
    throw new Error("ADDON_CONFLICT: tool, domain, and addon directories must be separate");
  }
}

function trackedFiles(root: string): string[] | undefined {
  const probe = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (probe.status !== 0) return undefined;
  const result = runGit(root, ["ls-files", "-z"]);
  if (result.status !== 0) throw new Error("ADDON_CONFLICT: could not inspect tracked Git files");
  return String(result.stdout).split("\0").filter(Boolean).map((item) => item.replaceAll("\\", "/"));
}

function assertNoTrackedAddonFiles(root: string): void {
  const files = trackedFiles(root);
  if (!files) return;
  const blocked = files.filter((item) =>
    item === STATE_DIR_REL || item.startsWith(`${STATE_DIR_REL}/`) ||
    /^\.agents\/skills\/kint-origin-addon-[^/]+(?:\/|$)/.test(item) ||
    /^\.claude\/skills\/kint-origin-addon-[^/]+(?:\/|$)/.test(item) ||
    /^\.cursor\/rules\/kint-origin-addon-[^/]+\.mdc$/.test(item)
  );
  if (blocked.length) throw new Error(`ADDON_TRACKED: remove these addon-managed paths from Git first: ${blocked.join(", ")}`);
}

function managedIgnoreContent(root: string): { content: string; changed: boolean } {
  const file = path.join(root, ".gitignore");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (before.charCodeAt(0) === 0xfeff) throw new Error("ADDON_CONFLICT: .gitignore must be UTF-8 without BOM");
  const lines = before.split(/\r?\n/);
  const starts = lines.filter((item) => item === IGNORE_BEGIN).length;
  const ends = lines.filter((item) => item === IGNORE_END).length;
  if (starts !== ends || starts > 1 || (starts === 1 && lines.indexOf(IGNORE_BEGIN) >= lines.indexOf(IGNORE_END))) {
    throw new Error("ADDON_CONFLICT: malformed addon block in .gitignore");
  }
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  let outside = before;
  if (starts === 1) {
    const start = lines.indexOf(IGNORE_BEGIN);
    const end = lines.indexOf(IGNORE_END);
    outside = [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n");
  }
  const base = outside.replace(/[\r\n]+$/, "");
  const content = `${base ? `${base}${newline}${newline}` : ""}${IGNORE_BLOCK.replaceAll("\n", newline)}${newline}`;
  return { content, changed: content !== before };
}

function addonLinks(candidate: AddonCandidate): AddonLink[] {
  const links: AddonLink[] = [{ path: `${STATE_DIR_REL}/linked/${candidate.name}`, target: candidate.root }];
  for (const skill of candidate.skills) {
    const target = path.join(candidate.root, "skills", skill);
    links.push(
      { path: `.agents/skills/${skill}`, target },
      { path: `.claude/skills/${skill}`, target }
    );
  }
  return links.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function addonIndex(addons: Record<string, InstalledAddon>): string {
  const names = Object.keys(addons).sort((a, b) => a.localeCompare(b, "en"));
  return [
    "# Installed kint-origin addons",
    "",
    "If this file exists, read every rule file listed below before starting work. Apply those rules alongside the project rules.",
    "",
    ...names.flatMap((name) => [
      `## ${name}`,
      "",
      `- Manifest: \`.kint-origin/addons/linked/${name}/addon.json\``,
      ...(addons[name].rules?.length
        ? addons[name].rules.map((file) => `- Rule: \`.kint-origin/addons/linked/${name}/${file}\``)
        : [`- Rules: no Markdown rules are installed.`]),
      ""
    ])
  ].join("\n");
}

function cursorIndex(): string {
  return [
    "---",
    "description: Read and follow installed kint-origin addon guidance.",
    "alwaysApply: true",
    "---",
    "",
    "If `.kint-origin/addons/INDEX.md` exists, read it before working and follow every installed addon rule it references.",
    ""
  ].join("\n");
}

function generatedWrites(state: AddonState): Array<{ path: string; content: string }> {
  const writes = [
    { path: ADDON_INDEX_REL, content: addonIndex(state.addons) },
    { path: CURSOR_INDEX_REL, content: cursorIndex() }
  ];
  state.generated = Object.fromEntries(writes.map((item) => [item.path, hash(item.content)]));
  return writes;
}

function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch { return false; }
}

function validateInstalledLinks(root: string, state: AddonState): void {
  for (const installed of Object.values(state.addons)) {
    for (const link of installed.links) {
      if (exists(path.resolve(root, link.path)) && !isManagedLink(root, link)) {
        throw new Error(`ADDON_CONFLICT: addon-managed link was replaced: ${link.path}`);
      }
    }
  }
}

function operationPlan(root: string, operation: AddonOperationPlan["operation"], name: string, state: AddonState, candidate?: AddonCandidate): AddonOperationPlan {
  checkIndexIntegrity(root, state);
  validateInstalledLinks(root, state);
  const current = state.addons[name];
  if (operation === "install" && current) throw new Error(`ADDON_CONFLICT: ${name} is already installed; use addon update`);
  if (operation === "update" && !current) throw new Error(`ADDON_NOT_INSTALLED: ${name}`);
  if (operation === "remove" && !current) throw new Error(`ADDON_NOT_INSTALLED: ${name}`);
  if (operation !== "remove" && !candidate) throw new Error(`ADDON_SOURCE_MISSING: ${name}`);

  const previousLinks = current?.links ?? [];
  const desiredLinks = candidate ? addonLinks(candidate) : [];
  const priorByPath = new Map(previousLinks.map((item) => [item.path, item]));
  for (const link of desiredLinks) {
    const destination = path.resolve(root, link.path);
    const prior = priorByPath.get(link.path);
    if (exists(destination) && (!prior || !isManagedLink(root, prior))) {
      throw new Error(`ADDON_CONFLICT: destination already exists: ${link.path}`);
    }
  }
  const desiredPaths = new Set(desiredLinks.map((item) => item.path));
  const removedLinks = previousLinks.filter((item) => !desiredPaths.has(item.path));
  const nextState: AddonState = { ...state, addons: { ...state.addons }, generated: { ...state.generated } };
  if (operation === "remove") delete nextState.addons[name];
  else nextState.addons[name] = { version: candidate?.manifest.version, links: desiredLinks, rules: candidate?.rules };

  const ignore = managedIgnoreContent(root);
  const fileWrites = [
    ...(ignore.changed ? [{ path: ".gitignore", content: ignore.content }] : []),
    ...generatedWrites(nextState)
  ];
  return { operation, addon: name, nextState, desiredLinks, removedLinks, fileWrites };
}

function listNames(state: AddonState): string[] { return Object.keys(state.addons); }

export function listAddons(domainRoot = process.cwd()): AddonListResult {
  const root = safeDomainRoot(domainRoot);
  const state = loadState(root);
  const source = resolveAddonDirectory(root);
  const candidates = source ? discoverAddons(source) : new Map();
  const result: AddonListResult = { sourceConfigured: Boolean(source), addons: [] };
  const names = new Set([...listNames(state), ...candidates.keys()]);
  for (const name of [...names].sort((a, b) => a.localeCompare(b, "en"))) {
    const installed = state.addons[name];
    const candidate = candidates.get(name);
    if (candidate instanceof Error) {
      result.addons.push({ name, version: null, description: null, status: "invalid", issues: [candidate.message] });
    } else if (!candidate) {
      if (installed) result.addons.push({ name, version: null, description: null, status: "source-missing", issues: ["addon source is unavailable"] });
    } else if (!installed) {
      result.addons.push({ name, version: candidate.manifest.version, description: candidate.manifest.description, status: "available", issues: [] });
    } else {
      const desired = addonLinks(candidate);
      const same = installed.version === candidate.manifest.version && JSON.stringify(installed.rules ?? []) === JSON.stringify(candidate.rules) && desired.length === installed.links.length && desired.every((link) => installed.links.some((old) => old.path === link.path && samePath(old.target, link.target) && isManagedLink(root, old)));
      result.addons.push({ name, version: candidate.manifest.version, description: candidate.manifest.description, status: same ? "installed" : "needs-update", issues: same ? [] : ["installed links differ from source"] });
    }
  }
  return result;
}

function requireCandidate(source: string | undefined, name: string): AddonCandidate {
  if (!source) throw new Error("ADDON_SOURCE_MISSING: set KINT_ORIGIN_ADDON_DIR to an absolute directory");
  const candidate = discoverAddons(source).get(name);
  if (!candidate) throw new Error(`ADDON_SOURCE_MISSING: ${name}`);
  if (candidate instanceof Error) throw candidate;
  return candidate;
}

function context(root: string, addonRoot: string): AddonContext {
  return {
    domainRoot: root,
    addonDirectory: addonRoot,
    stateDirectory: path.join(root, STATE_DIR_REL),
    cliPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js")
  };
}

function snapshot(root: string, relativePath: string): Buffer | undefined {
  const file = path.resolve(root, relativePath);
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`ADDON_CONFLICT: expected a regular managed file: ${relativePath}`);
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function ensureParents(root: string, file: string, created: string[]): void {
  const relativeDir = path.relative(root, path.dirname(file));
  if (relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) throw new Error("ADDON_CONFLICT: destination escaped domain root");
  let current = root;
  for (const segment of relativeDir.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`ADDON_CONFLICT: unsafe parent directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current);
      created.push(current);
    }
  }
}

function writeAtomic(file: string, bytes: Buffer): void {
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (exists(temporary)) fs.unlinkSync(temporary);
  }
}

function createDirectoryLink(root: string, link: AddonLink, createdDirs: string[]): void {
  const destination = path.resolve(root, link.path);
  ensureParents(root, destination, createdDirs);
  if (exists(destination)) {
    if (isManagedLink(root, link)) return;
    throw new Error(`ADDON_CONFLICT: destination already exists: ${link.path}`);
  }
  const target = process.platform === "win32" ? link.target : path.relative(path.dirname(destination), link.target);
  fs.symlinkSync(target, destination, process.platform === "win32" ? "junction" : "dir");
}

function assertIgnoreAfterWrite(root: string, plan: AddonOperationPlan): void {
  if (!trackedFiles(root)) return;
  const paths = [ADDON_STATE_REL, ADDON_INDEX_REL, CURSOR_INDEX_REL, ...plan.desiredLinks.map((item) => item.path)];
  for (const item of paths) {
    const result = runGit(root, ["check-ignore", "-q", "--no-index", "--", item]);
    if (result.status !== 0) throw new Error(`ADDON_CONFLICT: Git ignore does not protect ${item}`);
  }
}

function applyPlan(root: string, plan: AddonOperationPlan): AddonChangeResult {
  recordLocalAction("apply-addon-plan", root, { addon: plan.addon, operation: plan.operation });
  const stateFile = path.join(root, ADDON_STATE_REL);
  const writePaths = [...plan.fileWrites.map((item) => item.path), ADDON_STATE_REL];
  const snapshots = new Map(writePaths.map((item) => [item, snapshot(root, item)]));
  const linkPaths = new Map<string, string | undefined>();
  for (const item of [...plan.desiredLinks, ...plan.removedLinks]) linkPaths.set(item.path, readLinkTarget(path.resolve(root, item.path)));
  const createdDirs: string[] = [];
  const created: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const lock = path.join(root, STATE_DIR_REL, ".lock");
  let lockOwned = false;
  try {
    ensureParents(root, path.join(root, STATE_DIR_REL, ".placeholder"), createdDirs);
    const lockFd = fs.openSync(lock, "wx");
    lockOwned = true;
    try { fs.writeSync(lockFd, `${process.pid}\n`); } finally { fs.closeSync(lockFd); }
    for (const item of writePaths) {
      const now = snapshot(root, item);
      const before = snapshots.get(item);
      if ((now === undefined) !== (before === undefined) || (now && before && !now.equals(before))) {
        throw new Error(`ADDON_CONFLICT: managed file changed after preflight: ${item}`);
      }
    }
    const ignoreWrite = plan.fileWrites.find((item) => item.path === ".gitignore");
    if (ignoreWrite) {
      const dest = path.join(root, ".gitignore");
      ensureParents(root, dest, createdDirs);
      writeAtomic(dest, Buffer.from(ignoreWrite.content, "utf8"));
      if (snapshots.get(".gitignore") === undefined) created.push(".gitignore"); else updated.push(".gitignore");
    }
    assertIgnoreAfterWrite(root, plan);
    for (const item of plan.removedLinks) {
      const destination = path.resolve(root, item.path);
      const actual = readLinkTarget(destination);
      if (actual !== undefined) {
        if (!samePath(actual, item.target)) throw new Error(`ADDON_CONFLICT: refusing to remove replaced link: ${item.path}`);
        fs.unlinkSync(destination);
        removed.push(item.path);
      }
    }
    for (const item of plan.desiredLinks) {
      const before = readLinkTarget(path.resolve(root, item.path));
      if (before && samePath(before, item.target)) continue;
      if (before) fs.unlinkSync(path.resolve(root, item.path));
      createDirectoryLink(root, item, createdDirs);
      if (before) updated.push(item.path); else created.push(item.path);
    }
    for (const item of plan.fileWrites) {
      if (item.path === ".gitignore") continue;
      const dest = path.join(root, item.path);
      ensureParents(root, dest, createdDirs);
      const before = snapshots.get(item.path);
      const bytes = Buffer.from(item.content, "utf8");
      if (before?.equals(bytes)) continue;
      writeAtomic(dest, bytes);
      if (before === undefined) created.push(item.path); else updated.push(item.path);
    }
    const previousState = snapshots.get(ADDON_STATE_REL);
    const stateJson = serializeState(plan.nextState);
    writeAtomic(stateFile, Buffer.from(stateJson, "utf8"));
    if (previousState === undefined) created.push(ADDON_STATE_REL);
    else if (!previousState.equals(Buffer.from(stateJson, "utf8"))) updated.push(ADDON_STATE_REL);
    return { operation: plan.operation, addon: plan.addon, created: created.sort(), updated: updated.sort(), removed: removed.sort(), unchanged: 0, warnings: [], aborted: false };
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const [relativePath, before] of snapshots) {
      try {
        const file = path.resolve(root, relativePath);
        const current = snapshot(root, relativePath);
        if (before === undefined) {
          if (current !== undefined) fs.unlinkSync(file);
        } else if (!current?.equals(before)) {
          ensureParents(root, file, []);
          writeAtomic(file, before);
        }
      } catch { rollbackErrors.push(relativePath); }
    }
    for (const [relativePath, before] of linkPaths) {
      try {
        const file = path.resolve(root, relativePath);
        const current = readLinkTarget(file);
        if (current && !before) fs.unlinkSync(file);
        else if (before && (!current || !samePath(current, before))) {
          if (current) fs.unlinkSync(file);
          ensureParents(root, file, []);
          const target = process.platform === "win32" ? before : path.relative(path.dirname(file), before);
          fs.symlinkSync(target, file, process.platform === "win32" ? "junction" : "dir");
        }
      } catch { rollbackErrors.push(relativePath); }
    }
    if (rollbackErrors.length) throw new Error(`ADDON_CONFLICT: operation failed and rollback was incomplete (${rollbackErrors.join(", ")}); cause: ${String(error)}`);
    throw error;
  } finally {
    if (lockOwned) { try { fs.unlinkSync(lock); } catch { /* preserve lock if removal fails */ } }
    for (const directory of [...createdDirs].reverse()) { try { fs.rmdirSync(directory); } catch { /* retain non-empty directories */ } }
  }
}

export async function manageAddon(
  operation: AddonOperationPlan["operation"],
  name: string,
  { yes = false, domainRoot = process.cwd() }: { yes?: boolean; domainRoot?: string } = {}
): Promise<AddonChangeResult> {
  if (!NAME_RE.test(name) || name.length > 48) throw new Error(`ADDON_MANIFEST_INVALID: invalid addon name: ${name}`);
  const root = safeDomainRoot(domainRoot);
  assertNoTrackedAddonFiles(root);
  let source: string | undefined;
  try {
    source = resolveAddonDirectory(root);
  } catch (error) {
    if (operation !== "remove" || !(error instanceof Error) || !error.message.startsWith("ADDON_SOURCE_MISSING:")) throw error;
  }
  if (source) assertRootsSeparated(root, source);
  if (operation !== "remove" && !source) throw new Error("ADDON_SOURCE_MISSING: set KINT_ORIGIN_ADDON_DIR to an absolute directory");
  const state = loadState(root);
  const candidate = operation === "remove" ? undefined : requireCandidate(source, name);
  const plan = operationPlan(root, operation, name, state, candidate);
  const changed = plan.fileWrites.some((item) => {
    const before = snapshot(root, item.path);
    return before === undefined || !before.equals(Buffer.from(item.content, "utf8"));
  }) || plan.desiredLinks.some((item) => !isManagedLink(root, item)) || plan.removedLinks.some((item) => exists(path.resolve(root, item.path))) ||
    !snapshot(root, ADDON_STATE_REL)?.equals(Buffer.from(serializeState(plan.nextState), "utf8"));
  if (!changed) return { operation, addon: name, created: [], updated: [], removed: [], unchanged: 1, warnings: [], aborted: false };
  log(`addon ${operation} ${name}`);
  for (const item of plan.fileWrites) log(`  ${exists(path.resolve(root, item.path)) ? "update" : "create"}: ${item.path}`);
  for (const item of plan.desiredLinks) log(`  link: ${item.path} -> ${item.target}`);
  for (const item of plan.removedLinks) log(`  remove link: ${item.path}`);
  if (!yes && !process.stdin.isTTY) throw new Error("ADDON_CONFLICT: confirmation is unavailable; review the plan and pass --yes");
  if (!yes && !(await confirmYes("Apply these addon changes? [y/N]"))) {
    return { operation, addon: name, created: [], updated: [], removed: [], unchanged: 0, warnings: [], aborted: true };
  }
  if (source) assertRootsSeparated(root, source);
  return applyPlan(root, plan);
}

export interface PreparedAddonSync {
  addons: string[];
  changed: boolean;
  apply: () => string[];
}

/** update 用に addon のリンクを事前検査し、承認後に適用する計画を返す。 */
export function prepareAddonSync(domainRoot = process.cwd()): PreparedAddonSync {
  const root = safeDomainRoot(domainRoot);
  const state = loadState(root);
  const names = Object.keys(state.addons).sort((a, b) => a.localeCompare(b, "en"));
  if (names.length === 0) return { addons: [], changed: false, apply: () => [] };
  assertNoTrackedAddonFiles(root);
  const source = resolveAddonDirectory(root);
  if (!source) throw new Error("ADDON_SOURCE_MISSING: installed addons exist but KINT_ORIGIN_ADDON_DIR is not configured");
  assertRootsSeparated(root, source);
  checkIndexIntegrity(root, state);
  validateInstalledLinks(root, state);
  const nextState: AddonState = { ...state, addons: { ...state.addons }, generated: { ...state.generated } };
  const desiredLinks: AddonLink[] = [];
  const removedLinks: AddonLink[] = [];
  let linksChanged = false;
  for (const name of names) {
    const candidate = requireCandidate(source, name);
    const previous = state.addons[name];
    const desired = addonLinks(candidate);
    for (const link of desired) {
      const existing = path.resolve(root, link.path);
      const prior = previous.links.find((item) => item.path === link.path);
      if (exists(existing) && (!prior || !isManagedLink(root, prior))) {
        throw new Error(`ADDON_CONFLICT: destination already exists: ${link.path}`);
      }
    }
    const desiredPaths = new Set(desired.map((item) => item.path));
    const removed = previous.links.filter((item) => !desiredPaths.has(item.path));
    if (previous.version !== candidate.manifest.version || JSON.stringify(previous.rules ?? []) !== JSON.stringify(candidate.rules) || desired.length !== previous.links.length || desired.some((item) => !previous.links.some((old) => old.path === item.path && samePath(old.target, item.target)))) linksChanged = true;
    desiredLinks.push(...desired);
    removedLinks.push(...removed);
    nextState.addons[name] = { version: candidate.manifest.version, links: desired, rules: candidate.rules };
  }
  const ignore = managedIgnoreContent(root);
  const fileWrites: AddonOperationPlan["fileWrites"] = [
    ...(ignore.changed ? [{ path: ".gitignore", content: ignore.content }] : []),
    ...generatedWrites(nextState)
  ];
  const plan: AddonOperationPlan = {
    operation: "update",
    addon: "all",
    nextState,
    desiredLinks,
    removedLinks,
    fileWrites
  };
  const changed = linksChanged || fileWrites.some((item) => {
    const before = snapshot(root, item.path);
    return before === undefined || !before.equals(Buffer.from(item.content, "utf8"));
  }) || removedLinks.some((item) => exists(path.resolve(root, item.path)));
  return { addons: names, changed, apply: () => changed ? (applyPlan(root, plan), names) : [] };
}

export function makeEmptyAddon(name: string, addonDirectory?: string, domainRoot = process.cwd()): string {
  if (!addonDirectory) throw new Error("ADDON_SOURCE_MISSING: set KINT_ORIGIN_ADDON_DIR first");
  if (!NAME_RE.test(name) || name.length > 48) throw new Error(`ADDON_MANIFEST_INVALID: invalid addon name: ${name}`);
  if (!path.isAbsolute(addonDirectory)) throw new Error("ADDON_MANIFEST_INVALID: KINT_ORIGIN_ADDON_DIR must be absolute");
  const rootDomain = safeDomainRoot(domainRoot);
  const parentStat = fs.lstatSync(addonDirectory);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("ADDON_CONFLICT: addon source must be an existing directory");
  const parent = fs.realpathSync(addonDirectory);
  assertRootsSeparated(rootDomain, parent);
  const root = path.join(parent, name);
  if (exists(root)) throw new Error(`ADDON_CONFLICT: destination already exists: ${root}`);
  const staging = `${root}.tmp-${randomUUID()}`;
  try {
    recordLocalAction("create-addon", root, { addon: name });
    fs.mkdirSync(staging);
    for (const item of ["commands", "skills", "rules", "templates"]) fs.mkdirSync(path.join(staging, item));
    fs.writeFileSync(path.join(staging, "addon.json"), `${JSON.stringify({ schemaVersion: 1, name, version: "0.1.0", description: `${name} addon`, commands: {} }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(staging, root);
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* keep original error */ }
    throw error;
  }
  return root;
}

export function prepareAddonRun(domainRoot: string, name: string, command: string): { context: AddonContext; entry: string } {
  if (!NAME_RE.test(name) || !NAME_RE.test(command)) throw new Error("ADDON_MANIFEST_INVALID: invalid addon or command name");
  const root = safeDomainRoot(domainRoot);
  const source = resolveAddonDirectory(root);
  if (!source) throw new Error("ADDON_SOURCE_MISSING: set KINT_ORIGIN_ADDON_DIR first");
  assertRootsSeparated(root, source);
  const state = loadState(root);
  const installed = state.addons[name];
  if (!installed) throw new Error(`ADDON_NOT_INSTALLED: ${name}`);
  checkIndexIntegrity(root, state);
  validateInstalledLinks(root, state);
  const candidate = requireCandidate(source, name);
  const desired = addonLinks(candidate);
  const same = installed.version === candidate.manifest.version && JSON.stringify(installed.rules ?? []) === JSON.stringify(candidate.rules) && desired.length === installed.links.length && desired.every((link) => installed.links.some((old) => old.path === link.path && samePath(old.target, link.target) && isManagedLink(root, old)));
  if (!same) throw new Error(`ADDON_LINK_STALE: run addon update ${name}`);
  const relativeEntry = candidate.manifest.commands[command];
  if (!relativeEntry) throw new Error(`ADDON_COMMAND_UNKNOWN: ${name} ${command}`);
  return { context: context(root, source), entry: path.resolve(candidate.root, relativeEntry) };
}

