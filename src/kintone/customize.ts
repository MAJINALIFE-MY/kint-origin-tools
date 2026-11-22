import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir, listFilesRecursive, parseJsonText } from "../fsutil.js";
import { canonicalJson } from "../normalize.js";
import { getAppDirName, kintoneAppRootPath, kintoneAppsRootPath, kintoneSpacesRootPath } from "../paths.js";
import { runCliKintone } from "./cliKintone.js";
import { recordLocalAction } from "../runLog.js";
import { classify, hashBytes, hashLocalJson, sha256 } from "./pullState.js";

const CUSTOMIZE_FOLDER_MAP = [
  { platform: "desktop", type: "js", folder: "customize/desktop/js" },
  { platform: "desktop", type: "css", folder: "customize/desktop/css" },
  { platform: "mobile", type: "js", folder: "customize/mobile/js" },
  { platform: "mobile", type: "css", folder: "customize/mobile/css" }
] as const;

export const CUSTOMIZE_DIRECTORIES: string[] = CUSTOMIZE_FOLDER_MAP.map((m) => m.folder);
const CUSTOMIZE_FOLDER = "customize";
const CUSTOMIZE_MANIFEST_FILE = "customize-manifest.json";

function customizeDirPath(appDir: string): string {
  return path.join(appDir, CUSTOMIZE_FOLDER);
}

export function customizeManifestPath(appDir: string): string {
  return path.join(customizeDirPath(appDir), CUSTOMIZE_MANIFEST_FILE);
}

function ensureCustomizeDirectories(appDir: string): void {
  ensureDir(customizeDirPath(appDir));
  for (const folder of CUSTOMIZE_DIRECTORIES) ensureDir(path.join(appDir, folder));
}

async function initCustomizeManifest({ appDir }: { appDir: string }): Promise<void> {
  ensureCustomizeDirectories(appDir);
  const manifestPath = customizeManifestPath(appDir);
  if (!fs.existsSync(manifestPath)) {
    await runCliKintone(["customize", "init", "--output", CUSTOMIZE_MANIFEST_FILE, "--yes"], {
      cwd: customizeDirPath(appDir)
    });
  }
  ensureCustomizeDirectories(appDir);
}

async function exportCustomize({
  appId,
  appDir,
  guestSpaceId = ""
}: {
  appId: string | number;
  appDir: string;
  guestSpaceId?: string;
}): Promise<void> {
  await initCustomizeManifest({ appDir });
  await runCliKintone(
    ["customize", "export", "--app", String(appId), "--output", CUSTOMIZE_MANIFEST_FILE, "--yes"],
    { cwd: customizeDirPath(appDir), guestSpaceId }
  );
  ensureCustomizeDirectories(appDir);
}

// customize の比較単位。マニフェストと、マニフェストに載っている JS/CSS（`push app` が反映するもの）。
// plugin-configs・customize.json・plugins.json と、マニフェストに載っていない付随ファイル（.gitkeep・.map 等）は含めない。
export interface CustomizeUnit {
  hash: string;
  manifest?: string;
  /** customize/ からの相対パス（マニフェストに載っているもの）→ ハッシュ。ファイルが無ければ "(missing)" */
  files: Record<string, string>;
}

function readManifestJson(appDir: string): unknown {
  try {
    const file = customizeManifestPath(appDir);
    return parseJsonText(fs.readFileSync(file, "utf8"), file);
  } catch {
    return undefined;
  }
}

// マニフェストのエントリのうち、customize/ の外を指すもの（絶対パス・`..` を含む）。
// manifestFiles は差分の比較単位からこれらを除くため、範囲外のエントリは diff / push の前に検出して止める。
export function manifestOutsideEntries(manifest: unknown): string[] {
  const outside: string[] = [];
  for (const { platform, type } of CUSTOMIZE_FOLDER_MAP) {
    const list = (manifest as any)?.[platform]?.[type];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== "string" || /^https?:\/\//i.test(entry)) continue;
      const rel = entry.replaceAll("\\", "/").replace(/^\.\//, "");
      if (!rel || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split("/").includes("..")) outside.push(entry);
    }
  }
  return outside;
}

// マニフェストに載っているローカルのファイル（customize/ からの相対パス。URL と、customize/ の外を指すものは除く）。
export function manifestFiles(manifest: unknown): string[] {
  const files = new Set<string>();
  for (const { platform, type } of CUSTOMIZE_FOLDER_MAP) {
    const list = (manifest as any)?.[platform]?.[type];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== "string" || /^https?:\/\//i.test(entry)) continue;
      const rel = entry.replaceAll("\\", "/").replace(/^\.\//, "");
      if (!rel || path.isAbsolute(rel) || rel.split("/").includes("..")) continue;
      files.add(rel);
    }
  }
  return [...files];
}

// appDir 配下の customize の比較単位。マニフェストが無ければ undefined。
export function customizeUnit(appDir: string): CustomizeUnit | undefined {
  const manifest = hashLocalJson(customizeManifestPath(appDir));
  if (manifest === undefined) return undefined;
  const files: Record<string, string> = {};
  for (const rel of manifestFiles(readManifestJson(appDir)).sort((a, b) => a.localeCompare(b, "en"))) {
    const file = path.join(customizeDirPath(appDir), rel);
    files[rel] = fs.existsSync(file) ? hashBytes(fs.readFileSync(file)) : "(missing)";
  }
  return { hash: sha256(canonicalJson({ manifest, files })), manifest, files };
}

function copyIfDifferent(source: string, target: string): void {
  const bytes = fs.readFileSync(source);
  if (fs.existsSync(target) && bytes.equals(fs.readFileSync(target))) return;
  recordLocalAction("copy-customize-file", target, { bytes: bytes.length });
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, bytes);
}

// source の customize 一式を target へ写す。target の以前のマニフェストに載っていて、source のマニフェストに
// 無くなった JS/CSS（環境から消えたもの）だけを target から消す。マニフェストに載っていないファイルには触れない。
function mirrorCustomize(sourceAppDir: string, targetAppDir: string): void {
  const previouslyListed = manifestFiles(readManifestJson(targetAppDir));
  ensureCustomizeDirectories(targetAppDir);
  if (fs.existsSync(customizeManifestPath(sourceAppDir))) {
    copyIfDifferent(customizeManifestPath(sourceAppDir), customizeManifestPath(targetAppDir));
  }
  for (const { folder } of CUSTOMIZE_FOLDER_MAP) {
    const sourceDir = path.join(sourceAppDir, folder);
    const targetDir = path.join(targetAppDir, folder);
    for (const rel of listFilesRecursive(sourceDir)) copyIfDifferent(path.join(sourceDir, rel), path.join(targetDir, rel));
  }
  const nowListed = new Set(manifestFiles(readManifestJson(sourceAppDir)));
  for (const rel of previouslyListed) {
    const file = path.join(customizeDirPath(targetAppDir), rel);
    if (!nowListed.has(rel) && fs.existsSync(file)) {
      recordLocalAction("remove-stale-customize-file", file);
      fs.rmSync(file);
    }
  }
}

export interface CustomizeSyncResult {
  /** ローカル編集を保持し、環境の内容を取り込まなかった */
  kept: boolean;
  /** 保持した理由が「環境側も変更されている」（conflict）か */
  conflict: boolean;
  /** 取得後の base ハッシュ（保持したときは前回のまま） */
  hash?: string;
}

// 環境の customize を一時ディレクトリへ取得し、ローカル編集が無ければ data/ へ反映する。
// tracked=false（pull 状態が未作成）のときはローカル編集の判定をせず、常に取り込む。
export async function syncCustomize({
  appId,
  appDir,
  guestSpaceId = "",
  base,
  tracked,
  discardLocal = false
}: {
  appId: string | number;
  appDir: string;
  guestSpaceId?: string;
  base?: string;
  tracked: boolean;
  discardLocal?: boolean;
}): Promise<CustomizeSyncResult> {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-customize-"));
  try {
    await exportCustomize({ appId, appDir: staging, guestSpaceId });
    const remote = customizeUnit(staging);
    const local = customizeUnit(appDir);
    const state = classify({ base, local: local?.hash, remote: remote?.hash });
    if (tracked && !discardLocal && (state === "local" || state === "conflict")) {
      return { kept: true, conflict: state === "conflict", hash: base };
    }
    mirrorCustomize(staging, appDir);
    return { kept: false, conflict: false, hash: remote?.hash };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function resolveCustomizeAppDir({
  appId,
  guestSpaceId = ""
}: {
  appId: string | number;
  guestSpaceId?: string;
}): string {
  if (guestSpaceId) {
    return kintoneAppRootPath({ guestSpaceId, appId });
  }
  const appDirName = getAppDirName(appId);
  const domainAppDir = path.join(kintoneAppsRootPath(), appDirName);
  if (fs.existsSync(domainAppDir)) return domainAppDir;
  const spacesRoot = kintoneSpacesRootPath();
  if (fs.existsSync(spacesRoot)) {
    for (const spaceDirName of fs.readdirSync(spacesRoot)) {
      const appDir = path.join(spacesRoot, spaceDirName, "apps", appDirName);
      if (fs.existsSync(appDir)) return appDir;
    }
  }
  return domainAppDir;
}
