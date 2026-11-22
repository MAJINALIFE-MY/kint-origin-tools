import type { SpaceEntry } from "./discover.js";
import { appAdminLink, badge, definitionList, escapeHtml, errorMessageOf, hrefPath, htmlTable, jsonDetails, pageShell } from "./page.js";

export interface SpacePageData {
  entry: SpaceEntry;
  spaceJson?: unknown;
  settingsJson?: unknown;
  hasBodyHtml?: boolean;
  appsJson?: unknown;
  // このページから data 内スペースディレクトリへの相対パス（"/" 区切り・未エンコード）。
  dataHref: string;
  // kintone ドメイン（ホスト名。アプリ設定画面リンク用。未取得なら空）。
  domain: string;
}

type Dict = Record<string, any>;

function asDict(value: unknown): Dict {
  return value && typeof value === "object" ? (value as Dict) : {};
}

export function renderSpacePage(data: SpacePageData): string {
  const { entry } = data;
  const space = asDict(data.spaceJson);
  const title = entry.name || space.name || entry.dirName;

  const crumbs = [
    `<strong>kint-origin</strong>`,
    `<a href="${escapeHtml(hrefPath("..", "index.html"))}">ホーム</a>`,
    `<span class="crumb-sep">›</span><span>${escapeHtml(title)}</span>`,
    entry.deleted ? badge("削除済み", "deleted") : ""
  ]
    .filter(Boolean)
    .join(" ");

  const pairs: Array<[string, unknown]> = [
    ["スペース名", title],
    ["ID", entry.id],
    ["種類", entry.isGuest ? "ゲストスペース" : "スペース"]
  ];
  if (data.spaceJson !== undefined && !errorMessageOf(data.spaceJson)) {
    pairs.push(["公開設定", space.isPrivate ? "非公開" : "公開"], ["本文", space.body || "-"]);
  }

  const infoSection = [
    `<section class="card"><div class="card-head"><h2>基本情報</h2>${
      data.spaceJson === undefined ? badge("space.json 未取得") : ""
    }${entry.deleted ? badge("削除済み", "deleted") : ""}</div>`,
    definitionList(pairs),
    data.hasBodyHtml
      ? `<p class="json-link"><a href="${escapeHtml(hrefPath(data.dataHref, "body.html"))}">body.html を開く</a></p>`
      : "",
    data.settingsJson !== undefined ? jsonDetails("settings.json", data.settingsJson, hrefPath(data.dataHref, "settings.json")) : "",
    data.spaceJson !== undefined ? jsonDetails("space.json", data.spaceJson, hrefPath(data.dataHref, "space.json")) : "",
    `</section>`
  ].join("");

  // 配下アプリ: ディレクトリ走査結果（entry.apps）を正とし、apps.json は名前の補完に使う。
  const namesFromAppsJson = new Map<string, string>();
  if (Array.isArray(data.appsJson)) {
    for (const app of data.appsJson as Dict[]) {
      if (app?.appId) namesFromAppsJson.set(String(app.appId), String(app.name || ""));
    }
  }
  const appRows = entry.apps
    .map((app) => {
      const name = app.name || namesFromAppsJson.get(app.appId) || `app-${app.appId}`;
      return [
        `<a href="${escapeHtml(hrefPath("..", "apps", `app-${app.appId}.html`))}">${escapeHtml(name)}</a>${
          app.deleted ? "" : appAdminLink(data.domain, app.appId, app.guestSpaceId)
        }`,
        escapeHtml(app.appId),
        escapeHtml(app.code || ""),
        app.hasRecordsCsv ? badge("レコード取得済み", "ok") : `<span class="muted">-</span>`
      ];
    });
  const appsSection = [
    `<section class="card"><div class="card-head"><h2>アプリ（${entry.apps.length}）</h2></div>`,
    appRows.length
      ? `<div class="tbl-scroll">${htmlTable(["アプリ名", "ID", "コード", "レコード"], appRows, { className: "tbl-plain" })}</div>`
      : `<p class="muted">このスペース配下に取得済みアプリはありません。</p>`,
    data.appsJson !== undefined ? jsonDetails("apps.json", data.appsJson, hrefPath(data.dataHref, "apps.json")) : "",
    `</section>`
  ].join("");

  return pageShell({
    title: `${title} - kint-origin`,
    topbar: crumbs,
    body: [`<h1>${escapeHtml(title)} <span class="muted">${escapeHtml(entry.dirName)}</span></h1>`, infoSection, appsSection].join("\n")
  });
}
