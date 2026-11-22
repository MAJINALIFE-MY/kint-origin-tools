import type { KintoneApp } from "./client.js";

// kintone のアプリ/スペースに関する ID 正規化ヘルパ（依存なしの小ユーティリティ）。

export type AppScope = "domain" | "space" | "guestspace";

export function stringify(value: unknown): string {
  return value == null ? "" : String(value);
}

export function appIdOf(app: KintoneApp): string {
  return stringify(app.appId);
}
