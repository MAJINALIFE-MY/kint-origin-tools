// 新規アプリドラフト（push/new-apps/<名前>/）の読み込み・検証と、
// アプリ間参照プレースホルダ {{app:名前}} の解決・依存順序の決定。
// ネットワークアクセスを持たない（smoke テストで直接検証する）。

import fs from "node:fs";
import path from "node:path";

import { listFilesRecursive, readJsonIfExists } from "../fsutil.js";
import { pushNewAppsRootPath } from "../paths.js";
import type { IndexedApp } from "./appIndex.js";

export interface AppDraftMeta {
  name: string;
  space?: string;
  thread?: string;
  guestSpaceId?: string;
}

export interface AppDraftCreated {
  appId: string;
  createdAt: string;
  domain?: string;
}

export interface AppDraft {
  draftName: string; // ディレクトリ名
  dir: string;
  meta: AppDraftMeta;
  files: string[]; // ドラフト内の設定 JSON（app.json / created.json を除く相対パス）
  refs: string[]; // {{app:X}} で参照している名前の一覧
  created?: AppDraftCreated; // created.json（二重作成防止マーカー）
}

const APP_REF_PATTERN = /\{\{app:([^{}]+)\}\}/g;

export const DRAFT_META_FILE = "app.json";
export const DRAFT_CREATED_FILE = "created.json";

// 値ツリー内の文字列から {{app:X}} の X を重複なしで収集する。
export function collectAppRefs(value: unknown): string[] {
  const refs = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      for (const match of node.matchAll(APP_REF_PATTERN)) refs.add(match[1]);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const item of Object.values(node)) walk(item);
    }
  };
  walk(value);
  return [...refs];
}

// 値ツリー内の文字列に含まれる {{app:X}} を resolve(X) の結果で全置換した新しい値を返す。
// resolve が throw した場合はそのまま伝播する（呼び出し側でファイル名等の文脈を付与する）。
export function resolveAppRefsDeep(value: unknown, resolve: (ref: string) => string): unknown {
  if (typeof value === "string") {
    return value.replace(APP_REF_PATTERN, (_match, ref: string) => resolve(ref));
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveAppRefsDeep(item, resolve));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = resolveAppRefsDeep(item, resolve);
    }
    return result;
  }
  return value;
}

// {{app:X}} の解決関数を作る。優先順位:
// 1) 今回の実行で作成したドラフト（名前 → 新 appId）
// 2) 数値ならそのまま appId とみなす
// 3) 索引（data/kintone/index/apps.json）のアプリコード完全一致
// 4) 索引のアプリ名一致（一意のときのみ。重複はエラー）
export function createAppRefResolver({
  createdByName,
  index
}: {
  createdByName: Map<string, string>;
  index: Map<string, IndexedApp>;
}): (ref: string) => string {
  const apps = [...index.values()];
  return (ref: string): string => {
    const created = createdByName.get(ref);
    if (created) return created;
    if (/^\d+$/.test(ref)) return ref;
    const byCode = apps.filter((app) => app.code && app.code === ref);
    if (byCode.length === 1) return byCode[0].appId;
    if (byCode.length > 1) {
      throw new Error(`{{app:${ref}}} はアプリコードが重複しています（appId: ${byCode.map((a) => a.appId).join(", ")}）。`);
    }
    const byName = apps.filter((app) => app.name === ref);
    if (byName.length === 1) return byName[0].appId;
    if (byName.length > 1) {
      throw new Error(
        `{{app:${ref}}} は同名アプリが複数あります（appId: ${byName.map((a) => a.appId).join(", ")}）。アプリコードか appId で指定してください。`
      );
    }
    throw new Error(
      `{{app:${ref}}} を解決できません。索引にないアプリの場合は \`kint-origin pull index\` を実行するか、appId を直接指定してください。`
    );
  };
}

// ドラフト1件を読み込んで検証する（app.json の name 必須）。
export function readAppDraft(dir: string): AppDraft {
  const draftName = path.basename(dir);
  const metaPath = path.join(dir, DRAFT_META_FILE);
  const meta = readJsonIfExists(metaPath) as AppDraftMeta | undefined;
  if (!meta || typeof meta !== "object") {
    throw new Error(`ドラフトのメタファイルがありません: ${metaPath}（{"name": "アプリ名"} を含む app.json が必須です）`);
  }
  if (!meta.name || typeof meta.name !== "string") {
    throw new Error(`${metaPath} に name（アプリ名）がありません。`);
  }
  const created = readJsonIfExists(path.join(dir, DRAFT_CREATED_FILE)) as AppDraftCreated | undefined;

  const files = listFilesRecursive(dir)
    .map((file) => file.replaceAll(path.sep, "/"))
    .filter((file) => file.endsWith(".json") && file !== DRAFT_META_FILE && file !== DRAFT_CREATED_FILE)
    .sort((a, b) => a.localeCompare(b, "en"));

  const refs = new Set<string>();
  for (const file of files) {
    const payload = readJsonIfExists(path.join(dir, file));
    for (const ref of collectAppRefs(payload)) refs.add(ref);
  }

  return {
    draftName,
    dir,
    meta,
    files,
    refs: [...refs].sort((a, b) => a.localeCompare(b, "ja")),
    ...(created && created.appId ? { created } : {})
  };
}

// push/new-apps/ 配下のドラフトを列挙する。
// 先頭が "_" のディレクトリ（配布サンプル _example 等）は対象外。
export function listNewAppDrafts(root: string = pushNewAppsRootPath()): AppDraft[] {
  if (!fs.existsSync(root)) return [];
  const drafts: AppDraft[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    drafts.push(readAppDraft(path.join(root, entry.name)));
  }
  return drafts.sort((a, b) => a.draftName.localeCompare(b.draftName, "ja"));
}

// ドラフト間の参照（{{app:X}} の X が他ドラフトの名前）から依存順を決める。
// 参照される側（ルックアップ先）が先。循環は経路付きエラー。
export function orderDraftsByDependency(drafts: AppDraft[]): AppDraft[] {
  // ドラフト名・app.json の name のどちらでも参照できるようにする。
  const byAlias = new Map<string, AppDraft[]>();
  const addAlias = (alias: string, draft: AppDraft): void => {
    const matches = byAlias.get(alias) ?? [];
    if (!matches.some((item) => item.draftName === draft.draftName)) matches.push(draft);
    byAlias.set(alias, matches);
  };
  for (const draft of drafts) {
    addAlias(draft.draftName, draft);
    addAlias(draft.meta.name, draft);
  }

  const dependsOn = new Map<string, Set<string>>(); // draftName -> 依存先 draftName 集合
  for (const draft of drafts) {
    const deps = new Set<string>();
    for (const ref of draft.refs) {
      const matches = byAlias.get(ref) ?? [];
      if (matches.length > 1) throw new Error(`{{app:${ref}}} が複数のドラフトに一致します: ${matches.map((item) => item.draftName).join(", ")}`);
      const target = matches[0];
      if (target && target.draftName !== draft.draftName) deps.add(target.draftName);
    }
    dependsOn.set(draft.draftName, deps);
  }

  // Kahn のトポロジカルソート。
  const remaining = new Map<string, Set<string>>([...dependsOn.entries()].map(([k, v]) => [k, new Set(v)]));
  const ordered: AppDraft[] = [];
  const byDraftName = new Map(drafts.map((draft) => [draft.draftName, draft]));
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b, "ja"));
    if (ready.length === 0) {
      const cycle = [...remaining.keys()].join(" → ");
      throw new Error(
        `ドラフト間の参照が循環しています: ${cycle}\n` +
          "片方のドラフトから相手への {{app:...}} 参照（ルックアップ等のフィールド）を一旦外して作成し、" +
          "作成後に pull された data/ 側のアプリ設定を編集し、`kint-origin push app` により追補してください。"
      );
    }
    for (const name of ready) {
      remaining.delete(name);
      ordered.push(byDraftName.get(name)!);
      for (const deps of remaining.values()) deps.delete(name);
    }
  }
  return ordered;
}
