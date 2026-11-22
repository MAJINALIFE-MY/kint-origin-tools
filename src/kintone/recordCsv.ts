import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { UTF8_BOM } from "./cliKintone.js";

function recordIdFromCell(value: string): string | null {
  if (value === "*") return null;
  const match = /^(?:.*-)?([1-9]\d*)$/.exec(value.trim());
  return match?.[1] ?? null;
}

function recordRows(rows: string[][], recordNumberIndex: number): Array<{ id: string; start: number; end: number }> {
  const groups: Array<{ id: string; start: number; end: number }> = [];
  let current: { id: string; start: number; end: number } | undefined;
  for (let index = 1; index < rows.length; index += 1) {
    const cell = rows[index][recordNumberIndex] ?? "";
    const id = recordIdFromCell(cell);
    if (id) {
      if (current) current.end = index;
      current = { id, start: index, end: index + 1 };
      groups.push(current);
    } else if (cell === "*" || cell === "") {
      if (current) current.end = index + 1;
    }
  }
  return groups;
}

export function assertRecordCsvContainsId(csv: string, recordNumberField: string, recordId: string): void {
  const rows = parseCsv(csv);
  const index = (rows[0] ?? []).indexOf(recordNumberField);
  if (index < 0) throw new Error(`CSV にレコード番号フィールド "${recordNumberField}" がありません。`);
  const wanted = recordIdFromCell(recordId) ?? recordId.trim();
  if (!recordRows(rows, index).some((group) => group.id === wanted)) throw new Error(`レコードID ${recordId} の取得結果がありません。records.csv は更新していません。`);
}

function parseCsv(csv: string): string[][] {
  return parse(csv, { bom: true, relax_column_count: false, skip_empty_lines: true });
}

// cli-kintone と同じ引用・改行規則で CSV を再生成する。
// 数式として解釈される先頭文字（= + - @ とタブ・復帰）の値。preview.csv を表計算ソフトで開いたとき、
// kintone のレコードの値（外部の人が入力できる）が数式として実行されないよう、先頭にシングルクォートを付ける。
// 見るための preview.csv の変更前後の値だけに使う。取得物（records.csv）や、計画・実行に使う値は変えない。
export function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function stringifyCsv(rows: string[][]): string {
  return UTF8_BOM + stringify(rows, {
    record_delimiter: "\n",
    quoted_match: /^(?!\*$).+$/,
    quoted_empty: false
  });
}

// 単一レコード取得CSVを既存CSVへ反映する。サブテーブルを含む場合も同じレコード番号の全行を置換する。
export function mergeRecordCsv(existingCsv: string, replacementCsv: string, recordNumberField: string, recordId: string): string {
  const existingRows = parseCsv(existingCsv);
  const replacementRows = parseCsv(replacementCsv);
  const existingHeader = existingRows[0] || [];
  const replacementHeader = replacementRows[0] || [];

  if (existingHeader.length === 0 || replacementHeader.length === 0) {
    throw new Error("records.csv のヘッダーを読み取れませんでした。");
  }
  if (existingHeader.length !== replacementHeader.length || existingHeader.some((value, index) => value !== replacementHeader[index])) {
    throw new Error("既存 records.csv と取得結果の列構成が異なります。先に全件取得を実行してください。");
  }

  const recordNumberIndex = existingHeader.indexOf(recordNumberField);
  if (recordNumberIndex < 0) {
    throw new Error(`records.csv にレコード番号フィールド "${recordNumberField}" がありません。`);
  }

  const wantedId = recordIdFromCell(recordId) ?? recordId.trim();
  assertRecordCsvContainsId(replacementCsv, recordNumberField, wantedId);
  const replacementGroups = recordRows(replacementRows, recordNumberIndex).filter((group) => group.id === wantedId);
  const replacement = replacementGroups.flatMap((group) => replacementRows.slice(group.start, group.end));

  const merged: string[][] = [existingHeader];
  const targets = recordRows(existingRows, recordNumberIndex).filter((group) => group.id === wantedId);
  const targetRows = new Set<number>();
  for (const group of targets) for (let index = group.start; index < group.end; index += 1) targetRows.add(index);
  let inserted = false;
  for (let index = 1; index < existingRows.length; index += 1) {
    if (targetRows.has(index)) {
      if (!inserted) merged.push(...replacement);
      inserted = true;
      continue;
    }
    merged.push(existingRows[index]);
  }
  if (!inserted) merged.push(...replacement);
  return stringifyCsv(merged);
}
