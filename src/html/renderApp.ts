import type { AppEntry } from "./discover.js";
import { appAdminLink, badge, definitionList, escapeHtml, errorMessageOf, hrefPath, htmlTable, jsonDetails, pageShell } from "./page.js";
import { fieldTypeLabel } from "./fieldTypes.js";
import { recordsSectionHtml, RECORDS_VIEWER_JS } from "./renderRecords.js";

// アプリ 1 件分のページ入力。fs 読み込みは generate.ts 側で済ませる（本モジュールは純関数）。
export interface AppPageData {
  entry: AppEntry;
  spaceName: string;
  files: {
    appJson?: unknown;
    settings?: unknown;
    fields?: unknown;
    layout?: unknown;
    views?: unknown;
    reports?: unknown;
    status?: unknown;
    appActions?: unknown;
    notificationsGeneral?: unknown;
    notificationsPerRecord?: unknown;
    notificationsReminder?: unknown;
    plugins?: unknown;
    customize?: unknown;
    appAcl?: unknown;
    recordAcl?: unknown;
    fieldAcl?: unknown;
  };
  pluginConfigs: Array<{ id: string; payload: unknown }>;
  // customize/ 配下に実在するファイル（"desktop/js/..." 等の相対パス）。
  customizeFiles: string[];
  records?: { recordsJsName: string; total: number };
  // records/attachments/ 配下の実在ファイル（"rid/field/file" 相対パス）。
  attachments: string[];
  // このページから data 内アプリディレクトリへの相対パス（"/" 区切り・未エンコード）。
  dataHref: string;
}

type Dict = Record<string, any>;

function asDict(value: unknown): Dict {
  return value && typeof value === "object" ? (value as Dict) : {};
}

// セクションの共通枠。未取得/取得エラーの扱いを一元化し、元 JSON の details とファイルリンクを付ける。
function section(
  id: string,
  title: string,
  payload: unknown,
  srcFile: string,
  dataHref: string,
  renderBody: () => string
): string {
  const head = (extra: string) => `<div class="card-head"><h2 id="${escapeHtml(id)}">${escapeHtml(title)}</h2>${extra}</div>`;
  if (payload === undefined) {
    return `<section class="card">${head(badge("未取得"))}<p class="muted">このデータはまだ取得されていません。</p></section>`;
  }
  const errorMessage = errorMessageOf(payload);
  if (errorMessage) {
    return `<section class="card">${head(badge("取得エラー", "error"))}<p class="muted">${escapeHtml(errorMessage)}</p></section>`;
  }
  return `<section class="card">${head("")}${renderBody()}${jsonDetails(srcFile, payload, hrefPath(dataHref, srcFile))}</section>`;
}

function entityText(entity: unknown): string {
  const e = asDict(entity);
  const labels: Record<string, string> = {
    USER: "ユーザー",
    GROUP: "グループ",
    ORGANIZATION: "組織",
    FIELD_ENTITY: "フィールド",
    CREATOR: "作成者"
  };
  const type = String(e.type || "");
  const code = String(e.code || "");
  return `${labels[type] || type}${code ? `: ${code}` : ""}`;
}

function yesNo(value: unknown): string {
  return value ? "○" : "−";
}

// layout.json の並び順にフィールドコードを平坦化する（フィールド表の表示順に使う）。
function layoutFieldOrder(layoutPayload: unknown): string[] {
  const order: string[] = [];
  const walkFields = (fields: any[]) => {
    for (const field of fields || []) {
      if (field?.code) order.push(String(field.code));
    }
  };
  const walk = (nodes: any[]) => {
    for (const node of nodes || []) {
      if (!node || typeof node !== "object") continue;
      if (node.type === "ROW") walkFields(node.fields);
      else if (node.type === "GROUP") {
        if (node.code) order.push(String(node.code));
        walk(node.layout);
      } else if (node.type === "SUBTABLE") {
        if (node.code) order.push(String(node.code));
        walkFields(node.fields);
      }
    }
  };
  walk(asDict(layoutPayload).layout);
  return order;
}

function optionsText(options: unknown): string {
  const dict = asDict(options);
  return Object.values(dict)
    .filter((option: any) => option && typeof option === "object")
    .sort((a: any, b: any) => Number(a.index ?? 0) - Number(b.index ?? 0))
    .map((option: any) => String(option.label ?? ""))
    .join("、");
}

function fieldNotes(prop: Dict): string {
  const notes: string[] = [];
  if (prop.options) notes.push(`選択肢: ${optionsText(prop.options)}`);
  if (prop.expression) notes.push(`計算式: ${prop.expression}`);
  if (prop.defaultValue !== undefined && prop.defaultValue !== "" && !Array.isArray(prop.defaultValue)) {
    notes.push(`初期値: ${prop.defaultValue}`);
  }
  if (Array.isArray(prop.defaultValue) && prop.defaultValue.length) {
    notes.push(`初期値: ${prop.defaultValue.map((v: any) => (typeof v === "object" ? v?.code : v)).join("、")}`);
  }
  if (prop.lookup) {
    const related = asDict(asDict(prop.lookup).relatedApp);
    notes.push(`ルックアップ: アプリ ${related.app ?? ""} の ${asDict(prop.lookup).relatedKeyField ?? ""}`);
  }
  if (prop.referenceTable) {
    const related = asDict(asDict(prop.referenceTable).relatedApp);
    notes.push(`関連レコード: アプリ ${related.app ?? ""}`);
  }
  if (prop.enabled === false) notes.push("無効（使用しない設定）");
  if (prop.maxLength) notes.push(`最大文字数: ${prop.maxLength}`);
  return notes.join(" / ");
}

function renderFieldsBody(fieldsPayload: unknown, layoutPayload: unknown): string {
  const properties = asDict(asDict(fieldsPayload).properties);
  const orderHint = layoutFieldOrder(layoutPayload);
  const codes = Object.keys(properties);
  codes.sort((a, b) => {
    const ia = orderHint.indexOf(a);
    const ib = orderHint.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b, "ja");
  });

  const rows: string[][] = [];
  for (const code of codes) {
    const prop = asDict(properties[code]);
    rows.push([
      `<code>${escapeHtml(code)}</code>`,
      escapeHtml(prop.label ?? ""),
      escapeHtml(fieldTypeLabel(prop.type)),
      `<span class="center">${yesNo(prop.required)}</span>`,
      `<span class="center">${yesNo(prop.unique)}</span>`,
      escapeHtml(fieldNotes(prop))
    ]);
    if (prop.type === "SUBTABLE" && prop.fields) {
      for (const [subCode, subProp] of Object.entries(asDict(prop.fields))) {
        const sub = asDict(subProp);
        rows.push([
          `<code>└ ${escapeHtml(subCode)}</code>`,
          escapeHtml(sub.label ?? ""),
          escapeHtml(fieldTypeLabel(sub.type)),
          `<span class="center">${yesNo(sub.required)}</span>`,
          `<span class="center">${yesNo(sub.unique)}</span>`,
          escapeHtml(fieldNotes(sub))
        ]);
      }
    }
  }
  if (rows.length === 0) return `<p class="muted">フィールドがありません。</p>`;
  return `<div class="tbl-scroll">${htmlTable(["コード", "ラベル", "型", "必須", "重複禁止", "補足"], rows)}</div>`;
}

function renderLayoutBody(layoutPayload: unknown, fieldsPayload: unknown): string {
  const properties = asDict(asDict(fieldsPayload).properties);
  const labelOf = (code: string) => String(asDict(properties[code]).label || code);

  const renderField = (field: Dict): string => {
    const width = asDict(field.size).width ? `width: ${escapeHtml(asDict(field.size).width)}px;` : "";
    if (field.type === "SPACER") return `<div class="layout-field muted" style="${width}">（スペース）</div>`;
    if (field.type === "HR") return `<div class="layout-field muted" style="flex:1 1 100%;">──── 罫線 ────</div>`;
    if (field.type === "LABEL") {
      return `<div class="layout-field" style="${width}"><span class="lf-label muted">ラベル</span>${escapeHtml(field.label ?? "")}</div>`;
    }
    const code = String(field.code || "");
    return [
      `<div class="layout-field" style="${width}">`,
      `<span class="lf-label">${escapeHtml(labelOf(code))}</span>`,
      `<span class="lf-meta">${escapeHtml(code)} / ${escapeHtml(fieldTypeLabel(field.type))}</span>`,
      `</div>`
    ].join("");
  };

  const renderNodes = (nodes: any[]): string => {
    const parts: string[] = [];
    for (const node of nodes || []) {
      if (!node || typeof node !== "object") continue;
      if (node.type === "ROW") {
        parts.push(`<div class="layout-row">${(node.fields || []).map((f: Dict) => renderField(f)).join("")}</div>`);
      } else if (node.type === "GROUP") {
        const title = labelOf(String(node.code || ""));
        parts.push(
          `<div class="layout-group"><div class="lg-title">${escapeHtml(title)}（グループ）</div>${renderNodes(node.layout)}</div>`
        );
      } else if (node.type === "SUBTABLE") {
        const title = labelOf(String(node.code || ""));
        parts.push(
          `<div class="layout-group"><div class="lg-title">${escapeHtml(title)}（テーブル）</div><div class="layout-row">${(node.fields || [])
            .map((f: Dict) => renderField(f))
            .join("")}</div></div>`
        );
      }
    }
    return parts.join("");
  };

  const body = renderNodes(asDict(layoutPayload).layout);
  return body || `<p class="muted">レイアウト情報がありません。</p>`;
}

function renderViewsBody(viewsPayload: unknown): string {
  const views = Object.values(asDict(asDict(viewsPayload).views)) as Dict[];
  if (views.length === 0) return `<p class="muted">一覧はありません。</p>`;
  const typeLabels: Record<string, string> = { LIST: "リスト", CALENDAR: "カレンダー", CUSTOM: "カスタマイズ" };
  views.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  const rows = views.map((view) => [
    escapeHtml(view.name ?? ""),
    escapeHtml(typeLabels[String(view.type)] || view.type || ""),
    escapeHtml(Array.isArray(view.fields) ? view.fields.join("、") : ""),
    escapeHtml(view.filterCond ?? ""),
    escapeHtml(view.sort ?? "")
  ]);
  return `<div class="tbl-scroll">${htmlTable(["名前", "種類", "表示フィールド", "絞り込み条件", "ソート"], rows)}</div>`;
}

function renderReportsBody(reportsPayload: unknown): string {
  const reports = Object.values(asDict(asDict(reportsPayload).reports)) as Dict[];
  if (reports.length === 0) return `<p class="muted">グラフはありません。</p>`;
  reports.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  const rows = reports.map((report) => [
    escapeHtml(report.name ?? ""),
    escapeHtml(report.chartType ?? ""),
    escapeHtml((report.groups || []).map((g: Dict) => g?.code).join("、")),
    escapeHtml((report.aggregations || []).map((a: Dict) => `${a?.type ?? ""}${a?.code ? `(${a.code})` : ""}`).join("、")),
    escapeHtml(report.filterCond ?? "")
  ]);
  return `<div class="tbl-scroll">${htmlTable(["名前", "グラフ種類", "グループ化", "集計", "絞り込み条件"], rows)}</div>`;
}

function renderStatusBody(statusPayload: unknown): string {
  const status = asDict(statusPayload);
  if (!status.enable) return `<p class="muted">プロセス管理は無効です。</p>`;
  const states = Object.values(asDict(status.states)) as Dict[];
  states.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  const stateRows = states.map((state) => {
    const assignee = asDict(state.assignee);
    const entities = (assignee.entities || []).map((e: Dict) => entityText(e?.entity)).join("、");
    return [escapeHtml(state.name ?? ""), escapeHtml(assignee.type ?? ""), escapeHtml(entities)];
  });
  const actions = (status.actions || []) as Dict[];
  const flow = actions
    .map(
      (action) =>
        `<p class="flow-line">${escapeHtml(action.from ?? "")}<span class="flow-arrow">→</span>[${escapeHtml(
          action.name ?? ""
        )}]<span class="flow-arrow">→</span>${escapeHtml(action.to ?? "")}${
          action.filterCond ? `<span class="muted">（条件: ${escapeHtml(action.filterCond)}）</span>` : ""
        }</p>`
    )
    .join("");
  return [
    `<h3>ステータス</h3>`,
    `<div class="tbl-scroll">${htmlTable(["ステータス名", "作業者の設定", "作業者"], stateRows, { className: "tbl-plain" })}</div>`,
    `<h3>アクション（ステータス遷移）</h3>`,
    flow || `<p class="muted">アクションはありません。</p>`
  ].join("");
}

function renderAppActionsBody(appActionsPayload: unknown): string {
  const actions = Object.entries(asDict(asDict(appActionsPayload).actions)) as Array<[string, Dict]>;
  if (actions.length === 0) return `<p class="muted">アプリアクションはありません。</p>`;
  const rows = actions
    .sort((a, b) => Number(a[1]?.index ?? 0) - Number(b[1]?.index ?? 0))
    .map(([name, action]) => {
      const dest = asDict(action.destApp);
      return [
        escapeHtml(name),
        escapeHtml(dest.app ? `アプリ ${dest.app}${dest.code ? `（${dest.code}）` : ""}` : ""),
        escapeHtml(String((action.mappings || []).length))
      ];
    });
  return `<div class="tbl-scroll">${htmlTable(["名前", "コピー先アプリ", "フィールド割当数"], rows, { className: "tbl-plain" })}</div>`;
}

function renderNotificationsBody(general: unknown, perRecord: unknown, reminder: unknown): string {
  const parts: string[] = [];

  const generalRows = (asDict(general).notifications || []).map((n: Dict) => [
    escapeHtml(entityText(n?.entity)),
    `<span class="center">${yesNo(n?.includeSubs)}</span>`,
    escapeHtml(
      [
        n?.recordAdded ? "レコード追加" : "",
        n?.recordEdited ? "レコード編集" : "",
        n?.commentAdded ? "コメント書き込み" : "",
        n?.statusChanged ? "ステータス変更" : "",
        n?.fileImported ? "ファイル読み込み" : ""
      ]
        .filter(Boolean)
        .join("、")
    )
  ]);
  parts.push(`<h3>アプリの条件通知</h3>`);
  parts.push(
    generalRows.length
      ? `<div class="tbl-scroll">${htmlTable(["通知先", "サブ組織含む", "通知タイミング"], generalRows, { className: "tbl-plain" })}</div>`
      : `<p class="muted">設定はありません。</p>`
  );

  const perRecordRows = (asDict(perRecord).notifications || []).map((n: Dict) => [
    escapeHtml(n?.filterCond ?? ""),
    escapeHtml(n?.title ?? ""),
    escapeHtml((n?.targets || []).map((t: Dict) => entityText(t?.entity)).join("、"))
  ]);
  parts.push(`<h3>レコードの条件通知</h3>`);
  parts.push(
    perRecordRows.length
      ? `<div class="tbl-scroll">${htmlTable(["条件", "通知内容", "通知先"], perRecordRows, { className: "tbl-plain" })}</div>`
      : `<p class="muted">設定はありません。</p>`
  );

  const reminderDict = asDict(reminder);
  const reminderRows = (reminderDict.notifications || []).map((n: Dict) => {
    const timing = asDict(n?.timing);
    const when = timing.code
      ? `${timing.code} から ${timing.daysLater ?? 0} 日後 ${timing.hoursLater ? `${timing.hoursLater} 時間後` : timing.time ?? ""}`
      : "";
    return [
      escapeHtml(when),
      escapeHtml(n?.filterCond ?? ""),
      escapeHtml(n?.title ?? ""),
      escapeHtml((n?.targets || []).map((t: Dict) => entityText(t?.entity)).join("、"))
    ];
  });
  parts.push(`<h3>リマインダー通知${reminderDict.timezone ? `（タイムゾーン: ${escapeHtml(reminderDict.timezone)}）` : ""}</h3>`);
  parts.push(
    reminderRows.length
      ? `<div class="tbl-scroll">${htmlTable(["タイミング", "条件", "通知内容", "通知先"], reminderRows, { className: "tbl-plain" })}</div>`
      : `<p class="muted">設定はありません。</p>`
  );

  return parts.join("");
}

function renderAppAclBody(appAclPayload: unknown): string {
  const rights = (asDict(appAclPayload).rights || []) as Dict[];
  if (rights.length === 0) return `<p class="muted">設定はありません。</p>`;
  const rows = rights.map((right) => [
    escapeHtml(entityText(right?.entity)),
    `<span class="center">${yesNo(right?.appEditable)}</span>`,
    `<span class="center">${yesNo(right?.recordViewable)}</span>`,
    `<span class="center">${yesNo(right?.recordAddable)}</span>`,
    `<span class="center">${yesNo(right?.recordEditable)}</span>`,
    `<span class="center">${yesNo(right?.recordDeletable)}</span>`,
    `<span class="center">${yesNo(right?.recordImportable)}</span>`,
    `<span class="center">${yesNo(right?.recordExportable)}</span>`
  ]);
  return `<div class="tbl-scroll">${htmlTable(
    ["対象", "アプリ管理", "レコード閲覧", "追加", "編集", "削除", "読み込み", "書き出し"],
    rows,
    { className: "tbl-plain" }
  )}</div>`;
}

function renderRecordAclBody(recordAclPayload: unknown): string {
  const rights = (asDict(recordAclPayload).rights || []) as Dict[];
  const rows: string[][] = [];
  for (const right of rights) {
    for (const entry of (right?.entities || []) as Dict[]) {
      rows.push([
        escapeHtml(right?.filterCond ?? ""),
        escapeHtml(entityText(entry?.entity)),
        `<span class="center">${yesNo(entry?.viewable)}</span>`,
        `<span class="center">${yesNo(entry?.editable)}</span>`,
        `<span class="center">${yesNo(entry?.deletable)}</span>`
      ]);
    }
  }
  if (rows.length === 0) return `<p class="muted">設定はありません。</p>`;
  return `<div class="tbl-scroll">${htmlTable(["条件", "対象", "閲覧", "編集", "削除"], rows, { className: "tbl-plain" })}</div>`;
}

function renderFieldAclBody(fieldAclPayload: unknown): string {
  const rights = (asDict(fieldAclPayload).rights || []) as Dict[];
  const accessibilityLabels: Record<string, string> = { READ: "閲覧のみ", WRITE: "編集可", NONE: "不可" };
  const rows: string[][] = [];
  for (const right of rights) {
    for (const entry of (right?.entities || []) as Dict[]) {
      rows.push([
        `<code>${escapeHtml(right?.code ?? "")}</code>`,
        escapeHtml(entityText(entry?.entity)),
        escapeHtml(accessibilityLabels[String(entry?.accessibility)] || entry?.accessibility || "")
      ]);
    }
  }
  if (rows.length === 0) return `<p class="muted">設定はありません。</p>`;
  return `<div class="tbl-scroll">${htmlTable(["フィールド", "対象", "権限"], rows, { className: "tbl-plain" })}</div>`;
}

function renderCustomizeBody(
  customizePayload: unknown,
  pluginsPayload: unknown,
  pluginConfigs: Array<{ id: string; payload: unknown }>,
  customizeFiles: string[],
  dataHref: string
): string {
  const parts: string[] = [];
  const customize = asDict(customizePayload);
  const existing = new Set(customizeFiles.map((file) => file.split("\\").join("/")));

  const scopeLabels: Record<string, string> = { ALL: "全ユーザー", ADMIN: "アプリ管理者のみ", NONE: "適用しない" };
  parts.push(`<p>適用範囲: ${escapeHtml(scopeLabels[String(customize.scope)] || customize.scope || "-")}</p>`);

  const renderAssets = (platform: "desktop" | "mobile", kind: "js" | "css"): string => {
    const items = (asDict(customize[platform])[kind] || []) as Dict[];
    if (items.length === 0) return `<li class="muted">${platform} ${kind.toUpperCase()}: なし</li>`;
    const links = items.map((item) => {
      if (item?.type === "URL") {
        // customize.json の URL は取得値のためスキームを検証（http/https のみリンク化）
        const url = String(item.url ?? "");
        if (/^https?:\/\//i.test(url)) return `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
        return escapeHtml(url);
      }
      const name = String(asDict(item?.file).name || "");
      const relPath = `${platform}/${kind}/${name}`;
      if (existing.has(relPath)) {
        return `<a href="${escapeHtml(hrefPath(dataHref, "customize", platform, kind, name))}">${escapeHtml(name)}</a>`;
      }
      return `${escapeHtml(name)} <span class="muted">（実体未取得）</span>`;
    });
    return `<li>${platform} ${kind.toUpperCase()}: ${links.join("、 ")}</li>`;
  };
  parts.push(`<ul>${renderAssets("desktop", "js")}${renderAssets("desktop", "css")}${renderAssets("mobile", "js")}${renderAssets("mobile", "css")}</ul>`);

  const plugins = (asDict(pluginsPayload).plugins || []) as Dict[];
  parts.push(`<h3>プラグイン</h3>`);
  if (plugins.length === 0) {
    parts.push(`<p class="muted">追加されているプラグインはありません。</p>`);
  } else {
    const rows = plugins.map((plugin) => [
      escapeHtml(plugin?.name ?? ""),
      `<code>${escapeHtml(plugin?.id ?? "")}</code>`,
      `<span class="center">${plugin?.enabled === false ? "無効" : "有効"}</span>`
    ]);
    parts.push(`<div class="tbl-scroll">${htmlTable(["名前", "プラグインID", "状態"], rows, { className: "tbl-plain" })}</div>`);
  }
  for (const config of pluginConfigs) {
    parts.push(jsonDetails(`plugin-configs/${config.id}.json`, config.payload, hrefPath(dataHref, "customize", "plugin-configs", `${config.id}.json`)));
  }
  return parts.join("");
}

function renderAttachmentsSection(attachments: string[], dataHref: string): string {
  if (attachments.length === 0) return "";
  // rid/field/file の相対パスを rid → field → files にまとめる。
  const tree = new Map<string, Map<string, string[]>>();
  for (const relPath of attachments) {
    const [rid, field, ...rest] = relPath.split("/");
    if (!rid || !field || rest.length === 0) continue;
    if (!tree.has(rid)) tree.set(rid, new Map());
    const fields = tree.get(rid)!;
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field)!.push(rest.join("/"));
  }
  const items = [...tree.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([rid, fields]) => {
      const fieldItems = [...fields.entries()]
        .map(([field, files]) => {
          const fileItems = files
            .map(
              (file) =>
                `<li><a href="${escapeHtml(hrefPath(dataHref, "records", "attachments", rid, field, file))}">${escapeHtml(file)}</a></li>`
            )
            .join("");
          return `<li>${escapeHtml(field)}<ul>${fileItems}</ul></li>`;
        })
        .join("");
      return `<li>レコード ${escapeHtml(rid)}<ul>${fieldItems}</ul></li>`;
    })
    .join("");
  return `<section class="card"><div class="card-head"><h2 id="attachments">添付ファイル</h2></div><div class="attach-tree"><ul>${items}</ul></div></section>`;
}

export function renderAppPage(data: AppPageData): string {
  const { entry, files, dataHref } = data;
  const appJson = asDict(files.appJson);
  const settings = asDict(files.settings);
  const title = entry.name || `app-${entry.appId}`;

  const spaceLabel = entry.guestSpaceId
    ? `ゲストスペース ${entry.guestSpaceId}`
    : entry.spaceId
      ? `スペース ${entry.spaceId}`
      : "";
  const spaceHref = entry.guestSpaceId
    ? hrefPath("..", "spaces", `guestspace-${entry.guestSpaceId}.html`)
    : entry.spaceId
      ? hrefPath("..", "spaces", `space-${entry.spaceId}.html`)
      : "";

  const crumbs = [
    `<strong>kint-origin</strong>`,
    `<a href="${escapeHtml(hrefPath("..", "index.html"))}">ホーム</a>`,
    spaceHref && !entry.deleted
      ? `<span class="crumb-sep">›</span><a href="${escapeHtml(spaceHref)}">${escapeHtml(data.spaceName || spaceLabel)}</a>`
      : "",
    `<span class="crumb-sep">›</span><span>${escapeHtml(title)}</span>`,
    entry.deleted ? badge("削除済み", "deleted") : ""
  ]
    .filter(Boolean)
    .join(" ");

  // 基本情報（app.json + settings.json の合成なので section() ヘルパは使わない）。
  const basicPairs: Array<[string, unknown]> = [
    ["アプリ名", entry.name],
    ["アプリID", entry.appId],
    ["コード", entry.code || "-"],
    ["所属", spaceLabel ? `${data.spaceName ? `${data.spaceName}（${spaceLabel}）` : spaceLabel}` : "ドメイン直下"],
    ["ドメイン", appJson.domain || "-"]
  ];
  if (files.settings !== undefined && !errorMessageOf(files.settings)) {
    basicPairs.push(
      ["説明", settings.description || "-"],
      ["テーマ", settings.theme || "-"],
      ["アイコン", asDict(settings.icon).key || asDict(settings.icon).type || "-"],
      ["レコードのタイトル", asDict(settings.titleField).code || "-"],
      ["コメント", settings.enableComments === undefined ? "-" : settings.enableComments ? "有効" : "無効"]
    );
  }
  const basicSection = [
    `<section class="card"><div class="card-head"><h2 id="basic">基本情報</h2>${entry.deleted ? badge("削除済み", "deleted") : ""}</div>`,
    definitionList(basicPairs),
    files.appJson !== undefined ? jsonDetails("app.json", files.appJson, hrefPath(dataHref, "app.json")) : "",
    files.settings !== undefined
      ? jsonDetails("app_settings/settings.json", files.settings, hrefPath(dataHref, "app_settings", "settings.json"))
      : "",
    `</section>`
  ].join("");

  const recordsSection = data.records
    ? [
        `<section class="card"><div class="card-head"><h2 id="records">レコード</h2></div>`,
        recordsSectionHtml({
          recordsJsName: data.records.recordsJsName,
          total: data.records.total,
          csvHref: hrefPath(dataHref, "records", "records.csv")
        }),
        `</section>`
      ].join("")
    : `<section class="card"><div class="card-head"><h2 id="records">レコード</h2>${badge("未取得")}</div><p class="muted">records.csv がありません（<code>kint-origin pull records --id ${escapeHtml(entry.appId)}</code> で取得）。</p></section>`;

  const sections = [
    basicSection,
    section("fields", "フォーム（フィールド）", files.fields, "form/fields.json", dataHref, () =>
      renderFieldsBody(files.fields, files.layout)
    ),
    section("layout", "フォーム（レイアウト）", files.layout, "form/layout.json", dataHref, () =>
      renderLayoutBody(files.layout, files.fields)
    ),
    section("views", "一覧", files.views, "views/views.json", dataHref, () => renderViewsBody(files.views)),
    section("reports", "グラフ", files.reports, "reports/reports.json", dataHref, () => renderReportsBody(files.reports)),
    section("status", "プロセス管理", files.status, "app_settings/status.json", dataHref, () => renderStatusBody(files.status)),
    section("app-actions", "アプリアクション", files.appActions, "app_settings/app_actions.json", dataHref, () =>
      renderAppActionsBody(files.appActions)
    ),
    section("notifications", "通知", files.notificationsGeneral, "notifications/notifications_general.json", dataHref, () =>
      renderNotificationsBody(files.notificationsGeneral, files.notificationsPerRecord, files.notificationsReminder)
    ),
    section("app-acl", "アプリのアクセス権", files.appAcl, "acl/app_acl.json", dataHref, () => renderAppAclBody(files.appAcl)),
    section("record-acl", "レコードのアクセス権", files.recordAcl, "acl/record_acl.json", dataHref, () =>
      renderRecordAclBody(files.recordAcl)
    ),
    section("field-acl", "フィールドのアクセス権", files.fieldAcl, "acl/field_acl.json", dataHref, () =>
      renderFieldAclBody(files.fieldAcl)
    ),
    section("customize", "カスタマイズ / プラグイン", files.customize, "customize/customize.json", dataHref, () =>
      renderCustomizeBody(files.customize, files.plugins, data.pluginConfigs, data.customizeFiles, dataHref)
    ),
    recordsSection,
    renderAttachmentsSection(data.attachments, dataHref)
  ].filter(Boolean);

  const tocItems: Array<[string, string]> = [
    ["basic", "基本情報"],
    ["fields", "フィールド"],
    ["layout", "レイアウト"],
    ["views", "一覧"],
    ["reports", "グラフ"],
    ["status", "プロセス管理"],
    ["app-actions", "アプリアクション"],
    ["notifications", "通知"],
    ["app-acl", "アプリのアクセス権"],
    ["record-acl", "レコードのアクセス権"],
    ["field-acl", "フィールドのアクセス権"],
    ["customize", "カスタマイズ"],
    ["records", "レコード"]
  ];
  if (data.attachments.length) tocItems.push(["attachments", "添付ファイル"]);
  const toc = `<ul>${tocItems.map(([id, label]) => `<li><a href="#${id}">${escapeHtml(label)}</a></li>`).join("")}</ul>`;

  return pageShell({
    title: `${title} - kint-origin`,
    topbar: crumbs,
    toc,
    body: [
      `<h1>${escapeHtml(title)}${
        entry.deleted ? "" : appAdminLink(String(appJson.domain || ""), entry.appId, entry.guestSpaceId)
      } <span class="muted">app-${escapeHtml(entry.appId)}</span></h1>`,
      ...sections
    ].join("\n"),
    scripts: data.records ? [RECORDS_VIEWER_JS] : []
  });
}
