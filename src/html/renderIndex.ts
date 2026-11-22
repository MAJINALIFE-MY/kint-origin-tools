import type { SiteModel } from "./discover.js";
import { appAdminLink, badge, escapeHtml, hrefPath, htmlTable, pageShell } from "./page.js";

// ダッシュボード（html/index.html）。data/ 未取得でも案内ページとして成立させる。
export function renderIndexPage(site: SiteModel): string {
  const topbar = [`<strong>kint-origin</strong>`, `<span>${escapeHtml(site.domain || "kintone データ一覧")}</span>`].join(" ");

  const sections: string[] = [];

  if (site.apps.length === 0 && site.spaces.length === 0 && !site.hasUsers) {
    sections.push(
      [
        `<section class="card"><div class="card-head"><h2>データ未取得</h2></div>`,
        `<p>data/ に取得済みデータがありません。まず <code>kint-origin pull kintone</code> を実行し、その後 <code>kint-origin html</code> を再実行してください。</p>`,
        `</section>`
      ].join("")
    );
  }

  if (site.apps.length > 0) {
    const sorted = [...site.apps].sort((a, b) => {
      const byName = (a.name || `app-${a.appId}`).localeCompare(b.name || `app-${b.appId}`, "ja");
      if (byName !== 0) return byName;
      return a.appId.localeCompare(b.appId, "en", { numeric: true });
    });
    const spaceNameById = new Map<string, string>();
    for (const space of site.spaces) {
      spaceNameById.set(`${space.isGuest ? "g" : "s"}${space.id}`, space.name || space.dirName);
    }
    const rows = sorted.map((app) => {
      const belonging = app.guestSpaceId
        ? `<a href="${escapeHtml(hrefPath("spaces", `guestspace-${app.guestSpaceId}.html`))}">${escapeHtml(
            spaceNameById.get(`g${app.guestSpaceId}`) || `ゲストスペース ${app.guestSpaceId}`
          )}</a>`
        : app.spaceId
          ? `<a href="${escapeHtml(hrefPath("spaces", `space-${app.spaceId}.html`))}">${escapeHtml(
              spaceNameById.get(`s${app.spaceId}`) || `スペース ${app.spaceId}`
            )}</a>`
          : `<span class="muted">ドメイン直下</span>`;
      return [
        `<a href="${escapeHtml(hrefPath("apps", `app-${app.appId}.html`))}">${escapeHtml(app.name || `app-${app.appId}`)}</a>${
          app.deleted ? ` ${badge("削除済み", "deleted")}` : appAdminLink(site.domain, app.appId, app.guestSpaceId)
        }`,
        escapeHtml(app.appId),
        escapeHtml(app.code || ""),
        belonging,
        escapeHtml(app.modifiedAt || ""),
        app.hasRecordsCsv ? badge("取得済み", "ok") : `<span class="muted">-</span>`
      ];
    });
    sections.push(
      [
        `<section class="card"><div class="card-head"><h2>アプリ（${site.apps.length}）</h2></div>`,
        `<input class="filter-input" type="search" placeholder="アプリを検索…" data-filter-target="apps-table">`,
        `<div class="tbl-scroll">${htmlTable(["アプリ名", "ID", "コード", "所属", "最終更新", "レコード"], rows, { id: "apps-table" })}</div>`,
        `</section>`
      ].join("")
    );
  }

  if (site.spaces.length > 0) {
    const rows = site.spaces.map((space) => [
      `<a href="${escapeHtml(hrefPath("spaces", `${space.dirName}.html`))}">${escapeHtml(space.name || space.dirName)}</a>${
        space.deleted ? ` ${badge("削除済み", "deleted")}` : ""
      }`,
      escapeHtml(space.id),
      escapeHtml(space.isGuest ? "ゲストスペース" : "スペース"),
      escapeHtml(String(space.apps.length))
    ]);
    sections.push(
      [
        `<section class="card"><div class="card-head"><h2>スペース（${site.spaces.length}）</h2></div>`,
        `<div class="tbl-scroll">${htmlTable(["スペース名", "ID", "種類", "取得済みアプリ数"], rows, { className: "tbl-plain" })}</div>`,
        `</section>`
      ].join("")
    );
  }

  sections.push(
    [
      `<section class="card"><div class="card-head"><h2>ユーザー・組織・グループ</h2></div>`,
      site.hasUsers
        ? `<p><a href="users.html">ユーザー・組織・グループを見る</a></p>`
        : `<p class="muted">未取得です（<code>kint-origin pull users</code> で取得後、<code>kint-origin html</code> を再実行）。</p>`,
      `</section>`
    ].join("")
  );

  if (site.warnings.length > 0) {
    const items = site.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
    sections.push(
      `<section class="card"><div class="card-head"><h2>警告</h2>${badge("要確認", "error")}</div><ul>${items}</ul></section>`
    );
  }

  return pageShell({
    title: `${site.domain || "kintone データ一覧"} - kint-origin`,
    topbar,
    body: [`<h1>${escapeHtml(site.domain || "kintone データ一覧")}</h1>`, ...sections].join("\n")
  });
}
