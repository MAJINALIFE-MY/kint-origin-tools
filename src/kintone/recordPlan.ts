import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONCURRENCY, mapWithLimit } from "../limit.js";
import { pushRecordsRootPath } from "../paths.js";
import { lookupIndexedApp } from "./appIndex.js";
import { neutralizeFormula } from "./recordCsv.js";
import { recordsApiPath, type BulkRequestItem, type KintoneClient } from "./client.js";
import {
  cellKey,
  formatIssues,
  parseJobCsv,
  recordKey,
  validateJobName,
  type FieldPath,
  type JobIssue,
  type JobRow,
  type RecordRef
} from "./recordJob.js";
import {
  buildSchemaIndex,
  clearValue,
  convertCopyValue,
  copyTypeError,
  displayValue,
  hasDefaultValue,
  parseLocalFilePaths,
  parseSetValue,
  resolveField,
  writableError,
  type FieldSchema,
  type SchemaIndex
} from "./recordValues.js";

/** 送信前にアップロードして fileKey に置き換えるファイル（payload 中は "@upload:<id>" で参照する）。 */
export interface UploadItem {
  id: string;
  source:
    | { type: "kintone"; app: string; guestSpaceId: string; fileKey: string; name: string; size: number }
    | { type: "local"; path: string; root: string; name: string; size: number };
  /** アップロード先（コピー先アプリ）のゲストスペース ID。通常は ""。 */
  targetGuestSpaceId: string;
}

export interface TargetRecordPlan {
  app: string;
  guestSpaceId: string;
  kind: "update" | "create";
  /** update のとき、既存レコードの ID とリビジョン。 */
  id?: string;
  revision?: string;
  /** create のとき、ジョブ内の new:<キー>。 */
  newKey?: string;
  /** このレコードに関係する最初のジョブ行（エラー表示・並び順用）。 */
  firstLine: number;
  /** 送信するレコード本体（変更するフィールドだけ）。FILE は { fileKey: "@upload:u3" } を含みうる。 */
  record: Record<string, { value: unknown }>;
  /** 影響するトップレベルのフィールドコード（バックアップと検証の対象）。 */
  touched: string[];
  /** 反映後の検証用: フィールドごとの期待する表示値。 */
  expected: Array<{ field: string; display: string }>;
}

export interface BulkItem extends BulkRequestItem {
  meta: { app: string; kind: "update" | "create" | "delete"; ids?: string[]; keys?: string[] };
}

export interface BulkGroup {
  /** 1 から始まる通し番号。 */
  index: number;
  guestSpaceId: string;
  requests: BulkItem[];
}

/** 既存レコードのバックアップ（touched のフィールドの raw 値と、実行前のリビジョン）。 */
export interface BackupRecord {
  app: string;
  guestSpaceId: string;
  id: string;
  revision: string;
  fields: Record<string, any>;
}

export interface RecordPlan {
  jobName: string;
  jobDir: string;
  rows: JobRow[];
  apps: Map<string, { guestSpaceId: string; schema: SchemaIndex }>;
  targets: TargetRecordPlan[];
  uploads: UploadItem[];
  bulks: BulkGroup[];
  backup: BackupRecord[];
  /** preview.csv の内容（ヘッダー行を含む）。 */
  preview: string[][];
  warnings: string[];
  stats: {
    /** コピー元のアプリ → レコード ID の集合。 */
    sources: Map<string, Set<string>>;
    uploadBytes: number;
    backupFiles: number;
    backupBytes: number;
    /** 計画のために呼んだ GET の回数（フォーム定義＋レコード取得）。 */
    getCalls: number;
  };
}

// kintone の上限: 1 リクエスト 100 件、bulkRequest 1 回 20 リクエスト。
export const RECORDS_PER_REQUEST = 100;
export const REQUESTS_PER_BULK = 20;

const numeric = (a: string, b: string): number => Number(a) - Number(b);

/**
 * 更新・追加の対象を、kintone の上限に合わせて bulkRequest に分割する（純関数）。
 * 並び順: ゲストスペース（通常が先、その後は ID 昇順）→ アプリ ID 昇順 → 更新（レコード ID 昇順）→ 追加（ジョブの出現順）。
 * 同じゲストスペース内のアプリだけを 1 回の bulkRequest にまとめられる（kintone の制限）。
 */
export function bulkify(targets: TargetRecordPlan[]): BulkGroup[] {
  const byGuest = new Map<string, TargetRecordPlan[]>();
  for (const target of targets) {
    const list = byGuest.get(target.guestSpaceId) ?? [];
    list.push(target);
    byGuest.set(target.guestSpaceId, list);
  }
  const guestIds = [...byGuest.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : numeric(a, b)));

  const groups: BulkGroup[] = [];
  let index = 0;
  for (const guestSpaceId of guestIds) {
    const items: BulkItem[] = [];
    const inGuest = byGuest.get(guestSpaceId) ?? [];
    const apps = [...new Set(inGuest.map((target) => target.app))].sort(numeric);
    for (const app of apps) {
      const inApp = inGuest.filter((target) => target.app === app);
      const updates = inApp.filter((target) => target.kind === "update").sort((a, b) => numeric(a.id ?? "0", b.id ?? "0"));
      const creates = inApp.filter((target) => target.kind === "create").sort((a, b) => a.firstLine - b.firstLine);
      for (let i = 0; i < updates.length; i += RECORDS_PER_REQUEST) {
        const chunk = updates.slice(i, i + RECORDS_PER_REQUEST);
        items.push({
          method: "PUT",
          api: recordsApiPath(guestSpaceId),
          payload: { app, records: chunk.map((target) => ({ id: target.id, revision: target.revision, record: target.record })) },
          meta: { app, kind: "update", ids: chunk.map((target) => target.id ?? "") }
        });
      }
      for (let i = 0; i < creates.length; i += RECORDS_PER_REQUEST) {
        const chunk = creates.slice(i, i + RECORDS_PER_REQUEST);
        items.push({
          method: "POST",
          api: recordsApiPath(guestSpaceId),
          payload: { app, records: chunk.map((target) => target.record) },
          meta: { app, kind: "create", keys: chunk.map((target) => target.newKey ?? "") }
        });
      }
    }
    for (let i = 0; i < items.length; i += REQUESTS_PER_BULK) {
      index += 1;
      groups.push({ index, guestSpaceId, requests: items.slice(i, i + REQUESTS_PER_BULK) });
    }
  }
  return groups;
}


// ---- ジョブの読み込みと、行の解決（スキーマに照らした検証） ----

const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 添付 1 ファイルの上限（kintone の仕様: 1GB）

interface AppInfo {
  guestSpaceId: string;
  schema: SchemaIndex;
}

/** push/records/ の下にある、job.csv を持つジョブ名（_ や . で始まる雛形・隠しフォルダは除く）。 */
function listJobNames(): string[] {
  const root = pushRecordsRootPath();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith(".") && fs.existsSync(path.join(root, entry.name, "job.csv")))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "ja"));
}

/** ジョブのフォルダと job.csv のパス。ジョブが無ければ、存在するジョブを案内して throw する。 */
export function resolveJob(jobName: string): { jobDir: string; jobFile: string } {
  validateJobName(jobName);
  const jobDir = path.join(pushRecordsRootPath(), jobName);
  const jobFile = path.join(jobDir, "job.csv");
  if (!fs.existsSync(jobFile)) {
    const names = listJobNames();
    throw new Error(
      "ジョブが見つかりません: push/records/" + jobName + "/job.csv（存在するジョブ: " + (names.length > 0 ? names.join(", ") : "なし。雛形: push/records/_example/") + "）"
    );
  }
  return { jobDir, jobFile };
}

/** cwd からの相対パス（区切りは /）。出力・文言用。 */
export function relativeToCwd(target: string): string {
  return path.relative(process.cwd(), target).split(path.sep).join("/");
}

function recordLabel(ref: RecordRef): string {
  return ref.kind === "id" ? ref.id : "new:" + ref.key;
}

interface ResolvedRow {
  row: JobRow;
  dst: FieldSchema;
  src?: FieldSchema;
  /** set / clear が書き込む値（FILE への set 以外）。 */
  setValue?: unknown;
  /** FILE への set: ジョブフォルダ内のローカルファイル。 */
  files?: Array<{ path: string; root: string; name: string; size: number }>;
  /** テーブル全体への操作（セルではない）。 */
  wholeTable: boolean;
}

function innerTableErrors(src: FieldSchema, dst: FieldSchema): string[] {
  const errors: string[] = [];
  for (const [code, dstInner] of dst.fields ?? []) {
    const srcInner = src.fields?.get(code);
    if (!srcInner || writableError(dstInner, { isNew: false })) continue;
    const typeError = copyTypeError(srcInner, dstInner);
    if (typeError) errors.push("テーブル「" + dst.code + "」の内側のフィールド「" + code + "」: " + typeError);
  }
  return errors;
}

function checkLocalFiles(row: JobRow, jobDir: string, problems: string[]): ResolvedRow["files"] {
  const parsed = parseLocalFilePaths(row.value ?? "");
  if ("error" in parsed) {
    problems.push(parsed.error);
    return undefined;
  }
  const files: NonNullable<ResolvedRow["files"]> = [];
  const jobStat = fs.lstatSync(jobDir);
  if (jobStat.isSymbolicLink() || !jobStat.isDirectory()) {
    problems.push("添付ファイルのルートが通常のフォルダではありません: 「" + jobDir + "」");
    return files;
  }
  const root = fs.realpathSync(jobDir);
  for (const item of parsed.paths) {
    const absolute = path.resolve(jobDir, item);
    const relative = path.relative(jobDir, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      problems.push("添付ファイルはジョブフォルダの中に置いてください: 「" + item + "」");
      continue;
    }
    try {
      assertLocalUploadPath(absolute, root);
      const stat = fs.statSync(absolute);
      if (stat.size > MAX_FILE_BYTES) problems.push("1GB を超える添付ファイルは扱えません: 「" + item + "」");
      else files.push({ path: absolute, root, name: path.basename(absolute), size: stat.size });
    } catch (error) {
      problems.push((error instanceof Error ? error.message : String(error)) + ": 「" + item + "」");
    }
  }
  return files;
}

/** ジョブ添付が指定ルート内の通常ファイルであり、シンボリックリンク等を経由しないことを計画・実行時に確認する。 */
export function assertLocalUploadPath(filePath: string, root: string): void {
  const rootPath = path.resolve(root);
  const absolute = path.resolve(filePath);
  const relative = path.relative(rootPath, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("添付ファイルのパスがジョブフォルダの外です");
  let current = rootPath;
  const rootStat = fs.lstatSync(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("添付ファイルのルートが通常のフォルダではありません");
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("添付ファイルのパスにシンボリックリンクまたはジャンクションがあります");
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile()) throw new Error("添付ファイルが通常ファイルではありません");
  const realRoot = fs.realpathSync(rootPath);
  const realFile = fs.realpathSync(absolute);
  const realRelative = path.relative(realRoot, realFile);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("添付ファイルの実体がジョブフォルダの外です");
}

/** 行ごとにフィールド・型・値・ファイルを検証し、解決結果を返す（API は呼ばない）。 */
function resolveRows(rows: JobRow[], apps: Map<string, AppInfo>, jobDir: string): { resolved: ResolvedRow[]; issues: JobIssue[] } {
  const resolved: ResolvedRow[] = [];
  const issues: JobIssue[] = [];
  for (const row of rows) {
    const toApp = apps.get(row.to.app);
    const dstOrError = toApp ? resolveField(toApp.schema, row.to.field, row.to.app) : "app " + row.to.app + " のフォーム定義がありません";
    if (typeof dstOrError === "string") {
      issues.push({ lines: [row.line], message: dstOrError });
      continue;
    }
    const dst = dstOrError;
    const wholeTable = dst.type === "SUBTABLE";
    const problems: string[] = [];
    const writeProblem = writableError(dst, { isNew: row.to.record.kind === "new" });
    if (writeProblem) problems.push(writeProblem);
    if (row.mode && dst.type !== "FILE" && !wholeTable) problems.push("mode は添付ファイルとテーブル全体の操作にだけ指定できます");

    const entry: ResolvedRow = { row, dst, wholeTable };
    if (row.op === "copy" && row.from) {
      const fromApp = apps.get(row.from.app);
      const srcOrError = fromApp ? resolveField(fromApp.schema, row.from.field, row.from.app) : "app " + row.from.app + " のフォーム定義がありません";
      if (typeof srcOrError === "string") problems.push(srcOrError);
      else {
        entry.src = srcOrError;
        const typeError = copyTypeError(srcOrError, dst);
        if (typeError) problems.push(typeError);
        else if (wholeTable) problems.push(...innerTableErrors(srcOrError, dst));
      }
    } else if (row.op === "set" && !writeProblem) {
      if (dst.type === "FILE") entry.files = checkLocalFiles(row, jobDir, problems);
      else {
        const parsed = parseSetValue(dst, row.value ?? "");
        if ("error" in parsed) problems.push(parsed.error);
        else entry.setValue = parsed.value;
      }
    } else if (row.op === "clear" && !writeProblem) {
      const cleared = clearValue(dst);
      if ("error" in cleared) problems.push(cleared.error);
      else entry.setValue = cleared.value;
    }
    if (problems.length > 0) for (const message of problems) issues.push({ lines: [row.line], message });
    else resolved.push(entry);
  }
  return { resolved, issues };
}

/** 同じセルへの重複書き込み、テーブル全体の replace / clear と他の操作の併用を検出する。 */
function detectConflicts(resolved: ResolvedRow[]): JobIssue[] {
  const issues: JobIssue[] = [];
  const byCell = new Map<string, ResolvedRow[]>();
  const byTable = new Map<string, ResolvedRow[]>();
  for (const item of resolved) {
    const key = cellKey(item.row);
    byCell.set(key, [...(byCell.get(key) ?? []), item]);
    const table = item.row.to.field.table ?? (item.wholeTable ? item.row.to.field.code : undefined);
    if (table) {
      const tableKey = recordKey(item.row.to.app, item.row.to.record) + "|" + table;
      byTable.set(tableKey, [...(byTable.get(tableKey) ?? []), item]);
    }
  }
  for (const group of byCell.values()) {
    if (group.length < 2) continue;
    // 添付への追記（append）どうしだけは、行の順に合成できる。
    const mergeable = group.every((item) => item.dst.type === "FILE" && item.row.op !== "clear" && item.row.mode !== "replace");
    if (mergeable) continue;
    const first = group[0].row;
    issues.push({
      lines: group.map((item) => item.row.line),
      message: "同じセル（app " + first.to.app + " / レコード " + recordLabel(first.to.record) + " / " + first.to.field.raw + "）への書き込みが重複しています"
    });
  }
  for (const group of byTable.values()) {
    const destructive = group.some((item) => item.wholeTable && (item.row.op === "clear" || item.row.mode === "replace"));
    if (destructive && group.length > 1) {
      issues.push({ lines: group.map((item) => item.row.line), message: "テーブル全体の replace / clear と他の操作は同じジョブで併用できません" });
    }
  }
  return issues;
}

// ---- レコードの取得（GET のみ） ----

type FetchedRecords = Map<string, Map<string, any>>;

function topLevelCode(path: FieldPath): string {
  return path.table ?? path.code;
}

/** ジョブが参照するレコード（コピー元・既存のコピー先）を、アプリごとに 100 件ずつ取得する。存在しない ID は issues に入れる。 */
async function fetchRecords(
  client: KintoneClient,
  apps: Map<string, AppInfo>,
  resolved: ResolvedRow[],
  counters: { getCalls: number }
): Promise<{ records: FetchedRecords; issues: JobIssue[] }> {
  const need = new Map<string, { ids: Set<string>; codes: Set<string>; lines: Map<string, number[]> }>();
  const want = (app: string, id: string, field: FieldPath, line: number): void => {
    const entry = need.get(app) ?? { ids: new Set<string>(), codes: new Set<string>(), lines: new Map<string, number[]>() };
    entry.ids.add(id);
    entry.codes.add(topLevelCode(field));
    entry.lines.set(id, [...(entry.lines.get(id) ?? []), line]);
    need.set(app, entry);
  };
  for (const { row } of resolved) {
    if (row.from) want(row.from.app, row.from.record, row.from.field, row.line);
    if (row.to.record.kind === "id") want(row.to.app, row.to.record.id, row.to.field, row.line);
  }

  const tasks: Array<{ app: string; ids: string[]; fields: string[] }> = [];
  for (const [app, entry] of need) {
    const ids = [...entry.ids].sort((a, b) => Number(a) - Number(b));
    for (let i = 0; i < ids.length; i += RECORDS_PER_REQUEST) {
      tasks.push({ app, ids: ids.slice(i, i + RECORDS_PER_REQUEST), fields: ["$id", "$revision", ...entry.codes] });
    }
  }
  const pages = await mapWithLimit(tasks, DEFAULT_CONCURRENCY, async (task) => {
    const guestSpaceId = apps.get(task.app)?.guestSpaceId ?? "";
    counters.getCalls += 1;
    return client.getRecordsByQuery(task.app, {
      query: "$id in (" + task.ids.join(",") + ") limit " + RECORDS_PER_REQUEST,
      fields: task.fields,
      guestSpaceId
    });
  });

  const records: FetchedRecords = new Map();
  tasks.forEach((task, index) => {
    const byId = records.get(task.app) ?? new Map<string, any>();
    for (const record of pages[index]) byId.set(String(record.$id?.value), record);
    records.set(task.app, byId);
  });

  const issues: JobIssue[] = [];
  for (const [app, entry] of need) {
    for (const id of entry.ids) {
      if (records.get(app)?.has(id)) continue;
      issues.push({ lines: entry.lines.get(id) ?? [], message: "app " + app + " にレコード " + id + " が存在しません（または閲覧権限がありません）" });
    }
  }
  return { records, issues };
}

/** コピー元の値（GET の value）を取り出す。テーブルのセルは行 ID で探し、無ければエラー文を返す。 */
function sourceValue(records: FetchedRecords, from: NonNullable<JobRow["from"]>): { value: unknown } | { error: string } {
  const record = records.get(from.app)?.get(from.record);
  if (!record) return { error: "app " + from.app + " にレコード " + from.record + " が存在しません" };
  const path = from.field;
  if (!path.table) return { value: record[path.code]?.value };
  const rowId = path.row?.kind === "id" ? path.row.id : "";
  const rows: any[] = Array.isArray(record[path.table]?.value) ? record[path.table].value : [];
  const row = rows.find((item) => String(item.id) === rowId);
  if (!row) return { error: "テーブル「" + path.table + "」に行 ID " + rowId + " がありません（app " + from.app + " / レコード " + from.record + "）" };
  return { value: row.value?.[path.code]?.value };
}

// ---- レコード 1 件ぶんの書き込み内容を組み立てる ----

interface FileEntry {
  /** 既存の添付（そのまま残す）。 */
  fileKey?: string;
  /** これからアップロードする添付（payload では "@upload:<id>" で参照する）。 */
  uploadId?: string;
  name: string;
}
type Cell = { kind: "value"; value: unknown } | { kind: "files"; entries: FileEntry[] };
interface NewRow {
  key?: string;
  cells: Map<string, Cell>;
}
interface TableState {
  mode: "keep" | "replace" | "clear";
  /** 実行前の行（keep のとき行 ID を残す）。 */
  base: any[];
  /** 既存の行のセルの変更（行 ID → セル）。 */
  edits: Map<string, Map<string, Cell>>;
  newRows: NewRow[];
}

interface ApplyContext {
  apps: Map<string, AppInfo>;
  records: FetchedRecords;
  uploads: UploadItem[];
  stats: RecordPlan["stats"];
  warnings: string[];
  issues: JobIssue[];
}

interface AppliedTarget {
  target: TargetRecordPlan;
  /** セルごとの変更後の表示値（preview 用。ファイルの合成が終わってから評価する）。 */
  after: Map<string, () => string>;
  before: Map<string, string>;
}

function toEntries(value: unknown): FileEntry[] {
  return Array.isArray(value) ? value.map((file: any) => ({ fileKey: file.fileKey, name: file.name })) : [];
}

function cellValue(cell: Cell): unknown {
  return cell.kind === "value" ? cell.value : cell.entries.map((entry) => ({ fileKey: entry.fileKey ?? "@upload:" + entry.uploadId }));
}

function cellsToValue(cells: Map<string, Cell>): Record<string, { value: unknown }> {
  const out: Record<string, { value: unknown }> = {};
  for (const [code, cell] of cells) out[code] = { value: cellValue(cell) };
  return out;
}

function tableRowCount(state: TableState): number {
  if (state.mode === "clear") return 0;
  return state.mode === "replace" ? state.newRows.length : state.base.length + state.newRows.length;
}

/** テーブルの送信用の行。既存の行は ID だけ（変更なし）か ID と変更したセル、新しい行は ID なし。replace なら既存の行は送らず削除する。 */
function tableRowsPayload(state: TableState): unknown[] {
  if (state.mode === "clear") return [];
  const rows: unknown[] = [];
  if (state.mode === "keep") {
    for (const row of state.base) {
      const edits = state.edits.get(String(row.id));
      rows.push(edits ? { id: row.id, value: cellsToValue(edits) } : { id: row.id });
    }
  }
  for (const row of state.newRows) rows.push({ value: cellsToValue(row.cells) });
  return rows;
}

function displayCell(field: FieldSchema | undefined, cell: Cell): string {
  return cell.kind === "value" ? displayValue(field, cell.value) : displayValue(field, cell.entries.map((entry) => ({ name: entry.name })));
}

/** 同じレコードを対象にした行を、1 件の更新（既存）または追加（new:）の内容にまとめる。 */
function applyTarget(ctx: ApplyContext, app: string, ref: RecordRef, items: ResolvedRow[]): AppliedTarget {
  const info = ctx.apps.get(app) as AppInfo;
  const existing: any = ref.kind === "id" ? ctx.records.get(app)?.get(ref.id) : undefined;
  const current: any = existing ?? {};
  const isNew = ref.kind === "new";
  const top = new Map<string, Cell>();
  const tables = new Map<string, TableState>();
  const after = new Map<string, () => string>();
  const before = new Map<string, string>();
  const issue = (line: number, message: string): void => {
    ctx.issues.push({ lines: [line], message });
  };

  const rowsOf = (table: string): any[] => (Array.isArray(current[table]?.value) ? current[table].value : []);
  const findRow = (table: string, rowId: string): any => rowsOf(table).find((row) => String(row.id) === rowId);
  const currentCell = (path: FieldPath): unknown => {
    if (!path.table) return current[path.code]?.value;
    if (path.row?.kind !== "id") return undefined;
    return findRow(path.table, path.row.id)?.value?.[path.code]?.value;
  };
  const tableState = (code: string): TableState => {
    let state = tables.get(code);
    if (!state) {
      state = { mode: "keep", base: rowsOf(code), edits: new Map(), newRows: [] };
      tables.set(code, state);
    }
    return state;
  };
  const cellsFor = (path: FieldPath): Map<string, Cell> => {
    if (!path.table || !path.row) return top;
    const state = tableState(path.table);
    if (path.row.kind === "id") {
      const cells = state.edits.get(path.row.id) ?? new Map<string, Cell>();
      state.edits.set(path.row.id, cells);
      return cells;
    }
    const key = path.row.key;
    let target = state.newRows.find((item) => item.key === key);
    if (!target) {
      target = { key, cells: new Map() };
      state.newRows.push(target);
    }
    return target.cells;
  };
  // 添付セルの現在の並び。置換（replace / clear）なら空から、追記なら既存の添付を残して始める。
  const fileEntriesOf = (path: FieldPath, replace: boolean): FileEntry[] => {
    const cells = cellsFor(path);
    const found = cells.get(path.code);
    if (found?.kind === "files") return found.entries;
    const entries = replace ? [] : toEntries(currentCell(path));
    cells.set(path.code, { kind: "files", entries });
    return entries;
  };
  const uploadFromKintone = (entries: FileEntry[], files: any[], fromApp: string): void => {
    for (const file of files) {
      const id = "u" + (ctx.uploads.length + 1);
      const size = Number(file.size) || 0;
      const guestSpaceId = ctx.apps.get(fromApp)?.guestSpaceId ?? "";
      ctx.uploads.push({ id, source: { type: "kintone", app: fromApp, guestSpaceId, fileKey: file.fileKey, name: file.name, size }, targetGuestSpaceId: info.guestSpaceId });
      ctx.stats.uploadBytes += size;
      entries.push({ uploadId: id, name: file.name });
    }
  };
  const uploadFromLocal = (entries: FileEntry[], files: NonNullable<ResolvedRow["files"]>): void => {
    for (const file of files) {
      const id = "u" + (ctx.uploads.length + 1);
      ctx.uploads.push({ id, source: { type: "local", path: file.path, root: file.root, name: file.name, size: file.size }, targetGuestSpaceId: info.guestSpaceId });
      ctx.stats.uploadBytes += file.size;
      entries.push({ uploadId: id, name: file.name });
    }
  };

  for (const item of items) {
    const { row, dst, src } = item;
    const path = row.to.field;
    const key = cellKey(row);
    if (!isNew && path.table && path.row?.kind === "id" && !findRow(path.table, path.row.id)) {
      issue(row.line, "テーブル「" + path.table + "」に行 ID " + path.row.id + " がありません（app " + app + " / レコード " + recordLabel(ref) + "）");
      continue;
    }
    if (!before.has(key)) before.set(key, displayValue(dst, item.wholeTable ? rowsOf(path.code) : currentCell(path)));

    let source: { value: unknown } | undefined;
    if (row.op === "copy" && row.from) {
      const fetched = sourceValue(ctx.records, row.from);
      if ("error" in fetched) {
        issue(row.line, fetched.error);
        continue;
      }
      source = fetched;
    }

    if (dst.type === "FILE") {
      const entries = fileEntriesOf(path, row.mode === "replace" || row.op === "clear");
      if (source && row.from) uploadFromKintone(entries, Array.isArray(source.value) ? source.value : [], row.from.app);
      else if (row.op === "set") uploadFromLocal(entries, item.files ?? []);
      after.set(key, () => displayValue(dst, entries.map((entry) => ({ name: entry.name }))));
      continue;
    }

    if (item.wholeTable) {
      const state = tableState(path.code);
      if (row.op === "clear") state.mode = "clear";
      else if (source && row.from && src) {
        if (row.mode === "replace") state.mode = "replace";
        const missing = [...(dst.fields?.keys() ?? [])].filter((code) => !src.fields?.has(code));
        if (missing.length > 0) {
          ctx.warnings.push("テーブル「" + dst.code + "」のコピー元に無いフィールドは空になります: " + missing.join(", "));
        }
        for (const srcRow of Array.isArray(source.value) ? source.value : []) {
          const cells = new Map<string, Cell>();
          for (const [code, dstInner] of dst.fields ?? []) {
            const srcInner = src.fields?.get(code);
            if (!srcInner || writableError(dstInner, { isNew: false })) continue;
            const innerValue = srcRow.value?.[code]?.value;
            if (dstInner.type === "FILE") {
              const entries: FileEntry[] = [];
              uploadFromKintone(entries, Array.isArray(innerValue) ? innerValue : [], row.from.app);
              cells.set(code, { kind: "files", entries });
              continue;
            }
            const converted = convertCopyValue(srcInner, dstInner, innerValue);
            if ("error" in converted) issue(row.line, "テーブル「" + dst.code + "」の「" + code + "」: " + converted.error);
            else cells.set(code, { kind: "value", value: converted.value });
          }
          state.newRows.push({ cells });
        }
      }
      after.set(key, () => "(" + tableRowCount(state) + " 行)");
      continue;
    }

    let value: unknown = item.setValue;
    if (source && src) {
      const converted = convertCopyValue(src, dst, source.value);
      if ("error" in converted) {
        issue(row.line, converted.error);
        continue;
      }
      value = converted.value;
    }
    cellsFor(path).set(path.code, { kind: "value", value });
    after.set(key, () => displayValue(dst, value));
  }

  const record: Record<string, { value: unknown }> = {};
  const expected: TargetRecordPlan["expected"] = [];
  for (const [code, cell] of top) {
    record[code] = { value: cellValue(cell) };
    expected.push({ field: code, display: displayCell(info.schema.top.get(code), cell) });
  }
  for (const [code, state] of tables) {
    record[code] = { value: tableRowsPayload(state) };
    expected.push({ field: code, display: "(" + tableRowCount(state) + " 行)" });
    for (const [rowId, cells] of state.edits) {
      for (const [innerCode, cell] of cells) {
        expected.push({ field: code + "[" + rowId + "]." + innerCode, display: displayCell(info.schema.inner.get(innerCode), cell) });
      }
      // 送らなかったセルは変わらないはず。kintone が省略したセルを消す挙動だった場合に検出できるよう、保持も検証する（計算・ルックアップのコピー先は再計算されるため除く）。
      const baseRow = findRow(code, rowId);
      for (const [innerCode, innerCell] of Object.entries((baseRow?.value ?? {}) as Record<string, any>)) {
        const inner = info.schema.inner.get(innerCode);
        if (cells.has(innerCode) || !inner || writableError(inner, { isNew: false })) continue;
        expected.push({ field: code + "[" + rowId + "]." + innerCode, display: displayValue(inner, innerCell?.value) });
      }
    }
  }
  const firstLine = Math.min(...items.map((item) => item.row.line));
  const touched = [...top.keys(), ...tables.keys()];
  const base = { app, guestSpaceId: info.guestSpaceId, firstLine, record, touched, expected };
  const target: TargetRecordPlan =
    ref.kind === "new"
      ? { ...base, kind: "create", newKey: ref.key }
      : { ...base, kind: "update", id: ref.id, revision: String(existing?.$revision?.value ?? "") };
  const isEmpty = (value: unknown): boolean => value == null || value === "" || (Array.isArray(value) && value.length === 0);
  for (const [code, cell] of top) {
    const field = info.schema.top.get(code);
    if (field?.required && isEmpty(cellValue(cell))) issue(firstLine, "必須フィールド「" + code + "」へ空の値は設定できません");
  }
  for (const [tableCode, state] of tables) {
    const table = info.schema.top.get(tableCode);
    for (const row of state.newRows) {
      for (const inner of table?.fields?.values() ?? []) {
        if (!inner.required) continue;
        const cell = row.cells.get(inner.code);
        if (!cell && !hasDefaultValue(inner)) issue(firstLine, "テーブル「" + tableCode + "」の必須フィールド「" + inner.code + "」が新規行にありません");
        else if (cell && isEmpty(cellValue(cell))) issue(firstLine, "テーブル「" + tableCode + "」の必須フィールド「" + inner.code + "」へ空の値は設定できません");
      }
    }
  }
  return { target, after, before };
}

// ---- 計画の組み立て ----

function numericCompare(a: string, b: string): number {
  return Number(a) - Number(b);
}

/** 新規レコードで、必須なのに既定値も指定も無いフィールドのコード。 */
function missingRequired(info: AppInfo, target: TargetRecordPlan): string[] {
  if (target.kind !== "create") return [];
  const missing: string[] = [];
  for (const field of info.schema.top.values()) {
    if (!field.required) continue;
    if (field.type === "SUBTABLE" || writableError(field, { isNew: true })) continue;
    const cell = target.record[field.code];
    if (!cell && !hasDefaultValue(field)) missing.push(field.code);
  }
  return missing;
}

/** バックアップ対象の raw 値に含まれる添付の件数とサイズ（テーブル内のセルを含む）。 */
function countFiles(fields: Record<string, any>): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value as any[]) {
      if (item && typeof item === "object" && "fileKey" in item) {
        files += 1;
        bytes += Number(item.size) || 0;
      } else if (item?.value && typeof item.value === "object") {
        for (const cell of Object.values(item.value as Record<string, any>)) visit(cell?.value);
      }
    }
  };
  for (const field of Object.values(fields)) visit(field?.value);
  return { files, bytes };
}

function compareTargets(a: TargetRecordPlan, b: TargetRecordPlan): number {
  if (a.app !== b.app) return numericCompare(a.app, b.app);
  if (a.kind !== b.kind) return a.kind === "update" ? -1 : 1;
  return a.kind === "update" ? numericCompare(a.id ?? "0", b.id ?? "0") : a.firstLine - b.firstLine;
}

const PREVIEW_HEADER = ["to_app", "to_record", "to_field", "op", "mode", "before", "after", "source", "rows"];

/**
 * diff records と push records が共有する実行計画を、GET のみで作る。
 * CSV の構文、フォーム定義との整合性、対象レコードの存在、取得した値の順に検証する。
 */
export async function buildRecordPlan({ client, jobName }: { client: KintoneClient; jobName: string }): Promise<RecordPlan> {
  const { jobDir, jobFile } = resolveJob(jobName);
  const parsed = parseJobCsv(fs.readFileSync(jobFile, "utf8"));
  if (parsed.issues.length > 0) throw new Error(formatIssues(jobName, parsed.issues));
  const rows = parsed.rows;
  const warnings: string[] = [];
  const stats: RecordPlan["stats"] = { sources: new Map(), uploadBytes: 0, backupFiles: 0, backupBytes: 0, getCalls: 0 };

  const appIds = [...new Set(rows.flatMap((row) => [row.to.app, ...(row.from ? [row.from.app] : [])]))].sort(numericCompare);
  const apps = new Map<string, AppInfo>();
  await mapWithLimit(appIds, DEFAULT_CONCURRENCY, async (appId) => {
    const indexed = lookupIndexedApp(appId);
    if (!indexed) {
      warnings.push("アプリ " + appId + " は索引にありません（通常のアプリとして扱います。ゲストスペースのアプリなら kint-origin pull index で索引を更新してください）");
    }
    const guestSpaceId = indexed?.guestSpaceId || "";
    stats.getCalls += 1;
    try {
      const form = await client.getAppResource("/app/form/fields.json", appId, { guestSpaceId });
      apps.set(appId, { guestSpaceId, schema: buildSchemaIndex(form?.properties ?? {}) });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const hint = code === "GAIA_IL23" || code === "GAIA_IL25" ? "（ゲストスペースのアプリの可能性があります。kint-origin pull index で索引を更新してください）" : "";
      throw new Error("app " + appId + " のフォーム定義を取得できません: " + (error as Error).message + hint);
    }
  });

  const { resolved, issues: rowIssues } = resolveRows(rows, apps, jobDir);
  const schemaIssues = [...rowIssues, ...detectConflicts(resolved)];
  if (schemaIssues.length > 0) throw new Error(formatIssues(jobName, schemaIssues));

  const fetched = await fetchRecords(client, apps, resolved, stats);
  if (fetched.issues.length > 0) throw new Error(formatIssues(jobName, fetched.issues));
  for (const { row } of resolved) {
    if (!row.from) continue;
    const ids = stats.sources.get(row.from.app) ?? new Set<string>();
    ids.add(row.from.record);
    stats.sources.set(row.from.app, ids);
  }

  // 行をレコード単位にまとめ、取得した値を使って書き込み内容を検証する。
  const uploads: UploadItem[] = [];
  const ctx: ApplyContext = { apps, records: fetched.records, uploads, stats, warnings, issues: [] };
  const groups = new Map<string, { app: string; ref: RecordRef; items: ResolvedRow[] }>();
  for (const item of resolved) {
    const key = recordKey(item.row.to.app, item.row.to.record);
    const group = groups.get(key) ?? { app: item.row.to.app, ref: item.row.to.record, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const applied = [...groups.values()].map((group) => applyTarget(ctx, group.app, group.ref, group.items));
  applied.sort((a, b) => compareTargets(a.target, b.target));
  for (const { target } of applied) {
    for (const code of missingRequired(apps.get(target.app) as AppInfo, target)) {
      ctx.issues.push({ lines: [target.firstLine], message: "新規レコード new:" + target.newKey + " に必須フィールド「" + code + "」がありません" });
    }
  }
  if (ctx.issues.length > 0) throw new Error(formatIssues(jobName, ctx.issues));

  // 復旧に備え、変更対象のフィールドの取得値と実行前のリビジョンを保持する。
  const backup: BackupRecord[] = [];
  for (const { target } of applied) {
    if (target.kind !== "update" || !target.id) continue;
    const record = fetched.records.get(target.app)?.get(target.id);
    const fields: Record<string, any> = {};
    for (const code of target.touched) fields[code] = record?.[code] ?? { value: null };
    backup.push({ app: target.app, guestSpaceId: target.guestSpaceId, id: target.id, revision: target.revision ?? "", fields });
    const counted = countFiles(fields);
    stats.backupFiles += counted.files;
    stats.backupBytes += counted.bytes;
  }

  const afterByCell = new Map<string, () => string>();
  const beforeByCell = new Map<string, string>();
  for (const item of applied) {
    for (const [key, fn] of item.after) afterByCell.set(key, fn);
    for (const [key, value] of item.before) beforeByCell.set(key, value);
  }
  const preview: string[][] = [PREVIEW_HEADER];
  for (const { row } of resolved) {
    const key = cellKey(row);
    const source = row.op === "copy" && row.from ? row.from.app + "/" + row.from.record + "/" + row.from.field.raw : row.op;
    preview.push([row.to.app, recordLabel(row.to.record), row.to.field.raw, row.op, row.mode ?? "", neutralizeFormula(beforeByCell.get(key) ?? ""), neutralizeFormula(afterByCell.get(key)?.() ?? ""), source, String(row.line)]);
  }
  const targets = applied.map((item) => item.target);
  const bulks = bulkify(targets);
  if (bulks.length > 1) {
    warnings.push("一括処理が " + bulks.length + " 回に分かれます。途中で失敗すると前の回までは反映済みになります（--restore で戻せます）");
  }
  return { jobName, jobDir, rows, apps, targets, uploads, bulks, backup, preview, warnings: [...new Set(warnings)], stats };
}

/** 推定 REST API 回数。diff は計画のための GET だけ、push はバックアップ・転送・書き込み・検証を足す。 */
export function estimateApiCalls(plan: RecordPlan, { push }: { push: boolean }): number {
  if (!push) return plan.stats.getCalls;
  const downloads = new Set(plan.uploads.flatMap((upload) => (upload.source.type === "kintone" ? [upload.source.fileKey] : [])));
  const perApp = new Map<string, number>();
  for (const target of plan.targets) perApp.set(target.app, (perApp.get(target.app) ?? 0) + 1);
  const verify = [...perApp.values()].reduce((sum, count) => sum + Math.ceil(count / RECORDS_PER_REQUEST), 0);
  return plan.stats.getCalls + plan.stats.backupFiles + downloads.size + plan.uploads.length + plan.bulks.length + verify;
}
