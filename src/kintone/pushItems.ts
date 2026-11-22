// push（反映）の変換層。pull で保存した JSON（GET レスポンス形）を、
// 動作テスト環境（preview）への PUT/POST リクエストボディへ変換する純関数群。

import { canonicalJson, normalizeDynamicValues } from "../normalize.js";

export type PushMode = "update" | "create";

export interface PushBuildContext {
  appId: string;
  mode: PushMode;
}

export interface PushItem {
  key: string;
  endpoint: string; // preview 環境への PUT 先
  file: string; // EXPORT_ITEMS と同じファイル名（pull 出力と同一契約）
  folder: string;
  // GET 保存物 → PUT ボディ。null はスキップ（理由は skipReason で返す）。
  buildBody(payload: any, ctx: PushBuildContext): { body: Record<string, unknown> } | { skip: string };
}

// フォームに常在する組み込みフィールド。fields の追加/更新 API には送れない。
const BUILTIN_FIELD_TYPES = new Set([
  "RECORD_NUMBER",
  "CREATOR",
  "CREATED_TIME",
  "MODIFIER",
  "UPDATED_TIME",
  "STATUS",
  "STATUS_ASSIGNEE",
  "CATEGORY"
]);

// pull 時にリソース取得へ失敗した場合のスタブ（pull.ts が書き込む）。
export function isErrorStub(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && "_error" in (payload as Record<string, unknown>));
}

// 保存物の revision は normalizeDynamicValues で "-" に潰れているため、送信前に必ず除去する
// （kintone 側は revision 省略＝リビジョン検証なし）。
export function stripRevision<T extends Record<string, unknown>>(payload: T): T {
  const copy: Record<string, unknown> = { ...payload };
  delete copy.revision;
  return copy as T;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// destApp / relatedApp は GET で app と code の両方が返るが、更新系は片方のみ指定。
// プレースホルダ解決後の app を優先し、app が無ければ code を残す。
function normalizeAppRef(ref: any): any {
  if (!ref || typeof ref !== "object") return ref;
  const copy = { ...ref };
  if (copy.app) {
    delete copy.code;
  } else {
    delete copy.app;
  }
  return copy;
}

// lookup / referenceTable の参照先アプリ指定を送信可能な形へ整える。
function normalizeFieldProperty(prop: any): any {
  const copy = { ...prop };
  if (copy.lookup?.relatedApp) {
    copy.lookup = { ...copy.lookup, relatedApp: normalizeAppRef(copy.lookup.relatedApp) };
  }
  if (copy.referenceTable?.relatedApp) {
    copy.referenceTable = { ...copy.referenceTable, relatedApp: normalizeAppRef(copy.referenceTable.relatedApp) };
  }
  return copy;
}

export interface SplitFieldsResult {
  add: Record<string, any>; // ローカルのみ → POST（フィールド追加）
  update: Record<string, any>; // 両方に存在 → PUT（フィールド更新）
  missingOnLocal: string[]; // リモートのみ（組み込み除く）。削除はしない・警告表示のみ
}

// ローカル fields.json の properties と、preview 環境の現況 properties を比較して振り分ける。
export function splitFieldProperties(
  localProperties: Record<string, any> | undefined,
  remoteProperties: Record<string, any> | undefined
): SplitFieldsResult {
  const local = localProperties || {};
  const remote = remoteProperties || {};
  const add: Record<string, any> = {};
  const update: Record<string, any> = {};
  for (const [code, prop] of Object.entries(local)) {
    if (BUILTIN_FIELD_TYPES.has(String(prop?.type))) continue;
    const normalized = normalizeFieldProperty(clone(prop));
    if (code in remote) {
      update[code] = normalized;
    } else {
      add[code] = normalized;
    }
  }
  const missingOnLocal = Object.keys(remote).filter(
    (code) => !(code in local) && !BUILTIN_FIELD_TYPES.has(String(remote[code]?.type))
  );
  return { add, update, missingOnLocal };
}

export interface FieldsDiff {
  added: string[]; // ローカルのみ（環境に無い）
  changed: string[]; // 両方にあり、内容が異なる
  missingOnLocal: string[]; // 環境のみ（組み込み除く）。削除はしない・警告表示のみ
}

export function diffFieldProperties(
  localProperties: Record<string, any> | undefined,
  remoteProperties: Record<string, any> | undefined
): FieldsDiff {
  const local = localProperties || {};
  const remote = remoteProperties || {};
  const fingerprint = (prop: unknown): string => canonicalJson(normalizeDynamicValues(prop));
  const sorted = (codes: string[]): string[] => codes.sort((a, b) => a.localeCompare(b, "en"));
  const added: string[] = [];
  const changed: string[] = [];
  for (const [code, prop] of Object.entries(local)) {
    if (BUILTIN_FIELD_TYPES.has(String(prop?.type))) continue;
    if (!(code in remote)) added.push(code);
    else if (fingerprint(prop) !== fingerprint(remote[code])) changed.push(code);
  }
  const missingOnLocal = Object.keys(remote).filter(
    (code) => !(code in local) && !BUILTIN_FIELD_TYPES.has(String(remote[code]?.type))
  );
  return { added: sorted(added), changed: sorted(changed), missingOnLocal: sorted(missingOnLocal) };
}

// views / reports / actions の id は既存要素との対応付けに使われる。
// 新規アプリ（create）では存在しない id を送るとエラーになるため除去する。
function stripIdsForCreate(entries: Record<string, any>, mode: PushMode): Record<string, any> {
  if (mode !== "create") return entries;
  const result: Record<string, any> = {};
  for (const [name, entry] of Object.entries(entries)) {
    const copy = { ...entry };
    delete copy.id;
    result[name] = copy;
  }
  return result;
}

// fields は add/update の振り分けが必要なため PUSH_ITEMS には含めず、push.ts が個別に扱う。
export const PUSH_ITEMS: PushItem[] = [
  {
    key: "layout",
    endpoint: "/app/form/layout.json",
    file: "layout.json",
    folder: "form",
    buildBody(payload, ctx) {
      const p = stripRevision(clone(payload));
      if (!Array.isArray(p.layout)) return { skip: "layout がありません" };
      return { body: { app: ctx.appId, layout: p.layout } };
    }
  },
  {
    key: "views",
    endpoint: "/app/views.json",
    file: "views.json",
    folder: "views",
    buildBody(payload, ctx) {
      const p = stripRevision(clone(payload));
      const views = p.views && typeof p.views === "object" ? (p.views as Record<string, any>) : {};
      if (Object.keys(views).length === 0) return { skip: "一覧の定義が空です（誤って全一覧を消さないため送信しません）" };
      return { body: { app: ctx.appId, views: stripIdsForCreate(views, ctx.mode) } };
    }
  },
  {
    key: "reports",
    endpoint: "/app/reports.json",
    file: "reports.json",
    folder: "reports",
    buildBody(payload, ctx) {
      const p = stripRevision(clone(payload));
      const reports = p.reports && typeof p.reports === "object" ? (p.reports as Record<string, any>) : {};
      if (Object.keys(reports).length === 0) return { skip: "グラフの定義が空です" };
      return { body: { app: ctx.appId, reports: stripIdsForCreate(reports, ctx.mode) } };
    }
  },
  {
    key: "settings",
    endpoint: "/app/settings.json",
    file: "settings.json",
    folder: "app_settings",
    buildBody(payload, ctx) {
      const p: Record<string, any> = stripRevision(clone(payload));
      // アイコン画像（FILE）は fileKey が "-" に正規化されており再利用できないため送らない
      //（PRESET アイコンはそのまま反映できる）。
      if (p.icon && p.icon.type === "FILE") delete p.icon;
      return { body: { ...p, app: ctx.appId } };
    }
  },
  {
    key: "status",
    endpoint: "/app/status.json",
    file: "status.json",
    folder: "app_settings",
    buildBody(payload, ctx) {
      const p: Record<string, any> = stripRevision(clone(payload));
      if (!p.states) return { skip: "プロセス管理が未設定です" };
      return { body: { app: ctx.appId, enable: Boolean(p.enable), states: p.states, actions: p.actions ?? [] } };
    }
  },
  {
    key: "actions",
    endpoint: "/app/actions.json",
    file: "app_actions.json",
    folder: "app_settings",
    buildBody(payload, ctx) {
      const p = stripRevision(clone(payload));
      const actions = p.actions && typeof p.actions === "object" ? (p.actions as Record<string, any>) : {};
      if (Object.keys(actions).length === 0) return { skip: "アプリアクションの定義が空です" };
      const normalized: Record<string, any> = {};
      for (const [name, action] of Object.entries(stripIdsForCreate(actions, ctx.mode))) {
        const copy = { ...action };
        if (copy.destApp) copy.destApp = normalizeAppRef(copy.destApp);
        normalized[name] = copy;
      }
      return { body: { app: ctx.appId, actions: normalized } };
    }
  },
  {
    key: "notifications_general",
    endpoint: "/app/notifications/general.json",
    file: "notifications_general.json",
    folder: "notifications",
    buildBody(payload, ctx) {
      const p: Record<string, any> = stripRevision(clone(payload));
      return { body: { ...p, app: ctx.appId } };
    }
  },
  {
    key: "notifications_per_record",
    endpoint: "/app/notifications/perRecord.json",
    file: "notifications_perRecord.json",
    folder: "notifications",
    buildBody(payload, ctx) {
      const p: Record<string, any> = stripRevision(clone(payload));
      return { body: { ...p, app: ctx.appId } };
    }
  },
  {
    key: "notifications_reminder",
    endpoint: "/app/notifications/reminder.json",
    file: "notifications_reminder.json",
    folder: "notifications",
    buildBody(payload, ctx) {
      const p: Record<string, any> = stripRevision(clone(payload));
      return { body: { ...p, app: ctx.appId } };
    }
  },
  {
    key: "app_acl",
    endpoint: "/app/acl.json",
    file: "app_acl.json",
    folder: "acl",
    buildBody(payload, ctx) {
      const p = stripRevision(clone(payload));
      if (!Array.isArray(p.rights) || p.rights.length === 0) return { skip: "アクセス権の定義が空です" };
      return { body: { app: ctx.appId, rights: p.rights } };
    }
  },
  {
    key: "record_acl",
    endpoint: "/record/acl.json",
    file: "record_acl.json",
    folder: "acl",
    buildBody(payload, ctx) {
      const p = stripRevision(clone(payload));
      if (!Array.isArray(p.rights) || p.rights.length === 0) return { skip: "レコードのアクセス権の定義が空です" };
      return { body: { app: ctx.appId, rights: p.rights } };
    }
  },
  {
    key: "field_acl",
    endpoint: "/field/acl.json",
    file: "field_acl.json",
    folder: "acl",
    buildBody(payload, ctx) {
      const p = stripRevision(clone(payload));
      if (!Array.isArray(p.rights) || p.rights.length === 0) return { skip: "フィールドのアクセス権の定義が空です" };
      return { body: { app: ctx.appId, rights: p.rights } };
    }
  }
];

// --only の指定に使える有効キー（fields は特別扱いだが指定可能）。
export const PUSH_KEYS: string[] = ["fields", ...PUSH_ITEMS.map((item) => item.key)];

// data/.../app-<id>/ で push の対象になるファイル（pull 状態・diff・push・Claude の hook の正本）。
export const PUSHABLE_FILES: Array<{ key: string; folder: string; file: string }> = [
  { key: "fields", folder: "form", file: "fields.json" },
  ...PUSH_ITEMS.map(({ key, folder, file }) => ({ key, folder, file }))
];
