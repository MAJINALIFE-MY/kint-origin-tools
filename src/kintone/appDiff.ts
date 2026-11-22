// アプリ設定の反映計画。環境へ問い合わせず、Git の基準と pull 状態・作業ツリーを比較する。

import fs from "node:fs";
import path from "node:path";

import { readJsonIfExists } from "../fsutil.js";
import { log } from "../log.js";
import { runGit } from "../git.js";
import { canonicalJson } from "../normalize.js";
import { createAppRefResolver, resolveAppRefsDeep } from "./appDraft.js";
import { readAppIndex } from "./appIndex.js";
import { customizeManifestPath, manifestFiles, manifestOutsideEntries } from "./customize.js";
import { resolveCustomizeAppDir } from "./customize.js";
import { hashBytes, hashJson, readPullState } from "./pullState.js";
import { diffFieldProperties, isErrorStub, PUSHABLE_FILES, type FieldsDiff } from "./pushItems.js";

export type ResourceState = "same" | "local" | "skipped";

export interface ResourceDiff {
  key: string;
  /** `folder/file` */
  file: string;
  state: ResourceState;
  reason?: string;
}

export interface CustomizeDiff {
  state: ResourceState;
  reason?: string;
  added: string[];
  removed: string[];
  changed: string[];
  /** customize.json の置換単位。変更グループ内の FILE は全て再アップロードする。 */
  groups: string[];
}

export interface AppDiff {
  appId: string;
  name: string;
  guestSpaceId: string;
  appDir: string;
  baseCommit: string;
  pullState: boolean;
  resources: ResourceDiff[];
  fields?: FieldsDiff;
  customize: CustomizeDiff;
}

export interface AppInspection {
  diff: AppDiff;
  /** 送信計画に使う作業ツリー上の値 */
  locals: Map<string, any>;
  /** pull 状態と一致する Git 基準コミット上の値 */
  baselines: Map<string, any>;
  /** push 後に同じファイルを利用者が編集していないか照合するためのハッシュ */
  workingHashes: Map<string, string>;
}

type AppRefResolver = (ref: string) => string;

interface GitContext {
  root: string;
  appPath: string;
  commit: string;
  changedPaths: Set<string>;
}

interface HashUnit {
  hash: string;
  manifestHash: string;
  files: Record<string, string>;
}

function gitOutput(root: string, args: string[], label: string): string {
  const result = runGit(root, args, { logOutput: false });
  if (result.error || result.status !== 0) {
    const message = result.stderr?.trim() || result.error?.message || "Git コマンドに失敗しました";
    throw new Error(`${label}: ${message}`);
  }
  return result.stdout ?? "";
}

function createGitContext(appDir: string, baseRef: string): GitContext {
  const root = gitOutput(process.cwd(), ["rev-parse", "--show-toplevel"], "アプリの Git リポジトリを特定できません").trim();
  if (!root) throw new Error("アプリの Git リポジトリを特定できません。");
  const resolvedRoot = path.resolve(root);
  const resolvedAppDir = path.resolve(appDir);
  const appPath = path.relative(resolvedRoot, resolvedAppDir).replaceAll(path.sep, "/");
  if (!appPath || appPath === ".." || appPath.startsWith("../") || path.isAbsolute(appPath)) {
    throw new Error(`アプリのデータが Git リポジトリ内にありません: ${appDir}`);
  }

  const commit = gitOutput(
    resolvedRoot,
    ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
    `Git 基準をコミットとして解決できません: ${baseRef}`
  ).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error(`Git 基準のコミット ID が不正です: ${baseRef}`);

  const unmerged = gitOutput(resolvedRoot, ["ls-files", "-u", "-z", "--", appPath], "Git の競合状態を確認できません");
  if (unmerged) throw new Error(`アプリの取得ファイルに Git の未解決競合があります: ${appPath}`);

  const tracked = gitOutput(
    resolvedRoot,
    ["diff", "--name-only", "-z", "--no-renames", commit, "--", appPath],
    "Git の変更ファイルを確認できません"
  );
  const untracked = gitOutput(
    resolvedRoot,
    ["ls-files", "--others", "--exclude-standard", "-z", "--", appPath],
    "Git の未追跡ファイルを確認できません"
  );
  const changedPaths = new Set(`${tracked}${untracked}`.split("\0").filter(Boolean));
  return { root: resolvedRoot, appPath, commit, changedPaths };
}

function gitPath(context: GitContext, appRelativePath: string): string {
  return `${context.appPath}/${appRelativePath.replaceAll(path.sep, "/")}`;
}

function readGitBlob(context: GitContext, appRelativePath: string): string | undefined {
  const spec = `${context.commit}:${gitPath(context, appRelativePath)}`;
  const exists = runGit(context.root, ["cat-file", "-e", spec], { logOutput: false });
  if (exists.status !== 0) {
    if (exists.error) throw new Error(`Git 基準のファイルを確認できません: ${appRelativePath}`);
    return undefined;
  }
  return gitOutput(context.root, ["show", spec], `Git 基準のファイルを読み込めません: ${appRelativePath}`);
}

function readGitJson(context: GitContext, appRelativePath: string): any | undefined {
  const text = readGitBlob(context, appRelativePath);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Git 基準の JSON を読み込めません: ${appRelativePath} (${message})`);
  }
}

function ensureLocalFile(appDir: string, file: string): void {
  const fullPath = path.resolve(appDir, file);
  const relative = path.relative(path.resolve(appDir), fullPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`アプリの範囲外を参照しています: ${file}`);
  }
  const stat = fs.lstatSync(fullPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`通常ファイルではありません: ${file}`);
  const realRoot = fs.realpathSync(appDir);
  const realFile = fs.realpathSync(fullPath);
  const realRelative = path.relative(realRoot, realFile);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`アプリの範囲外を参照しています: ${file}`);
  }
}

function parseLocalJson(appDir: string, file: string): any | undefined {
  const fullPath = path.join(appDir, file);
  if (!fs.existsSync(fullPath)) return undefined;
  ensureLocalFile(appDir, file);
  try {
    return readJsonIfExists(fullPath) as any;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: ${message}`);
  }
}

function isIgnored(root: string, gitRelativePath: string): boolean {
  const result = runGit(root, ["check-ignore", "-q", "--", gitRelativePath], { logOutput: false });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`Git の除外状態を確認できません: ${gitRelativePath}`);
}

function validateCustomizeManifest(manifest: any): void {
  const outside = manifestOutsideEntries(manifest);
  if (outside.length) {
    throw new Error(`customize のマニフェストに範囲外のファイルがあります: ${outside.join(", ")}`);
  }
}

function manifestHashUnit(manifest: any, readFileHash: (rel: string) => string | undefined): HashUnit {
  const manifestHash = hashJson(manifest);
  const files: Record<string, string> = {};
  for (const rel of manifestFiles(manifest).sort((a, b) => a.localeCompare(b, "en"))) {
    files[rel] = readFileHash(rel) ?? "(missing)";
  }
  const hash = hashBytes(Buffer.from(canonicalJson({ manifest: manifestHash, files }), "utf8"));
  return { hash, manifestHash, files };
}

function localCustomizeUnit(appDir: string, manifest: any): HashUnit {
  return manifestHashUnit(manifest, (rel) => {
    const file = `customize/${rel}`;
    const fullPath = path.join(appDir, file);
    if (!fs.existsSync(fullPath)) return undefined;
    ensureLocalFile(appDir, file);
    return hashBytes(fs.readFileSync(fullPath));
  });
}

function gitCustomizeUnit(context: GitContext, manifest: any): HashUnit {
  return manifestHashUnit(manifest, (rel) => {
    const text = readGitBlob(context, `customize/${rel}`);
    return text === undefined ? undefined : hashBytes(Buffer.from(text, "utf8"));
  });
}

const CUSTOMIZE_GROUPS = ["desktop.js", "desktop.css", "mobile.js", "mobile.css"] as const;

function customizeGroupsChanged(localManifest: any, baseManifest: any, local: HashUnit, base: HashUnit): string[] {
  const scopeChanged = localManifest?.scope !== baseManifest?.scope;
  const groups = CUSTOMIZE_GROUPS.filter((group) => {
    if (scopeChanged) return true;
    const [platform, type] = group.split(".");
    const localEntries = Array.isArray(localManifest?.[platform]?.[type]) ? localManifest[platform][type] : [];
    const baseEntries = Array.isArray(baseManifest?.[platform]?.[type]) ? baseManifest[platform][type] : [];
    if (canonicalJson(localEntries) !== canonicalJson(baseEntries)) return true;
    const paths = new Set([
      ...localEntries.filter((entry: unknown): entry is string => typeof entry === "string" && !/^https?:\/\//i.test(entry)),
      ...baseEntries.filter((entry: unknown): entry is string => typeof entry === "string" && !/^https?:\/\//i.test(entry))
    ].map((entry) => entry.replaceAll("\\", "/").replace(/^\.\//, "")));
    return [...paths].some((rel) => local.files[rel] !== base.files[rel]);
  });
  // scope 以外の未知のマニフェスト項目も customize 設定に影響する可能性があるため、全グループを反映する。
  const knownKeys = new Set(["scope", "desktop", "mobile"]);
  const extraLocal = Object.keys(localManifest ?? {}).some((key) => !knownKeys.has(key));
  const extraBase = Object.keys(baseManifest ?? {}).some((key) => !knownKeys.has(key));
  if (extraLocal || extraBase) return [...CUSTOMIZE_GROUPS];
  return groups.length > 0 ? groups : [...CUSTOMIZE_GROUPS];
}

function selectKeys(only?: string[]): Set<string> | undefined {
  if (!only) return undefined;
  const valid = new Set(["customize", ...PUSHABLE_FILES.map((entry) => entry.key)]);
  const unknown = only.filter((key) => !valid.has(key));
  if (unknown.length) throw new Error(`--only に不明なキーがあります: ${unknown.join(", ")}（有効: customize, ${[...valid].filter((key) => key !== "customize").join(", ")}）`);
  return new Set(only);
}

function appName(appDir: string, appId: string): string {
  const metadata = readJsonIfExists(path.join(appDir, "app.json")) as { name?: unknown } | undefined;
  if (typeof metadata?.name === "string" && metadata.name) return metadata.name;
  return readAppIndex().get(appId)?.name ?? "";
}

function resolveRefValue(payload: any, resolver: AppRefResolver, file: string): any {
  try {
    return resolveAppRefsDeep(payload, resolver);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: ${message}`);
  }
}

export function inspectApp({
  appId,
  guestSpaceId = "",
  appDir,
  name = "",
  baseRef = "HEAD",
  only
}: {
  appId: string;
  guestSpaceId?: string;
  appDir: string;
  name?: string;
  baseRef?: string;
  only?: string[];
}): AppInspection {
  const selected = selectKeys(only);
  const state = readPullState(appDir);
  const context = createGitContext(appDir, baseRef);
  const resolver = createAppRefResolver({ createdByName: new Map(), index: readAppIndex() });
  const resources: ResourceDiff[] = [];
  const locals = new Map<string, any>();
  const baselines = new Map<string, any>();
  const workingHashes = new Map<string, string>();
  const changedPaths = context.changedPaths;
  let fields: FieldsDiff | undefined;

  for (const entry of PUSHABLE_FILES) {
    if (selected && !selected.has(entry.key)) continue;
    const file = `${entry.folder}/${entry.file}`;
    const gitFile = gitPath(context, file);
    const localPath = path.join(appDir, file);
    const localExists = fs.existsSync(localPath);
    const wasChanged = changedPaths.has(gitFile);
    if (!localExists) {
      resources.push({ key: entry.key, file, state: "skipped", reason: "ファイルの削除は反映しません" });
      continue;
    }
    const localRaw = parseLocalJson(appDir, file);
    if (isErrorStub(localRaw)) throw new Error(`${file}: pull 失敗の _error スタブは反映できません。pull app で正常な内容を取得してください。`);
    const local = resolveRefValue(localRaw, resolver, file);
    const localHash = hashJson(local);
    const pullHash = state?.files[file];

    if (pullHash && localHash === pullHash) {
      resources.push({ key: entry.key, file, state: "same", reason: wasChanged ? "Git 基準との差分は pull app で取得した内容です" : undefined });
      continue;
    }
    if (!wasChanged) {
      throw new Error(`${file}: pull 後にコミットされた変更を検出しました。編集前のコミットを --base に指定してください。`);
    }
    if (!state || !pullHash) {
      throw new Error(`${file}: pull 状態がありません。pull app で取得してから Git に保存し、編集してください。`);
    }
    const baseRaw = readGitJson(context, file);
    if (baseRaw === undefined) throw new Error(`${file}: Git 基準に pull 済みファイルがありません。pull app の取得結果を先に Git に保存してください。`);
    const baseline = resolveRefValue(baseRaw, resolver, file);
    if (hashJson(baseline) !== pullHash) {
      throw new Error(`${file}: Git 基準が pull app の取得時点と一致しません。取得結果をコミットして、そのコミットを --base に指定してください。`);
    }

    resources.push({ key: entry.key, file, state: "local" });
    locals.set(entry.key, local);
    baselines.set(entry.key, baseline);
    workingHashes.set(entry.key, hashJson(localRaw));
    if (entry.key === "fields") fields = diffFieldProperties(local?.properties, baseline?.properties);
  }

  let customize: CustomizeDiff = { state: "skipped", reason: "--only の対象外", added: [], removed: [], changed: [], groups: [] };
  if (!selected || selected.has("customize")) {
    const manifestFile = "customize/customize-manifest.json";
    const manifestPath = customizeManifestPath(appDir);
    const localManifestExists = fs.existsSync(manifestPath);
    const baseManifestText = readGitBlob(context, manifestFile);
    if (!localManifestExists && baseManifestText === undefined) {
      customize = { state: "same", added: [], removed: [], changed: [], groups: [] };
    } else if (!localManifestExists) {
      customize = { state: "skipped", reason: "customize のマニフェスト削除は反映しません", added: [], removed: [], changed: [], groups: [] };
    } else {
      ensureLocalFile(appDir, manifestFile);
      const localManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
      validateCustomizeManifest(localManifest);
      const localUnit = localCustomizeUnit(appDir, localManifest);
      const pullHash = state?.customize;
      const manifestChanged = changedPaths.has(gitPath(context, manifestFile));
      const allLocalFilePaths = manifestFiles(localManifest).map((rel) => `customize/${rel}`);
      const relevantGitChanges = allLocalFilePaths.some((file) => changedPaths.has(gitPath(context, file)));
      const baseManifest = baseManifestText === undefined ? undefined : JSON.parse(baseManifestText.replace(/^\uFEFF/, ""));

      if (baseManifest) validateCustomizeManifest(baseManifest);
      const baseUnit = baseManifest ? gitCustomizeUnit(context, baseManifest) : undefined;
      if (pullHash && localUnit.hash === pullHash) {
        customize = { state: "same", added: [], removed: [], changed: [], groups: [] };
      } else if (!manifestChanged && !relevantGitChanges) {
        throw new Error("customize: pull 後にコミットされた変更を検出しました。編集前のコミットを --base に指定してください。");
      } else if (!state || !pullHash) {
        throw new Error("customize: pull 状態がありません。pull app で取得してから Git に保存し、編集してください。");
      } else if (!baseUnit || baseUnit.hash !== pullHash) {
        throw new Error("customize: Git 基準が pull app の取得時点と一致しません。取得結果をコミットして、そのコミットを --base に指定してください。");
      } else {
        for (const rel of manifestFiles(localManifest)) {
          const localFile = `customize/${rel}`;
          const absolute = path.join(appDir, localFile);
          if (fs.existsSync(absolute)) {
            ensureLocalFile(appDir, localFile);
            if (!changedPaths.has(gitPath(context, localFile)) && baseUnit.files[rel] === "(missing)" && isIgnored(context.root, gitPath(context, localFile))) {
              throw new Error(`${localFile}: customize マニフェストにある新規ファイルが Git から除外されています。Git の除外設定を確認してください。`);
            }
          }
        }
        const baseFiles = baseUnit.files;
        const localFiles = localUnit.files;
        const added = Object.keys(localFiles).filter((rel) => !(rel in baseFiles));
        const removed = Object.keys(baseFiles).filter((rel) => !(rel in localFiles));
        const changed = Object.keys(localFiles).filter((rel) => rel in baseFiles && localFiles[rel] !== baseFiles[rel]);
        if (localUnit.manifestHash !== baseUnit.manifestHash) changed.push("customize-manifest.json");
        customize = { state: "local", added, removed, changed, groups: customizeGroupsChanged(localManifest, baseManifest, localUnit, baseUnit) };
        locals.set("customize", localManifest);
        workingHashes.set("customize", localUnit.hash);
      }
    }
  }

  const diff: AppDiff = {
    appId,
    name,
    guestSpaceId,
    appDir,
    baseCommit: context.commit,
    pullState: Boolean(state),
    resources,
    ...(fields ? { fields } : {}),
    customize
  };
  return { diff, locals, baselines, workingHashes };
}

export function describeAppDiff(diff: AppDiff): string[] {
  const lines = [`Git 基準: ${diff.baseCommit}`];
  if (!diff.pullState) lines.push("pull 状態がありません。pull app で取得してから Git に保存し、編集してください。");
  for (const resource of diff.resources) {
    if (resource.state === "local") lines.push(`ローカル変更（push 対象）: ${resource.key} (${resource.file})`);
    else if (resource.state === "skipped") lines.push(`対象外: ${resource.key} (${resource.reason})`);
  }
  if (diff.fields) {
    const changes = [
      diff.fields.added.length ? `追加 ${diff.fields.added.join(", ")}` : "",
      diff.fields.changed.length ? `変更 ${diff.fields.changed.join(", ")}` : "",
      diff.fields.missingOnLocal.length ? `Git 基準のみ（削除しません） ${diff.fields.missingOnLocal.join(", ")}` : ""
    ].filter(Boolean);
    if (changes.length) lines.push(`  フィールド: ${changes.join(" / ")}`);
  }
  if (diff.customize.state === "local") {
    if (diff.customize.added.length) lines.push(`  customize 追加: ${diff.customize.added.join(", ")}`);
    if (diff.customize.removed.length) lines.push(`  customize 削除: ${diff.customize.removed.join(", ")}`);
    if (diff.customize.changed.length) lines.push(`  customize 変更: ${diff.customize.changed.join(", ")}`);
  } else if (diff.customize.state === "skipped" && diff.customize.reason) {
    lines.push(`対象外: customize (${diff.customize.reason})`);
  }
  if (!diff.resources.some((resource) => resource.state === "local") && diff.customize.state !== "local") {
    lines.push("Git 基準と pull 状態から送る変更はありません。");
  }
  return lines;
}

export function diffApp({
  appId,
  guestSpaceId = "",
  baseRef = "HEAD",
  only
}: {
  appId: string;
  guestSpaceId?: string;
  baseRef?: string;
  only?: string[];
}): AppDiff {
  const appDir = resolveCustomizeAppDir({ appId, guestSpaceId });
  if (!fs.existsSync(appDir)) throw new Error(`アプリが未取得です: ${appDir}\n先に kint-origin pull app --id ${appId} を実行してください。`);
  const { diff } = inspectApp({ appId, guestSpaceId, appDir, name: appName(appDir, appId), baseRef, only });
  for (const line of describeAppDiff(diff)) log(line);
  return diff;
}
