// 静的HTML生成の共通部品。動的値は例外なく escapeHtml を通す（属性値も含む）。
// 生成物は file:// で直接開く前提: 外部CDN・Webフォント・fetch/XHR は使わない。

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// 相対 href をセグメント単位で percent-encode して "/" 連結する。
// 日本語ファイル名も file:// で解決できる。Windows の "\" は絶対に出さない。
export function hrefPath(...segments: string[]): string {
  return segments
    .flatMap((segment) => String(segment).split("/"))
    .filter((part) => part.length > 0)
    .map((part) => (part === ".." || part === "." ? part : encodeURIComponent(part)))
    .join("/");
}

export function badge(text: string, kind: "muted" | "error" | "deleted" | "ok" = "muted"): string {
  return `<span class="badge badge-${kind}">${escapeHtml(text)}</span>`;
}

// 歯車アイコン（インライン SVG。file:// 前提のため外部画像は使わない）。
const GEAR_SVG =
  `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">` +
  `<path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.86z"/>` +
  `</svg>`;

// kintone アプリ設定画面（フォーム設定）への外部リンク（歯車アイコン）。
// domain は app.json の domain（ホスト名）。未取得なら空文字を返す（削除済みアプリは呼び出し側で抑止）。
export function appAdminLink(domain: string, appId: string, guestSpaceId?: string): string {
  if (!domain || !appId) return "";
  const prefix = guestSpaceId ? `/k/guest/${encodeURIComponent(guestSpaceId)}` : "/k";
  const url = `https://${domain}${prefix}/admin/app/flow?app=${encodeURIComponent(appId)}#section=form`;
  return `<a class="admin-link" href="${escapeHtml(url)}" title="kintone のアプリ設定画面を開く" target="_blank" rel="noopener">${GEAR_SVG}</a>`;
}

// 元データ（取得 JSON）を折りたたみで併記し、data/ 内の実ファイルへの相対リンクも付ける。
export function jsonDetails(label: string, payload: unknown, fileHref: string): string {
  return [
    `<details class="rawjson"><summary>元データ (${escapeHtml(label)})</summary>`,
    `<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`,
    `<p class="rawjson-link"><a href="${escapeHtml(fileHref)}">${escapeHtml(label)} を開く</a></p>`,
    `</details>`
  ].join("");
}

// {"_error": "..."} 形式（pull 時の取得失敗）ならメッセージを返す。
export function errorMessageOf(payload: unknown): string {
  if (payload && typeof payload === "object" && typeof (payload as Record<string, unknown>)._error === "string") {
    return String((payload as Record<string, unknown>)._error);
  }
  return "";
}

// ヘッダー行＋データ行（セルは呼び出し側で escape/構築済みの HTML）から table を組む。
export function htmlTable(headers: string[], rows: string[][], options: { id?: string; className?: string } = {}): string {
  const idAttr = options.id ? ` id="${escapeHtml(options.id)}"` : "";
  const classAttr = ` class="tbl${options.className ? ` ${escapeHtml(options.className)}` : ""}"`;
  const thead = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<table${idAttr}${classAttr}>${thead}${tbody}</table>`;
}

// ラベルと値（テキスト）の定義リスト。値は内部で escape する。
export function definitionList(pairs: Array<[string, unknown]>): string {
  const items = pairs
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "")}</dd>`)
    .join("");
  return `<dl class="def">${items}</dl>`;
}

// テーブルのテキストフィルタ（静的 JS。動的値を含めない）。
// data-filter-target="<tableId>" を持つ input が対象テーブルの tbody 行を絞り込む。
const FILTER_JS = `
(function () {
  "use strict";
  var inputs = document.querySelectorAll("input[data-filter-target]");
  for (var i = 0; i < inputs.length; i += 1) {
    (function (input) {
      var table = document.getElementById(input.getAttribute("data-filter-target"));
      if (!table) return;
      input.addEventListener("input", function () {
        var query = input.value.toLowerCase();
        var rows = table.tBodies.length ? table.tBodies[0].rows : [];
        for (var j = 0; j < rows.length; j += 1) {
          var hit = rows[j].textContent.toLowerCase().indexOf(query) >= 0;
          rows[j].style.display = hit ? "" : "none";
        }
      });
    })(inputs[i]);
  }
})();
`;

const PAGE_CSS = `
:root {
  --border: #d5d9e0;
  --bg: #f5f6f8;
  --panel: #ffffff;
  --text: #333941;
  --muted: #7a828e;
  --accent: #3498db;
  --accent-dark: #20669a;
  --head-bg: #eef1f5;
}
* { box-sizing: border-box; }
html { scroll-padding-top: 4.5rem; }
body {
  margin: 0;
  font-family: "Yu Gothic UI", "Meiryo", "Hiragino Kaku Gothic ProN", system-ui, sans-serif;
  font-size: 14px;
  color: var(--text);
  background: var(--bg);
  line-height: 1.6;
}
a { color: var(--accent-dark); text-decoration: none; }
a:hover { text-decoration: underline; }
.topbar {
  position: sticky; top: 0; z-index: 20;
  background: #2c3e50; color: #fff;
  padding: 0.55rem 1.2rem;
  display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
}
.topbar a { color: #cfe3f5; }
.topbar .crumb-sep { color: #7f96ac; }
.topbar strong { color: #fff; font-weight: 600; }
.wrap { display: flex; gap: 1rem; max-width: 1400px; margin: 0 auto; padding: 1rem 1.2rem 4rem; align-items: flex-start; }
main { flex: 1 1 auto; min-width: 0; }
.toc {
  flex: 0 0 200px; position: sticky; top: 3.4rem;
  background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
  padding: 0.6rem 0.8rem; font-size: 13px;
}
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc li { margin: 0.15rem 0; }
h1 { font-size: 1.35rem; margin: 0.4rem 0 0.8rem; }
h2 { font-size: 1.1rem; margin: 0; }
section.card {
  background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
  padding: 0.9rem 1.1rem; margin: 0 0 1rem;
}
section.card > .card-head {
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  border-bottom: 2px solid var(--accent); padding-bottom: 0.45rem; margin-bottom: 0.7rem;
}
.tbl { border-collapse: collapse; width: 100%; background: #fff; }
.tbl th, .tbl td { border: 1px solid var(--border); padding: 0.35rem 0.55rem; text-align: left; vertical-align: top; word-break: break-word; }
.tbl th { background: var(--head-bg); font-weight: 600; white-space: nowrap; position: sticky; top: 2.6rem; }
.tbl-plain th { position: static; }
.tbl td.center { text-align: center; }
.tbl-scroll { overflow-x: auto; }
.muted { color: var(--muted); }
.badge {
  display: inline-block; font-size: 11px; border-radius: 3px; padding: 0.05rem 0.45rem;
  border: 1px solid var(--border); background: var(--head-bg); color: var(--muted); vertical-align: middle;
}
.badge-error { background: #fdecea; border-color: #f5c6c0; color: #b3261e; }
.badge-deleted { background: #fdf3e6; border-color: #f0d5ac; color: #9a6a1f; }
.badge-ok { background: #e8f4ec; border-color: #bfe0cb; color: #1e7d43; }
.admin-link { margin-left: 0.35rem; color: var(--muted); vertical-align: -2px; }
.admin-link:hover { color: var(--accent-dark); }
h1 .admin-link svg { width: 16px; height: 16px; }
.def { display: grid; grid-template-columns: 12em 1fr; gap: 0.15rem 1rem; margin: 0; }
.def dt { color: var(--muted); }
.def dd { margin: 0; white-space: pre-wrap; }
.rawjson { margin-top: 0.7rem; font-size: 13px; }
.rawjson > summary { cursor: pointer; color: var(--muted); }
.rawjson pre {
  background: #2b2f36; color: #dde3ea; border-radius: 4px;
  padding: 0.7rem; overflow: auto; max-height: 24rem; font-size: 12px;
}
.filter-input {
  width: 22em; max-width: 100%; padding: 0.3rem 0.55rem; margin: 0 0 0.6rem;
  border: 1px solid var(--border); border-radius: 4px; font-size: 14px;
}
.layout-row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
.layout-field {
  border: 1px solid var(--border); border-radius: 4px; background: #fafbfc;
  padding: 0.3rem 0.5rem; font-size: 12px; min-width: 6em;
}
.layout-field .lf-label { font-weight: 600; display: block; }
.layout-field .lf-meta { color: var(--muted); }
.layout-group { border: 1px dashed var(--border); border-radius: 4px; padding: 0.5rem 0.7rem; margin-bottom: 0.5rem; }
.layout-group > .lg-title { font-weight: 600; margin-bottom: 0.4rem; }
.flow-line { margin: 0.15rem 0; }
.flow-arrow { color: var(--accent-dark); padding: 0 0.35rem; }
.records-bar { display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap; margin-bottom: 0.6rem; }
.records-bar .pager { display: flex; align-items: center; gap: 0.35rem; }
.records-bar button {
  border: 1px solid var(--border); background: #fff; border-radius: 4px;
  padding: 0.2rem 0.7rem; cursor: pointer; font-size: 13px;
}
.records-bar button:disabled { color: #c1c6cd; cursor: default; }
.records-table td { max-width: 28em; }
.records-table td .cell-multiline { white-space: pre-wrap; max-height: 9em; overflow: auto; display: block; }
.records-table tbody.rec tr.sub td { background: #fafbfc; }
.records-table tbody.rec tr.main td { border-top: 2px solid #b9c2cd; }
.attach-tree ul { margin: 0.1rem 0 0.1rem 1.2rem; padding: 0; list-style: none; }
.attach-tree > ul { margin-left: 0; }
footer.gen { color: var(--muted); font-size: 12px; margin-top: 2rem; }
`;

export interface PageShellOptions {
  // ブラウザタブ表示用タイトル（内部で escape する）。
  title: string;
  // パンくず等のヘッダー内 HTML（構築済み・escape 済みを渡す）。
  topbar: string;
  // ページ内目次 HTML（省略可。構築済みを渡す）。
  toc?: string;
  // 本文 HTML(構築済み)。
  body: string;
  // 追加のインライン JS（静的文字列のみ。動的値を含めないこと）。
  scripts?: string[];
}

export function pageShell({ title, topbar, toc, body, scripts = [] }: PageShellOptions): string {
  const aside = toc ? `<aside class="toc">${toc}</aside>` : "";
  const scriptTags = [FILTER_JS, ...scripts].map((js) => `<script>${js}</script>`).join("\n");
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<header class="topbar">${topbar}</header>
<div class="wrap">
${aside}
<main>
${body}
<footer class="gen">kint-origin html により data/ の取得内容から生成（再生成で上書きされます）</footer>
</main>
</div>
${scriptTags}
</body>
</html>
`;
}
