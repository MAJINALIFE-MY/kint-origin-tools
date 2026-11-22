export interface ExportItem {
  key: string;
  endpoint: string;
  file: string;
  folder: string;
}

export const EXPORT_FOLDERS: string[] = [
  "app_settings",
  "form",
  "views",
  "reports",
  "notifications",
  "customize",
  "acl"
];

export const EXPORT_ITEMS: ExportItem[] = [
  { key: "layout", endpoint: "/app/form/layout.json", file: "layout.json", folder: "form" },
  { key: "fields", endpoint: "/app/form/fields.json", file: "fields.json", folder: "form" },
  { key: "form", endpoint: "/form.json", file: "form.json", folder: "form" },
  { key: "views", endpoint: "/app/views.json", file: "views.json", folder: "views" },
  { key: "reports", endpoint: "/app/reports.json", file: "reports.json", folder: "reports" },
  { key: "settings", endpoint: "/app/settings.json", file: "settings.json", folder: "app_settings" },
  { key: "status", endpoint: "/app/status.json", file: "status.json", folder: "app_settings" },
  { key: "actions", endpoint: "/app/actions.json", file: "app_actions.json", folder: "app_settings" },
  { key: "notifications_general", endpoint: "/app/notifications/general.json", file: "notifications_general.json", folder: "notifications" },
  { key: "notifications_per_record", endpoint: "/app/notifications/perRecord.json", file: "notifications_perRecord.json", folder: "notifications" },
  { key: "notifications_reminder", endpoint: "/app/notifications/reminder.json", file: "notifications_reminder.json", folder: "notifications" },
  { key: "plugins", endpoint: "/app/plugins.json", file: "plugins.json", folder: "customize" },
  { key: "customize", endpoint: "/app/customize.json", file: "customize.json", folder: "customize" },
  { key: "app_acl", endpoint: "/app/acl.json", file: "app_acl.json", folder: "acl" },
  { key: "record_acl", endpoint: "/record/acl.json", file: "record_acl.json", folder: "acl" },
  { key: "field_acl", endpoint: "/field/acl.json", file: "field_acl.json", folder: "acl" }
];

// cli-kintone の customize export。REST の customize と同じ「アプリ管理」権限で、customize の拒否と連動させる。
export const CUSTOMIZE_EXPORT_KEY = "customize_export";

// アプリ管理権限が必要なキー。permission-denies.json の denied はこの順で保存する。
// layout / fields / form / views / reports / settings / status は閲覧権限で取れるため含めない。
export const APP_ADMIN_KEYS: readonly string[] = [
  "actions",
  "notifications_general",
  "notifications_per_record",
  "notifications_reminder",
  "plugins",
  "customize",
  CUSTOMIZE_EXPORT_KEY,
  "app_acl",
  "record_acl",
  "field_acl"
];

// 管理権限の有無を確かめる代表キー。これが 403 / CB_NO02 なら、残りの管理系は同じ実行では要求しない。
export const PERMISSION_PROBE_KEY = "app_acl";

export function isAppAdminKey(key: string): boolean {
  return APP_ADMIN_KEYS.includes(key);
}

// 管理系以外を除き、重複を消して APP_ADMIN_KEYS の順に並べる。
export function sortAdminKeys(keys: Iterable<string>): string[] {
  return [...new Set(keys)].filter(isAppAdminKey).sort((a, b) => APP_ADMIN_KEYS.indexOf(a) - APP_ADMIN_KEYS.indexOf(b));
}
