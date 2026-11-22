// push（kintone への反映）のオーケストレーション。
// kintone の仕様上、設定変更は「動作テスト環境（preview）へ PUT → deploy API で運用環境へ反映」の2段階。
// 環境へ影響する危険操作のため、実行前に反映内容・復旧プランを提示して y/N 確認する（-y は、内容を承認したうえで確認を省略する指定）。
// アプリ設定は pull 時点の Git 基準から変更されたリソースだけを送る。push 前の環境照合は行わない。

import fs from "node:fs";
import path from "node:path";

import { confirmYes } from "../confirm.js";
import { readJsonIfExists, writeJson } from "../fsutil.js";
import { log } from "../log.js";
import { getEnv } from "../env.js";
import { describeAppDiff, inspectApp, type AppInspection } from "./appDiff.js";
import { KintoneClient } from "./client.js";
import { customizeUnit, resolveCustomizeAppDir } from "./customize.js";
import { canonicalJson, normalizeDynamicValues } from "../normalize.js";
import { pullApp } from "./pull.js";
import { refreshAppIndexForPulledApp } from "./apps.js";
import { readAppIndex } from "./appIndex.js";
import { isOtherTenant, otherTenantMessage } from "./tenant.js";
import { hashLocalJson, readPullState, writePullState } from "./pullState.js";
import { kintoneAppRootPath } from "../paths.js";
import {
  PUSH_ITEMS,
  PUSH_KEYS,
  diffFieldProperties,
  isErrorStub,
  splitFieldProperties
} from "./pushItems.js";
import {
  DRAFT_CREATED_FILE,
  collectAppRefs,
  createAppRefResolver,
  listNewAppDrafts,
  orderDraftsByDependency,
  resolveAppRefsDeep,
  type AppDraft
} from "./appDraft.js";

const DEPLOY_POLL_INTERVAL_MS = 3_000;
const DEPLOY_TIMEOUT_MS = 600_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 対話確認ができない環境（AI エージェントのシェル等）では、内容を承認したうえで -y を付けて実行する。
// 承認の取り方は kint-origin-push / kint-origin-records スキルに定める。
export function assertConfirmable({ yes }: { yes: boolean }): void {
  if (yes) return;
  if (!process.stdin.isTTY) {
    throw new Error(
      "対話確認ができない実行環境のため中断しました。反映内容（kint-origin diff）を確認し、承認済みであれば -y を付けて再実行してください。"
    );
  }
}

function assertPullState(inspection: AppInspection): void {
  if (!inspection.diff.pullState) {
    throw new Error(
      `pull 状態がありません: ${inspection.diff.appDir}\nkint-origin pull app --id ${inspection.diff.appId} を実行してから編集してください。`
    );
  }
}

function validateOnlyKeys(only: string[] | undefined): void {
  if (!only) return;
  const unknown = only.filter((key) => key !== "customize" && !PUSH_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`--only に不明なキーがあります: ${unknown.join(", ")}（有効: customize, ${PUSH_KEYS.join(", ")}）`);
  }
}

interface PreparedRequest {
  key: string;
  method: "PUT" | "POST";
  endpoint: string;
  body: Record<string, unknown>;
}

export interface SkippedResource {
  key: string;
  reason: string;
}

interface PushPlan {
  requests: PreparedRequest[];
  skipped: SkippedResource[];
  fieldsAdded: number;
  fieldsUpdated: number;
  fieldsMissingOnLocal: string[];
}

// 新規アプリのドラフト一式を読み、送信可能なリクエスト列へ変換する（読み取り GET のみ・書き込みなし）。
async function buildCreatePlan({
  client,
  appId,
  guestSpaceId,
  sourceDir,
  resolver
}: {
  client: KintoneClient;
  appId: string;
  guestSpaceId: string;
  sourceDir: string;
  resolver: (ref: string) => string;
}): Promise<PushPlan> {
  const requests: PreparedRequest[] = [];
  const skipped: SkippedResource[] = [];
  let fieldsAdded = 0;
  let fieldsUpdated = 0;
  let fieldsMissingOnLocal: string[] = [];

  const resolveRefs = (payload: unknown, file: string): unknown => {
    try {
      return resolveAppRefsDeep(payload, resolver);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${file}: ${message}`);
    }
  };

  // fields は add(POST)/update(PUT) の振り分けが必要なため特別扱い。
  const fieldsFile = path.join(sourceDir, "form", "fields.json");
  const fieldsPayload = readJsonIfExists(fieldsFile) as any;
  if (fieldsPayload === undefined) {
    skipped.push({ key: "fields", reason: "ファイルがありません（form/fields.json）" });
  } else if (isErrorStub(fieldsPayload)) {
    skipped.push({ key: "fields", reason: "pull 失敗時のスタブ（_error）のため送信しません" });
  } else {
    const resolved = resolveRefs(fieldsPayload, "form/fields.json") as any;
    const remote = await client.getAppResource("/app/form/fields.json", appId, { guestSpaceId, preview: true });
    const split = splitFieldProperties(resolved?.properties, remote?.properties);
    fieldsMissingOnLocal = split.missingOnLocal;
    if (Object.keys(split.add).length > 0) {
      requests.push({
        key: "fields(add)",
        method: "POST",
        endpoint: "/app/form/fields.json",
        body: { app: appId, properties: split.add }
      });
      fieldsAdded = Object.keys(split.add).length;
    }
    if (Object.keys(split.update).length > 0) {
      requests.push({
        key: "fields(update)",
        method: "PUT",
        endpoint: "/app/form/fields.json",
        body: { app: appId, properties: split.update }
      });
      fieldsUpdated = Object.keys(split.update).length;
    }
    if (fieldsAdded === 0 && fieldsUpdated === 0) {
      skipped.push({ key: "fields", reason: "送信対象のフィールドがありません（組み込みフィールドのみ等）" });
    }
  }

  for (const item of PUSH_ITEMS) {
    const filePath = path.join(sourceDir, item.folder, item.file);
    const payload = readJsonIfExists(filePath) as any;
    if (payload === undefined) {
      skipped.push({ key: item.key, reason: `ファイルがありません（${item.folder}/${item.file}）` });
      continue;
    }
    if (isErrorStub(payload)) {
      skipped.push({ key: item.key, reason: "pull 失敗時のスタブ（_error）のため送信しません" });
      continue;
    }
    const resolved = resolveRefs(payload, `${item.folder}/${item.file}`);
    const result = item.buildBody(resolved, { appId, mode: "create" });
    if ("skip" in result) {
      skipped.push({ key: item.key, reason: result.skip });
      continue;
    }
    requests.push({ key: item.key, method: "PUT", endpoint: item.endpoint, body: result.body });
  }

  return { requests, skipped, fieldsAdded, fieldsUpdated, fieldsMissingOnLocal };
}

// Git 基準と作業ツリーの差分から、動作テスト環境へ送る API 本文を組み立てる。
function buildUpdatePlan({
  appId,
  inspection
}: {
  appId: string;
  inspection: AppInspection;
}): PushPlan {
  const requests: PreparedRequest[] = [];
  const skipped: SkippedResource[] = [];
  let fieldsAdded = 0;
  let fieldsUpdated = 0;
  const fieldsMissingOnLocal = inspection.diff.fields?.missingOnLocal ?? [];

  for (const resource of inspection.diff.resources) {
    if (resource.state === "skipped") {
      skipped.push({ key: resource.key, reason: resource.reason ?? "対象外" });
      continue;
    }
    if (resource.state === "same") {
      if (resource.reason) skipped.push({ key: resource.key, reason: resource.reason });
      continue;
    }
    const local = inspection.locals.get(resource.key);
    const baseline = inspection.baselines.get(resource.key);

    // 変更したフィールドだけを、Git 基準にあるかどうかで追加 (POST) と更新 (PUT) に振り分ける。
    if (resource.key === "fields") {
      const diff = diffFieldProperties(local?.properties, baseline?.properties);
      const changedCodes = new Set([...diff.added, ...diff.changed]);
      const changed = Object.fromEntries(Object.entries(local?.properties ?? {}).filter(([code]) => changedCodes.has(code)));
      const split = splitFieldProperties(changed, baseline?.properties);
      if (Object.keys(split.add).length > 0) {
        requests.push({
          key: "fields(add)",
          method: "POST",
          endpoint: "/app/form/fields.json",
          body: { app: appId, properties: split.add }
        });
        fieldsAdded = Object.keys(split.add).length;
      }
      if (Object.keys(split.update).length > 0) {
        requests.push({
          key: "fields(update)",
          method: "PUT",
          endpoint: "/app/form/fields.json",
          body: { app: appId, properties: split.update }
        });
        fieldsUpdated = Object.keys(split.update).length;
      }
      if (fieldsAdded === 0 && fieldsUpdated === 0) {
        skipped.push({ key: "fields", reason: "送信対象のフィールドがありません（組み込みフィールドのみ等）" });
      }
      continue;
    }

    const item = PUSH_ITEMS.find((candidate) => candidate.key === resource.key);
    if (!item) continue;
    const result = item.buildBody(local, { appId, mode: "update" });
    if ("skip" in result) {
      skipped.push({ key: item.key, reason: result.skip });
      continue;
    }
    let body = result.body;
    if (item.key === "settings") {
      const baseResult = item.buildBody(baseline, { appId, mode: "update" });
      if ("skip" in baseResult) {
        skipped.push({ key: item.key, reason: "Git 基準の設定を読み取れないため送信しません" });
        continue;
      }
      const changedSettings = Object.fromEntries(
        Object.entries(body).filter(([key]) => {
          if (key === "app") return false;
          return canonicalJson(normalizeDynamicValues((body as any)[key])) !== canonicalJson(normalizeDynamicValues((baseResult.body as any)[key]));
        })
      );
      if (Object.keys(changedSettings).length === 0) {
        skipped.push({ key: item.key, reason: "送信可能な設定項目に差分がありません" });
        continue;
      }
      body = { app: appId, ...changedSettings };
    }
    requests.push({ key: item.key, method: "PUT", endpoint: item.endpoint, body });
  }
  if (inspection.diff.customize.state === "skipped" && inspection.diff.customize.reason) {
    skipped.push({ key: "customize", reason: inspection.diff.customize.reason });
  }

  return { requests, skipped, fieldsAdded, fieldsUpdated, fieldsMissingOnLocal };
}

// expected を渡すと、そのアプリが全て SUCCESS で応答に含まれているときだけ success にする。
// 応答が空・要求したアプリが欠けているのを「成功」と見なすと、反映できていないのに完了と報告してしまう。
export function summarizeDeployStatuses(
  statuses: Array<{ app: string; status: string }>,
  expected?: string[]
): {
  state: "processing" | "success" | "failed";
  failed: string[];
} {
  const failed = statuses.filter((s) => s.status === "FAIL" || s.status === "CANCEL").map((s) => s.app);
  if (failed.length > 0) return { state: "failed", failed };
  if (statuses.length === 0 && (!expected || expected.length > 0)) return { state: "processing", failed: [] };
  if (statuses.some((s) => s.status === "PROCESSING")) return { state: "processing", failed: [] };
  if (expected) {
    const succeeded = new Set(statuses.filter((s) => s.status === "SUCCESS").map((s) => String(s.app)));
    if (expected.some((app) => !succeeded.has(String(app)))) return { state: "processing", failed: [] };
  }
  return { state: "success", failed: [] };
}

// 復旧プランは反映の承認を求める前に提示する。
export function buildRecoveryPlanText({
  mode,
  backupRoot,
  restoreCommand
}: {
  mode: "create" | "records" | "space";
  backupRoot?: string;
  restoreCommand?: string;
}): string {
  const lines: string[] = ["【復旧プラン】"];
  if (mode === "records") {
    lines.push(
      "- レコードの書き込みは動作テスト環境を経由せず、運用環境へ即時に反映されます。",
      `- 反映前に、対象レコードの現在の値と添付ファイルを ${backupRoot ?? "push/records/<ジョブ名>/runs/<実行時刻>/backup/"} に保存します。`,
      `- 元に戻す場合: ${restoreCommand ?? "kint-origin push records --name <ジョブ名> --restore <実行時刻>"}`,
      "  （更新したフィールドをバックアップの値に戻し、このジョブで作成したレコードを削除します。",
      "   実行後に他の人が編集したレコードは中断して報告します）",
      "- 一括処理が複数回に分かれる場合、途中で失敗すると前の回までは反映済みです。その場合も同じコマンドで戻せます。",
      "- 更新者・更新日時は実行したユーザーと時刻になります。Webhook や通知が発生することがあります。"
    );
  } else if (mode === "space") {
    lines.push(
      "- スペースの設定・本文には動作テスト環境（preview）が無く、運用環境へ即時に反映されます（途中で破棄はできません）。",
      "- 元へ戻す場合:",
      `  1) 事前バックアップ ${backupRoot ?? "_agentdata/backup/"}<実行時刻>/ の settings.json / body.html を data/ の該当スペースフォルダへ戻して再度 push space`,
      "  2) または Git 履歴の data/ 配下（直前の pull 結果）から復元して再度 push space"
    );
  } else {
    lines.push(
      "- deploy 前: 新規アプリは運用環境に現れません。不要になった場合は kintone システム管理の画面から削除できます。",
      "- deploy 後: アプリの削除は API では行えません。kintone のアプリ設定（運用管理）から削除してください。",
      "- 作成直後に `pull app` で取得されるため、以後の変更は Git 履歴で追跡・復元できます。"
    );
  }
  return lines.join("\n");
}

// 新規アプリドラフトを逐次送信（書き込みはリトライされないため並列にしない）。失敗時は revert（変更破棄）を提案する。
async function executePushRequests({
  client,
  appId,
  guestSpaceId,
  requests,
  yes
}: {
  client: KintoneClient;
  appId: string;
  guestSpaceId: string;
  requests: PreparedRequest[];
  yes: boolean;
}): Promise<void> {
  const done: string[] = [];
  for (const request of requests) {
    try {
      if (request.method === "POST") {
        await client.postPreviewAppResource(request.endpoint, request.body, { guestSpaceId });
      } else {
        await client.putPreviewAppResource(request.endpoint, request.body, { guestSpaceId });
      }
      done.push(request.key);
      log(`反映(動作テスト環境): ${request.key}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`反映失敗: ${request.key} (${message})`);
      if (done.length > 0) log(`送信済み: ${done.join(", ")}`);
      await offerRevert({ client, appId, guestSpaceId, yes });
      throw new Error(`app-${appId} の ${request.key} の反映に失敗しました: ${message}`);
    }
  }
}

// 新規アプリドラフト反映中に行った、動作テスト環境の変更破棄（revert deploy）。-y 実行時は自動、TTY なら確認、非対話なら手順案内のみ。
async function offerRevert({
  client,
  appId,
  guestSpaceId,
  yes
}: {
  client: KintoneClient;
  appId: string;
  guestSpaceId: string;
  yes: boolean;
}): Promise<void> {
  const manualGuide =
    "動作テスト環境に途中までの変更が残っています。再実行で上書きするか、kintone のアプリ設定画面の「変更を中止」で破棄してください。";
  try {
    if (yes) {
      log("revert: 動作テスト環境の変更を破棄します...");
      await deployAndWait({ client, appIds: [appId], guestSpaceId, revert: true });
      log("revert 完了: 動作テスト環境を運用環境と同じ状態に戻しました。");
      return;
    }
    if (process.stdin.isTTY) {
      const ok = await confirmYes("動作テスト環境の変更を破棄して運用環境と同じ状態に戻しますか？(revert) [y/N]");
      if (ok) {
        await deployAndWait({ client, appIds: [appId], guestSpaceId, revert: true });
        log("revert 完了: 動作テスト環境を運用環境と同じ状態に戻しました。");
      } else {
        log(manualGuide);
      }
      return;
    }
    log(manualGuide);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`revert に失敗しました (${message})。${manualGuide}`);
  }
}

// deploy（または revert）を実行し、反映完了までポーリングする。
async function deployAndWait({
  client,
  appIds,
  guestSpaceId,
  revert = false
}: {
  client: KintoneClient;
  appIds: string[];
  guestSpaceId: string;
  revert?: boolean;
}): Promise<void> {
  await client.deployApps(
    appIds.map((app) => ({ app })),
    { revert, guestSpaceId }
  );
  const startedAt = Date.now();
  while (true) {
    const statuses = await client.getDeployStatuses(appIds, { guestSpaceId });
    const summary = summarizeDeployStatuses(statuses, appIds.map(String));
    if (summary.state === "success") return;
    if (summary.state === "failed") {
      throw new Error(
        `運用環境への反映に失敗しました（アプリ: ${summary.failed.join(", ")}）。` +
          "動作テスト環境には反映済みです。設定を修正して再 push するか、kintone のアプリ設定画面の「変更を中止」で破棄してください。"
      );
    }
    if (Date.now() - startedAt > DEPLOY_TIMEOUT_MS) {
      throw new Error(
        `運用環境への反映が ${DEPLOY_TIMEOUT_MS / 60_000} 分以内に完了しませんでした。kintone のアプリ設定画面で反映状況を確認してください。`
      );
    }
    log("運用環境へ反映中...");
    await sleep(DEPLOY_POLL_INTERVAL_MS);
  }
}

export function backupTimestamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function logPlan(plan: PushPlan): void {
  log(`送信リソース: ${plan.requests.length > 0 ? plan.requests.map((r) => r.key).join(", ") : "(なし)"}`);
  for (const skip of plan.skipped) {
    log(`  対象外: ${skip.key} — ${skip.reason}`);
  }
  if (plan.fieldsMissingOnLocal.length > 0) {
    log(
      `  警告: kintone 側のみに存在するフィールドがあります（削除はしません）: ${plan.fieldsMissingOnLocal.join(", ")}`
    );
  }
}

export interface PushAppSummary {
  status: "no_changes" | "aborted" | "preview_saved" | "deployed";
  appId: string;
  name: string;
  guestSpaceId: string;
  baseCommit: string;
  pushed: Array<{ key: string; method: string; endpoint: string }>;
  uploadedCustomizeFiles: string[];
  skipped: SkippedResource[];
  fieldsAdded: number;
  fieldsUpdated: number;
  fieldsMissingOnLocal: string[];
  deployed: boolean;
  aborted?: boolean;
}

interface CustomizeUpload {
  filePath: string;
  fileName: string;
  target: { platform: "desktop" | "mobile"; type: "js" | "css"; index: number };
}

interface CustomizeApiPlan {
  request?: PreparedRequest;
  uploads: CustomizeUpload[];
}

function safeCustomizeFile(appDir: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`customize のファイルパスが不正です: ${relativePath}`);
  }
  const root = path.resolve(appDir, "customize");
  const fullPath = path.resolve(root, normalized);
  const relative = path.relative(root, fullPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`customize の範囲外を参照しています: ${relativePath}`);
  }
  const stat = fs.lstatSync(fullPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`customize の通常ファイルではありません: ${relativePath}`);
  const realRelative = path.relative(fs.realpathSync(root), fs.realpathSync(fullPath));
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`customize の範囲外を参照しています: ${relativePath}`);
  }
  return fullPath;
}

function buildCustomizeApiPlan({ appDir, appId, inspection }: { appDir: string; appId: string; inspection: AppInspection }): CustomizeApiPlan {
  if (inspection.diff.customize.state !== "local") return { uploads: [] };
  const manifest = inspection.locals.get("customize");
  const groups = inspection.diff.customize.groups;
  if (!manifest || !Array.isArray(groups) || groups.length === 0) throw new Error("customize の変更グループを特定できません。");
  const body: Record<string, any> = { app: appId, scope: manifest.scope ?? "ALL" };
  const uploads: CustomizeUpload[] = [];

  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions) || manifest.permissions.some((entry: any) =>
      !entry || typeof entry !== "object" || typeof entry.permission !== "string" ||
      (entry.scope !== undefined && typeof entry.scope !== "string")
    )) {
      throw new Error("customize/permissions は permission と任意の scope を持つオブジェクトの配列で指定してください。");
    }
    body.permissions = manifest.permissions;
  }
  if (manifest.allowed_hosts !== undefined) {
    if (!Array.isArray(manifest.allowed_hosts) || manifest.allowed_hosts.some((host: unknown) => typeof host !== "string")) {
      throw new Error("customize/allowed_hosts は文字列の配列で指定してください。");
    }
    body.allowedHosts = manifest.allowed_hosts;
  }

  for (const group of groups) {
    const [platform, type] = group.split(".") as ["desktop" | "mobile", "js" | "css"];
    const source = manifest?.[platform]?.[type];
    if (source !== undefined && !Array.isArray(source)) throw new Error(`customize/${platform}.${type} は配列で指定してください。`);
    const entries: any[] = [];
    for (const item of (source ?? []) as unknown[]) {
      if (typeof item !== "string") throw new Error(`customize/${platform}.${type} の各項目は文字列で指定してください。`);
      if (/^https?:\/\//i.test(item)) {
        entries.push({ type: "URL", url: item });
        continue;
      }
      const filePath = safeCustomizeFile(appDir, item);
      const index = entries.length;
      entries.push({ type: "FILE", file: { name: path.basename(item.replaceAll("\\", "/")), fileKey: "" } });
      uploads.push({ filePath, fileName: path.basename(item.replaceAll("\\", "/")), target: { platform, type, index } });
    }
    body[platform] ??= {};
    body[platform][type] = entries;
  }

  return {
    request: { key: "customize", method: "PUT", endpoint: "/app/customize.json", body },
    uploads
  };
}

async function executeAppPlan({
  client,
  guestSpaceId,
  requests,
  uploads
}: {
  client: KintoneClient;
  guestSpaceId: string;
  requests: PreparedRequest[];
  uploads: CustomizeUpload[];
}): Promise<{ pushed: Array<{ key: string; method: string; endpoint: string }> }> {
  const uploadedCustomizeFiles: string[] = [];
  const customizeRequest = requests.find((request) => request.key === "customize");
  try {
    for (const upload of uploads) {
      const fileKey = await client.uploadAppCustomizeFile(upload.filePath, upload.fileName, { guestSpaceId });
      const platform = (customizeRequest?.body[upload.target.platform] as any) ?? {};
      const item = platform[upload.target.type]?.[upload.target.index];
      if (item?.type !== "FILE") throw new Error(`customize のアップロード先を特定できません: ${upload.fileName}`);
      item.file.fileKey = fileKey;
      uploadedCustomizeFiles.push(upload.fileName);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`customize ファイルのアップロードに失敗しました (${message})。設定 API はまだ実行していません。アップロード済み一時ファイル: ${uploadedCustomizeFiles.join(", ") || "なし"}`);
  }

  const pushed: Array<{ key: string; method: string; endpoint: string }> = [];
  for (const request of requests) {
    try {
      if (request.method === "POST") await client.postPreviewAppResource(request.endpoint, request.body, { guestSpaceId });
      else await client.putPreviewAppResource(request.endpoint, request.body, { guestSpaceId });
      pushed.push({ key: request.key, method: request.method, endpoint: request.endpoint });
      log(`反映（動作テスト環境）: ${request.key}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const uncertain = Boolean((error as { uncertain?: boolean } | undefined)?.uncertain);
      throw new Error(
        `app 設定の反映に失敗しました: ${request.key} (${message})${uncertain ? "。サーバー側で反映された可能性があります" : ""}。` +
          `反映済みリソース: ${pushed.map((item) => item.key).join(", ") || "なし"}。` +
          "途中まで動作テスト環境へ反映された可能性があります。ほかの人の変更を消さないため自動 revert は行っていません。kintone のアプリ設定画面で状態を確認してください。"
      );
    }
  }
  return { pushed };
}

function advancePullStateAfterDeploy({
  appDir,
  inspection,
  pushed
}: {
  appDir: string;
  inspection: AppInspection;
  pushed: ReadonlySet<string>;
}): void {
  const state = readPullState(appDir);
  if (!state) return;
  let changed = false;
  for (const resource of inspection.diff.resources) {
    if (!pushed.has(resource.key)) continue;
    const expected = inspection.workingHashes.get(resource.key);
    const filePath = path.join(appDir, resource.file);
    const current = hashLocalJson(filePath);
    if (!expected || current !== expected) {
      log(`push 後にローカル編集が続いたため pull 状態を更新しません: ${resource.file}`);
      continue;
    }
    state.files[resource.file] = current;
    changed = true;
  }
  if (pushed.has("customize")) {
    const expected = inspection.workingHashes.get("customize");
    const current = customizeUnit(appDir)?.hash;
    if (expected && current === expected) {
      state.customize = current;
      changed = true;
    } else {
      log("push 後に customize のローカル編集が続いたため pull 状態を更新しません。");
    }
  }
  if (changed) writePullState(appDir, state);
}

// Git 基準コミットからの差分だけを preview へ送り、必要なら deploy する。push 前後の全設定取得や自動バックアップは行わない。
export async function pushApp({
  appId,
  guestSpaceId = "",
  only,
  baseRef = "HEAD",
  deploy = true,
  yes = false
}: {
  appId: string;
  guestSpaceId?: string;
  only?: string[];
  baseRef?: string;
  deploy?: boolean;
  yes?: boolean;
}): Promise<PushAppSummary> {
  assertConfirmable({ yes });
  validateOnlyKeys(only);

  const appDir = resolveCustomizeAppDir({ appId, guestSpaceId });
  if (!fs.existsSync(appDir)) {
    throw new Error(`アプリが未取得です: ${appDir}\n先に kint-origin pull app --id ${appId} を実行してください。`);
  }
  if (isOtherTenant(appDir)) throw new Error(otherTenantMessage(appDir));
  const metadata = readJsonIfExists(path.join(appDir, "app.json")) as { name?: unknown } | undefined;
  const name = typeof metadata?.name === "string" ? metadata.name : "";
  const client = new KintoneClient();
  const inspection = inspectApp({ appId: String(appId), guestSpaceId, appDir, name, baseRef, only });
  assertPullState(inspection);
  for (const line of describeAppDiff(inspection.diff)) log(line);

  const plan = buildUpdatePlan({ appId: String(appId), inspection });
  const customizePlan = buildCustomizeApiPlan({ appDir, appId: String(appId), inspection });
  if (customizePlan.request) plan.requests.push(customizePlan.request);
  for (const skip of plan.skipped) log(`対象外: ${skip.key} — ${skip.reason}`);
  if (plan.fieldsMissingOnLocal.length > 0) log(`警告: pull 基準にのみ存在するフィールド（削除しません）: ${plan.fieldsMissingOnLocal.join(", ")}`);

  const base: PushAppSummary = {
    status: "no_changes",
    appId: String(appId),
    name,
    guestSpaceId,
    baseCommit: inspection.diff.baseCommit,
    pushed: [],
    uploadedCustomizeFiles: customizePlan.uploads.map((upload) => upload.fileName),
    skipped: plan.skipped,
    fieldsAdded: plan.fieldsAdded,
    fieldsUpdated: plan.fieldsUpdated,
    fieldsMissingOnLocal: plan.fieldsMissingOnLocal,
    deployed: false
  };
  if (plan.requests.length === 0) {
    log("Git 基準と pull 状態から送る変更はありません。");
    return base;
  }

  log(`送信リソース: ${plan.requests.map((request) => request.key).join(", ")}`);
  if (customizePlan.uploads.length > 0) log(`customize ファイルアップロード: ${customizePlan.uploads.length} 件（変更グループ内のファイルを全て再送）`);
  log("API の事前照合・全設定バックアップ・反映後の全設定 pull は行いません。");
  log(`Git 基準: ${inspection.diff.baseCommit}（pull app の取得結果を含むコミットを --base に指定してください）`);
  log("同じリソースに pull 後の他者変更があれば、ローカルの Git 差分で上書きします。deploy は preview にある全ての変更を運用環境へ反映します。");
  log("復旧: Git の pull 基準から対象ファイルを戻して再度 push app します。preview への途中反映で失敗した場合は、状態を確認してからアプリ設定画面の「変更を中止」を使ってください。");
  log(deploy ? "この操作は preview に設定を書き込み、deploy 後に運用環境へ反映します。" : "--no-deploy のため preview への反映で止め、運用環境は変更しません。");

  if (!yes) {
    const ok = await confirmYes("続行しますか？ [y/N]");
    if (!ok) {
      log("中断しました。");
      return { ...base, status: "aborted", pushed: [], uploadedCustomizeFiles: [], aborted: true };
    }
  }

  const { pushed: completed } = await executeAppPlan({
    client,
    guestSpaceId,
    requests: plan.requests,
    uploads: customizePlan.uploads
  });
  if (!deploy) {
    log("preview への反映が完了しました。運用環境への反映は行っていません。");
    return { ...base, status: "preview_saved", pushed: completed };
  }

  try {
    await deployAndWait({ client, appIds: [String(appId)], guestSpaceId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`preview への書き込みは完了しましたが deploy を確認できませんでした (${message})。kintone のアプリ設定画面で状態を確認してください。`);
  }
  const pushedKeys = new Set(completed.map((item) => item.key.replace(/\(.*\)$/, "")));
  advancePullStateAfterDeploy({ appDir, inspection, pushed: pushedKeys });
  log("運用環境への反映が完了しました。ローカルの Git 差分は保持しています。");
  return { ...base, status: "deployed", pushed: completed, deployed: true };
}
export interface PushCreateResult {
  draftName: string;
  name: string;
  appId: string;
  resumed: boolean;
  pushed: Array<{ key: string; method: string; endpoint: string }>;
  skipped: SkippedResource[];
  fieldsAdded: number;
  fieldsMissingOnLocal: string[];
}

export interface PushCreateSummary {
  created: PushCreateResult[];
  skippedDrafts: Array<{ draftName: string; reason: string }>;
  deployed: boolean;
  aborted?: boolean;
}

interface CreatePlan {
  ordered: AppDraft[];
  skippedDrafts: Array<{ draftName: string; reason: string }>;
  allDrafts: AppDraft[];
}

// 作成するドラフトを選び、依存順に並べる（API は呼ばない）。push create と diff create で共有する。
function planCreate({ name, all }: { name?: string; all?: boolean }): CreatePlan {
  const drafts = listNewAppDrafts();
  if (drafts.length === 0) {
    throw new Error(
      "新規アプリのドラフトがありません。push/new-apps/<アプリ名>/ に app.json（{\"name\": \"アプリ名\"}）と設定 JSON を置いてください（雛形: push/new-apps/_example/）。"
    );
  }

  let targets: AppDraft[];
  const skippedDrafts: Array<{ draftName: string; reason: string }> = [];
  if (name) {
    // フォルダ名の完全一致を優先する。app.json の name だけで一致するドラフトが複数あるときは、別のドラフトを選ばずに拒否する。
    const byFolder = drafts.find((draft) => draft.draftName === name);
    const byAppName = drafts.filter((draft) => draft.meta.name === name);
    if (!byFolder && byAppName.length > 1) {
      throw new Error(
        `app.json の name が「${name}」のドラフトが複数あります（${byAppName.map((d) => d.draftName).join(", ")}）。--name にはフォルダ名を指定してください。`
      );
    }
    const found = byFolder ?? byAppName[0];
    if (!found) {
      throw new Error(`ドラフトが見つかりません: ${name}（存在するドラフト: ${drafts.map((d) => d.draftName).join(", ")}）`);
    }
    // --name 明示指定なら作成済みでも「リソース反映から再開」できる。
    targets = [found];
  } else if (all) {
    targets = drafts.filter((draft) => {
      if (draft.created) {
        skippedDrafts.push({
          draftName: draft.draftName,
          reason: `作成済み（appId=${draft.created.appId}）。以後の変更は pull した app-${draft.created.appId} の data/ を編集して push app してください。`
        });
        return false;
      }
      return true;
    });
    if (targets.length === 0) {
      throw new Error("未作成のドラフトがありません（すべて作成済みです）。");
    }
  } else {
    throw new Error(`--name <ドラフト名> または --all を指定してください（存在するドラフト: ${drafts.map((d) => d.draftName).join(", ")}）`);
  }

  return { ordered: orderDraftsByDependency(targets), skippedDrafts, allDrafts: drafts };
}

function createRefPreflight(plan: CreatePlan, domain: string): AppDraft[] {
  const aliases = new Map<string, AppDraft[]>();
  const addAlias = (name: string, draft: AppDraft): void => {
    const matches = aliases.get(name) ?? [];
    if (!matches.some((item) => item.draftName === draft.draftName)) matches.push(draft);
    aliases.set(name, matches);
  };
  for (const draft of plan.allDrafts) {
    addAlias(draft.draftName, draft);
    addAlias(draft.meta.name, draft);
  }
  const validatedMarkers = new Set<string>();
  const validateMarker = (draft: AppDraft): void => {
    if (!draft.created || validatedMarkers.has(draft.draftName)) return;
    if (!/^[1-9]\d*$/.test(draft.created.appId)) throw new Error(`${draft.draftName}/created.json の appId が不正です。`);
    if (draft.created.domain) {
      if (draft.created.domain.toLocaleLowerCase() !== domain.toLocaleLowerCase()) {
        throw new Error(`${draft.draftName}/created.json は別のドメイン用です (${draft.created.domain})。現在の接続先 ${domain} では再利用できません。`);
      }
    } else {
      const appDir = kintoneAppRootPath({
        appId: draft.created.appId,
        guestSpaceId: draft.meta.guestSpaceId || "",
        spaceId: draft.meta.guestSpaceId ? "" : draft.meta.space || ""
      });
      const appMetadata = readJsonIfExists(path.join(appDir, "app.json")) as any;
      if (String(appMetadata?.appId ?? "") !== draft.created.appId || String(appMetadata?.domain ?? "").toLocaleLowerCase() !== domain.toLocaleLowerCase()) {
        throw new Error(`${draft.draftName}/created.json にドメイン記録がありません。app-${draft.created.appId} の同一ドメインの data/.../app.json が確認できないため、誤接続防止で再利用しません。`);
      }
    }
    validatedMarkers.add(draft.draftName);
  };
  for (const draft of plan.ordered) if (draft.created) validateMarker(draft);
  const selected = new Set(plan.ordered.map((draft) => draft.draftName));
  const indexResolver = createAppRefResolver({ createdByName: new Map(), index: readAppIndex() });
  const dependencies = new Set<AppDraft>();
  const resolve = (ref: string, owner: AppDraft): string => {
    const matches = aliases.get(ref) ?? [];
    if (matches.length > 1) throw new Error(`${owner.draftName}: {{app:${ref}}} が複数のドラフトに一致します: ${matches.map((item) => item.draftName).join(", ")}`);
    const target = matches[0];
    if (target?.created) {
      validateMarker(target);
      if (target.draftName !== owner.draftName) dependencies.add(target);
      return target.created.appId;
    }
    if (target && selected.has(target.draftName)) return "1"; // 作成前の構造検証用。実際の appId は作成後に置換する。
    if (target) throw new Error(`${owner.draftName}: {{app:${ref}}} のドラフトは今回の対象に含まれていません。--all を指定するか、先にそのドラフトを作成してください。`);
    return indexResolver(ref);
  };
  for (const draft of plan.ordered) {
    const resolveForDraft = (value: unknown, file: string): unknown => {
      const refs = collectAppRefs(value);
      for (const ref of refs) resolve(ref, draft);
      try {
        return resolveAppRefsDeep(value, (ref) => resolve(ref, draft));
      } catch (error) {
        throw new Error(`${draft.draftName}/${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const fieldsPath = path.join(draft.dir, "form", "fields.json");
    const fields = readJsonIfExists(fieldsPath) as any;
    if (fields !== undefined && !isErrorStub(fields)) {
      const resolved = resolveForDraft(fields, "form/fields.json") as any;
      if (resolved?.properties != null && (!resolved.properties || typeof resolved.properties !== "object" || Array.isArray(resolved.properties))) {
        throw new Error(`${draft.draftName}/form/fields.json の properties はオブジェクトである必要があります。`);
      }
    }
    for (const item of PUSH_ITEMS) {
      const file = path.join(draft.dir, item.folder, item.file);
      const payload = readJsonIfExists(file);
      if (payload === undefined || isErrorStub(payload)) continue;
      const resolved = resolveForDraft(payload, `${item.folder}/${item.file}`);
      try {
        item.buildBody(resolved, { appId: "1", mode: "create" });
      } catch (error) {
        throw new Error(`${draft.draftName}/${item.folder}/${item.file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return [...dependencies];
}

function logCreatePlan({ ordered }: CreatePlan): void {
  log(`作成順: ${ordered.map((d) => `${d.draftName}${d.created ? "（作成済み・再開）" : ""}`).join(" → ")}`);
  for (const draft of ordered) {
    log(
      `  ${draft.draftName}: name="${draft.meta.name}"` +
        (draft.meta.space ? ` space=${draft.meta.space}` : "") +
        (draft.meta.guestSpaceId ? ` guestspace=${draft.meta.guestSpaceId}` : "") +
        ` files=[${draft.files.join(", ") || "(なし)"}]` +
        (draft.refs.length ? ` refs=[${draft.refs.map((r) => `{{app:${r}}}`).join(", ")}]` : "")
    );
  }
  log(buildRecoveryPlanText({ mode: "create" }));
}

// push create の事前確認。作成順・ドラフトの内容・参照・復旧プランを表示する（API は呼ばない）。
export function diffCreate({ name, all = false }: { name?: string; all?: boolean }) {
  const plan = planCreate({ name, all });
  logCreatePlan(plan);
  return {
    order: plan.ordered.map((draft) => ({
      draftName: draft.draftName,
      name: draft.meta.name,
      space: draft.meta.space ?? "",
      guestSpaceId: draft.meta.guestSpaceId ?? "",
      files: draft.files,
      refs: draft.refs,
      created: Boolean(draft.created)
    })),
    skippedDrafts: plan.skippedDrafts
  };
}

export async function pushCreate({
  name,
  all = false,
  deploy = true,
  yes = false
}: {
  name?: string;
  all?: boolean;
  deploy?: boolean;
  yes?: boolean;
}): Promise<PushCreateSummary> {
  assertConfirmable({ yes });

  const plan = planCreate({ name, all });
  const { ordered, skippedDrafts } = plan;
  const domain = new URL(getEnv().baseUrl).host;
  const createdDependencies = createRefPreflight(plan, domain);
  logCreatePlan(plan);
  if (deploy) {
    log("作成したアプリは deploy 後に運用環境へ公開されます。");
  } else {
    log("--no-deploy 指定のため、動作テスト環境への作成・反映まで行います（運用環境には公開されません）。");
  }

  if (!yes) {
    const ok = await confirmYes("続行しますか？ [y/N]");
    if (!ok) {
      log("中断しました。");
      return { created: [], skippedDrafts, deployed: false, aborted: true };
    }
  }

  const client = new KintoneClient();
  const createdByName = new Map<string, string>();
  for (const draft of plan.allDrafts) {
    if (!draft.created) continue;
    const folderMatches = plan.allDrafts.filter((item) => item.draftName === draft.draftName);
    const nameMatches = plan.allDrafts.filter((item) => item.meta.name === draft.meta.name);
    if (folderMatches.length === 1) createdByName.set(draft.draftName, draft.created.appId);
    if (nameMatches.length === 1) createdByName.set(draft.meta.name, draft.created.appId);
  }
  const resolver = createAppRefResolver({ createdByName, index: readAppIndex() });
  const results: PushCreateResult[] = [];

  // --all から除外した作成済みドラフトを依存先として使う場合、対象環境に存在するかを全件確認してから新規作成を始める。
  for (const dependency of createdDependencies) {
    if (deploy) {
      try {
        await client.getAppInfo(dependency.created!.appId, { guestSpaceId: dependency.meta.guestSpaceId || "" });
      } catch (error) {
        if ((error as { status?: number }).status === 404) {
          throw new Error(`依存先 ${dependency.draftName} (app-${dependency.created!.appId}) は動作テスト環境にだけ存在します。先に --name ${dependency.draftName} で運用環境へ反映してください。`);
        }
        throw new Error(`依存先 ${dependency.draftName} (app-${dependency.created!.appId}) の運用環境での存在を確認できません: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      await client.getAppResource("/app/form/fields.json", dependency.created!.appId, { guestSpaceId: dependency.meta.guestSpaceId || "", preview: true });
    }
  }

  for (const draft of ordered) {
    const guestSpaceId = draft.meta.guestSpaceId || "";
    let appId: string;
    let resumed = false;
    if (draft.created) {
      appId = draft.created.appId;
      resumed = true;
      log(`${draft.draftName}: 作成済み app-${appId} の反映を再開します。`);
    } else {
      // space 指定かつ thread 未指定なら、スペースの defaultThread を補完する。
      let thread = draft.meta.thread || "";
      if (draft.meta.space && !thread) {
        const space = await client.getSpace(draft.meta.space, { guestSpaceId });
        thread = space?.defaultThread != null ? String(space.defaultThread) : "";
      }
      const created = await client.createPreviewApp(
        { name: draft.meta.name, space: draft.meta.space, thread },
        { guestSpaceId }
      );
      appId = String(created.app);
      // 二重作成防止マーカーは作成直後に書く（以降の失敗時は再実行で「反映から再開」になる）。
      writeJson(path.join(draft.dir, DRAFT_CREATED_FILE), {
        appId,
        createdAt: new Date().toISOString(),
        domain
      }, { allowWhenLogUnavailable: true });
      log(`${draft.draftName}: 新規作成 app-${appId}（動作テスト環境）`);
    }
    createdByName.set(draft.draftName, appId);
    createdByName.set(draft.meta.name, appId);

    const draftPlan = await buildCreatePlan({
      client,
      appId,
      guestSpaceId,
      sourceDir: draft.dir,
      resolver
    });
    logPlan(draftPlan);
    await executePushRequests({ client, appId, guestSpaceId, requests: draftPlan.requests, yes });

    results.push({
      draftName: draft.draftName,
      name: draft.meta.name,
      appId,
      resumed,
      pushed: draftPlan.requests.map(({ key, method, endpoint }) => ({ key, method, endpoint })),
      skipped: draftPlan.skipped,
      fieldsAdded: draftPlan.fieldsAdded,
      fieldsMissingOnLocal: draftPlan.fieldsMissingOnLocal
    });
  }

  if (!deploy) {
    log("動作テスト環境への作成・反映まで完了しました（運用環境には未公開）。");
    return { created: results, skippedDrafts, deployed: false };
  }

  // deploy はゲストスペース単位でしかまとめられないため、guestSpaceId ごとにグループ化する。
  const groups = new Map<string, string[]>();
  for (const result of results) {
    const draft = ordered.find((d) => d.draftName === result.draftName)!;
    const key = draft.meta.guestSpaceId || "";
    groups.set(key, [...(groups.get(key) || []), result.appId]);
  }
  for (const [guestSpaceId, appIds] of groups) {
    await deployAndWait({ client, appIds, guestSpaceId });
  }
  log("運用環境への反映が完了しました。");

  // 検証 pull + 索引登録（新 appId を data/ と索引に載せる）。
  for (const result of results) {
    const draft = ordered.find((d) => d.draftName === result.draftName)!;
    const guestSpaceId = draft.meta.guestSpaceId || "";
    const pulled = await pullApp({ appId: result.appId, guestSpaceId });
    await refreshAppIndexForPulledApp({ appId: result.appId, guestSpaceId, incomplete: Boolean(pulled.resourceFailures?.length) });
  }
  log("検証 pull 完了。data/ に新規アプリが登録されました。");

  return { created: results, skippedDrafts, deployed: true };
}
