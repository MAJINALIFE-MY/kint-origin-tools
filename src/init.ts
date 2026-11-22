import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDir } from "./fsutil.js";
import { generateAgents } from "./agents.js";
import { initGitignoreContent, readTemplateGitignore } from "./domainGitignore.js";
import { assertNotToolRepository } from "./domainGuard.js";
import { log } from "./log.js";
import { planPluginTemplate } from "./pluginTemplate.js";
import { recordLocalAction } from "./runLog.js";

const TEMPLATE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "template");

const INIT_DIRECTORIES = [
  path.join("data", "kintone", "apps"),
  path.join("data", "kintone", "spaces"),
  path.join("data", "kintone", "common", "customize", "desktop", "js"),
  path.join("data", "kintone", "common", "customize", "desktop", "css"),
  path.join("data", "kintone", "common", "customize", "mobile", "js"),
  path.join("data", "kintone", "common", "customize", "mobile", "css"),
  path.join("data", "kintone", "deleted", "apps"),
  path.join("data", "kintone", "deleted", "spaces"),
  path.join("data", "cybozu-common", "users"),
  path.join("data", "cybozu-common", "groups"),
  path.join("data", "cybozu-common", "organizations"),
  path.join("data", "cybozu-common", "csv"),
  path.join("push", "new-apps"),
  path.join("push", "records"),
  path.join("push", "import"),
  "favorites"
];

export interface InitResult {
  copied: string[];
  skipped: string[];
  createdDirs: string[];
}

// 既存だったため init が書かなかったとき、AI の誤操作を止める仕組み（push の確認・.env と取得物の保護）が入らないファイル。
// 古い設定のまま使い続けても気づけないため、スキップしたら警告する。
const PROTECTION_FILES = [
  ".agents/hooks/kint-origin-guard-core.mjs",
  ".claude/settings.json",
  ".claude/hooks/kint-origin-guard.mjs",
  ".cursor/hooks.json",
  ".cursor/hooks/kint-origin-guard.mjs",
  ".codex/rules/kint-origin.rules",
  ".codex/hooks.json",
  ".codex/hooks/kint-origin-guard.mjs"
];

function warnSkippedProtection(skipped: string[]): void {
  const hit = PROTECTION_FILES.filter((file) => skipped.includes(file));
  if (hit.length === 0) return;
  log(
    `警告: 既存のため生成しなかった保護用のファイルがあります（push の確認・.env と取得物の保護が、配布の版になっていない可能性があります）: ${hit.join(", ")}\n` +
      "  配布の版にするには kint-origin update を実行してください（上書きされるファイルを確認してから更新します）。"
  );
}

// .gitignore は既存でも温存しつつ、.env などの管理ブロックと、雛形の除外のうち無い行を追記する（無ければ雛形を書く）。
// 追記できないときも init は続け、.env がコミットされ得ることを警告する。
function initGitignore(targetRoot: string, copied: string[], skipped: string[]): void {
  const target = path.resolve(targetRoot, ".gitignore");
  const template = readTemplateGitignore();
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) {
    recordLocalAction("create-gitignore", target);
    fs.writeFileSync(target, template, "utf8");
    copied.push(".gitignore");
    return;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    log("警告: .gitignore が通常ファイルではないため、.env などの除外を追記しませんでした。.env をコミットしないよう、除外を手で設定してください。");
    skipped.push(".gitignore");
    return;
  }
  const existing = fs.readFileSync(target, "utf8");
  let content: string;
  try {
    content = initGitignoreContent(existing, template);
  } catch (error) {
    log(
      `警告: .gitignore の kint-origin 管理ブロックを読めないため、除外を追記しませんでした（${error instanceof Error ? error.message : String(error)}）。` +
        "ブロックを直してから、kint-origin init をもう一度実行してください。"
    );
    skipped.push(".gitignore");
    return;
  }
  if (content === existing) {
    skipped.push(".gitignore");
    return;
  }
  recordLocalAction("update-gitignore", target);
  fs.writeFileSync(target, content, "utf8");
  copied.push(".gitignore");
  log("既存の .gitignore に kint-origin の除外を追記しました（既存の行は変更していません）。");
}

function listTemplateFiles(dirPath: string, basePath = dirPath): string[] {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Template directory not found: ${dirPath}`);
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTemplateFiles(entryPath, basePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(path.relative(basePath, entryPath));
    }
  }
  return files;
}

export function initProject(targetRoot = process.cwd()): InitResult {
  assertNotToolRepository(targetRoot, "init");
  const copied: string[] = [];
  const skipped: string[] = [];
  const createdDirs: string[] = [];

  for (const dir of INIT_DIRECTORIES) {
    const targetDir = path.resolve(targetRoot, dir);
    ensureDir(targetDir);
    createdDirs.push(dir.replaceAll(path.sep, "/"));
  }

  for (const relativeFile of listTemplateFiles(TEMPLATE_ROOT)) {
    // .gitignore は既存でも温存しつつ、.env などの除外を追記する。
    if (relativeFile === "gitignore") {
      initGitignore(targetRoot, copied, skipped);
      continue;
    }
    // agents/ 配下は AI エージェント設定の正本。フラットコピーせず generateAgents で生成する。
    if (relativeFile === "agents" || relativeFile.startsWith(`agents${path.sep}`)) continue;
    // plugins/ の台帳とGit除外は既存のファイルを保全する手順で配置する。
    if (relativeFile.startsWith(`plugins${path.sep}`)) continue;
    // app-templates/ は配布用のアプリテンプレート zip（バイナリ）。パッケージ内から読む入力で、UTF-8 のテキストとしてコピーすると壊れる。
    if (relativeFile === "app-templates" || relativeFile.startsWith(`app-templates${path.sep}`)) continue;
    const targetFile = path.resolve(targetRoot, relativeFile);
    const displayPath = relativeFile.replaceAll(path.sep, "/");
    if (fs.existsSync(targetFile)) {
      skipped.push(displayPath);
      continue;
    }

    ensureDir(path.dirname(targetFile));
    const sourceFile = path.join(TEMPLATE_ROOT, relativeFile);
    recordLocalAction("copy-template-file", targetFile, { bytes: fs.statSync(sourceFile).size });
    fs.writeFileSync(targetFile, fs.readFileSync(sourceFile, "utf8"), "utf8");
    copied.push(displayPath);
  }

  const plugins = planPluginTemplate(targetRoot);
  copied.push(...plugins.apply());
  skipped.push(...plugins.skipped);
  const agents = generateAgents({ targetRoot });
  copied.push(...agents.written);
  skipped.push(...agents.skipped);
  warnSkippedProtection(skipped);

  return { copied, skipped, createdDirs };
}
