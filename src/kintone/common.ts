import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { parseJsonText } from "../fsutil.js";
import { kintoneCommonRootPath } from "../paths.js";
import { listZipEntries, readZipEntry, ZIP_MAX_ENTRIES } from "../zipRead.js";
import { KintoneClient } from "./client.js";
import { listInstalledPlugins, writeInstalledPlugins } from "./installedPlugins.js";
import { recordLocalAction } from "../runLog.js";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 200 * 1024 * 1024;
const PLUGIN_REQUIRED_FILE = path.join("plugins", "required.json");
const JSON_UTF8 = new TextDecoder("utf-8", { fatal: true });

type JsonObject = Record<string, unknown>;

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "en");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const object = value as JsonObject;
    return Object.fromEntries(Object.keys(object).sort(compareText).map((key) => [key, stableValue(object[key])]));
  }
  return value;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(stableValue(value), null, 2)}\n`, "utf8");
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizedParts(relative: string, label: string): string[] {
  const normalized = relative.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0")) {
    throw new Error(`${label}: 絶対パスまたは空のパスは使えません: ${relative}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label}: 相対パスに不正な要素があります: ${relative}`);
  }
  return parts;
}

function assertNoSymlink(pathname: string, label: string): void {
  const absolute = path.resolve(pathname);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const rest = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of rest) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`${label}: シンボリックリンクは使えません: ${current}`);
  }
}

function assertRegularFile(filePath: string, label: string): void {
  assertNoSymlink(filePath, label);
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${label}: 通常ファイルが必要です: ${filePath}`);
}

function safeInputPath(root: string, relative: string, label: string): string {
  const parts = normalizedParts(relative, label);
  const filePath = path.resolve(root, ...parts);
  if (!isWithin(root, filePath)) throw new Error(`${label}: 取り込み元の外を指すパスです: ${relative}`);
  assertRegularFile(filePath, label);
  return filePath;
}

function ensureSafeDirectory(directory: string, label: string): void {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const rest = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of rest) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`${label}: シンボリックリンクは使えません: ${current}`);
    if (stat && !stat.isDirectory()) throw new Error(`${label}: ディレクトリではありません: ${current}`);
    if (!stat) fs.mkdirSync(current);
  }
}

function outputPath(root: string, relative: string, label: string): string {
  const parts = normalizedParts(relative, label);
  const target = path.resolve(root, ...parts);
  if (!isWithin(root, target)) throw new Error(`${label}: 出力先の外を指すパスです: ${relative}`);
  assertNoSymlink(target, label);
  return target;
}

function writeAtomic(filePath: string, bytes: Buffer, label: string, mayReplace: boolean): "written" | "unchanged" {
  const parent = path.dirname(filePath);
  ensureSafeDirectory(parent, label);
  const previous = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (previous?.isSymbolicLink() || (previous && !previous.isFile())) {
    throw new Error(`${label}: 通常ファイル以外は上書きできません: ${filePath}`);
  }
  if (previous?.isFile()) {
    const oldBytes = fs.readFileSync(filePath);
    if (oldBytes.equals(bytes)) return "unchanged";
    if (!mayReplace) throw new Error(`${label}: 既存の未管理ファイルを上書きできません: ${filePath}`);
  }
  const temporary = path.join(parent, `.kint-origin-${randomUUID()}.tmp`);
  try {
    recordLocalAction("write-common-export", filePath, { bytes: bytes.length });
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return "written";
}

function removeManagedFile(root: string, relative: string, label: string, removed: string[], dryRun = false): void {
  const target = outputPath(root, relative, label);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label}: 管理対象の通常ファイルではありません: ${target}`);
  if (dryRun) return;
  fs.unlinkSync(target);
  removed.push(relative.replaceAll("\\", "/"));
}

function readInputJson(root: string, relative: string, label: string): unknown {
  const filePath = safeInputPath(root, relative, label);
  let text: string;
  try {
    text = JSON_UTF8.decode(fs.readFileSync(filePath)).replace(/^\uFEFF/, "");
  } catch {
    throw new Error(`${label}: UTF-8 の JSON ファイルが必要です。`);
  }
  return parseJsonText(text, filePath);
}

function readOutputJson(root: string, relative: string, label: string): unknown | undefined {
  const filePath = outputPath(root, relative, label);
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error(`${label}: 管理対象の通常ファイルではありません: ${filePath}`);
  return parseJsonText(fs.readFileSync(filePath, "utf8"), filePath);
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label}: 文字列の配列が必要です。`);
  }
  return value as string[];
}

function customizeEntries(manifest: unknown, label: string): { files: string[]; normalized: JsonObject } {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`${label}: JSON オブジェクトが必要です。`);
  const value = manifest as JsonObject;
  if (!["ALL", "ADMIN", "NONE"].includes(String(value.scope))) throw new Error(`${label}: scope は ALL / ADMIN / NONE のいずれかです。`);
  const files = new Set<string>();
  const normalized: JsonObject = { ...value, scope: value.scope };
  for (const platform of ["desktop", "mobile"] as const) {
    const source = value[platform];
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error(`${label}: ${platform} の js/css 配列が必要です。`);
    const section = source as JsonObject;
    const target: JsonObject = {};
    for (const kind of ["js", "css"] as const) {
      const entries = stringList(section[kind], `${label}: ${platform}.${kind}`);
      target[kind] = entries.map((entry) => {
        if (/^https?:\/\//i.test(entry)) {
          try {
            const url = new URL(entry);
            if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
          } catch {
            throw new Error(`${label}: 有効な http(s) URL ではありません: ${entry}`);
          }
          return entry;
        }
        const parts = normalizedParts(entry, label);
        const rel = parts.join("/");
        if (parts[0] !== platform || parts[1] !== kind || path.posix.extname(rel).toLowerCase() !== `.${kind}`) {
          throw new Error(`${label}: ${platform}/${kind} 以下の .${kind} ファイルを指定してください: ${entry}`);
        }
        files.add(rel);
        return rel;
      });
    }
    normalized[platform] = target;
  }
  return { files: [...files].sort(compareText), normalized };
}

function assertPortableNames(current: string[], previous: string[], label: string): void {
  const byFoldedName = new Map<string, string>();
  for (const name of current) {
    const folded = name.toLocaleLowerCase("en-US");
    const existing = byFoldedName.get(folded);
    if (existing && existing !== name) throw new Error(`${label}: Windows で同じ名前になるファイルを複数指定できません: ${existing} / ${name}`);
    byFoldedName.set(folded, name);
  }
  const previousByFoldedName = new Map(previous.map((name) => [name.toLocaleLowerCase("en-US"), name]));
  for (const name of current) {
    const old = previousByFoldedName.get(name.toLocaleLowerCase("en-US"));
    if (old && old !== name) throw new Error(`${label}: ファイル名の大文字・小文字だけを変更する同期はできません: ${old} -> ${name}`);
  }
}

function templateArchiveBase(file: string): string {
  return file.replace(/\.(?:zip|sptpl)$/i, "");
}

interface TemplateInput {
  category: "apps" | "spaces";
  names: string[];
  archives: Array<{ file: string; bytes: Buffer; jsonFiles: Array<{ path: string; bytes: Buffer }> }>;
}

function readTemplateInput(root: string, category: "apps" | "spaces"): TemplateInput | undefined {
  const relativeDir = `templates/${category}`;
  const directory = path.join(root, ...relativeDir.split("/"));
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${relativeDir}: 通常ディレクトリが必要です。`);
  const index = readInputJson(root, `${relativeDir}/index.json`, `${relativeDir}/index.json`);
  if (!index || typeof index !== "object" || Array.isArray(index)) throw new Error(`${relativeDir}/index.json: JSON オブジェクトが必要です。`);
  const names = stringList((index as JsonObject).archives, `${relativeDir}/index.json の archives`);
  if (new Set(names).size !== names.length) throw new Error(`${relativeDir}/index.json: archives に重複があります。`);
  const archives: TemplateInput["archives"] = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:zip|sptpl)$/i.test(name) || name.startsWith(".")) {
      throw new Error(`${relativeDir}/index.json: zip / sptpl 名は安全なファイル名にしてください: ${name}`);
    }
    const inputPath = safeInputPath(root, `${relativeDir}/${name}`, `${relativeDir}/${name}`);
    const bytes = fs.readFileSync(inputPath);
    if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error(`${relativeDir}/${name}: zip は 100 MB 以下にしてください。`);
    const entries = listZipEntries(bytes);
    if (entries.length > ZIP_MAX_ENTRIES) throw new Error(`${relativeDir}/${name}: zip のエントリ数が上限を超えています。`);
    const seen = new Set<string>();
    let total = 0;
    const jsonFiles: TemplateInput["archives"][number]["jsonFiles"] = [];
    for (const entry of entries) {
      const normalizedName = entry.name.replaceAll("\\", "/");
      const isDirectory = normalizedName.endsWith("/");
      const relative = isDirectory ? normalizedName.slice(0, -1) : normalizedName;
      normalizedParts(relative, `${relativeDir}/${name} の zip エントリ`);
      if (seen.has(relative)) throw new Error(`${relativeDir}/${name}: zip に重複エントリがあります: ${relative}`);
      seen.add(relative);
      if (entry.size > MAX_ARCHIVE_ENTRY_BYTES) throw new Error(`${relativeDir}/${name}: エントリ ${relative} は 20 MB 以下にしてください。`);
      total += entry.size;
      if (total > MAX_ARCHIVE_TOTAL_BYTES) throw new Error(`${relativeDir}/${name}: 展開後合計サイズは 200 MB 以下にしてください。`);
      if (isDirectory || !/\.json$/i.test(relative)) continue;
      const body = readZipEntry(bytes, entry, MAX_ARCHIVE_ENTRY_BYTES);
      let parsed: unknown;
      try {
        parsed = parseJsonText(JSON_UTF8.decode(body), `${name}:${relative}`);
      } catch (error) {
        throw new Error(`${relativeDir}/${name}: ${relative} の JSON を読めません: ${error instanceof Error ? error.message : String(error)}`);
      }
      jsonFiles.push({ path: relative, bytes: jsonBytes(parsed) });
    }
    jsonFiles.sort((a, b) => compareText(a.path, b.path));
    archives.push({ file: name, bytes, jsonFiles });
  }
  return { category, names, archives };
}

function zipEquivalent(left: Buffer, right: Buffer): boolean {
  try {
    const signature = (bytes: Buffer) => listZipEntries(bytes)
      .map((entry) => `${entry.name.replaceAll("\\", "/")}\0${entry.size}\0${entry.crc32}`)
      .sort(compareText)
      .join("\n");
    return signature(left) === signature(right);
  } catch {
    return false;
  }
}

function oldTemplateIndex(root: string, category: "apps" | "spaces"): Array<{ file: string; jsonFiles: string[] }> {
  const relative = `templates/${category}/index.json`;
  const value = readOutputJson(root, relative, relative);
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${relative}: 既存の管理索引が不正です。`);
  const archives = (value as JsonObject).archives;
  if (!Array.isArray(archives)) throw new Error(`${relative}: 既存の管理索引に archives がありません。`);
  return archives.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${relative}: 既存の archive 情報が不正です。`);
    const record = item as JsonObject;
    if (typeof record.file !== "string") throw new Error(`${relative}: 既存の archive 名が不正です。`);
    return { file: record.file, jsonFiles: stringList(record.jsonFiles, `${relative}: jsonFiles`) };
  });
}

function writeTracked(
  root: string,
  relative: string,
  bytes: Buffer,
  tracked: Set<string>,
  written: string[],
  skipped: string[],
  dryRun = false
): void {
  const target = outputPath(root, relative, relative);
  if (dryRun) {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) throw new Error(`${relative}: 通常ファイル以外は上書きできません: ${target}`);
    if (stat?.isFile() && !fs.readFileSync(target).equals(bytes) && !tracked.has(relative)) {
      throw new Error(`${relative}: 既存の未管理ファイルを上書きできません: ${target}`);
    }
    return;
  }
  const result = writeAtomic(target, bytes, relative, tracked.has(relative));
  (result === "written" ? written : skipped).push(relative.replaceAll("\\", "/"));
}

function importCustomize(root: string, outputRoot: string, written: string[], skipped: string[], removed: string[], dryRun = false): void {
  const inputDir = path.join(root, "customize");
  const dirStat = fs.lstatSync(inputDir, { throwIfNoEntry: false });
  if (!dirStat) return;
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error("customize: 通常ディレクトリが必要です。");
  const manifestPath = "customize/customize-manifest.json";
  const parsed = readInputJson(root, manifestPath, manifestPath);
  const { files, normalized } = customizeEntries(parsed, manifestPath);
  const previousPath = "customize/customize-manifest.json";
  const previous = readOutputJson(outputRoot, previousPath, previousPath);
  const previousFiles = previous === undefined ? [] : customizeEntries(previous, previousPath).files;
  assertPortableNames(files, previousFiles, manifestPath);
  const tracked = new Set([previousPath, ...previousFiles.map((file) => `customize/${file}`)]);
  const rootCustomize = path.join(root, "customize");
  const assets = files.map((relative) => {
    const source = safeInputPath(rootCustomize, relative, `customize/${relative}`);
    const bytes = fs.readFileSync(source);
    let text: string;
    try {
      text = JSON_UTF8.decode(bytes).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    } catch {
      throw new Error(`customize/${relative}: UTF-8 のテキストファイルが必要です。`);
    }
    return { relative: `customize/${relative}`, bytes: Buffer.from(text, "utf8") };
  });
  for (const asset of assets) writeTracked(outputRoot, asset.relative, asset.bytes, tracked, written, skipped, dryRun);
  for (const stale of previousFiles.filter((file) => !files.includes(file))) removeManagedFile(outputRoot, `customize/${stale}`, "customize", removed, dryRun);
  writeTracked(outputRoot, previousPath, jsonBytes(normalized), tracked, written, skipped, dryRun);
}

function importSettings(root: string, outputRoot: string, written: string[], skipped: string[], removed: string[], dryRun = false): void {
  const inputDir = path.join(root, "settings");
  const dirStat = fs.lstatSync(inputDir, { throwIfNoEntry: false });
  if (!dirStat) return;
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error("settings: 通常ディレクトリが必要です。");
  const names = fs.readdirSync(inputDir, { withFileTypes: true }).filter((item) => item.isFile() && item.name.toLowerCase().endsWith(".json")).map((item) => item.name).sort(compareText);
  if (names.some((name) => name.toLowerCase() === "index.json")) throw new Error("settings/index.json は取り込み元で使えません。");
  for (const item of fs.readdirSync(inputDir, { withFileTypes: true })) {
    if (item.isSymbolicLink() || (item.isDirectory() && item.name !== ".gitkeep")) throw new Error(`settings/${item.name}: 通常の JSON ファイルだけを置いてください。`);
  }
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/i.test(name)) throw new Error(`settings/${name}: 安全な JSON ファイル名ではありません。`);
  }
  const previousPath = "settings/index.json";
  const previousIndex = readOutputJson(outputRoot, previousPath, previousPath);
  let previousFiles: string[] = [];
  if (previousIndex !== undefined) {
    if (!previousIndex || typeof previousIndex !== "object" || Array.isArray(previousIndex)) throw new Error(`${previousPath}: 既存の管理索引が不正です。`);
    previousFiles = stringList((previousIndex as JsonObject).files, `${previousPath}: files`);
  }
  assertPortableNames(names, previousFiles, "settings");
  const tracked = new Set([previousPath, ...previousFiles.map((name) => `settings/${name}`)]);
  for (const name of names) {
    const value = readInputJson(root, `settings/${name}`, `settings/${name}`);
    writeTracked(outputRoot, `settings/${name}`, jsonBytes(value), tracked, written, skipped, dryRun);
  }
  for (const stale of previousFiles.filter((name) => !names.includes(name))) removeManagedFile(outputRoot, `settings/${stale}`, "settings", removed, dryRun);
  writeTracked(outputRoot, previousPath, jsonBytes({ files: names }), tracked, written, skipped, dryRun);
}

function importTemplateCategory(
  input: TemplateInput | undefined,
  outputRoot: string,
  written: string[],
  skipped: string[],
  removed: string[],
  dryRun = false
): void {
  if (!input) return;
  const category = input.category;
  const previousIndexPath = `templates/${category}/index.json`;
  const previous = oldTemplateIndex(outputRoot, category);
  assertPortableNames(input.archives.map((archive) => archive.file), previous.map((archive) => archive.file), `templates/${category}`);
  const previousByFile = new Map(previous.map((archive) => [archive.file, archive]));
  const currentFiles = new Set(input.archives.map((archive) => archive.file));
  const plannedFiles = [previousIndexPath];
  for (const archive of input.archives) {
    const zipPath = `templates/${category}/${archive.file}`;
    const extractedRoot = `templates/${category}/${templateArchiveBase(archive.file)}`;
    plannedFiles.push(zipPath, ...archive.jsonFiles.map((item) => `${extractedRoot}/${item.path}`));
  }
  const planned = new Map<string, string>();
  for (const file of plannedFiles) {
    const folded = file.toLocaleLowerCase("en-US");
    const same = planned.get(folded);
    if (same && same !== file) throw new Error(`templates/${category}: Windows で同じパスになる出力があります: ${same} / ${file}`);
    planned.set(folded, file);
  }
  for (const file of plannedFiles) {
    const folded = file.toLocaleLowerCase("en-US");
    const parts = folded.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = parts.slice(0, index).join("/");
      if (planned.has(ancestor)) throw new Error(`templates/${category}: ファイルと展開先のパスが衝突します: ${planned.get(ancestor)} / ${file}`);
    }
  }
  for (const archive of input.archives) {
    const zipPath = `templates/${category}/${archive.file}`;
    const extractedRoot = `templates/${category}/${templateArchiveBase(archive.file)}`;
    const old = previousByFile.get(archive.file);
    const oldZipPath = outputPath(outputRoot, zipPath, zipPath);
    const previousZipStat = fs.lstatSync(oldZipPath, { throwIfNoEntry: false });
    if (previousZipStat?.isFile() && old && zipEquivalent(fs.readFileSync(oldZipPath), archive.bytes)) {
      if (!dryRun) {
        skipped.push(zipPath);
      }
    } else {
      const tracked = new Set(old ? [zipPath] : []);
      writeTracked(outputRoot, zipPath, archive.bytes, tracked, written, skipped, dryRun);
    }
    const oldJson = new Set((old?.jsonFiles ?? []).map((file) => `${extractedRoot}/${file}`));
    for (const jsonFile of archive.jsonFiles) {
      const relative = `${extractedRoot}/${jsonFile.path}`;
      writeTracked(outputRoot, relative, jsonFile.bytes, oldJson, written, skipped, dryRun);
    }
    for (const stale of oldJson) {
      const key = stale.slice(extractedRoot.length + 1);
      if (!archive.jsonFiles.some((item) => item.path === key)) removeManagedFile(outputRoot, stale, `templates/${category}`, removed, dryRun);
    }
  }
  for (const stale of previous.filter((archive) => !currentFiles.has(archive.file))) {
    const zipPath = `templates/${category}/${stale.file}`;
    removeManagedFile(outputRoot, zipPath, `templates/${category}`, removed, dryRun);
    const extractedRoot = `templates/${category}/${templateArchiveBase(stale.file)}`;
    for (const jsonFile of stale.jsonFiles) removeManagedFile(outputRoot, `${extractedRoot}/${jsonFile}`, `templates/${category}`, removed, dryRun);
  }
  const index = {
    archives: input.archives.map((archive) => ({ file: archive.file, jsonFiles: archive.jsonFiles.map((item) => item.path) }))
  };
  writeTracked(outputRoot, previousIndexPath, jsonBytes(index), new Set([previousIndexPath]), written, skipped, dryRun);
}

export interface CommonPullSummary {
  installedPlugins: number;
  requiredPlugins: number;
  apiCalls: number;
  written: string[];
}

export async function pullCommon(): Promise<CommonPullSummary> {
  const client = new KintoneClient();
  const [installed, required] = await Promise.all([listInstalledPlugins(client), client.listRequiredPlugins()]);
  const requiredPlugins = required.plugins
    .map((plugin) => {
      if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) throw new Error("必須プラグイン一覧 API の応答に不正な項目があります。");
      return plugin as JsonObject;
    })
    .sort((a, b) => compareText(String(a.id ?? ""), String(b.id ?? "")));
  writeInstalledPlugins(installed.plugins);
  const commonRoot = kintoneCommonRootPath();
  const requiredPath = path.join(commonRoot, PLUGIN_REQUIRED_FILE);
  assertNoSymlink(requiredPath, "共通プラグイン設定");
  const targetStat = fs.lstatSync(requiredPath, { throwIfNoEntry: false });
  if (targetStat && !targetStat.isFile()) throw new Error(`共通プラグイン設定は通常ファイルではありません: ${requiredPath}`);
  writeAtomic(requiredPath, jsonBytes({ plugins: requiredPlugins }), "共通プラグイン設定", true);
  return {
    installedPlugins: installed.plugins.length,
    requiredPlugins: requiredPlugins.length,
    apiCalls: installed.apiCalls + required.apiCalls,
    written: ["data/kintone/plugin/installed.json", "data/kintone/common/plugins/required.json"]
  };
}

export interface CommonCaptureSummary {
  mode: "manual";
  captureRoot: string;
  written: string[];
  unchanged: string[];
  removed: string[];
}

export function importCommonCapture(source: string): CommonCaptureSummary {
  const captureRoot = path.resolve(process.cwd(), source);
  const displayRoot = isWithin(process.cwd(), captureRoot) ? `${path.relative(process.cwd(), captureRoot).replaceAll("\\", "/")}/` : captureRoot;
  const stat = fs.lstatSync(captureRoot, { throwIfNoEntry: false });
  if (!stat) throw new Error(`${displayRoot}: 取り込み元ディレクトリがありません。`);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${displayRoot}: 通常ディレクトリである必要があります。`);

  const outputRoot = kintoneCommonRootPath();
  const written: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];
  // 入力全体を先に検証し、形式エラーで既存の data/ を途中まで更新しない。
  const templates = [readTemplateInput(captureRoot, "apps"), readTemplateInput(captureRoot, "spaces")];
  importCustomize(captureRoot, outputRoot, [], [], [], true);
  importSettings(captureRoot, outputRoot, [], [], [], true);
  for (const item of templates) importTemplateCategory(item, outputRoot, [], [], [], true);
  importCustomize(captureRoot, outputRoot, written, unchanged, removed);
  importSettings(captureRoot, outputRoot, written, unchanged, removed);
  for (const item of templates) importTemplateCategory(item, outputRoot, written, unchanged, removed);
  return {
    mode: "manual",
    captureRoot: displayRoot,
    written,
    unchanged,
    removed
  };
}
