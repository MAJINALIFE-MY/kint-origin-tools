// レコード操作ジョブで使う、フィールドの型・書き込み可否・値の解釈と型変換（純関数）。
// kintone の値の形式は公式の「フィールド形式」（取得時と登録・更新時で異なる）に従う。

import { fieldTypeLabel } from "../html/fieldTypes.js";
import type { FieldPath } from "./recordJob.js";

export interface FieldSchema {
  code: string;
  type: string;
  label: string;
  required: boolean;
  defaultValue: unknown;
  /** DROP_DOWN / RADIO_BUTTON / CHECK_BOX / MULTI_SELECT の選択肢名。 */
  options: string[];
  /** テーブル内のフィールドなら、親テーブルのコード。 */
  table?: string;
  /** SUBTABLE の内側のフィールド。 */
  fields?: Map<string, FieldSchema>;
  /** ルックアップのコピー先（ルックアップが値を入れるため書き込めない）。 */
  lookupCopyTarget: boolean;
  /** 自動計算が設定された文字列（1行）。 */
  autoCalc: boolean;
  /** 「値の重複を禁止する」設定（文字列（1行）・数値）。CSV 取込の更新キーの判定に使う。 */
  unique: boolean;
}

export interface SchemaIndex {
  top: Map<string, FieldSchema>;
  /** テーブル内のフィールドを、内側のコードで引く（フィールドコードはアプリ内で一意）。 */
  inner: Map<string, FieldSchema>;
}

/** GET /app/form/fields.json の properties から、フィールドの索引を作る。 */
export function buildSchemaIndex(properties: Record<string, any>): SchemaIndex {
  const copyTargets = new Set<string>();
  const collect = (prop: any): void => {
    const mappings = prop?.lookup?.fieldMappings;
    if (!Array.isArray(mappings)) return;
    for (const mapping of mappings) if (mapping?.field) copyTargets.add(String(mapping.field));
  };
  const props = Object.values(properties ?? {}) as any[];
  for (const prop of props) {
    collect(prop);
    if (prop?.type === "SUBTABLE" && prop.fields) for (const inner of Object.values(prop.fields)) collect(inner);
  }

  const make = (prop: any, table?: string): FieldSchema => ({
    code: String(prop.code),
    type: String(prop.type),
    label: String(prop.label ?? prop.code),
    required: prop.required === true,
    defaultValue: prop.defaultValue,
    options: Object.keys(prop.options ?? {}),
    table,
    lookupCopyTarget: copyTargets.has(String(prop.code)),
    autoCalc: prop.type === "SINGLE_LINE_TEXT" && typeof prop.expression === "string" && prop.expression !== "",
    unique: prop.unique === true
  });

  const top = new Map<string, FieldSchema>();
  const inner = new Map<string, FieldSchema>();
  for (const prop of props) {
    if (!prop || typeof prop !== "object" || !prop.code) continue;
    const field = make(prop);
    if (prop.type === "SUBTABLE") {
      field.fields = new Map();
      for (const innerProp of Object.values(prop.fields ?? {}) as any[]) {
        if (!innerProp?.code) continue;
        const innerField = make(innerProp, field.code);
        field.fields.set(innerField.code, innerField);
        inner.set(innerField.code, innerField);
      }
    }
    top.set(field.code, field);
  }
  return { top, inner };
}

/** フィールド記法からスキーマを引く。見つからなければエラー文（app を含む）を返す。 */
export function resolveField(schema: SchemaIndex, path: FieldPath, app: string): FieldSchema | string {
  if (path.table) {
    const table = schema.top.get(path.table);
    if (!table) return "app " + app + " にテーブル「" + path.table + "」がありません";
    if (table.type !== "SUBTABLE") return "app " + app + " のフィールド「" + path.table + "」はテーブルではありません";
    const field = table.fields?.get(path.code);
    if (!field) return "app " + app + " のテーブル「" + path.table + "」にフィールド「" + path.code + "」がありません";
    return field;
  }
  const field = schema.top.get(path.code);
  if (!field) return "app " + app + " にフィールド「" + path.code + "」がありません";
  return field;
}

// 値の登録・更新ができない型（公式「フィールド形式」の「値を登録、または更新するとき」）。
const UNWRITABLE_TYPES = new Set([
  "RECORD_NUMBER",
  "__ID__",
  "__REVISION__",
  "CALC",
  "STATUS",
  "STATUS_ASSIGNEE",
  "CATEGORY",
  "REFERENCE_TABLE",
  "GROUP",
  "LABEL",
  "SPACER",
  "HR"
]);
// 新規レコードにだけ設定できる型（既存レコードの値は更新できない）。
const NEW_ONLY_TYPES = new Set(["CREATOR", "CREATED_TIME", "MODIFIER", "UPDATED_TIME"]);

export function typeLabel(field: FieldSchema): string {
  return fieldTypeLabel(field.type);
}

/** 書き込めないフィールドならエラー文、書き込めるなら null。 */
export function writableError(field: FieldSchema, { isNew }: { isNew: boolean }): string | null {
  const name = "フィールド「" + field.code + "」（" + typeLabel(field) + "）";
  if (UNWRITABLE_TYPES.has(field.type)) return name + "は書き込めません";
  if (field.lookupCopyTarget) return name + "はルックアップのコピー先のため書き込めません";
  if (field.autoCalc) return name + "は自動計算のため書き込めません";
  if (NEW_ONLY_TYPES.has(field.type) && !isNew) return name + "は新規レコード（new:）にだけ設定できます";
  return null;
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;

/** 数値の文字列を正規形にする（先頭の 0・小数の末尾の 0・-0 を除く）。数値として読めない文字列はそのまま返す。 */
export function canonicalNumber(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return text;
  const integer = match[2].replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const body = fraction ? integer + "." + fraction : integer;
  return body === "0" ? "0" : match[1] + body;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;

export function isValidDateTimeValue(type: string, value: string): boolean {
  if (type === "DATE") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
  }
  if (type === "TIME") {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59);
  }
  if (type === "DATETIME" || type === "CREATED_TIME" || type === "UPDATED_TIME") {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] ?? "0");
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return false;
    if (match[7] !== "Z" && (Number(match[9]) > 23 || Number(match[10]) > 59)) return false;
    return !Number.isNaN(Date.parse(value));
  }
  return false;
}

export function normalizeDateTimeValue(type: string, value: string): { value: string; truncatedSeconds: boolean } | null {
  if (value === "") return { value, truncatedSeconds: false };
  if (!isValidDateTimeValue(type, value)) return null;
  if (type === "DATETIME") {
    const match = /T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    const parsed = new Date(Date.parse(value));
    return { value: `${parsed.toISOString().slice(0, 16)}Z`, truncatedSeconds: Boolean(match?.[1]) };
  }
  return { value, truncatedSeconds: false };
}

type Parsed = { value: unknown } | { error: string };

function splitLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function optionError(field: FieldSchema, picked: string): string {
  const shown = field.options.slice(0, 10).join(", ") + (field.options.length > 10 ? ", …" : "");
  return "選択肢「" + picked + "」は「" + field.label + "」にありません（選べる値: " + shown + "）";
}

/** set の value を、FILE と SUBTABLE 以外のフィールドへ書き込む値（レコードの value に入れるもの）に変換する。 */
export function parseSetValue(field: FieldSchema, raw: string): Parsed {
  const quoted = "「" + raw + "」";
  switch (field.type) {
    case "SINGLE_LINE_TEXT":
      return raw.includes("\n") ? { error: "文字列（1行）に改行は設定できません" } : { value: raw };
    case "MULTI_LINE_TEXT":
    case "RICH_TEXT":
    case "LINK":
      return { value: raw };
    case "NUMBER":
      return NUMBER_RE.test(raw) ? { value: raw } : { error: "数値で指定してください: " + quoted };
    case "DATE":
      return DATE_RE.test(raw) && isValidDateTimeValue("DATE", raw) ? { value: raw } : { error: "実在する日付を YYYY-MM-DD で指定してください: " + quoted };
    case "TIME":
      return TIME_RE.test(raw) && isValidDateTimeValue("TIME", raw) ? { value: raw } : { error: "時刻は 00:00～23:59 で指定してください: " + quoted };
    case "DATETIME":
    case "CREATED_TIME":
    case "UPDATED_TIME":
      return DATETIME_RE.test(raw) && isValidDateTimeValue(field.type, raw) ? { value: raw } : { error: "実在する日時を 2026-11-03T10:15:00Z の形式で指定してください: " + quoted };
    case "DROP_DOWN":
    case "RADIO_BUTTON":
      return field.options.includes(raw) ? { value: raw } : { error: optionError(field, raw) };
    case "CHECK_BOX":
    case "MULTI_SELECT": {
      const picked = splitLines(raw);
      const bad = picked.find((item) => !field.options.includes(item));
      return bad === undefined ? { value: picked } : { error: optionError(field, bad) };
    }
    case "USER_SELECT":
    case "ORGANIZATION_SELECT":
    case "GROUP_SELECT":
      return { value: splitLines(raw).map((code) => ({ code })) };
    case "CREATOR":
    case "MODIFIER":
      return raw.includes("\n") ? { error: "コードは 1 つだけ指定してください" } : { value: { code: raw.trim() } };
    case "SUBTABLE":
      return { error: "テーブルは set できません。セル（テーブル[行ID].フィールド）で指定してください" };
    case "FILE":
      return { error: "添付ファイルのパスは parseLocalFilePaths で解釈します" };
    default:
      return { error: "フィールド「" + field.code + "」（" + typeLabel(field) + "）は set できません" };
  }
}

/** FILE への set の value（改行区切りの相対パス）を解釈する。存在確認は呼び出し側で行う。 */
export function parseLocalFilePaths(raw: string): { paths: string[] } | { error: string } {
  const paths = splitLines(raw);
  if (paths.length === 0) return { error: "添付ファイルのパスがありません" };
  for (const item of paths) {
    const absolute = item.startsWith("/") || item.startsWith("\x5c") || /^[A-Za-z]:/.test(item);
    const parent = item.split(/[\x5c/]/).includes("..");
    if (absolute || parent) {
      return { error: "添付ファイルのパスはジョブフォルダからの相対パスで指定してください（絶対パスと .. は使えません）: 「" + item + "」" };
    }
  }
  return { paths };
}

/** clear で書き込む値（公式「フィールドの値を空に設定する場合」）。空にできないフィールドはエラー。 */
export function clearValue(field: FieldSchema): Parsed {
  const name = "フィールド「" + field.code + "」（" + typeLabel(field) + "）";
  if (field.type === "RADIO_BUTTON") return { error: "ラジオボタンは空にできません: " + name };
  if (field.required) return { error: "必須フィールドは空にできません: " + name };
  switch (field.type) {
    case "FILE":
    case "SUBTABLE":
    case "CHECK_BOX":
    case "MULTI_SELECT":
    case "USER_SELECT":
    case "ORGANIZATION_SELECT":
    case "GROUP_SELECT":
      return { value: [] };
    case "DATE":
    case "TIME":
      return { value: null };
    case "SINGLE_LINE_TEXT":
    case "MULTI_LINE_TEXT":
    case "RICH_TEXT":
    case "LINK":
    case "NUMBER":
    case "DROP_DOWN":
    case "DATETIME":
      return { value: "" };
    default:
      return { error: name + "は空にできません" };
  }
}

// ---- copy の型の組み合わせ ----

const SELECT_ONE = new Set(["DROP_DOWN", "RADIO_BUTTON"]);
const SELECT_MANY = new Set(["CHECK_BOX", "MULTI_SELECT"]);
const TEXT_DST = new Set(["SINGLE_LINE_TEXT", "MULTI_LINE_TEXT"]);
// 文字列へコピーできる型（そのまま文字列にできるもの・複数の値を連結するもの・表示名を連結するもの）。
const TEXT_SRC = new Set([
  "SINGLE_LINE_TEXT",
  "MULTI_LINE_TEXT",
  "NUMBER",
  "CALC",
  "RECORD_NUMBER",
  "DATE",
  "TIME",
  "DATETIME",
  "CREATED_TIME",
  "UPDATED_TIME",
  "DROP_DOWN",
  "RADIO_BUTTON",
  "LINK",
  "STATUS",
  "CHECK_BOX",
  "MULTI_SELECT",
  "CATEGORY",
  "USER_SELECT",
  "ORGANIZATION_SELECT",
  "GROUP_SELECT",
  "CREATOR",
  "MODIFIER",
  "STATUS_ASSIGNEE"
]);

/** コピー元の型からコピー先の型へコピーできるか。できなければエラー文、できれば null（値には依存しない）。 */
export function copyTypeError(src: FieldSchema, dst: FieldSchema): string | null {
  const mismatch = "型 " + typeLabel(src) + " から " + typeLabel(dst) + " へはコピーできません";
  const s = src.type;
  const d = dst.type;
  if (s === d) return null;
  if (s === "FILE" || d === "FILE" || s === "SUBTABLE" || d === "SUBTABLE") return mismatch;
  if (SELECT_ONE.has(s) && SELECT_ONE.has(d)) return null;
  if (SELECT_MANY.has(s) && SELECT_MANY.has(d)) return null;
  if (TEXT_DST.has(d) && TEXT_SRC.has(s)) return null;
  if (d === "NUMBER" && (s === "CALC" || s === "RECORD_NUMBER")) return null;
  return mismatch;
}

function asString(value: unknown): string {
  return value == null ? "" : String(value);
}

function personOrString(item: any): string {
  return typeof item === "string" ? item : asString(item?.name ?? item?.code);
}

function toText(value: unknown, singleLine: boolean): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(personOrString).join(singleLine ? ", " : "\n");
  if (typeof value === "object") return personOrString(value);
  return String(value);
}

/**
 * コピー元の値（GET の value）を、コピー先のフィールドへ書き込む値に変換する。FILE と SUBTABLE は専用の処理で扱う。
 * 型の組み合わせは copyTypeError と同じ（できないものはエラー）。
 */
export function convertCopyValue(src: FieldSchema, dst: FieldSchema, value: unknown): Parsed {
  const typeError = copyTypeError(src, dst);
  if (typeError) return { error: typeError };
  if (src.type === "FILE" || src.type === "SUBTABLE") return { error: "添付ファイルとテーブルは専用の処理でコピーします" };

  switch (dst.type) {
    case "SINGLE_LINE_TEXT":
    case "MULTI_LINE_TEXT": {
      const text = src.type === dst.type ? asString(value) : toText(value, dst.type === "SINGLE_LINE_TEXT");
      if (dst.type === "SINGLE_LINE_TEXT" && text.includes("\n")) return { error: "複数行の値は文字列（1行）へコピーできません" };
      return { value: text };
    }
    case "RICH_TEXT":
    case "LINK":
    case "DATETIME":
    case "CREATED_TIME":
    case "UPDATED_TIME":
      return { value: asString(value) };
    case "DATE":
    case "TIME":
      return { value: value === "" || value == null ? null : value };
    case "NUMBER": {
      const text = asString(value);
      if (text !== "" && !NUMBER_RE.test(text)) return { error: "数値として扱えない値はコピーできません: 「" + text + "」" };
      return { value: text };
    }
    case "DROP_DOWN":
    case "RADIO_BUTTON": {
      const picked = asString(value);
      if (picked === "") {
        return dst.type === "RADIO_BUTTON" ? { error: "選択が空の値はラジオボタンへコピーできません" } : { value: null };
      }
      return dst.options.includes(picked) ? { value: picked } : { error: optionError(dst, picked) };
    }
    case "CHECK_BOX":
    case "MULTI_SELECT": {
      const picked = Array.isArray(value) ? value.map(asString) : [];
      const bad = picked.find((item) => !dst.options.includes(item));
      return bad === undefined ? { value: picked } : { error: optionError(dst, bad) };
    }
    case "USER_SELECT":
    case "ORGANIZATION_SELECT":
    case "GROUP_SELECT":
      return { value: Array.isArray(value) ? value.map((item: any) => ({ code: item?.code })) : [] };
    case "CREATOR":
    case "MODIFIER":
      return { value: { code: (value as any)?.code } };
    default:
      return { error: "型 " + typeLabel(src) + " から " + typeLabel(dst) + " へはコピーできません" };
  }
}

/** GET で得た値を、同じフィールドへ書き戻せる形（登録・更新の形式）に直す。FILE と SUBTABLE は呼び出し側で扱う。 */
export function toWritableValue(field: FieldSchema, raw: unknown): unknown {
  switch (field.type) {
    case "USER_SELECT":
    case "ORGANIZATION_SELECT":
    case "GROUP_SELECT":
      return Array.isArray(raw) ? raw.map((item: any) => ({ code: item?.code })) : [];
    case "CREATOR":
    case "MODIFIER":
      return raw && typeof raw === "object" ? { code: (raw as any).code } : raw;
    default:
      return raw;
  }
}

/** 新規レコードの必須チェック用: 既定値が空でないか。 */
export function hasDefaultValue(field: FieldSchema): boolean {
  const value = field.defaultValue;
  if (value == null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

// ---- 表示・比較・出力 ----

function itemDisplay(item: any): string {
  if (item == null) return "";
  if (typeof item !== "object") return String(item);
  return asString(item.code ?? item.name);
}

/** プレビューと検証で使う、値の文字列表現。配列は並べ替えてから改行で連結する（順序に依存しない比較のため）。 */
export function displayValue(field: FieldSchema | undefined, value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) {
    if (field?.type === "SUBTABLE") return "(" + value.length + " 行)";
    return value
      .map(itemDisplay)
      .sort((a, b) => a.localeCompare(b, "ja"))
      .join("\n");
  }
  return typeof value === "object" ? itemDisplay(value) : String(value);
}

/** show records の出力用に値を整える。fileKey は出さず、テーブルの行は行 ID 付きにする。 */
export function normalizeForShow(field: FieldSchema | undefined, value: unknown): unknown {
  switch (field?.type) {
    case "FILE":
      return Array.isArray(value)
        ? value.map((item: any) => ({ name: item?.name, size: item?.size, contentType: item?.contentType }))
        : value;
    case "USER_SELECT":
    case "ORGANIZATION_SELECT":
    case "GROUP_SELECT":
    case "STATUS_ASSIGNEE":
      return Array.isArray(value) ? value.map((item: any) => ({ code: item?.code, name: item?.name })) : value;
    case "CREATOR":
    case "MODIFIER":
      return value && typeof value === "object" ? { code: (value as any).code, name: (value as any).name } : value;
    case "SUBTABLE":
      return Array.isArray(value)
        ? value.map((row: any) => {
            const cells: Record<string, unknown> = {};
            for (const [code, cell] of Object.entries((row?.value ?? {}) as Record<string, any>)) {
              cells[code] = normalizeForShow(field.fields?.get(code), cell?.value);
            }
            return { id: row?.id, ...cells };
          })
        : value;
    default:
      return value;
  }
}
