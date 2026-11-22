// `kint-origin app create` / `app templates`: push/new-apps/<アプリ名>/ に新規アプリのドラフトをローカルで作る。
// API・認証値は使わず、created.json にも触れない（アプリ ID が付くのは push create が作成した後）。
// 既定は、パッケージ内の空欄ドラフト（template/agents/common/skills/kint-origin-push/references/app-blank/）。
// --template <名前> のときだけ、kintone のアプリテンプレート zip（配布物の template/app-templates/ か、ドメインの push/app-templates/）を変換する。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseJsonText, readJsonIfExists, writeJson, writeText } from "../fsutil.js";
import { pushAppTemplatesRootPath, pushNewAppsRootPath } from "../paths.js";
import { readZipFile } from "../zipRead.js";
import { analyzeAppTemplate, templateAppName, templateIssuesMessage } from "./appTemplateConvert.js";
import { DRAFT_META_FILE } from "./appDraft.js";
import { recordLocalAction } from "../runLog.js";

// dist/kintone/appTemplate.js -> ../../ = パッケージ root（cwd ではない。グローバル link 下でも動く）
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// 空欄ドラフトの正本（テキスト。init / update がスキルの参照として配るものと同じ）。
const BLANK_DRAFT_DIR = path.join(PACKAGE_ROOT, "template", "agents", "common", "skills", "kint-origin-push", "references", "app-blank");
// ドラフトへ書く、正本のファイル（push できる相対パスと README）。app.json はコマンドが書く。
const BLANK_DRAFT_FILES = ["form/fields.json", "form/layout.json", "views/views.json", "README.md"] as const;

// 配布用のアプリテンプレート zip の置き場（パッケージ root 基準）。
const DISTRIBUTED_TEMPLATES_DIR = path.join(PACKAGE_ROOT, "template", "app-templates");

const TEMPLATE_ENTRY = "01/template.json";
const MAX_TEMPLATE_ZIP_BYTES = 32 * 1024 * 1024;
const APP_NAME_MAX_LENGTH = 64; // kintone のアプリ名の上限（アプリを作成する API の仕様）
const TEMPLATE_NAME_MAX_LENGTH = 100;

type TemplateSource = "distributed" | "domain";

// ---- 名前の検証 -------------------------------------------------------------------

const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|\x00-\x1f]/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

// アプリ名・テンプレート名（フォルダ名・ファイル名にそのまま使う）を検証する。
// パス区切り・`..`・先頭が `_` や `.`（雛形・非表示と区別するため）・Windows で使えない名前を拒否する。
function assertSafeName(label: string, value: string, maxLength: number): void {
  if (!value || value.trim() === "") throw new Error(`${label}を指定してください。`);
  if (value !== value.trim()) throw new Error(`${label}の先頭・末尾に空白は使えません: ${JSON.stringify(value)}`);
  if (value.length > maxLength) throw new Error(`${label}は ${maxLength} 文字以内で指定してください（${value.length} 文字）。`);
  if (value.startsWith("_") || value.startsWith(".")) {
    throw new Error(`${label}の先頭に「_」「.」は使えません（雛形・非表示のものと区別するため）: ${value}`);
  }
  if (FORBIDDEN_NAME_CHARS.test(value)) {
    throw new Error(`${label}に使えない文字があります（パス区切りの / \\、: * ? " < > |、制御文字）: ${value}`);
  }
  if (value.endsWith(".") || WINDOWS_RESERVED_NAME.test(value)) {
    throw new Error(`${label}に使えない名前です（Windows のフォルダ名にできません）: ${value}`);
  }
}

// 既存のドラフトと名前が衝突しないことを確かめる。push create --name はフォルダ名と app.json の name のどちらでも指定できるので、
// 新しい名前が別のドラフトの app.json の name と同じだと、別のドラフトが選ばれる。フォルダ名は、大文字小文字を区別しない環境を考えて無視して比べる。
function assertNoNameConflict(root: string, name: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    if (entry.name.toLowerCase() === name.toLowerCase()) {
      throw new Error(`ドラフトが既にあります: push/new-apps/${entry.name}（フォルダ名は大文字小文字を区別せず比べます。別の名前にしてください）`);
    }
    let existingName: unknown;
    try {
      existingName = (readJsonIfExists(path.join(root, entry.name, DRAFT_META_FILE)) as { name?: unknown } | undefined)?.name;
    } catch {
      continue; // 読めない app.json は、別の検査（diff create / push create）が報告する
    }
    if (existingName === name) {
      throw new Error(
        `既存のドラフト「${entry.name}」の app.json の name が同じです: ${name}（push create --name で区別できなくなるため、別の名前にするか、既存のドラフトの name を変えてください）`
      );
    }
  }
}

function assertOptionalId(label: string, value: string): void {
  if (value !== "" && !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${label} には正の整数（数字のみ）を指定してください: ${value}`);
  }
}

// ---- テンプレート zip の探索・読み込み -------------------------------------------------

interface TemplateZip {
  name: string;
  source: TemplateSource;
  file: string;
}

// ディレクトリ直下の `<名前>.zip`。先頭が `_` や `.` のもの・通常のファイルでないもの（ディレクトリ・シンボリックリンク）は数えない。
function zipsIn(dir: string, source: TemplateSource): TemplateZip[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.zip$/i.test(entry.name) && !entry.name.startsWith("_") && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name.slice(0, -".zip".length), source, file: path.join(dir, entry.name) }));
}

// 配布物とドメインの zip を集める。同じ名前が両方にあるときはエラー（どちらを使うかが曖昧になるため）。
function collectTemplateZips(): TemplateZip[] {
  const found = [...zipsIn(DISTRIBUTED_TEMPLATES_DIR, "distributed"), ...zipsIn(pushAppTemplatesRootPath(), "domain")];
  const seen = new Map<string, TemplateZip>();
  for (const item of found) {
    const other = seen.get(item.name);
    if (other) {
      throw new Error(
        `同じ名前のテンプレートが、配布物（template/app-templates/）と push/app-templates/ の両方にあります: ${item.name}\n` +
          "どちらかの名前を変えてください（push/app-templates/ の zip は、ドメインの独自のものです）。"
      );
    }
    seen.set(item.name, item);
  }
  return found.sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

function readTemplateJson(zipFile: string): unknown {
  const size = fs.statSync(zipFile).size;
  if (size > MAX_TEMPLATE_ZIP_BYTES) {
    throw new Error(`zip が大きすぎます（${size} バイト。上限 ${MAX_TEMPLATE_ZIP_BYTES} バイト）: ${path.basename(zipFile)}`);
  }
  const body = readZipFile(fs.readFileSync(zipFile), TEMPLATE_ENTRY);
  if (!body) {
    throw new Error(`zip に ${TEMPLATE_ENTRY} がありません（kintone のアプリテンプレートの zip ではない可能性があります）: ${path.basename(zipFile)}`);
  }
  return parseJsonText(body.toString("utf8"), `${path.basename(zipFile)} の ${TEMPLATE_ENTRY}`);
}

export interface AppTemplateListEntry {
  name: string;
  source: TemplateSource;
  /** zip の中のアプリ名。読めなかったときは null */
  appName: string | null;
  error?: string;
}

// `app templates`: 使えるアプリテンプレート zip の一覧（任意。無ければ空）。
export function listAppTemplates(): { templates: AppTemplateListEntry[] } {
  const templates = collectTemplateZips().map((item): AppTemplateListEntry => {
    try {
      return { name: item.name, source: item.source, appName: templateAppName(readTemplateJson(item.file)) || null };
    } catch (error) {
      return { name: item.name, source: item.source, appName: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
  return { templates };
}

function findTemplate(name: string): TemplateZip {
  assertSafeName("テンプレート名", name, TEMPLATE_NAME_MAX_LENGTH);
  const all = collectTemplateZips();
  const found = all.find((item) => item.name === name);
  if (found) return found;
  const available = all.length > 0 ? `使える名前: ${all.map((item) => item.name).join(", ")}` : "使えるテンプレート zip がありません（push/app-templates/<名前>.zip に置くと使えます）";
  throw new Error(`テンプレート「${name}」はありません。${available}\n空欄のアプリから始めるときは、--template を付けずに実行してください（空欄へは切り替えません）。`);
}

// ---- ドラフトの作成 ------------------------------------------------------------------

function readBlankFile(rel: string): string {
  const file = path.join(BLANK_DRAFT_DIR, ...rel.split("/"));
  if (!fs.existsSync(file)) {
    throw new Error(`空欄ドラフトの正本が見つかりません: ${file}\nkint-origin-tools のインストールが壊れている可能性があります（npm run build と再インストールを確認してください）。`);
  }
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

export interface CreateAppDraftOptions {
  name: string;
  template?: string;
  space?: string;
  thread?: string;
  guestSpaceId?: string;
}

export interface CreateAppDraftResult {
  draftName: string;
  name: string;
  /** --template に指定した名前。空欄ドラフトは null */
  template: string | null;
  /** cwd からの相対パス */
  dir: string;
  space: string;
  thread: string;
  guestSpaceId: string;
  files: string[];
}

// push/new-apps/<アプリ名>/ にドラフトを書く。既存のフォルダは拒否し、書く前に検証・変換を済ませる（失敗しても何も残さない）。
export function createAppDraft(options: CreateAppDraftOptions): CreateAppDraftResult {
  const name = options.name;
  const space = options.space ?? "";
  const thread = options.thread ?? "";
  const guestSpaceId = options.guestSpaceId ?? "";
  assertSafeName("アプリ名", name, APP_NAME_MAX_LENGTH);
  assertOptionalId("--space", space);
  assertOptionalId("--thread", thread);
  assertOptionalId("--guestspace", guestSpaceId);
  if (thread && !space) throw new Error("--thread は --space と一緒に指定してください（スペースのスレッドにアプリを作る指定です）。");

  const root = pushNewAppsRootPath();
  const dir = path.join(root, name);
  if (fs.existsSync(dir)) {
    throw new Error(`ドラフトが既にあります: push/new-apps/${name}（上書きしません。別の名前にするか、フォルダを削除・移動してください）`);
  }
  assertNoNameConflict(root, name);

  // 書き込む内容を先に全部用意する（テンプレートの変換エラーでは何も作らない）。
  const contents = new Map<string, string>(BLANK_DRAFT_FILES.map((rel) => [rel, readBlankFile(rel)]));
  const template = options.template ?? null;
  if (template !== null) {
    const zip = findTemplate(template);
    const analysis = analyzeAppTemplate(readTemplateJson(zip.file));
    // 範囲内のテンプレートが表すのは空のアプリそのもの。ドラフトの中身は空欄と同じ（app.json のアプリ名だけ --name）。
    if (analysis.issues.length > 0) throw new Error(templateIssuesMessage(template, analysis.issues));
  }

  recordLocalAction("create-app-draft", dir);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(dir); // 既存なら EEXIST で失敗する（上の確認との競合も上書きしない）
  try {
    writeJson(path.join(dir, DRAFT_META_FILE), { name, space, thread, guestSpaceId });
    for (const [rel, body] of contents) writeText(path.join(dir, ...rel.split("/")), body);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true }); // 今作ったフォルダだけを片付ける
    throw error;
  }

  return {
    draftName: name,
    name,
    template,
    dir: `push/new-apps/${name}`,
    space,
    thread,
    guestSpaceId,
    files: [DRAFT_META_FILE, ...contents.keys()].sort((a, b) => a.localeCompare(b, "en"))
  };
}
