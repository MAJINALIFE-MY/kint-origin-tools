import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { parseJsonText } from "../fsutil.js";
import { recordLocalAction } from "../runLog.js";
import { kintoneAppsRootPath, kintoneSpacesRootPath, pushImportRootPath } from "../paths.js";
import { UTF8_BOM } from "./cliKintone.js";
import { decodeCsvBytes, importColumnError, keyKindOf, parseImportConfig, parseImportCsv, parseKeyValue, resolveImportColumns } from "./recordImport.js";
import { validateJobName } from "./recordJob.js";
import { buildSchemaIndex, clearValue, normalizeDateTimeValue, parseSetValue, type FieldSchema, type SchemaIndex } from "./recordValues.js";
import type { RecordsCsvSchema } from "./recordsSchema.js";

const SCHEMA_FILE = ".kint-origin-records-schema.json";
const BASELINE_FILE = "baseline.csv";
const CHANGES_FILE = "changes.csv";
const REPORT_FILE = "report.json";
const OUTPUT_VERSION = 1;

export interface RehearsalIssue {
  scope: "baseline" | "changes";
  code: string;
  message: string;
  field?: string;
  line?: number;
  count?: number;
  severity?: "warning" | "error";
}

interface RehearsalColumn {
  code: string;
  type: string | null;
  localType: string;
  header: string[];
  status: "copied" | "added" | "type-changed" | "source-type-unknown" | "missing-source-column";
  field: FieldSchema;
  sourceIndex?: number;
}

interface CsvSource {
  header: string[];
  recordRows: string[][];
}

interface RehearsalJob {
  name: string;
  config: { app: string; updateKey: string };
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readRegularFile(filePath: string): Buffer {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new Error(`通常ファイルではありません: ${filePath}`);
  return fs.readFileSync(filePath);
}

function assertSafePath(filePath: string, kind: "file" | "directory"): void {
  const root = path.resolve(process.cwd());
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`作業ディレクトリ外のパスです: ${filePath}`);
  }
  let current = root;
  for (const [index, part] of relative.split(path.sep).entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`シンボリックリンクを含むパスです: ${current}`);
    const leaf = index === relative.split(path.sep).length - 1;
    if (!leaf && !stat.isDirectory()) throw new Error(`親パスがディレクトリではありません: ${current}`);
    if (leaf && kind === "directory" && !stat.isDirectory()) throw new Error(`ディレクトリではありません: ${current}`);
    if (leaf && kind === "file" && !stat.isFile()) throw new Error(`ファイルではありません: ${current}`);
  }
}

function appDirectoryCandidates(appId: string): string[] {
  const name = `app-${appId}`;
  const candidates: string[] = [];
  const direct = path.join(kintoneAppsRootPath(), name);
  if (fs.existsSync(direct)) candidates.push(direct);
  const spaces = kintoneSpacesRootPath();
  if (fs.existsSync(spaces)) {
    assertSafePath(spaces, "directory");
    for (const space of fs.readdirSync(spaces, { withFileTypes: true })) {
      if (!space.isDirectory() || !/^(?:space|guestspace)-[1-9]\d*$/.test(space.name)) continue;
      const candidate = path.join(spaces, space.name, "apps", name);
      if (fs.existsSync(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

function parseSourceCsv(bytes: Buffer, appId: string): CsvSource {
  let records: string[][];
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    records = parse(decoded, { bom: true, relax_column_count: false, skip_empty_lines: false });
  } catch {
    throw new Error(`アプリ ${appId} の records.csv をCSVとして読めません。pull records で再取得してください。`);
  }
  if (records.length === 0 || records[0].length === 0 || records[0].some((cell) => cell.trim() === "")) {
    throw new Error(`アプリ ${appId} の records.csv に有効なヘッダーがありません。pull records で再取得してください。`);
  }
  const header = records[0];
  if (new Set(header).size !== header.length) throw new Error(`アプリ ${appId} の records.csv に重複ヘッダーがあります。pull records で再取得してください。`);
  const hasPrimaryMarker = header[0] === "*";
  const dataRows = records.slice(1).filter((row) => !(row.length === 1 && row[0] === ""));
  if (!hasPrimaryMarker) return { header, recordRows: dataRows };

  const recordRows: string[][] = [];
  for (const row of dataRows) {
    if (row[0] === "*") recordRows.push(row);
    else if (row[0] !== "") throw new Error(`アプリ ${appId} の records.csv のサブテーブル行マーカーが不正です。pull records で再取得してください。`);
    else if (recordRows.length === 0) throw new Error(`アプリ ${appId} の records.csv がサブテーブル行から始まっています。pull records で再取得してください。`);
  }
  return { header, recordRows };
}

function loadSchema(bytes: Buffer, appId: string): RecordsCsvSchema {
  let value: unknown;
  try {
    value = parseJsonText(bytes.toString("utf8"), SCHEMA_FILE);
  } catch {
    throw new Error(`アプリ ${appId} のレコード型情報が壊れています。pull records で再取得してください。`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`アプリ ${appId} のレコード型情報が不正です。pull records で再取得してください。`);
  const schema = value as Partial<RecordsCsvSchema>;
  if (schema.schemaVersion !== 1 || schema.appId !== appId || typeof schema.formRevision !== "string" || !/^[a-f0-9]{64}$/.test(String(schema.csvSha256))) {
    throw new Error(`アプリ ${appId} のレコード型情報が一致しません。pull records で再取得してください。`);
  }
  if (!schema.fields || typeof schema.fields !== "object" || Array.isArray(schema.fields) || Object.entries(schema.fields).some(([code, type]) => !code || typeof type !== "string" || !type)) {
    throw new Error(`アプリ ${appId} のレコード型情報が不正です。pull records で再取得してください。`);
  }
  return schema as RecordsCsvSchema;
}

function loadFields(filePath: string, appId: string): SchemaIndex {
  const bytes = readRegularFile(filePath);
  let parsed: any;
  try {
    parsed = parseJsonText(bytes.toString("utf8"), filePath);
  } catch {
    throw new Error(`アプリ ${appId} の form/fields.json を読めません。pull app --id ${appId} を実行してください。`);
  }
  if (!parsed || typeof parsed !== "object" || !parsed.properties || typeof parsed.properties !== "object" || Array.isArray(parsed.properties)) {
    throw new Error(`アプリ ${appId} の form/fields.json が取得時のフォーム定義ではありません。pull app --id ${appId} を実行してください。`);
  }
  const codes = new Set<string>();
  for (const [key, field] of Object.entries(parsed.properties as Record<string, any>)) {
    if (!field || typeof field !== "object" || typeof field.code !== "string" || !field.code || field.code !== key || typeof field.type !== "string" || !field.type || codes.has(field.code)) {
      throw new Error(`アプリ ${appId} の form/fields.json に不正なフィールドがあります。pull app --id ${appId} を実行してください。`);
    }
    codes.add(field.code);
  }
  return buildSchemaIndex(parsed.properties);
}

function exportedValues(field: FieldSchema, value: string): string[] {
  if (field.type === "CHECK_BOX" || field.type === "MULTI_SELECT" || field.type === "USER_SELECT" || field.type === "ORGANIZATION_SELECT" || field.type === "GROUP_SELECT") {
    return value.split("\n").filter(Boolean);
  }
  return value === "" ? [] : [value];
}

function importHeaders(field: FieldSchema): string[] {
  return field.type === "CHECK_BOX" || field.type === "MULTI_SELECT" ? field.options.map((option) => `${field.code}[${option}]`) : [field.code];
}

function addDiagnostic(issues: RehearsalIssue[], issue: RehearsalIssue): void {
  if (issue.severity === "warning") {
    const existing = issues.find((candidate) => candidate.severity === "warning" && candidate.scope === issue.scope && candidate.code === issue.code && candidate.field === issue.field);
    if (existing) {
      existing.count = (existing.count ?? 0) + (issue.count ?? 1);
      return;
    }
  }
  issues.push(issue);
}

function expandFieldValue(field: FieldSchema, value: string, issues: RehearsalIssue[], scope: "baseline" | "changes", line?: number): string[] {
  if (field.type === "CHECK_BOX" || field.type === "MULTI_SELECT") {
    const selected = new Set(exportedValues(field, value));
    const unknown = [...selected].filter((option) => !field.options.includes(option));
    if (unknown.length > 0) addDiagnostic(issues, { scope, code: "removed-choice", message: "現フォームから削除された選択肢を除外しました。", field: field.code, line, count: unknown.length, severity: "warning" });
    return field.options.map((option) => (selected.has(option) ? "1" : ""));
  }
  if (field.type === "DROP_DOWN" || field.type === "RADIO_BUTTON") {
    if (value !== "" && !field.options.includes(value)) {
      addDiagnostic(issues, { scope, code: "removed-choice", message: "現フォームから削除された選択肢の値を空欄にしました。", field: field.code, line, count: 1, severity: "warning" });
      return [""];
    }
    return [value];
  }
  if (field.type === "DATE" || field.type === "TIME" || field.type === "DATETIME") {
    const normalized = normalizeDateTimeValue(field.type, value);
    if (!normalized) {
      addDiagnostic(issues, { scope, code: "invalid-date-value", message: "日付または時刻の形式が不正な値を空欄にしました。", field: field.code, line, count: 1, ...(scope === "baseline" ? { severity: "warning" as const } : {}) });
      return [""];
    }
    if (normalized.truncatedSeconds) addDiagnostic(issues, { scope, code: "truncated-seconds", message: "秒を切り捨てて分単位に変換しました。", field: field.code, line, count: 1, severity: "warning" });
    return [normalized.value];
  }
  return [value];
}

function stringifyImportCsv(rows: string[][]): string {
  return UTF8_BOM + stringify(rows, { record_delimiter: "\n", quoted_match: /^(?!\*$).+$/, quoted_empty: true });
}

function buildBaseline(source: CsvSource, previous: RecordsCsvSchema, schema: SchemaIndex): {
  csv: string;
  rows: number;
  columns: RehearsalColumn[];
  dropped: Array<{ code: string; reason: string }>;
  issues: RehearsalIssue[];
} {
  const issues: RehearsalIssue[] = [];
  const columns: RehearsalColumn[] = [];
  const dropped: Array<{ code: string; reason: string }> = [];
  for (const field of [...schema.top.values()].sort((a, b) => a.code.localeCompare(b.code, "ja"))) {
    const sourceIndex = source.header.indexOf(field.code);
    const sourceType = previous.fields[field.code] ?? null;
    const status: RehearsalColumn["status"] = sourceType && sourceType !== field.type ? "type-changed" : sourceIndex >= 0 && !sourceType ? "source-type-unknown" : sourceIndex >= 0 ? "copied" : sourceType ? "missing-source-column" : "added";
    const error = importColumnError(field);
    if (error) {
      dropped.push({ code: field.code, reason: "not-importable" });
      continue;
    }
    if (status === "missing-source-column") dropped.push({ code: field.code, reason: status });
    if (status === "source-type-unknown") dropped.push({ code: field.code, reason: status });
    if (status === "type-changed") dropped.push({ code: field.code, reason: status });
    columns.push({ code: field.code, type: sourceType, localType: field.type, header: importHeaders(field), status, field, ...(sourceIndex >= 0 ? { sourceIndex } : {}) });
  }
  if (columns.length === 0) {
    issues.push({ scope: "baseline", code: "no-importable-fields", message: "現フォームにCSVへ出力できるフィールドがありません。" });
    return { csv: "", rows: 0, columns, dropped, issues };
  }
  const output: string[][] = [[...columns.flatMap((column) => column.header)]];
  let emptyRequired = 0;
  for (const row of source.recordRows) {
    const outputRow: string[] = [];
    for (const column of columns) {
      const compatible = column.status === "copied" && column.sourceIndex !== undefined;
      const rawValue = compatible ? row[column.sourceIndex!] ?? "" : "";
      const values = expandFieldValue(column.field, rawValue, issues, "baseline");
      if (column.field.required && values.every((value) => value === "")) emptyRequired += 1;
      outputRow.push(...values);
    }
    output.push(outputRow);
  }
  if (emptyRequired > 0) issues.push({ scope: "baseline", code: "empty-required-values", message: "必須フィールドに空欄が残っています。画面取込前に確認してください。", count: emptyRequired, severity: "warning" });
  for (const code of source.header) {
    if (code === "*") continue;
    if (!schema.top.has(code)) dropped.push({ code, reason: previous.fields[code] ? "removed-from-form" : "unknown-source-field" });
  }
  return { csv: stringifyImportCsv(output), rows: output.length - 1, columns, dropped, issues };
}

function loadImportJob(name: string, appId: string, schema: SchemaIndex, baseline: string[][]): { job?: RehearsalJob; output?: string; rows: number; issues: RehearsalIssue[]; warning?: string } {
  const issues: RehearsalIssue[] = [];
  validateJobName(name, "push/import");
  const jobDir = path.join(pushImportRootPath(), name);
  const configPath = path.join(jobDir, "import.json");
  const csvPath = path.join(jobDir, "records.csv");
  assertSafePath(jobDir, "directory");
  const configBytes = readRegularFile(configPath);
  const csvBytes = readRegularFile(csvPath);
  const parsedConfig = parseImportConfig(configBytes.toString("utf8"));
  if ("errors" in parsedConfig) {
    issues.push({ scope: "changes", code: "invalid-import-config", message: "import.json の形式または値が不正です。" });
    return { rows: 0, issues };
  }
  const config = parsedConfig.config;
  let csvText: string;
  let parsedCsv: ReturnType<typeof parseImportCsv>;
  try {
    csvText = decodeCsvBytes(csvBytes, config.encoding);
    parsedCsv = parseImportCsv(csvText);
  } catch {
    issues.push({ scope: "changes", code: "invalid-import-csv", message: "records.csv を指定された文字コードで読み取れません。" });
    return { rows: 0, issues };
  }
  if (parsedCsv.issues.length > 0) {
    for (const issue of parsedCsv.issues) issues.push({ scope: "changes", code: "invalid-import-csv", message: "records.csv の形式が不正です。", ...(issue.lines[0] ? { line: issue.lines[0] } : {}) });
    return { rows: 0, issues };
  }
  const resolved = resolveImportColumns({ header: parsedCsv.header, schema, updateKey: config.updateKey, app: appId });
  if (resolved.issues.length > 0 || !resolved.kind) {
    for (const issue of resolved.issues) issues.push({ scope: "changes", code: "invalid-import-column", message: "列、更新キー、またはフィールド型を確認してください。", field: config.updateKey, ...(issue.lines[0] ? { line: issue.lines[0] } : {}) });
  }
  const keyField = schema.top.get(config.updateKey);
  const kind = keyField ? keyKindOf(keyField) : null;
  if (kind === "recordNumber") issues.push({ scope: "changes", code: "record-number-key", message: "別アプリへ読み込む変更CSVではレコード番号を更新キーに使えません。" , field: config.updateKey });
  if (!kind || (kind !== "text" && kind !== "number") || resolved.issues.length > 0) return { rows: 0, issues, warning: config.app !== appId ? `ジョブの app ${config.app} と --id ${appId} が異なります。--id 側のフォームで列を検証しました。` : undefined };

  const keyIndex = parsedCsv.header.indexOf(config.updateKey);
  const seen = new Set<string>();
  const output: string[][] = [parsedCsv.header.flatMap((code) => {
    const field = schema.top.get(code)!;
    return importHeaders(field);
  })];
  for (const row of parsedCsv.rows) {
    const keyResult = parseKeyValue(kind, keyField!, row.cells[keyIndex] ?? "");
    if ("error" in keyResult) {
      issues.push({ scope: "changes", code: "invalid-key", message: "更新キーの値を確認してください。", field: config.updateKey, line: row.line });
      continue;
    }
    if (seen.has(keyResult.key)) issues.push({ scope: "changes", code: "duplicate-key", message: "更新キーがCSV内で重複しています。", field: config.updateKey, line: row.line });
    seen.add(keyResult.key);
    const outputRow: string[] = [];
    parsedCsv.header.forEach((code, index) => {
      const field = schema.top.get(code)!;
      const raw = row.cells[index] ?? "";
      if (code !== config.updateKey) {
        const parsed = raw === "" ? clearValue(field) : parseSetValue(field, raw);
        if ("error" in parsed) {
          issues.push({ scope: "changes", code: "invalid-value", message: "フィールド値を確認してください。", field: code, line: row.line });
          outputRow.push(...importHeaders(field).map(() => ""));
          return;
        }
      }
      const values = expandFieldValue(field, raw, issues, "changes", row.line);
      outputRow.push(...values);
    });
    output.push(outputRow);
  }
  if (issues.some((issue) => issue.scope === "changes" && ["invalid-key", "duplicate-key", "invalid-value", "invalid-import-column", "record-number-key"].includes(issue.code))) {
    return { rows: 0, issues, warning: config.app !== appId ? `ジョブの app ${config.app} と --id ${appId} が異なります。--id 側のフォームで列を検証しました。` : undefined };
  }
  const baselineHeaders = baseline[0] ?? [];
  const keyHeader = importHeaders(keyField!)[0];
  const baselineKeyIndex = baselineHeaders.indexOf(keyHeader);
  const emptyKeys = baseline.slice(1).filter((row) => row[baselineKeyIndex] === "").length;
  if (baselineKeyIndex < 0 || emptyKeys > 0) {
    issues.push({ scope: "changes", severity: "warning", code: "baseline-key-empty", message: "baseline.csv に空欄または未出力の更新キーがあります。検証用アプリで更新キーを確認してください。", field: config.updateKey, count: baselineKeyIndex < 0 ? baseline.length - 1 : emptyKeys });
  }
  return {
    job: { name, config: { app: config.app, updateKey: config.updateKey } },
    output: stringifyImportCsv(output),
    rows: output.length - 1,
    issues,
    warning: config.app !== appId ? `ジョブの app ${config.app} と --id ${appId} が異なります。--id 側のフォームで列を検証しました。` : undefined
  };
}

function validatePreviousOutput(outputDir: string, appId: string): { baseline?: string; changes?: string } {
  const reportPath = path.join(outputDir, REPORT_FILE);
  if (!fs.existsSync(reportPath)) return {};
  const bytes = readRegularFile(reportPath);
  let report: any;
  try {
    report = parseJsonText(bytes.toString("utf8"), reportPath);
  } catch {
    throw new Error(`既存の ${reportPath} が読めません。手動で確認してください。`);
  }
  if (!report || report.schemaVersion !== OUTPUT_VERSION || report.appId !== appId || !report.files || typeof report.files !== "object") {
    throw new Error(`既存の ${reportPath} はこのコマンドの生成物として確認できません。手動で確認してください。`);
  }
  const hashes: { baseline?: string; changes?: string } = {};
  for (const name of [BASELINE_FILE, CHANGES_FILE] as const) {
    const entry = report.files[name === BASELINE_FILE ? "baseline" : "changes"];
    const filePath = path.join(outputDir, name);
    if (entry === null) {
      if (fs.existsSync(filePath)) throw new Error(`レポートに記録されていない出力ファイルがあります: ${filePath}`);
      continue;
    }
    if (!entry || entry.path !== `push/rehearsal/${appId}/${name}` || !/^[a-f0-9]{64}$/.test(entry.sha256) || !fs.existsSync(filePath)) {
      throw new Error(`既存の ${filePath} の生成記録を確認できません。手動で確認してください。`);
    }
    const current = readRegularFile(filePath);
    if (sha256(current) !== entry.sha256) throw new Error(`既存の生成CSVが編集されています。上書きしません: ${filePath}`);
    hashes[name === BASELINE_FILE ? "baseline" : "changes"] = entry.sha256;
  }
  return hashes;
}

function commitOutput(outputDir: string, stageDir: string, files: Map<string, string | null>, appId: string): void {
  const previous = validatePreviousOutput(outputDir, appId);
  const backupDir = path.join(stageDir, "previous");
  fs.mkdirSync(backupDir);
  const owned = new Set<string>([REPORT_FILE]);
  if (previous.baseline) owned.add(BASELINE_FILE);
  if (previous.changes) owned.add(CHANGES_FILE);
  for (const name of [BASELINE_FILE, CHANGES_FILE, REPORT_FILE]) {
    const target = path.join(outputDir, name);
    assertSafePath(target, "file");
    if (fs.existsSync(target) && !owned.has(name)) throw new Error(`出力先に既存ファイルがあり、生成物と確認できません: ${target}`);
  }
  const moved: string[] = [];
  const installed: string[] = [];
  let preserveStage = false;
  try {
    for (const name of owned) {
      const target = path.join(outputDir, name);
      if (!fs.existsSync(target)) continue;
      fs.renameSync(target, path.join(backupDir, name));
      moved.push(name);
    }
    for (const [name, content] of files) {
      if (content === null) continue;
      fs.renameSync(path.join(stageDir, name), path.join(outputDir, name));
      installed.push(name);
    }
  } catch (error) {
    try {
      for (const name of installed) fs.rmSync(path.join(outputDir, name), { force: true });
      for (const name of moved) fs.renameSync(path.join(backupDir, name), path.join(outputDir, name));
    } catch (restoreError) {
      preserveStage = true;
      const failure = new Error(`アプリ ${appId} の rehearsal 出力確定と前回出力の復元に失敗しました。退避先を確認してください: ${stageDir} (${restoreError instanceof Error ? restoreError.message : String(restoreError)})`);
      Object.assign(failure, { preserveStage: true });
      throw failure;
    }
    throw new Error(`アプリ ${appId} の rehearsal 出力を確定できませんでした。前回の出力を復元しました: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (!preserveStage) fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function acquireOutputLock(lockPath: string, appId: string): () => void {
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`アプリ ${appId} の rehearsal 出力が別の処理で実行中です。完了後に再実行してください。`);
    throw error;
  }
  return () => fs.unlinkSync(lockPath);
}

export interface RehearsalResult {
  status: "generated" | "issues";
  appId: string;
  baselineFile: string | null;
  changesFile: string | null;
  reportFile: string;
  baselineRows: number;
  changesRows: number;
  warningCount: number;
  issueCount: number;
}

export function diffRehearsal({ appId, importName }: { appId: string; importName?: string }): RehearsalResult {
  if (!/^[1-9]\d*$/.test(appId)) throw new Error("--id には正の整数を指定してください。");
  const candidates = appDirectoryCandidates(appId);
  if (candidates.length === 0) throw new Error(`アプリ ${appId} の取得先が見つかりません。pull app --id ${appId} と pull records --id ${appId} を実行してください。`);
  if (candidates.length > 1) throw new Error(`アプリ ${appId} の取得先が複数あります。保存先を1つにしてください: ${candidates.map((item) => path.relative(process.cwd(), item)).join(", ")}`);
  const appDir = candidates[0];
  assertSafePath(appDir, "directory");
  const recordsDir = path.join(appDir, "records");
  assertSafePath(recordsDir, "directory");
  const csvPath = path.join(recordsDir, "records.csv");
  const schemaPath = path.join(recordsDir, SCHEMA_FILE);
  const csvBytes = readRegularFile(csvPath);
  const schemaBytes = readRegularFile(schemaPath);
  const beforeSchema = loadSchema(schemaBytes, appId);
  const fieldsFile = path.join(appDir, "form", "fields.json");
  const localSchema = loadFields(fieldsFile, appId);
  const csvBytesAfter = readRegularFile(csvPath);
  const schemaBytesAfter = readRegularFile(schemaPath);
  if (!csvBytes.equals(csvBytesAfter) || !schemaBytes.equals(schemaBytesAfter)) throw new Error(`アプリ ${appId} の取得ファイルが読み込み中に変わりました。処理を再実行してください。`);
  if (sha256(csvBytes) !== beforeSchema.csvSha256) throw new Error(`アプリ ${appId} の records.csv と型情報が一致しません。pull records --id ${appId} で再取得してください。`);
  const source = parseSourceCsv(csvBytes, appId);
  const previous = beforeSchema;
  const baseline = buildBaseline(source, previous, localSchema);
  const warnings: string[] = [];
  const warningDetails = baseline.issues.filter((issue) => issue.severity === "warning");
  const issues = baseline.issues.filter((issue) => issue.severity !== "warning");

  let changes: ReturnType<typeof loadImportJob> | undefined;
  if (importName) {
    changes = loadImportJob(importName, appId, localSchema, baseline.csv ? parse(baseline.csv, { bom: true, relax_column_count: false, skip_empty_lines: false }) : []);
    warningDetails.push(...changes.issues.filter((issue) => issue.severity === "warning"));
    issues.push(...changes.issues.filter((issue) => issue.severity !== "warning"));
    if (changes.warning) warnings.push(changes.warning);
  }

  const outRoot = path.resolve(process.cwd(), "push", "rehearsal");
  const outputDir = path.join(outRoot, appId);
  const lockPath = path.join(outRoot, `${appId}.lock`);
  assertSafePath(outRoot, "directory");
  recordLocalAction("generate-record-rehearsal", outputDir);
  fs.mkdirSync(outRoot, { recursive: true });
  assertSafePath(outRoot, "directory");
  const release = acquireOutputLock(lockPath, appId);
  const stageDir = fs.mkdtempSync(path.join(outRoot, ".kint-origin-stage-"));
  let preserveStage = false;
  try {
    assertSafePath(outputDir, "directory");
    fs.mkdirSync(outputDir, { recursive: true });
    assertSafePath(outputDir, "directory");
    const relativeBaseline = `push/rehearsal/${appId}/${BASELINE_FILE}`;
    const relativeChanges = `push/rehearsal/${appId}/${CHANGES_FILE}`;
    const relativeReport = `push/rehearsal/${appId}/${REPORT_FILE}`;
    const canWriteBaseline = Boolean(baseline.csv);
    const canWriteChanges = Boolean(changes?.output) && !issues.some((issue) => issue.scope === "changes");
    const baselineBytes = canWriteBaseline ? Buffer.from(baseline.csv, "utf8") : null;
    const changesBytes = canWriteChanges ? Buffer.from(changes!.output!, "utf8") : null;
    if (baselineBytes) fs.writeFileSync(path.join(stageDir, BASELINE_FILE), baselineBytes);
    if (changesBytes) fs.writeFileSync(path.join(stageDir, CHANGES_FILE), changesBytes);
    const report = {
      schemaVersion: OUTPUT_VERSION,
      appId,
      source: {
        recordsCsv: path.relative(process.cwd(), csvPath).replaceAll("\\", "/"),
        fieldsJson: path.relative(process.cwd(), fieldsFile).replaceAll("\\", "/"),
        formRevision: previous.formRevision,
        csvSha256: previous.csvSha256
      },
      files: {
        baseline: baselineBytes ? { path: relativeBaseline, sha256: sha256(baselineBytes) } : null,
        changes: changesBytes ? { path: relativeChanges, sha256: sha256(changesBytes) } : null
      },
      baseline: {
        rows: baseline.rows,
        columns: baseline.columns.map(({ code, type, localType, header, status }) => ({ code, sourceType: type, localType, header, status })),
        dropped: baseline.dropped
      },
      changes: changes?.job ? { jobName: changes.job.name, appId: changes.job.config.app, updateKey: changes.job.config.updateKey, rows: changes.rows } : null,
      warnings: [...warnings, ...warningDetails.map((issue) => `${issue.code}${issue.field ? `:${issue.field}` : ""}${issue.count ? `:${issue.count}` : ""}`)],
      warningDetails,
      issues
    };
    fs.writeFileSync(path.join(stageDir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const oldFiles = validatePreviousOutput(outputDir, appId);
    if (oldFiles.baseline) assertSafePath(path.join(outputDir, BASELINE_FILE), "file");
    if (oldFiles.changes) assertSafePath(path.join(outputDir, CHANGES_FILE), "file");
    try {
      commitOutput(outputDir, stageDir, new Map([[BASELINE_FILE, baselineBytes ? baseline.csv : null], [CHANGES_FILE, changesBytes ? changes!.output! : null], [REPORT_FILE, "report"]]), appId);
    } catch (error) {
      if (error instanceof Error && "preserveStage" in error) preserveStage = true;
      throw error;
    }
    return {
      status: issues.length > 0 ? "issues" : "generated",
      appId,
      baselineFile: baselineBytes ? relativeBaseline : null,
      changesFile: changesBytes ? relativeChanges : null,
      reportFile: relativeReport,
      baselineRows: baseline.rows,
      changesRows: changesBytes ? changes!.rows : 0,
      warningCount: warnings.length + warningDetails.length,
      issueCount: issues.length
    };
  } finally {
    if (!preserveStage) fs.rmSync(stageDir, { recursive: true, force: true });
    release();
  }
}
