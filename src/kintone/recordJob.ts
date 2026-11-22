// レコード操作ジョブ（push/records/<ジョブ名>/job.csv）の解析と構文検証。
// 純関数だけを置く（API もファイルも触らない）。スキーマ・データに依存する検証は recordPlan.ts で行う。

import { parse } from "csv-parse/sync";

type JobOp = "copy" | "set" | "clear";
type FileMode = "append" | "replace";
/** レコード・テーブル行の参照。既存は ID、新規（まだ存在しない）は同じジョブ内で共有するキー。 */
type RowRef = { kind: "id"; id: string } | { kind: "new"; key: string };
export type RecordRef = RowRef;

export interface FieldPath {
  /** CSV に書かれたとおりの記法（セルの競合判定のキーに使う）。 */
  raw: string;
  /** フィールドコード。テーブルのセルなら内側のフィールドのコード。 */
  code: string;
  /** テーブルのセルなら、テーブルのフィールドコード。 */
  table?: string;
  /** テーブルのセルなら、行の参照。 */
  row?: RowRef;
}

export interface JobRow {
  /** CSV のレコード番号（ヘッダーを 1 とする）。 */
  line: number;
  op: JobOp;
  from?: { app: string; record: string; field: FieldPath };
  to: { app: string; record: RecordRef; field: FieldPath };
  mode?: FileMode;
  value?: string;
  note?: string;
}

export interface JobIssue {
  lines: number[];
  message: string;
}

const JOB_HEADERS = ["op", "from_app", "from_record", "from_field", "to_app", "to_record", "to_field", "mode", "value"] as const;
const OPTIONAL_HEADERS = ["note"] as const;

const ID_RE = /^[1-9]\d*$/;
// フィールドコードには [ ] . が使えないため、これらを記法の区切りに使っても衝突しない。
const CELL_RE = /^([^\[\].]+)\[(\d+|new:[A-Za-z0-9_-]{1,40})\]\.([^\[\].]+)$/;
const PLAIN_RE = /^[^\[\].]+$/;
const NEW_RECORD_RE = /^new:([A-Za-z0-9_-]{1,40})$/;

function parseRowRef(token: string): RowRef {
  return token.startsWith("new:") ? { kind: "new", key: token.slice(4) } : { kind: "id", id: token };
}

/** フィールド記法（`コード` / `テーブル[行ID].コード` / `テーブル[new:キー].コード`）を解析する。不正なら null。 */
export function parseFieldPath(raw: string): FieldPath | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const cell = CELL_RE.exec(text);
  if (cell) return { raw: text, code: cell[3], table: cell[1], row: parseRowRef(cell[2]) };
  if (PLAIN_RE.test(text)) return { raw: text, code: text };
  return null;
}

function parseRecordRef(token: string): RecordRef | null {
  if (ID_RE.test(token)) return { kind: "id", id: token };
  const created = NEW_RECORD_RE.exec(token);
  return created ? { kind: "new", key: created[1] } : null;
}

export function recordKey(app: string, ref: RecordRef): string {
  return app + "|" + (ref.kind === "id" ? ref.id : "new:" + ref.key);
}

export function cellKey(row: JobRow): string {
  return recordKey(row.to.app, row.to.record) + "|" + row.to.field.raw;
}

function parseCsvRecords(text: string): { records: string[][]; error?: string } {
  try {
    const records: string[][] = parse(text, { bom: true, relax_column_count: true, skip_empty_lines: true });
    return { records };
  } catch (error) {
    return { records: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** job.csv を解析し、構文の問題（スキーマやデータに依存しないもの）を集める。 */
export function parseJobCsv(text: string): { rows: JobRow[]; issues: JobIssue[] } {
  const issues: JobIssue[] = [];
  const rows: JobRow[] = [];
  const { records, error } = parseCsvRecords(text);
  if (error) {
    return { rows, issues: [{ lines: [], message: "job.csv を CSV として読めません: " + error }] };
  }
  if (records.length === 0) {
    return { rows, issues: [{ lines: [], message: "job.csv が空です（ヘッダー行が必要です）" }] };
  }

  const header = records[0].map((name) => name.trim());
  const allowed: string[] = [...JOB_HEADERS, ...OPTIONAL_HEADERS];
  const missing = JOB_HEADERS.filter((name) => !header.includes(name));
  const unknown = header.filter((name) => !allowed.includes(name));
  if (missing.length > 0) issues.push({ lines: [1], message: "job.csv のヘッダーに必須列がありません: " + missing.join(", ") });
  if (unknown.length > 0) {
    issues.push({ lines: [1], message: "job.csv に不明な列があります: " + unknown.join(", ") + "（使える列: " + allowed.join(", ") + "）" });
  }
  if (missing.length > 0 || unknown.length > 0) return { rows, issues };

  const index = new Map(header.map((name, i) => [name, i] as const));
  for (let i = 1; i < records.length; i += 1) {
    const line = i + 1;
    const record = records[i];
    const raw = (name: string): string => record[index.get(name) ?? -1] ?? "";
    const get = (name: string): string => raw(name).trim();
    const opRaw = get("op").toLowerCase();
    if (opRaw.startsWith("#")) continue; // コメント行
    if (record.length !== header.length) {
      issues.push({ lines: [line], message: "列数がヘッダー（" + header.length + " 列）と一致しません（" + record.length + " 列）" });
      continue;
    }
    const op = opRaw as JobOp;
    if (op !== "copy" && op !== "set" && op !== "clear") {
      issues.push({ lines: [line], message: "op は copy / set / clear のどれかです（「" + get("op") + "」）" });
      continue;
    }

    const problems: string[] = [];
    const fromApp = get("from_app");
    const fromRecord = get("from_record");
    const fromFieldRaw = get("from_field");
    const toApp = get("to_app");
    const toRecordRaw = get("to_record");
    const toFieldRaw = get("to_field");
    const modeRaw = get("mode").toLowerCase();
    // value は前後の空白を保つ（改行コードだけ正規化する）。
    const value = raw("value").replace(/\r\n/g, "\n");
    const note = index.has("note") ? get("note") : undefined;

    let from: JobRow["from"];
    if (op === "copy") {
      if (!fromApp || !fromRecord || !fromFieldRaw) {
        problems.push("copy には from_app・from_record・from_field が必要です");
      } else {
        const fromField = parseFieldPath(fromFieldRaw);
        if (!ID_RE.test(fromApp)) problems.push("from_app はアプリ ID（数字）で指定してください");
        if (!ID_RE.test(fromRecord)) problems.push("from_record はレコード ID（数字）で指定してください（new: は指定できません）");
        if (!fromField) problems.push("from_field の書き方が不正です: 「" + fromFieldRaw + "」（コード / テーブル[行ID].コード）");
        else if (fromField.row?.kind === "new") problems.push("from_field に new: は指定できません（コピー元は既存の行 ID を指定してください）");
        else if (ID_RE.test(fromApp) && ID_RE.test(fromRecord)) from = { app: fromApp, record: fromRecord, field: fromField };
      }
      if (value !== "") problems.push("copy では value を空にしてください");
    } else if (fromApp || fromRecord || fromFieldRaw) {
      problems.push("set / clear では from_* を空にしてください");
    }

    let toRecord: RecordRef | null = null;
    let toField: FieldPath | null = null;
    if (!toApp || !toRecordRaw || !toFieldRaw) {
      problems.push("to_app・to_record・to_field が必要です");
    } else {
      if (!ID_RE.test(toApp)) problems.push("to_app はアプリ ID（数字）で指定してください");
      toRecord = parseRecordRef(toRecordRaw);
      if (!toRecord) problems.push("to_record はレコード ID（数字）か new:<キー> で指定してください（「" + toRecordRaw + "」）");
      toField = parseFieldPath(toFieldRaw);
      if (!toField) problems.push("to_field の書き方が不正です: 「" + toFieldRaw + "」（コード / テーブル[行ID].コード / テーブル[new:キー].コード）");
      if (toRecord?.kind === "new" && toField?.row?.kind === "id") {
        problems.push("新規レコード（new:）のテーブルに既存の行 ID は指定できません。new:<キー> を使ってください");
      }
    }

    if (modeRaw !== "" && modeRaw !== "append" && modeRaw !== "replace") problems.push("mode は append / replace のどちらかです（「" + get("mode") + "」）");
    if (op === "set" && value === "") problems.push("set には value が必要です（空にする場合は clear）");
    if (op === "clear") {
      if (value !== "") problems.push("clear では value を空にしてください");
      if (modeRaw !== "") problems.push("clear では mode を空にしてください");
    }

    if (problems.length > 0) {
      for (const message of problems) issues.push({ lines: [line], message });
      continue;
    }
    if (!toRecord || !toField) continue;
    rows.push({
      line,
      op,
      from,
      to: { app: toApp, record: toRecord, field: toField },
      mode: modeRaw === "" ? undefined : (modeRaw as FileMode),
      value: op === "set" ? value : undefined,
      note
    });
  }
  if (rows.length === 0 && issues.length === 0) {
    issues.push({ lines: [], message: "job.csv に操作の行がありません" });
  }
  return { rows, issues };
}

// ジョブ名に使える文字: 文字（日本語を含む）・数字・ハイフン・アンダースコア・ドット（先頭以外）。
// 禁止文字を列挙する方式では、シェルの特殊文字（; & $ ( ) ' ` ! %）や空白を含む名前が通り、
// 画面・結果 JSON に出す復旧コマンドをそのままコピーして実行すると、意図しないコマンドが動いてしまう。
const JOB_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u;

/** ジョブ名が push/records/（取込は push/import/）の下のフォルダ名として使えるか検証する（使えなければ throw）。 */
export function validateJobName(name: string, root = "push/records"): void {
  const bad =
    !name ||
    name.length > 100 ||
    !JOB_NAME_PATTERN.test(name) ||
    name.includes("..") ||
    name.endsWith(".");
  if (bad) {
    throw new Error(
      "ジョブ名が不正です: " +
        name +
        "（文字・数字・- _ . だけ、先頭は文字か数字、100 文字まで。" + root + "/ の下のフォルダ名を指定してください。_ で始まるフォルダは雛形です）"
    );
  }
}

const MAX_ISSUES_SHOWN = 50;

/** 問題をまとめた 1 つのエラー文にする（先頭 50 件だけ表示し、残りは件数で示す）。 */
export function formatIssues(jobName: string, issues: JobIssue[]): string {
  const sorted = [...issues].sort((a, b) => (a.lines[0] ?? 0) - (b.lines[0] ?? 0));
  const lines = sorted.slice(0, MAX_ISSUES_SHOWN).map((issue) =>
    issue.lines.length > 0 ? "  行 " + issue.lines.join(", ") + ": " + issue.message : "  " + issue.message
  );
  if (sorted.length > MAX_ISSUES_SHOWN) lines.push("  …ほか " + (sorted.length - MAX_ISSUES_SHOWN) + " 件");
  return ["ジョブ「" + jobName + "」に " + issues.length + " 件の問題があります（何も変更していません）:", ...lines].join("\n");
}
