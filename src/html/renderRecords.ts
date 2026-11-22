import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { sanitizeFileName } from "../normalize.js";
import { escapeHtml, hrefPath } from "./page.js";
import { fieldTypeLabel } from "./fieldTypes.js";

// file:// のページから遅延読み込みできるよう、レコード一覧を別ファイルの JSONP として出力する。

interface FileLink {
  n: string; // 表示名（CSV 上のファイル名）
  h: string | null; // 実体があれば相対 href、無ければ null
}

type CellValue = string | { f: FileLink[] };

interface RecordGroup {
  rid: string; // レコードID（添付ディレクトリ名。レコード番号の数値部）
  rows: CellValue[][]; // 先頭行=主行、以降=サブテーブル行
}

export interface RecordsBuild {
  // window.__kintRecords(...) を呼ぶ JS ソース（app-<id>.records.js の中身）。
  recordsJs: string;
  total: number;
}

interface FieldProperty {
  type?: string;
  code?: string;
  label?: string;
  fields?: Record<string, FieldProperty>;
}

// fields.json から FILE フィールドコード（トップレベル＋サブテーブル内）を集める。
function collectFileFieldCodes(properties: Record<string, FieldProperty>): Set<string> {
  const codes = new Set<string>();
  for (const prop of Object.values(properties)) {
    if (!prop || typeof prop !== "object") continue;
    if (prop.type === "FILE" && prop.code) codes.add(prop.code);
    if (prop.type === "SUBTABLE" && prop.fields) {
      for (const sub of Object.values(prop.fields)) {
        if (sub?.type === "FILE" && sub.code) codes.add(sub.code);
      }
    }
  }
  return codes;
}

// サブテーブル内サブフィールドも含め、コード→プロパティの平坦マップを作る。
function flattenProperties(properties: Record<string, FieldProperty>): Map<string, FieldProperty> {
  const map = new Map<string, FieldProperty>();
  for (const prop of Object.values(properties)) {
    if (!prop || typeof prop !== "object" || !prop.code) continue;
    map.set(prop.code, prop);
    if (prop.type === "SUBTABLE" && prop.fields) {
      for (const sub of Object.values(prop.fields)) {
        if (sub?.code) map.set(sub.code, sub);
      }
    }
  }
  return map;
}

// レコード番号セル値からレコードID（数値部）を取り出す。アプリコード付き "CODE-123" にも対応。
function recordIdOf(value: string): string {
  const match = /(\d+)\s*$/.exec(String(value || ""));
  return match ? match[1] : "";
}

export function buildRecordsData({
  csvText,
  fieldsPayload,
  attachmentsDir,
  attachmentsHrefBase
}: {
  csvText: string;
  fieldsPayload: unknown;
  // records/attachments の絶対パス（実体存在チェック用）。
  attachmentsDir: string;
  // アプリページから records/attachments までの相対パス（"/" 区切り・未エンコード）。
  attachmentsHrefBase: string;
}): RecordsBuild {
  const rows: string[][] = parse(csvText, { bom: true, relax_column_count: true, skip_empty_lines: true });
  const header = rows[0] || [];
  const hasSubtableMarker = header[0] === "*";
  const columnCodes = hasSubtableMarker ? header.slice(1) : header;

  const properties =
    fieldsPayload && typeof fieldsPayload === "object" && (fieldsPayload as any).properties
      ? ((fieldsPayload as any).properties as Record<string, FieldProperty>)
      : {};
  const fileCodes = collectFileFieldCodes(properties);
  const propByCode = flattenProperties(properties);

  const columns = columnCodes.map((code) => {
    const prop = propByCode.get(code);
    return {
      code,
      label: prop?.label || code,
      type: prop?.type ? fieldTypeLabel(prop.type) : "",
      isFile: fileCodes.has(code)
    };
  });

  // レコード番号列: fields.json の RECORD_NUMBER を優先し、無ければ既定名、最後は先頭列。
  let recordNumberIndex = -1;
  for (const prop of Object.values(properties)) {
    if (prop?.type === "RECORD_NUMBER" && prop.code) {
      recordNumberIndex = columnCodes.indexOf(prop.code);
      break;
    }
  }
  if (recordNumberIndex < 0) recordNumberIndex = columnCodes.indexOf("レコード番号");
  if (recordNumberIndex < 0) recordNumberIndex = columnCodes.indexOf("Record_number");
  if (recordNumberIndex < 0) recordNumberIndex = 0;

  // 添付リンク: 実体は sanitizeFileName で保存され同名は上書きされる（recordAttachments.ts と同一規則）。
  const fileLinksOf = (recordId: string, code: string, cell: string): { f: FileLink[] } => {
    const names = String(cell || "")
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);
    return {
      f: names.map((name) => {
        const stored = sanitizeFileName(name);
        const exists =
          Boolean(recordId) && fs.existsSync(path.join(attachmentsDir, recordId, code, stored));
        return { n: name, h: exists ? hrefPath(attachmentsHrefBase, recordId, code, stored) : null };
      })
    };
  };

  const records: RecordGroup[] = [];
  for (const row of rows.slice(1)) {
    const cells = hasSubtableMarker ? row.slice(1) : row;
    const isMainRow = hasSubtableMarker ? row[0] === "*" : true;
    if (isMainRow) {
      records.push({ rid: recordIdOf(cells[recordNumberIndex] ?? ""), rows: [] });
    }
    const current = records[records.length - 1];
    if (!current) continue; // 主行より前にサブ行が来る不正 CSV は無視
    const converted: CellValue[] = cells.map((cell, index) => {
      const code = columnCodes[index] ?? "";
      if (fileCodes.has(code) && cell) return fileLinksOf(current.rid, code, cell);
      return cell ?? "";
    });
    current.rows.push(converted);
  }

  const payload = { columns, records, total: records.length };
  // "<" を JS の < エスケープへ置換し、値中の "</script>" による早期終端を防ぐ。
  const json = JSON.stringify(payload).replaceAll("<", "\\u003c");
  return { recordsJs: `window.__kintRecords(${json});\n`, total: records.length };
}

export function recordsSectionHtml({
  recordsJsName,
  total,
  csvHref
}: {
  recordsJsName: string;
  total: number;
  csvHref: string;
}): string {
  return [
    `<div id="records-viewer" data-src="${escapeHtml(recordsJsName)}">`,
    `<div class="records-bar">`,
    `<input id="rec-search" class="filter-input" type="search" placeholder="レコードを検索（全列部分一致）">`,
    `<span id="rec-count" class="muted">全 ${escapeHtml(total)} 件</span>`,
    `<span class="pager">`,
    `<button id="rec-prev" type="button">前へ</button>`,
    `<span id="rec-page" class="muted"></span>`,
    `<button id="rec-next" type="button">次へ</button>`,
    `</span>`,
    `<a href="${escapeHtml(csvHref)}">records.csv を開く</a>`,
    `</div>`,
    `<div id="rec-table-wrap" class="tbl-scroll"><p class="muted">レコードデータを読み込み中…</p></div>`,
    `</div>`
  ].join("\n");
}

// レコードビューアのクライアント JS（静的文字列のみ。動的値を含めない）。
// DOM は textContent / createElement で構築し、innerHTML に動的値を渡さない。
export const RECORDS_VIEWER_JS = `
(function () {
  "use strict";
  var box = document.getElementById("records-viewer");
  if (!box) return;
  var wrap = document.getElementById("rec-table-wrap");
  var searchInput = document.getElementById("rec-search");
  var prevButton = document.getElementById("rec-prev");
  var nextButton = document.getElementById("rec-next");
  var PAGE_SIZE = 100;
  var state = { payload: null, page: 0, query: "" };

  window.__kintRecords = function (payload) {
    state.payload = payload;
    render();
  };

  var loader = document.createElement("script");
  loader.src = box.getAttribute("data-src");
  loader.onerror = function () {
    wrap.textContent = "レコードデータを読み込めませんでした（" + box.getAttribute("data-src") + " が見つかりません。kint-origin html を再実行してください）。";
  };
  document.body.appendChild(loader);

  searchInput.addEventListener("input", function () {
    state.query = searchInput.value.toLowerCase();
    state.page = 0;
    render();
  });
  prevButton.addEventListener("click", function () { state.page -= 1; render(); });
  nextButton.addEventListener("click", function () { state.page += 1; render(); });

  function cellText(value) {
    if (value && typeof value === "object" && value.f) {
      return value.f.map(function (file) { return file.n; }).join("\\n");
    }
    return value == null ? "" : String(value);
  }

  function matches(record, query) {
    if (!query) return true;
    for (var i = 0; i < record.rows.length; i += 1) {
      var row = record.rows[i];
      for (var j = 0; j < row.length; j += 1) {
        if (cellText(row[j]).toLowerCase().indexOf(query) >= 0) return true;
      }
    }
    return false;
  }

  function buildCell(value) {
    var td = document.createElement("td");
    if (value && typeof value === "object" && value.f) {
      for (var i = 0; i < value.f.length; i += 1) {
        if (i > 0) td.appendChild(document.createElement("br"));
        var file = value.f[i];
        if (file.h) {
          var link = document.createElement("a");
          link.href = file.h;
          link.textContent = file.n;
          td.appendChild(link);
        } else {
          td.appendChild(document.createTextNode(file.n));
        }
      }
      return td;
    }
    var span = document.createElement("span");
    span.className = "cell-multiline";
    span.textContent = value == null ? "" : String(value);
    td.appendChild(span);
    return td;
  }

  function render() {
    var payload = state.payload;
    if (!payload) return;
    var filtered = [];
    for (var i = 0; i < payload.records.length; i += 1) {
      if (matches(payload.records[i], state.query)) filtered.push(payload.records[i]);
    }
    var pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (state.page >= pages) state.page = pages - 1;
    if (state.page < 0) state.page = 0;

    var table = document.createElement("table");
    table.className = "tbl records-table";
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    for (var c = 0; c < payload.columns.length; c += 1) {
      var th = document.createElement("th");
      var column = payload.columns[c];
      th.textContent = column.label === column.code ? column.label : column.label + " (" + column.code + ")";
      if (column.type) th.title = column.type;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    var start = state.page * PAGE_SIZE;
    var slice = filtered.slice(start, start + PAGE_SIZE);
    for (var r = 0; r < slice.length; r += 1) {
      var tbody = document.createElement("tbody");
      tbody.className = "rec";
      for (var rowIndex = 0; rowIndex < slice[r].rows.length; rowIndex += 1) {
        var tr = document.createElement("tr");
        tr.className = rowIndex === 0 ? "main" : "sub";
        var row = slice[r].rows[rowIndex];
        for (var cellIndex = 0; cellIndex < payload.columns.length; cellIndex += 1) {
          tr.appendChild(buildCell(row[cellIndex]));
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }

    wrap.innerHTML = "";
    if (filtered.length === 0) {
      var empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = state.query ? "検索条件に一致するレコードはありません。" : "レコードがありません。";
      wrap.appendChild(empty);
    } else {
      wrap.appendChild(table);
    }

    document.getElementById("rec-count").textContent = state.query
      ? filtered.length + " / " + payload.total + " 件"
      : "全 " + payload.total + " 件";
    document.getElementById("rec-page").textContent = (state.page + 1) + " / " + pages + " ページ";
    prevButton.disabled = state.page === 0;
    nextButton.disabled = state.page >= pages - 1;
  }
})();
`;
