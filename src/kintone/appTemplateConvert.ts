// kintone のアプリテンプレート zip（`01/template.json`）が、このツールで「空のアプリ」として扱える形かを検査する。
// ネットワークもファイルも使わない純関数（smoke で直接検証する）。
//
// 扱えるのは、kintone の「空のアプリ」（blankapp.zip）と同じ形・同じ既定の設定のテンプレートだけ:
//   カスタムフィールドなし・レイアウトが空・一覧が組み込みの「（すべて）」だけ・プロセス管理／プラグイン／JS・CSS／ルックアップ／関連レコード一覧が空・
//   一般設定（テーマ・アイコン・小数の桁など）が既定。
// 範囲内のテンプレートが表すのは空のアプリそのものなので、ドラフトの中身は空欄と同じになる（form/fields.json・form/layout.json・views/views.json は空）。
//   - 組み込みフィールド（レコード番号など）は、kintone がアプリの作成時に自動で作る。フィールドの追加 API では追加できない（公式）ので、書かない。
//     コードは API を実行したユーザーの表示言語で決まる（公式。実機の日本語のユーザーでは `レコード番号`）ので、ドラフトでは確定できない。
//   - 一覧「（すべて）」は、すべてのアプリに最初からある組み込みの一覧。API では同じ名前の一覧を作れない（実機: 名前の重複で拒否）ので、書かない。
//   - 通知の内部 ID と uuid は捨てる。アプリ名は --name で決まる。
// 黙って捨てないために、検査は「既知の項目が既定どおりか」だけでなく、「未知の項目がないか」「想定した形か」も見る。
// 範囲外の内容は「未対応の箇所」として全部返す（呼び出し側がドラフトを作らずに止める）。範囲を広げるときは、ここに検査と変換を足す。

type Json = Record<string, unknown>;

// 一般設定（apps[0].info）の既定。kintone の「空のアプリ」（blankapp.zip）の値。"" は「空（null・空文字）」を表す。
// name（アプリ名）は --name で決まるので比べない。jsFiles は別に検査する。
const DEFAULT_INFO: Readonly<Record<string, string>> = {
  automaticallyChooseTitleComponent: "true",
  code: "",
  decimalPrecision: "16",
  decimalScale: "4",
  description: "",
  enableBulkDeletion: "false",
  enableRecordReuse: "true",
  fiscalYearStartMonth: "4",
  iconKey: "APP39",
  iconType: "PRESET",
  jsScope: "ALL",
  roundingMode: "HALF_EVEN",
  theme: "PLAIN",
  titleComponentLocalId: "",
  useComment: "true",
  useHistory: "true",
  useInlineEditAndDelete: "true",
  useThumbnail: "true"
};

// テンプレートの組み込みフィールドの種別（RECORD_ID＝レコード番号、CREATED_AT＝作成日時、MODIFIED_AT＝更新日時）と、既定の「必須」。
const BUILTIN_FIELD_REQUIRED: Readonly<Record<string, string>> = {
  RECORD_ID: "true",
  CREATOR: "true",
  CREATED_AT: "true",
  MODIFIER: "true",
  MODIFIED_AT: "true",
  STATUS: "false",
  STATUS_ASSIGNEE: "false",
  CATEGORY: "false"
};

// 既定の通知（コメントが書かれたとき、作成者・更新者へ）の対象になる組み込みフィールドの種別。
const DEFAULT_NOTIFICATION_TARGET_TYPES: ReadonlySet<string> = new Set(["CREATOR", "MODIFIER"]);

// テンプレートの各階層で、このツールが知っている項目。これ以外があれば、未対応として報告する（黙って捨てない）。
const ROOT_KEYS = ["actions", "apps", "description", "iconKey", "iconMeta", "iconSrcAppId", "iconType", "imagesMeta", "lookups", "name", "references", "version"];
const APP_KEYS = ["acl", "app", "category", "form", "iconMeta", "info", "jsFiles", "notification", "plugins", "reports", "resource", "schema", "settingsNotesForm", "status", "uuid", "views"];
const INFO_KEYS = [...Object.keys(DEFAULT_INFO), "jsFiles", "name"];
const VIEW_KEYS = ["advancedMode", "builtinType", "device", "fields", "filter", "html", "keyFieldId", "name", "pager", "revision", "titleFieldId", "view", "viewType"];

export interface TemplateAnalysis {
  /** テンプレートに書かれたアプリ名（無ければ空） */
  appName: string;
  /** 扱えない内容（空なら、空のアプリとして扱える） */
  issues: string[];
}

function asObject(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// null・未定義・空文字・空配列・空オブジェクトは「空」。
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  const object = asObject(value);
  return object ? Object.keys(object).length === 0 : false;
}

// 真偽値は true と "true"（大文字小文字は問わない）を真とする。
function isTrue(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.toLowerCase() === "true");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// 既定値との比較。expected が "" のときは「空」であること。それ以外は、文字列にして大文字小文字を無視して一致すること。
function sameAs(actual: unknown, expected: string): boolean {
  if (expected === "") return isEmpty(actual);
  return actual !== null && actual !== undefined && String(actual).toLowerCase() === expected.toLowerCase();
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "なし";
  const json = JSON.stringify(value);
  return json.length > 40 ? `${json.slice(0, 40)}…` : json;
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

// 必須のオブジェクト。無い・オブジェクトでないときは issue を足し、空のオブジェクトを返す（後続の検査を続けるため）。
function objectAt(parent: Json, key: string, path: string, issues: string[]): Json {
  const value = parent[key];
  if (value === undefined) {
    issues.push(`想定した項目がありません: ${join(path, key)}`);
    return {};
  }
  const object = asObject(value);
  if (!object) {
    issues.push(`形式が想定と違います（オブジェクトではありません）: ${join(path, key)}`);
    return {};
  }
  return object;
}

// 必須の配列。
function arrayAt(parent: Json, key: string, path: string, issues: string[]): unknown[] {
  const value = parent[key];
  if (value === undefined) {
    issues.push(`想定した項目がありません: ${join(path, key)}`);
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push(`形式が想定と違います（配列ではありません）: ${join(path, key)}`);
    return [];
  }
  return value;
}

// 任意のオブジェクト（あれば、オブジェクトであること）。
function optionalObjectAt(parent: Json, key: string, path: string, issues: string[]): Json {
  if (parent[key] === undefined || parent[key] === null) return {};
  const object = asObject(parent[key]);
  if (!object) {
    issues.push(`形式が想定と違います（オブジェクトではありません）: ${join(path, key)}`);
    return {};
  }
  return object;
}

// 知らない項目を、未対応として報告する。
function onlyKeys(object: Json, allowed: readonly string[], path: string, issues: string[]): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) issues.push(`未対応の項目があります: ${join(path, key)}`);
  }
}

// テンプレートに書かれたアプリ名だけを取り出す（`app templates` の一覧用。扱えるかは見ない）。
export function templateAppName(template: unknown): string {
  const root = asObject(template);
  const app = asObject(asArray(root?.apps)[0]);
  return text(root?.name) || text(asObject(app?.info)?.name);
}

function parseLayout(value: unknown): { ok: true; layout: unknown[] } | { ok: false } {
  if (Array.isArray(value)) return { ok: true, layout: value };
  if (value === null || value === undefined) return { ok: true, layout: [] };
  if (typeof value !== "string") return { ok: false };
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? { ok: true, layout: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

// フィールド: 組み込みだけで、設定が既定のまま。戻り値は、フィールド id → 種別（通知・一覧の検査に使う）。
function checkFields(schema: Json, issues: string[]): Map<string, string> {
  const typeById = new Map<string, string>();
  onlyKeys(schema, ["groups", "revision", "subTable", "table"], "apps[0].schema", issues);
  const table = objectAt(schema, "table", "apps[0].schema", issues);
  onlyKeys(table, ["fieldList", "id", "label", "properties", "var"], "apps[0].schema.table", issues);
  const fieldList = objectAt(table, "fieldList", "apps[0].schema.table", issues);

  const customFields: string[] = [];
  const changedBuiltins: string[] = [];
  for (const [key, raw] of Object.entries(fieldList)) {
    const field = asObject(raw);
    if (!field) {
      issues.push(`形式が想定と違います（オブジェクトではありません）: apps[0].schema.table.fieldList.${key}`);
      continue;
    }
    const id = text(field.id) || key;
    const type = text(field.type);
    typeById.set(id, type);
    const name = text(field.var) || text(field.label) || key;
    if (!Object.hasOwn(BUILTIN_FIELD_REQUIRED, type)) {
      customFields.push(`${name}（${type || "種別不明"}）`);
      continue;
    }
    onlyKeys(field, ["id", "label", "properties", "type", "var"], `apps[0].schema.table.fieldList.${key}`, issues);
    // 組み込みフィールドの設定が既定のまま（名称の変更・必須や表示の変更がない）こと。名称は表示言語で決まるので、コードとラベルが同じであることだけを見る。
    const properties = asObject(field.properties) ?? {};
    const unchanged =
      text(field.var) === text(field.label) &&
      Object.keys(properties).every((property) => property === "noLabel" || property === "required") &&
      sameAs(properties.noLabel, "false") &&
      sameAs(properties.required, BUILTIN_FIELD_REQUIRED[type]);
    if (!unchanged) changedBuiltins.push(`${name}（${type}）`);
  }
  if (customFields.length > 0) issues.push(`カスタムフィールドがあります: ${customFields.join(", ")}`);
  if (changedBuiltins.length > 0) issues.push(`組み込みフィールドの設定が既定と違います（名称・必須・ラベルの表示など）: ${changedBuiltins.join(", ")}`);
  if (!isEmpty(schema.subTable)) issues.push("テーブルがあります");
  if (!isEmpty(schema.groups)) issues.push(`グループがあります（${asArray(schema.groups).length} 件）`);
  return typeById;
}

// 一覧: 組み込みの「（すべて）」の 1 つだけ。表示項目が既定（レコード番号だけ）、絞り込み・並び替えなし。書き出さない。
function checkViews(views: unknown[], typeById: Map<string, string>, issues: string[]): void {
  if (views.length !== 1) issues.push(`一覧が組み込みの「（すべて）」の 1 つだけではありません（${views.length} 件）`);
  views.forEach((raw, position) => {
    const view = asObject(raw);
    const name = text(view?.name) || `（${position + 1} 番目の一覧）`;
    if (!view) {
      issues.push(`形式が想定と違います（オブジェクトではありません）: apps[0].views[${position}]`);
      return;
    }
    onlyKeys(view, VIEW_KEYS, `apps[0].views[${position}]`, issues);
    if (view.builtinType !== "ALL" || view.viewType !== "LIST") {
      issues.push(`一覧「${name}」は組み込みの一覧（すべて）ではありません`);
      return;
    }
    const filter = optionalObjectAt(view, "filter", `apps[0].views[${position}]`, issues);
    onlyKeys(filter, ["category", "offset", "order", "q", "size", "sort"], `apps[0].views[${position}].filter`, issues);
    const configured = [
      ...["category", "offset", "order", "q", "size", "sort"].filter((key) => !isEmpty(filter[key])).map((key) => `filter.${key}`),
      ...["advancedMode", "device", "html", "keyFieldId", "pager", "titleFieldId"].filter((key) => !isEmpty(view[key]))
    ];
    if (configured.length > 0) issues.push(`組み込みの一覧「${name}」に設定があります: ${configured.join(", ")}`);
    const shown = asArray(view.fields).flatMap((row) => asArray(asObject(row)?.row).map((cell) => typeById.get(text(asObject(cell)?.id)) ?? ""));
    if (shown.length !== 1 || shown[0] !== "RECORD_ID") {
      issues.push(`組み込みの一覧「${name}」の表示項目が、既定（レコード番号だけ）と違います`);
    }
  });
}

// 通知: 既定（コメントが書かれたとき、作成者・更新者へ）だけ。内部 ID は捨てる。
function checkNotification(notification: Json, typeById: Map<string, string>, issues: string[]): void {
  onlyKeys(notification, ["appNotifications", "recordNotifications", "reminderTimezone", "reminders", "useComment", "useReminder"], "apps[0].notification", issues);
  const unusual = asArray(notification.appNotifications).filter((raw) => {
    const item = asObject(raw);
    const target = asObject(item?.target);
    const events = asArray(item?.events);
    const targetType = typeById.get(text(target?.entityId));
    return !(
      events.length === 1 &&
      events[0] === "RECORD_COMMENT_ADDED" &&
      target?.entityType === "FIELD_ENTITY" &&
      targetType !== undefined &&
      DEFAULT_NOTIFICATION_TARGET_TYPES.has(targetType)
    );
  });
  if (
    unusual.length > 0 ||
    !isEmpty(notification.recordNotifications) ||
    !isEmpty(notification.reminders) ||
    !isEmpty(notification.reminderTimezone) ||
    isTrue(notification.useReminder)
  ) {
    issues.push("既定以外の通知（アプリの通知・条件付き通知・リマインダー）があります");
  }
  if (!sameAs(notification.useComment, "true")) issues.push("コメントの通知の設定が既定（有効）と違います");
}

// テンプレートを検査し、扱えないところを全部集める。
export function analyzeAppTemplate(template: unknown): TemplateAnalysis {
  const issues: string[] = [];
  const root = asObject(template);
  const appName = templateAppName(template);
  if (!root) return { appName, issues: ["テンプレートの内容（01/template.json）がオブジェクトではありません"] };

  onlyKeys(root, ROOT_KEYS, "", issues);
  if (!Array.isArray(root.apps)) return { appName, issues: ["形式が想定と違います（配列ではありません）: apps"] };
  if (root.apps.length !== 1) {
    return { appName, issues: [`アプリが 1 つのテンプレートだけ扱えます（このテンプレートは ${root.apps.length} 個）`] };
  }
  const app = asObject(root.apps[0]);
  if (!app) return { appName, issues: ["アプリの定義（apps[0]）がオブジェクトではありません"] };

  // テンプレート全体: アプリの外側の定義と、アイコン・説明・画像。
  if (!isEmpty(root.actions)) issues.push(`アプリアクションがあります（${asArray(root.actions).length} 件）`);
  if (!isEmpty(root.lookups)) issues.push(`ルックアップがあります（${asArray(root.lookups).length} 件）`);
  if (!isEmpty(root.references)) issues.push(`関連レコード一覧（参照）があります（${asArray(root.references).length} 件）`);
  if (!isEmpty(root.imagesMeta) || !isEmpty(root.iconMeta)) issues.push("画像（アプリのアイコン画像など）があります");
  if (!isEmpty(root.description)) issues.push("アプリの説明があります");
  if (!sameAs(root.iconKey, DEFAULT_INFO.iconKey) || !sameAs(root.iconType, DEFAULT_INFO.iconType)) issues.push("アイコンが既定と違います");

  // アプリ: 知らない項目と、空であるべき定義。
  onlyKeys(app, APP_KEYS, "apps[0]", issues);
  if (!isEmpty(app.app)) issues.push("アプリの参照（apps[0].app）があります");
  if (!isEmpty(app.iconMeta)) issues.push("画像（アプリのアイコン画像など）があります");
  if (!isEmpty(app.plugins)) issues.push(`プラグインがあります（${asArray(app.plugins).length} 件）`);
  if (!isEmpty(app.reports)) issues.push(`グラフがあります（${asArray(app.reports).length} 件）`);

  // 一般設定（テーマ・アイコン・小数の桁・履歴・コメントなど）は既定のまま。
  const info = objectAt(app, "info", "apps[0]", issues);
  onlyKeys(info, INFO_KEYS, "apps[0].info", issues);
  if (!isEmpty(app.jsFiles) || !isEmpty(info.jsFiles)) issues.push("JavaScript / CSS のカスタマイズがあります");
  for (const [key, expected] of Object.entries(DEFAULT_INFO)) {
    if (!sameAs(info[key], expected)) issues.push(`一般設定「${key}」が既定（${expected || "なし"}）と違います（現在: ${show(info[key])}）`);
  }

  const status = objectAt(app, "status", "apps[0]", issues);
  onlyKeys(status, ["actions", "filters", "initialStateId", "states", "useStatus"], "apps[0].status", issues);
  if (isTrue(status.useStatus) || !isEmpty(status.states) || !isEmpty(status.actions) || !isEmpty(status.filters) || !isEmpty(status.initialStateId)) {
    issues.push("プロセス管理があります");
  }

  const acl = optionalObjectAt(app, "acl", "apps[0]", issues);
  onlyKeys(acl, ["app", "field", "record"], "apps[0].acl", issues);
  if (!isEmpty(acl.app) || !isEmpty(acl.field) || !isEmpty(acl.record)) issues.push("アクセス権の設定があります");

  const category = optionalObjectAt(app, "category", "apps[0]", issues);
  onlyKeys(category, ["categories", "useCategory"], "apps[0].category", issues);
  if (isTrue(category.useCategory) || !isEmpty(category.categories)) issues.push("カテゴリーがあります");

  const notes = optionalObjectAt(app, "settingsNotesForm", "apps[0]", issues);
  onlyKeys(notes, ["content", "willBeInherited"], "apps[0].settingsNotesForm", issues);
  if (!isEmpty(notes.content) || !isEmpty(notes.willBeInherited)) issues.push("設定のメモ（settingsNotesForm）があります");

  // フィールド・レイアウト・通知・一覧。
  const typeById = checkFields(objectAt(app, "schema", "apps[0]", issues), issues);
  const form = objectAt(app, "form", "apps[0]", issues);
  onlyKeys(form, ["layout", "revision"], "apps[0].form", issues);
  const layout = parseLayout(form.layout);
  if (!layout.ok) issues.push("フォームのレイアウトを読み取れません");
  else if (layout.layout.length > 0) issues.push("フォームのレイアウトが空ではありません");
  checkNotification(objectAt(app, "notification", "apps[0]", issues), typeById, issues);

  // 多言語名（リソース）が入っていない。
  const resource = optionalObjectAt(app, "resource", "apps[0]", issues);
  onlyKeys(resource, ["tables"], "apps[0].resource", issues);
  const hasLocalizedNames = asArray(resource.tables).some((table) =>
    asArray(asObject(table)?.rows).some((row) => !isEmpty(asObject(row)?.fields))
  );
  if (hasLocalizedNames) issues.push("多言語の名前の設定があります");

  checkViews(arrayAt(app, "views", "apps[0]", issues), typeById, issues);
  return { appName, issues };
}

// 扱えなかったときのエラーメッセージ（未対応の箇所を全部示す）。
export function templateIssuesMessage(templateName: string, issues: string[]): string {
  return [
    `テンプレート「${templateName}」には、このツールが扱えない内容があるため、ドラフトを作りませんでした:`,
    ...issues.map((issue) => `  - ${issue}`),
    "扱えるのは、kintone の「空のアプリ」と同じ形・同じ既定の設定のテンプレート（カスタムフィールド・レイアウト・グラフ・プロセス管理・プラグイン・JavaScript/CSS・ルックアップ・関連レコード一覧・アクセス権・アプリアクションが空で、一覧が組み込みの「（すべて）」だけ）です。",
    "空欄のアプリから始めるときは、--template を付けずに実行してください。"
  ].join("\n");
}
