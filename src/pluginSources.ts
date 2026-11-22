import fs from "node:fs";
import path from "node:path";

import { parseJsonText } from "./fsutil.js";

export const PLUGINS_DIR = "data/kintone/plugin";
export const PLUGIN_INSTALLED = `${PLUGINS_DIR}/installed.json`;
export const PLUGIN_SOURCES = `${PLUGINS_DIR}/sources.json`;
export const LOCAL_PLUGIN_SOURCES = `${PLUGINS_DIR}/sources.local.json`;

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PLUGIN_ID_PATTERN = /^[a-z]{32}$/;
const PROVISIONAL_ID = "x".repeat(32);
const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/[a-z0-9-]+\/([a-z0-9_.-]+)\/?$/i;
const SOURCE_FIELDS = new Set(["alias", "pluginId", "path", "githubUrl", "githubPath"]);

export interface InstalledPlugin {
  id: string;
  name: string;
  description: string;
  isMarketPlugin: boolean;
  version: string;
  [key: string]: unknown;
}

type Source = { path: string } | { githubUrl: string; githubPath?: string };
type SourceFile = typeof PLUGIN_SOURCES | typeof LOCAL_PLUGIN_SOURCES;
type Lookup = { id: string } | { name: string };
type Identity = { pluginId: string } | { name: string; pluginId: string | null };

interface Entry {
  alias?: string;
  pluginId?: string;
  source: Source;
  sourceFile: SourceFile;
}

type PluginSourceResult = Identity & (
  | { status: "unregistered" }
  | { status: "no-source"; sourceFile: typeof PLUGIN_INSTALLED; displayName: string; version: string }
  | ({ status: "found"; sourceFile: SourceFile; alias?: string } & Source)
  | { status: "missing-path"; sourceFile: SourceFile; path: string; alias?: string }
);

function invalid(file: string, reason: string): never {
  throw new Error(`PLUGIN_SOURCES_INVALID: ${file}: ${reason}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNativeAbsolute(value: string): boolean {
  if (process.platform !== "win32") return path.isAbsolute(value);
  // Windows のドライブ指定なしのルート相対パスは、実行時のドライブに依存する。
  return /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/])/i.test(value);
}

function isPortableRelative(value: string): boolean {
  return !/[\\:\u0000-\u001f]/.test(value)
    && value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function parseSource(entry: Record<string, unknown>, label: string, file: SourceFile): Source {
  const hasPath = Object.hasOwn(entry, "path");
  const hasGithub = Object.hasOwn(entry, "githubUrl");
  if (hasPath && hasGithub) invalid(file, `${label} には path または githubUrl のどちらか一方を指定してください。`);
  if (!hasPath && !hasGithub) invalid(file, `${label} には path または githubUrl を指定してください。`);

  if (hasPath) {
    const localPath = entry.path;
    if (Object.hasOwn(entry, "githubPath")) invalid(file, `${label} の githubPath は githubUrl と一緒に指定してください。`);
    if (typeof localPath === "string" && (isPortableRelative(localPath)
      || (file === LOCAL_PLUGIN_SOURCES && !/[\u0000-\u001f]/.test(localPath) && isNativeAbsolute(localPath)))) {
      return { path: localPath };
    }
    invalid(file, `${label} の path は ${PLUGINS_DIR}/ からの相対パス（/ 区切り）で指定してください。絶対パスは個人用台帳で指定できます。`);
  }

  const { githubUrl, githubPath } = entry;
  const match = typeof githubUrl === "string" && GITHUB_URL_PATTERN.exec(githubUrl);
  if (!match || match[1] === "." || match[1] === ".." || typeof githubUrl !== "string") {
    invalid(file, `${label} の githubUrl は https://github.com/<owner>/<repo> 形式で指定してください。`);
  }
  if (githubPath === undefined) return { githubUrl };
  if (typeof githubPath !== "string" || !isPortableRelative(githubPath)) {
    invalid(file, `${label} の githubPath はリポジトリ内の相対パス（/ 区切り）で指定してください。`);
  }
  return { githubUrl, githubPath };
}

function parseEntry(value: unknown, index: number, file: SourceFile): Entry {
  if (!isObject(value)) invalid(file, `配列の ${index + 1} 件目にはオブジェクトを指定してください。`);
  if (Object.keys(value).some((key) => !SOURCE_FIELDS.has(key))) {
    invalid(file, `配列の ${index + 1} 件目に未対応の項目があります。`);
  }
  const label = typeof value.alias === "string" ? value.alias : `配列の ${index + 1} 件目`;
  const { alias, pluginId } = value;
  if (alias !== undefined && (typeof alias !== "string" || !ID_PATTERN.test(alias))) {
    invalid(file, `${label} の alias には半角英数字・ハイフン・アンダースコアを指定してください。`);
  }
  if (pluginId !== undefined && (typeof pluginId !== "string" || !PLUGIN_ID_PATTERN.test(pluginId) || pluginId === PROVISIONAL_ID)) {
    invalid(file, `${label} の pluginId には確認済みの小文字32文字のプラグインIDを指定してください。仮のIDは登録しません。`);
  }
  if (alias === undefined && pluginId === undefined) {
    invalid(file, `${label} には alias または確認済みの pluginId を指定してください。`);
  }

  return {
    ...(alias === undefined ? {} : { alias: alias as string }),
    ...(pluginId === undefined ? {} : { pluginId: pluginId as string }),
    source: parseSource(value, label, file),
    sourceFile: file
  };
}

function readSourceFile(domainRoot: string, file: SourceFile): Entry[] {
  const absolute = path.join(domainRoot, file);
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isFile()) invalid(file, "通常ファイルとして保存してください。");

  let value: unknown;
  try {
    value = parseJsonText(fs.readFileSync(absolute, "utf8"), file);
  } catch {
    invalid(file, "JSON の構文を確認してください。");
  }
  if (!Array.isArray(value)) invalid(file, "参照先を登録するオブジェクトの配列を指定してください。");

  const entries = value.map((entry, index) => parseEntry(entry, index, file));
  const aliases = new Set<string>();
  const pluginIds = new Set<string>();
  for (const entry of entries) {
    if (entry.alias && aliases.has(entry.alias)) invalid(file, `alias ${entry.alias} が重複しています。`);
    if (entry.pluginId && pluginIds.has(entry.pluginId)) invalid(file, `pluginId ${entry.pluginId} が重複しています。`);
    if (entry.alias) aliases.add(entry.alias);
    if (entry.pluginId) pluginIds.add(entry.pluginId);
  }
  return entries;
}

function mergeSources(shared: Entry[], local: Entry[]): Entry[] {
  const usedLocal = new Set<Entry>();
  const merged: Entry[] = [];
  for (const entry of shared) {
    const matches = local.filter((candidate) =>
      (entry.pluginId !== undefined && candidate.pluginId === entry.pluginId)
      || (entry.alias !== undefined && candidate.alias === entry.alias)
    );
    if (matches.length > 1) invalid(LOCAL_PLUGIN_SOURCES, "同じ共有項目に対応する個人用参照が複数あります。");
    const override = matches[0];
    if (!override) {
      merged.push(entry);
      continue;
    }
    if (usedLocal.has(override)) invalid(LOCAL_PLUGIN_SOURCES, "個人用の参照先が複数の共有項目に一致します。");
    if (entry.pluginId && override.pluginId && entry.pluginId !== override.pluginId) {
      invalid(LOCAL_PLUGIN_SOURCES, `alias ${entry.alias ?? "（未設定）"} の個人用 pluginId が共有台帳と一致しません。`);
    }
    usedLocal.add(override);
    merged.push({
      ...entry,
      ...override,
      alias: override.alias ?? entry.alias,
      pluginId: override.pluginId ?? entry.pluginId,
      sourceFile: LOCAL_PLUGIN_SOURCES
    });
  }
  for (const entry of local) {
    if (!usedLocal.has(entry)) merged.push(entry);
  }

  const aliases = new Set<string>();
  const pluginIds = new Set<string>();
  for (const entry of merged) {
    if (entry.alias && aliases.has(entry.alias)) invalid(entry.sourceFile, `alias ${entry.alias} が共有台帳・個人用台帳間で重複しています。`);
    if (entry.pluginId && pluginIds.has(entry.pluginId)) invalid(entry.sourceFile, `pluginId ${entry.pluginId} が共有台帳・個人用台帳間で重複しています。`);
    if (entry.alias) aliases.add(entry.alias);
    if (entry.pluginId) pluginIds.add(entry.pluginId);
  }
  return merged;
}

function readInstalledPlugins(domainRoot: string): InstalledPlugin[] {
  const file = path.join(domainRoot, PLUGIN_INSTALLED);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isFile()) invalid(PLUGIN_INSTALLED, "通常ファイルとして保存してください。");

  let value: unknown;
  try {
    value = parseJsonText(fs.readFileSync(file, "utf8"), PLUGIN_INSTALLED);
  } catch {
    invalid(PLUGIN_INSTALLED, "JSON の構文を確認してください。");
  }
  if (!isObject(value) || !Array.isArray(value.plugins)) invalid(PLUGIN_INSTALLED, "plugins 配列を持つオブジェクトを指定してください。");
  const ids = new Set<string>();
  for (const plugin of value.plugins) {
    if (!isObject(plugin) || typeof plugin.id !== "string" || !PLUGIN_ID_PATTERN.test(plugin.id)
      || typeof plugin.name !== "string" || typeof plugin.description !== "string"
      || typeof plugin.isMarketPlugin !== "boolean" || typeof plugin.version !== "string" || ids.has(plugin.id)) {
      invalid(PLUGIN_INSTALLED, "plugins 配列に不正または重複した項目があります。");
    }
    ids.add(plugin.id);
  }
  return value.plugins as InstalledPlugin[];
}

export function findPluginSource(lookup: Lookup, domainRoot = process.cwd()): PluginSourceResult {
  const byName = "name" in lookup;
  const key = byName ? lookup.name : lookup.id;
  if (!ID_PATTERN.test(key)) {
    throw new Error(`${byName ? "--name にはalias" : "--id にはプラグインID"}（半角英数字・ハイフン・アンダースコア）を指定してください。`);
  }
  if (!byName && (!PLUGIN_ID_PATTERN.test(key) || key === PROVISIONAL_ID)) {
    throw new Error("--id には確認済みの小文字32文字のプラグインIDを指定してください。IDが分からない場合は登録した alias で照会してください。");
  }

  const queryIdentity: Identity = byName ? { name: key, pluginId: null } : { pluginId: key };
  const root = path.join(domainRoot, PLUGINS_DIR);
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat) return { ...queryIdentity, status: "unregistered" };
  if (!rootStat.isDirectory()) invalid(PLUGINS_DIR, "通常のディレクトリを使ってください。");

  const entries = mergeSources(readSourceFile(domainRoot, PLUGIN_SOURCES), readSourceFile(domainRoot, LOCAL_PLUGIN_SOURCES));
  const entry = entries.find((candidate) => byName ? candidate.alias === key : candidate.pluginId === key);
  if (!entry) {
    if (byName) return { ...queryIdentity, status: "unregistered" };
    const installed = readInstalledPlugins(domainRoot).find((plugin) => plugin.id === key);
    if (!installed) return { ...queryIdentity, status: "unregistered" };
    return {
      ...queryIdentity,
      status: "no-source",
      sourceFile: PLUGIN_INSTALLED,
      displayName: installed.name,
      version: installed.version
    };
  }

  const identity: Identity = byName
    ? { name: key, pluginId: entry.pluginId ?? null }
    : { pluginId: key };
  const { alias, source, sourceFile } = entry;
  const resultAlias = alias === undefined ? {} : { alias };
  if ("githubUrl" in source) return { ...identity, ...resultAlias, status: "found", sourceFile, ...source };

  const destination = path.resolve(root, source.path);
  let resolved: string;
  try {
    resolved = fs.realpathSync(destination);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ...identity, ...resultAlias, status: "missing-path", sourceFile, path: destination };
    }
    throw error;
  }
  if (!isNativeAbsolute(source.path)) {
    const relative = path.relative(fs.realpathSync(root), resolved);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      invalid(sourceFile, `${alias ?? "pluginId"} の相対パスの参照先は ${PLUGINS_DIR}/ 配下に置いてください。`);
    }
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile() && !stat.isDirectory()) invalid(sourceFile, `${alias ?? "pluginId"} の参照先はファイルまたはフォルダにしてください。`);
  return { ...identity, ...resultAlias, status: "found", sourceFile, path: resolved };
}
