// 更新キー付き CSV を読み込み、recordImportPush.ts が使う実行計画を作る。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { DEFAULT_CONCURRENCY, mapWithLimit } from "../limit.js";
import { pushImportRootPath } from "../paths.js";
import { lookupIndexedApp } from "./appIndex.js";
import type { KintoneClient } from "./client.js";
import { neutralizeFormula } from "./recordCsv.js";
import { formatIssues, validateJobName, type JobIssue } from "./recordJob.js";
import { bulkify, RECORDS_PER_REQUEST, type BackupRecord, type BulkGroup, type TargetRecordPlan } from "./recordPlan.js";
import {
  buildSchemaIndex,
  canonicalNumber,
  clearValue,
  displayValue,
  hasDefaultValue,
  parseSetValue,
  typeLabel,
  writableError,
  type FieldSchema,
  type SchemaIndex
} from "./recordValues.js";

// ---- import.json ----

export type ImportEncoding = "utf8" | "sjis";

export interface ImportConfig {
  app: string;
  /** 更新キーのフィールドコード（トップレベル）。 */
  updateKey: string;
  encoding: ImportEncoding;
  /** import.json に書かれたゲストスペース ID。無ければアプリ索引から判定する。 */
  guestSpaceId?: string;
}

const CONFIG_KEYS = ["app", "updateKey", "encoding", "guestSpaceId"];
const ID_RE = /^[1-9]\d*$/;

function idText(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && ID_RE.test(value.trim())) return value.trim();
  return null;
}

/** 設定の問題はまとめて返す。 */
export function parseImportConfig(text: string): { config: ImportConfig } | { errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    return { errors: ["import.json を JSON として読めません: " + (error instanceof Error ? error.message : String(error))] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { errors: ['import.json はオブジェクトで書いてください（例: { "app": 123, "updateKey": "社員番号" }）'] };
  }
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  const unknown = Object.keys(obj).filter((key) => !CONFIG_KEYS.includes(key));
  if (unknown.length > 0) errors.push("import.json に不明なキーがあります: " + unknown.join(", ") + "（使えるキー: " + CONFIG_KEYS.join(", ") + "）");

  const app = idText(obj.app);
  if (!app) errors.push("import.json の app にアプリ ID（正の整数）を指定してください");
  const updateKey = typeof obj.updateKey === "string" ? obj.updateKey.trim() : "";
  if (!updateKey) errors.push("import.json の updateKey に更新キーのフィールドコードを指定してください");

  let encoding: ImportEncoding = "utf8";
  if (obj.encoding !== undefined) {
    if (obj.encoding === "utf8" || obj.encoding === "sjis") encoding = obj.encoding;
    else errors.push('import.json の encoding は "utf8" か "sjis" のどちらかです（既定は utf8）');
  }
  let guestSpaceId: string | undefined;
  if (obj.guestSpaceId !== undefined) {
    const guest = idText(obj.guestSpaceId);
    if (guest) guestSpaceId = guest;
    else errors.push("import.json の guestSpaceId にはゲストスペース ID（正の整数）を指定してください");
  }
  if (errors.length > 0 || !app) return { errors };
  return { config: { app, updateKey, encoding, ...(guestSpaceId ? { guestSpaceId } : {}) } };
}

// ---- ジョブの置き場 ----

/** push/import/ の下にある、import.json を持つジョブ名（_ や . で始まる雛形・隠しフォルダは除く）。 */
function listImportJobNames(): string[] {
  const root = pushImportRootPath();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith(".") && fs.existsSync(path.join(root, entry.name, "import.json")))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "ja"));
}

/** ジョブのフォルダと入力ファイルのパス。ジョブが無ければ、存在するジョブを案内して throw する。 */
export function resolveImportJob(jobName: string): { jobDir: string; configFile: string; csvFile: string } {
  validateJobName(jobName, "push/import");
  const jobDir = path.join(pushImportRootPath(), jobName);
  const configFile = path.join(jobDir, "import.json");
  const csvFile = path.join(jobDir, "records.csv");
  if (!fs.existsSync(configFile)) {
    const names = listImportJobNames();
    throw new Error(
      "ジョブが見つかりません: push/import/" + jobName + "/import.json（存在するジョブ: " + (names.length > 0 ? names.join(", ") : "なし。雛形: push/import/_example/") + "）"
    );
  }
  if (!fs.existsSync(csvFile)) throw new Error("records.csv がありません: push/import/" + jobName + "/records.csv");
  return { jobDir, configFile, csvFile };
}

// ---- records.csv ----

/** CSV のバイト列を文字列にする。BOM は除く。読めない文字があれば encoding の指定を案内して throw する。 */
export function decodeCsvBytes(bytes: Uint8Array, encoding: ImportEncoding): string {
  try {
    return new TextDecoder(encoding === "sjis" ? "shift_jis" : "utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      encoding === "sjis"
        ? "records.csv を Shift_JIS として読めません（UTF-8 で保存したファイルなら import.json の encoding を外すか utf8 にしてください）"
        : 'records.csv を UTF-8 として読めません（Excel の「CSV」で保存したファイルなど Shift_JIS なら、import.json に "encoding": "sjis" を指定してください）'
    );
  }
}

/** import.json と records.csv の内容のハッシュ（改行コードと BOM の違いは無視する）。同じ入力の再実行ガードに使う。 */
export function hashImportJob(configText: string, csvText: string): string {
  const normalize = (text: string): string => text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  return crypto.createHash("sha256").update(normalize(configText)).update("\0").update(normalize(csvText)).digest("hex");
}

interface ImportRow {
  /** CSV のレコード番号（ヘッダーを 1 とする）。job.csv の行番号と同じ数え方。 */
  line: number;
  cells: string[];
}

export interface ParsedImportCsv {
  header: string[];
  rows: ImportRow[];
  issues: JobIssue[];
}

/** records.csv を解析し、構文の問題（スキーマやデータに依存しないもの）を集める（純関数）。 */
export function parseImportCsv(text: string): ParsedImportCsv {
  let records: string[][];
  try {
    records = parse(text, { bom: true, relax_column_count: true, skip_empty_lines: true });
  } catch (error) {
    return { header: [], rows: [], issues: [{ lines: [], message: "records.csv を CSV として読めません: " + (error instanceof Error ? error.message : String(error)) }] };
  }
  if (records.length === 0) return { header: [], rows: [], issues: [{ lines: [], message: "records.csv が空です（ヘッダー行が必要です）" }] };

  const issues: JobIssue[] = [];
  const header = records[0].map((name) => name.trim());
  header.forEach((name, index) => {
    if (name === "") issues.push({ lines: [1], message: "ヘッダーに空の列名があります（" + (index + 1) + " 列目）" });
  });
  const duplicated = [...new Set(header.filter((name, index) => name !== "" && header.indexOf(name) !== index))];
  if (duplicated.length > 0) issues.push({ lines: [1], message: "ヘッダーの列名が重複しています: " + duplicated.join(", ") });

  const rows: ImportRow[] = [];
  for (let i = 1; i < records.length; i += 1) {
    const line = i + 1;
    if (records[i].length !== header.length) {
      issues.push({ lines: [line], message: "列数がヘッダー（" + header.length + " 列）と一致しません（" + records[i].length + " 列）" });
      continue;
    }
    rows.push({ line, cells: records[i].map((cell) => cell.replace(/\r\n/g, "\n")) });
  }
  if (rows.length === 0 && issues.length === 0) issues.push({ lines: [], message: "records.csv にデータの行がありません" });
  return { header, rows, issues };
}

export interface LoadedImportJob {
  name: string;
  jobDir: string;
  config: ImportConfig;
  /** import.json と records.csv の内容のハッシュ。 */
  hash: string;
  header: string[];
  rows: ImportRow[];
}

/** ジョブの入力（import.json と records.csv）を読み、構文を検証する。API も認証値も使わない。 */
export function loadImportJob(name: string): LoadedImportJob {
  const { jobDir, configFile, csvFile } = resolveImportJob(name);
  const configText = fs.readFileSync(configFile, "utf8");
  const parsedConfig = parseImportConfig(configText);
  if ("errors" in parsedConfig) throw new Error(formatIssues(name, parsedConfig.errors.map((message) => ({ lines: [], message }))));
  let csvText: string;
  try {
    csvText = decodeCsvBytes(fs.readFileSync(csvFile), parsedConfig.config.encoding);
  } catch (error) {
    throw new Error(formatIssues(name, [{ lines: [], message: error instanceof Error ? error.message : String(error) }]));
  }
  const parsed = parseImportCsv(csvText);
  if (parsed.issues.length > 0) throw new Error(formatIssues(name, parsed.issues));
  return { name, jobDir, config: parsedConfig.config, hash: hashImportJob(configText, csvText), header: parsed.header, rows: parsed.rows };
}

// ---- 更新キー ----

export type KeyKind = "recordNumber" | "text" | "number";

const KEY_RULE =
  "更新キーに使えるのは、レコード番号、または「値の重複を禁止する」を設定した文字列（1行）・数値のフィールド（テーブルの外のもの）です";

export function keyKindOf(field: FieldSchema): KeyKind | null {
  if (field.table) return null;
  if (field.type === "RECORD_NUMBER") return "recordNumber";
  if (field.type === "SINGLE_LINE_TEXT" && field.unique) return "text";
  if (field.type === "NUMBER" && field.unique) return "number";
  return null;
}

/** レコード番号の CSV の値（数字、またはアプリコード付きの CODE-数字）を解釈する。 */
export function parseRecordNumber(raw: string): { id: string; appCode?: string } | null {
  const match = /^(?:(.+)-)?([1-9]\d*)$/.exec(raw.trim());
  return match ? { id: match[2], ...(match[1] !== undefined ? { appCode: match[1] } : {}) } : null;
}

/** 更新キーの CSV の値を、照合用の正規形（key）にする。key が同じ行は同じレコードを指す。 */
export function parseKeyValue(kind: KeyKind, field: FieldSchema, raw: string): { key: string; appCode?: string } | { error: string } {
  if (raw.trim() === "") return { error: "更新キー「" + field.code + "」の値が空です" };
  if (kind === "recordNumber") {
    const parsed = parseRecordNumber(raw);
    return parsed ? { key: parsed.id, appCode: parsed.appCode } : { error: "レコード番号は数字、またはアプリコード付き（CODE-数字）で指定してください: 「" + raw + "」" };
  }
  const value = parseSetValue(field, raw);
  if ("error" in value) return { error: "更新キー「" + field.code + "」: " + value.error };
  return { key: kind === "number" ? canonicalNumber(raw) : raw };
}

export function quoteQueryString(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function keyLiteral(kind: KeyKind, key: string): string {
  return kind === "text" ? quoteQueryString(key) : key;
}

// GET の URL が長くなりすぎないよう、`in` の値の長さ（URL エンコード後）にも上限を置く。
const QUERY_VALUES_BYTES = 3000;

export function chunkLiterals(literals: string[], max = RECORDS_PER_REQUEST, maxBytes = QUERY_VALUES_BYTES): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const literal of literals) {
    const width = encodeURIComponent(literal).length + 3;
    if (current.length > 0 && (current.length >= max || size + width > maxBytes)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(literal);
    size += width;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** 1 回分の照合クエリ。レコード番号は $id、それ以外はフィールドコードで引く。limit は 1 回の取得の上限（500）。 */
export function keyQuery(kind: KeyKind, code: string, literals: string[]): string {
  return (kind === "recordNumber" ? "$id" : code) + " in (" + literals.join(",") + ") limit 500";
}

// ---- 列（フィールド）の検証 ----

const IMPORTABLE_TYPES = new Set([
  "SINGLE_LINE_TEXT",
  "MULTI_LINE_TEXT",
  "RICH_TEXT",
  "LINK",
  "NUMBER",
  "DATE",
  "TIME",
  "DATETIME",
  "DROP_DOWN",
  "RADIO_BUTTON",
  "CHECK_BOX",
  "MULTI_SELECT",
  "USER_SELECT",
  "ORGANIZATION_SELECT",
  "GROUP_SELECT"
]);
const AUDIT_TYPES = new Set(["CREATOR", "CREATED_TIME", "MODIFIER", "UPDATED_TIME"]);

/** 取込で書けないフィールドならエラー文、書けるなら null（黙って飛ばさず、列を外すよう案内する）。 */
export function importColumnError(field: FieldSchema): string | null {
  const name = "フィールド「" + field.code + "」（" + typeLabel(field) + "）";
  const remove = "。この列を records.csv から外してください";
  if (field.type === "SUBTABLE" || field.type === "FILE") return name + "は取込できません（テーブル・添付ファイルは対象外です。push records のジョブで扱います）" + remove;
  if (AUDIT_TYPES.has(field.type)) return name + "は取込できません（作成者・更新者・作成日時・更新日時は対象外です）" + remove;
  const problem = writableError(field, { isNew: false });
  if (problem) return problem + remove;
  if (!IMPORTABLE_TYPES.has(field.type)) return name + "は取込に対応していません" + remove;
  return null;
}

interface ImportColumn {
  /** CSV の列の位置（0 始まり）。 */
  index: number;
  code: string;
  field: FieldSchema;
  isKey: boolean;
}

/** ヘッダー（フィールドコード）を、フォーム定義に照らして検証する（純関数）。問題はヘッダー行（行 1）か、行番号なしで返す。 */
export function resolveImportColumns({
  header,
  schema,
  updateKey,
  app
}: {
  header: string[];
  schema: SchemaIndex;
  updateKey: string;
  app: string;
}): { columns: ImportColumn[]; kind?: KeyKind; issues: JobIssue[] } {
  const issues: JobIssue[] = [];
  let kind: KeyKind | undefined;
  const keyField = schema.top.get(updateKey);
  if (!keyField) {
    issues.push({
      lines: [],
      message: schema.inner.has(updateKey)
        ? "更新キー「" + updateKey + "」はテーブル内のフィールドです。" + KEY_RULE
        : "更新キー「" + updateKey + "」のフィールドが app " + app + " にありません"
    });
  } else {
    kind = keyKindOf(keyField) ?? undefined;
    if (!kind) issues.push({ lines: [], message: "更新キー「" + updateKey + "」（" + typeLabel(keyField) + "）は使えません。" + KEY_RULE });
  }
  if (!header.includes(updateKey)) {
    issues.push({ lines: [1], message: "更新キー「" + updateKey + "」の列が records.csv にありません（ヘッダーの列名はフィールドコードです）" });
  }

  const columns: ImportColumn[] = [];
  header.forEach((code, index) => {
    const field = schema.top.get(code);
    if (!field) {
      issues.push({
        lines: [1],
        message: schema.inner.has(code)
          ? "列「" + code + "」はテーブル内のフィールドです。テーブルの列は取込できません。この列を records.csv から外してください"
          : "列「" + code + "」に対応するフィールドが app " + app + " にありません（ヘッダーの列名はフィールドコードです）"
      });
      return;
    }
    const isKey = code === updateKey;
    if (!(isKey && field.type === "RECORD_NUMBER")) {
      const problem = importColumnError(field);
      if (problem) issues.push({ lines: [1], message: "列「" + code + "」: " + problem });
    }
    columns.push({ index, code, field, isKey });
  });
  return { columns, kind, issues };
}

// ---- 行の値 ----

interface ParsedImportRow {
  line: number;
  /** 更新キーの CSV の値（そのまま）。新規レコードの識別（result.json の created.key）に使う。 */
  rawKey: string;
  /** 照合用の正規形。 */
  key: string;
  /** レコード番号に付いていたアプリコード。 */
  appCode?: string;
  /** 書き込む値（フィールドコード → value）。レコード番号の更新キーは含めない。 */
  values: Map<string, { value: unknown }>;
}

/** 1 行を解釈する。空のセルはフィールドを空にする（空にできないフィールドはエラー）。 */
export function parseImportRow(columns: ImportColumn[], kind: KeyKind, row: ImportRow): { parsed?: ParsedImportRow; issues: JobIssue[] } {
  const issues: JobIssue[] = [];
  const values = new Map<string, { value: unknown }>();
  let rawKey = "";
  let key = "";
  let appCode: string | undefined;
  let keyOk = false;
  for (const column of columns) {
    const raw = row.cells[column.index] ?? "";
    if (column.isKey) {
      rawKey = raw;
      const parsedKey = parseKeyValue(kind, column.field, raw);
      if ("error" in parsedKey) {
        issues.push({ lines: [row.line], message: parsedKey.error });
        continue;
      }
      keyOk = true;
      key = parsedKey.key;
      appCode = parsedKey.appCode;
      if (kind === "recordNumber") continue; // 番号は書き込まない（新規はサーバーが採番する）
    }
    const parsed = raw === "" ? clearValue(column.field) : parseSetValue(column.field, raw);
    if ("error" in parsed) issues.push({ lines: [row.line], message: "列「" + column.code + "」: " + parsed.error });
    else values.set(column.code, { value: parsed.value });
  }
  if (issues.length > 0 || !keyOk) return { issues };
  return { parsed: { line: row.line, rawKey, key, ...(appCode !== undefined ? { appCode } : {}), values }, issues };
}

/** プレビュー・比較用の値の文字列表現。日時は UTC の正規形にそろえる（+09:00 の指定と環境の値を同じものとして比べるため）。 */
function importDisplay(field: FieldSchema, value: unknown): string {
  const text = displayValue(field, value);
  if (field.type === "DATETIME" && text !== "") {
    const ms = Date.parse(text);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  return text;
}

/** 環境の今の値と、書き込もうとしている値が同じか（順序に依存しない。数値は桁の表記の違いを無視する）。 */
export function sameValue(field: FieldSchema, current: unknown, next: unknown): boolean {
  const a = importDisplay(field, current);
  const b = importDisplay(field, next);
  if (a === b) return true;
  return field.type === "NUMBER" && canonicalNumber(a) === canonicalNumber(b);
}

// ---- 計画 ----

export interface ImportPlan {
  jobName: string;
  jobDir: string;
  app: string;
  guestSpaceId: string;
  schema: SchemaIndex;
  updateKey: string;
  keyKind: KeyKind;
  /** 環境側のフォーム定義（verifyTargets に渡す形）。 */
  apps: Map<string, { guestSpaceId: string; schema: SchemaIndex }>;
  columns: string[];
  rows: number;
  targets: TargetRecordPlan[];
  bulks: BulkGroup[];
  backup: BackupRecord[];
  /** preview.csv の内容（ヘッダー行を含む）。 */
  preview: string[][];
  warnings: string[];
  stats: { updates: number; creates: number; unchanged: number; getCalls: number };
}

const PREVIEW_HEADER = ["line", "action", "record", "key", "field", "before", "after"];
// fields[0..99] の上限と URL の長さに収まるよう、列が多いときは fields を指定せず全フィールドを取得する。
const MAX_FIELDS_PARAM = 50;

function recordKeyOf(kind: KeyKind, code: string, record: any): string {
  if (kind === "recordNumber") return String(record.$id?.value ?? "");
  const value = String(record[code]?.value ?? "");
  return kind === "number" ? canonicalNumber(value) : value;
}

/** 新規追加の行で、必須なのに既定値も CSV の列も無いフィールドのコード。 */
function missingRequiredFields(schema: SchemaIndex, written: ReadonlySet<string>): string[] {
  const missing: string[] = [];
  for (const field of schema.top.values()) {
    if (!field.required || hasDefaultValue(field) || written.has(field.code)) continue;
    if (field.type === "SUBTABLE" || writableError(field, { isNew: true })) continue;
    missing.push(field.code);
  }
  return missing;
}

/**
 * 取込ジョブから実行計画を作る。GET だけを呼び、書き込みはしない（diff import と push import が共有する）。
 * 検証は 3 段階で、各段階で問題があれば、何も変更せずにまとめて報告する（ファイル → 列と値 → 環境のレコード）。
 */
export async function buildImportPlan({ client, job }: { client: KintoneClient; job: LoadedImportJob }): Promise<ImportPlan> {
  const { app, updateKey } = job.config;
  const warnings: string[] = [];
  const stats = { updates: 0, creates: 0, unchanged: 0, getCalls: 0 };

  const indexed = lookupIndexedApp(app);
  if (!indexed && job.config.guestSpaceId === undefined) {
    warnings.push("アプリ " + app + " は索引にありません（通常のアプリとして扱います。ゲストスペースのアプリなら import.json に guestSpaceId を書くか、kint-origin pull index で索引を更新してください）");
  }
  const guestSpaceId = job.config.guestSpaceId ?? indexed?.guestSpaceId ?? "";
  stats.getCalls += 1;
  let schema: SchemaIndex;
  try {
    const form = await client.getAppResource("/app/form/fields.json", app, { guestSpaceId });
    schema = buildSchemaIndex(form?.properties ?? {});
  } catch (error) {
    const code = (error as { code?: string }).code;
    const hint = code === "GAIA_IL23" || code === "GAIA_IL25" ? "（ゲストスペースのアプリの可能性があります。import.json に guestSpaceId を書くか、kint-origin pull index で索引を更新してください）" : "";
    throw new Error("app " + app + " のフォーム定義を取得できません: " + (error as Error).message + hint);
  }

  const resolved = resolveImportColumns({ header: job.header, schema, updateKey, app });
  if (resolved.issues.length > 0 || !resolved.kind) throw new Error(formatIssues(job.name, resolved.issues));
  const { columns } = resolved;
  const kind = resolved.kind;
  const issues: JobIssue[] = [];
  const rows: ParsedImportRow[] = [];
  for (const row of job.rows) {
    const result = parseImportRow(columns, kind, row);
    issues.push(...result.issues);
    if (result.parsed) rows.push(result.parsed);
  }
  const byKey = new Map<string, ParsedImportRow[]>();
  for (const row of rows) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);
  for (const group of byKey.values()) {
    if (group.length > 1) issues.push({ lines: group.map((row) => row.line), message: "更新キー「" + group[0].rawKey + "」が records.csv の中で重複しています" });
  }
  if (issues.length > 0) throw new Error(formatIssues(job.name, issues));

  const prefixed = rows.filter((row) => row.appCode !== undefined);
  if (prefixed.length > 0) {
    stats.getCalls += 1;
    const info = await client.getAppInfo(app, { guestSpaceId });
    const appCode = String(info.code ?? "");
    for (const row of prefixed) {
      if (row.appCode === appCode) continue;
      issues.push({
        lines: [row.line],
        message: "レコード番号「" + row.rawKey + "」のアプリコードが、このアプリ（" + (appCode ? "コード: " + appCode : "アプリコードなし") + "）と一致しません。別のアプリの CSV ではありませんか"
      });
    }
    if (issues.length > 0) throw new Error(formatIssues(job.name, issues));
  }

  const keyField = columns.find((column) => column.isKey)?.field as FieldSchema;
  const fields = job.header.length <= MAX_FIELDS_PARAM ? ["$id", "$revision", ...job.header] : undefined;
  const chunks = chunkLiterals([...byKey.keys()].map((key) => keyLiteral(kind, key)));
  const pages = await mapWithLimit(chunks, DEFAULT_CONCURRENCY, async (literals) => {
    stats.getCalls += 1;
    return client.getRecordsByQuery(app, { query: keyQuery(kind, keyField.code, literals), fields, guestSpaceId });
  });
  const fetched = new Map<string, any>();
  for (const page of pages) for (const record of page) fetched.set(String(record.$id?.value), record);
  const existing = new Map<string, any[]>();
  for (const record of fetched.values()) {
    const key = recordKeyOf(kind, keyField.code, record);
    existing.set(key, [...(existing.get(key) ?? []), record]);
  }
  for (const [key, records] of existing) {
    const lines = (byKey.get(key) ?? []).map((row) => row.line);
    if (!byKey.has(key)) {
      issues.push({
        lines: [],
        message:
          "環境のレコード " + records.map((record) => record.$id?.value).join(", ") + "（更新キー「" + key + "」）は、records.csv のどの行とも完全一致しません。" +
          "検索が大文字小文字などを同じ値として扱った可能性があります。records.csv の値を環境に合わせてください"
      });
    } else if (records.length > 1) {
      issues.push({ lines, message: "更新キー「" + key + "」に一致するレコードが環境に " + records.length + " 件あります（レコード " + records.map((record) => record.$id?.value).join(", ") + "）。更新するレコードを決められません" });
    }
  }
  if (issues.length > 0) throw new Error(formatIssues(job.name, issues));

  // 現在と同じ値のフィールドを送信対象から外す。
  const targets: TargetRecordPlan[] = [];
  const backup: BackupRecord[] = [];
  const preview: string[][] = [PREVIEW_HEADER];
  const neutral = neutralizeFormula;
  const notFoundNumbers: string[] = [];
  for (const row of rows) {
    const current = existing.get(row.key)?.[0];
    if (current) {
      const record: Record<string, { value: unknown }> = {};
      const expected: TargetRecordPlan["expected"] = [];
      const changes: string[][] = [];
      for (const column of columns) {
        const cell = row.values.get(column.code);
        if (column.isKey || !cell) continue;
        const now = current[column.code]?.value;
        if (sameValue(column.field, now, cell.value)) continue;
        record[column.code] = cell;
        expected.push({ field: column.code, display: importDisplay(column.field, cell.value) });
        changes.push([String(row.line), "update", String(current.$id.value), neutral(row.rawKey), column.code, neutral(importDisplay(column.field, now)), neutral(importDisplay(column.field, cell.value))]);
      }
      const touched = Object.keys(record);
      if (touched.length === 0) {
        stats.unchanged += 1;
        continue;
      }
      stats.updates += 1;
      preview.push(...changes);
      const id = String(current.$id.value);
      const revision = String(current.$revision?.value ?? "");
      targets.push({ app, guestSpaceId, kind: "update", id, revision, firstLine: row.line, record, touched, expected });
      backup.push({ app, guestSpaceId, id, revision, fields: Object.fromEntries(touched.map((code) => [code, current[code] ?? { value: null }])) });
      continue;
    }

    // 一致するレコードが無い行は新規追加（レコード番号の更新キーは書かない。番号はサーバーが採番する）
    const record: Record<string, { value: unknown }> = {};
    const expected: TargetRecordPlan["expected"] = [];
    for (const column of columns) {
      const cell = row.values.get(column.code);
      if (!cell) continue;
      record[column.code] = cell;
      expected.push({ field: column.code, display: importDisplay(column.field, cell.value) });
      preview.push([String(row.line), "create", "(新規)", neutral(row.rawKey), column.code, "", neutral(importDisplay(column.field, cell.value))]);
    }
    for (const code of missingRequiredFields(schema, new Set(Object.keys(record)))) {
      issues.push({ lines: [row.line], message: "新規追加の行（更新キー「" + row.rawKey + "」）に必須フィールド「" + code + "」の列がありません" });
    }
    if (kind === "recordNumber") notFoundNumbers.push(row.rawKey);
    stats.creates += 1;
    targets.push({ app, guestSpaceId, kind: "create", newKey: row.rawKey, firstLine: row.line, record, touched: Object.keys(record), expected });
  }
  if (issues.length > 0) throw new Error(formatIssues(job.name, issues));
  if (notFoundNumbers.length > 0) {
    warnings.push(
      "環境に無いレコード番号 " + notFoundNumbers.length + " 件は新規追加します（番号はサーバーが採番するため、CSV の番号にはなりません）: " +
        notFoundNumbers.slice(0, 5).join(", ") + (notFoundNumbers.length > 5 ? " …" : "")
    );
  }

  const bulks = bulkify(targets);
  if (bulks.length > 1) warnings.push("一括処理が " + bulks.length + " 回に分かれます。途中で失敗すると前の回までは反映済みになります（--restore で戻せます）");
  return {
    jobName: job.name,
    jobDir: job.jobDir,
    app,
    guestSpaceId,
    schema,
    updateKey,
    keyKind: kind,
    apps: new Map([[app, { guestSpaceId, schema }]]),
    columns: job.header,
    rows: job.rows.length,
    targets,
    bulks,
    backup,
    preview,
    warnings: [...new Set(warnings)],
    stats
  };
}

/** 推定 REST API 回数。diff は計画のための GET だけ、push はバックアップ・書き込み・検証を足す。 */
export function estimateImportApiCalls(plan: ImportPlan, { push }: { push: boolean }): number {
  if (!push) return plan.stats.getCalls;
  const verify = Math.ceil(plan.targets.length / RECORDS_PER_REQUEST);
  return plan.stats.getCalls + plan.bulks.length + verify;
}
