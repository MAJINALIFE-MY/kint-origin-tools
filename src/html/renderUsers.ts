import { escapeHtml, hrefPath, htmlTable, jsonDetails, pageShell } from "./page.js";

// cybozu.com 共通管理（ユーザー・組織・グループ）のページ。
// 取得物には個人情報が含まれるため、このページも取り扱いに注意（生成物はローカル閲覧用）。
export interface UsersPageData {
  users?: unknown;
  groups?: unknown;
  organizations?: unknown;
  // data/cybozu-common/csv/ に実在する CSV ファイル名。
  csvFiles: string[];
  // このページ(users.html)から data/cybozu-common への相対パス。
  dataHref: string;
}

type Dict = Record<string, any>;

export function renderUsersPage(data: UsersPageData): string {
  const crumbs = [
    `<strong>kint-origin</strong>`,
    `<a href="index.html">ホーム</a>`,
    `<span class="crumb-sep">›</span><span>ユーザー・組織・グループ</span>`
  ].join(" ");

  const sections: string[] = [];

  const users = Array.isArray(data.users) ? (data.users as Dict[]) : [];
  const userRows = users.map((user) => [
    `<code>${escapeHtml(user?.code ?? "")}</code>`,
    escapeHtml(user?.name ?? ""),
    escapeHtml(user?.email ?? ""),
    `<span class="center">${user?.valid === false ? "停止中" : "有効"}</span>`
  ]);
  sections.push(
    [
      `<section class="card"><div class="card-head"><h2 id="users">ユーザー（${users.length}）</h2></div>`,
      `<p class="muted">氏名・メールアドレス等の個人情報を含みます。共有時は注意してください。</p>`,
      userRows.length
        ? `<input class="filter-input" type="search" placeholder="ユーザーを検索…" data-filter-target="users-table"><div class="tbl-scroll">${htmlTable(
            ["ログイン名", "表示名", "メールアドレス", "状態"],
            userRows,
            { id: "users-table", className: "tbl-plain" }
          )}</div>`
        : `<p class="muted">users.json が未取得です（<code>kint-origin pull users</code> で取得）。</p>`,
      data.users !== undefined ? jsonDetails("users/users.json", data.users, hrefPath(data.dataHref, "users", "users.json")) : "",
      `</section>`
    ].join("")
  );

  const organizations = Array.isArray(data.organizations) ? (data.organizations as Dict[]) : [];
  const orgRows = organizations.map((org) => [
    `<code>${escapeHtml(org?.code ?? "")}</code>`,
    escapeHtml(org?.name ?? ""),
    escapeHtml(org?.parentCode ?? "")
  ]);
  sections.push(
    [
      `<section class="card"><div class="card-head"><h2 id="organizations">組織（${organizations.length}）</h2></div>`,
      orgRows.length
        ? `<div class="tbl-scroll">${htmlTable(["コード", "名前", "親組織"], orgRows, { className: "tbl-plain" })}</div>`
        : `<p class="muted">organizations.json が未取得か、組織がありません。</p>`,
      data.organizations !== undefined
        ? jsonDetails("organizations/organizations.json", data.organizations, hrefPath(data.dataHref, "organizations", "organizations.json"))
        : "",
      `</section>`
    ].join("")
  );

  const groups = Array.isArray(data.groups) ? (data.groups as Dict[]) : [];
  const groupRows = groups.map((group) => [`<code>${escapeHtml(group?.code ?? "")}</code>`, escapeHtml(group?.name ?? "")]);
  sections.push(
    [
      `<section class="card"><div class="card-head"><h2 id="groups">グループ（${groups.length}）</h2></div>`,
      groupRows.length
        ? `<div class="tbl-scroll">${htmlTable(["コード", "名前"], groupRows, { className: "tbl-plain" })}</div>`
        : `<p class="muted">groups.json が未取得か、グループがありません。</p>`,
      data.groups !== undefined ? jsonDetails("groups/groups.json", data.groups, hrefPath(data.dataHref, "groups", "groups.json")) : "",
      `</section>`
    ].join("")
  );

  if (data.csvFiles.length) {
    const items = data.csvFiles
      .map((file) => `<li><a href="${escapeHtml(hrefPath(data.dataHref, "csv", file))}">${escapeHtml(file)}</a></li>`)
      .join("");
    sections.push(
      `<section class="card"><div class="card-head"><h2 id="csv">CSV エクスポート</h2></div><ul>${items}</ul></section>`
    );
  }

  return pageShell({
    title: "ユーザー・組織・グループ - kint-origin",
    topbar: crumbs,
    body: [`<h1>ユーザー・組織・グループ</h1>`, ...sections].join("\n")
  });
}
