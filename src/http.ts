import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { CybozuEnv } from "./env.js";
import { log } from "./log.js";
import { assertRequestAllowed, type Permission } from "./policy.js";
import { assertRunLogWritable, recordLocalAction, recordRunEvent } from "./runLog.js";

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function joinUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

type QueryValue = string | number | boolean | Array<string | number> | null | undefined;
export type Query = Record<string, QueryValue>;

export interface CybozuError extends Error {
  status?: number;
  code?: string;
  pathname?: string;
  /** エラー応答の本文（bulkRequest の results など、呼び出し側が詳細を読むため）。 */
  payload?: unknown;
  /**
   * 書き込みが、サーバー側で反映されたかどうか分からない失敗（応答が返らなかった・サーバー内部の失敗）。
   * true のとき、呼び出し側は「何も変更していません」と案内してはいけない。
   */
  uncertain?: boolean;
}

// 応答を受け取れなかった（タイムアウト・接続断）失敗。応答が無いため、リクエストがサーバーで処理されたかどうかは分からない。
function uncertainError(message: string, cause?: unknown): CybozuError {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as CybozuError;
  error.uncertain = true;
  return error;
}

function appendQuery(url: URL, query: Query): void {
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      value.forEach((item, index) => url.searchParams.append(`${key}[${index}]`, String(item)));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

// kintone の検証エラー（{ "properties[活動履歴].label": { messages: ["必須です。"] } } の形）を、項目ごとの行にする（最大 10 項目）。
function describeValidationErrors(errors: unknown): string {
  if (!errors || typeof errors !== "object") return "";
  const lines: string[] = [];
  for (const [path, value] of Object.entries(errors as Record<string, any>)) {
    const messages = Array.isArray(value?.messages) ? value.messages.map(String).join(" / ") : "";
    lines.push(`  - ${path}${messages ? `: ${messages}` : ""}`);
  }
  if (lines.length === 0) return "";
  const shown = lines.slice(0, 10);
  if (lines.length > shown.length) shown.push(`  …ほか ${lines.length - shown.length} 項目`);
  return `入力の問題:\n${shown.join("\n")}`;
}

function buildError(args: { method: string; url: URL; response: Response; payload: any }): CybozuError {
  const { method, url, response, payload } = args;
  const code = payload?.code ? ` (${payload.code})` : "";
  const message = payload?.message || response.statusText || "Request failed";
  let text = `${method} ${url.pathname} failed${code}: ${message}`;
  // 入力の検証エラー（CB_VA01 など）は、どの項目が問題かを errors に返す。メッセージに含めないと、原因が分からない。
  const detail = describeValidationErrors(payload?.errors);
  if (detail) text += `\n${detail}`;
  if (response.status === 401) {
    text +=
      "\n.env の認証情報（CYBOZU_USERNAME / CYBOZU_PASSWORD）を確認してください。" +
      "パスワード変更・Basic 認証・2要素認証の設定も失敗原因になります。";
  }
  const error = new Error(text) as CybozuError;
  error.status = response.status;
  error.code = payload?.code || "";
  error.pathname = url.pathname;
  error.payload = payload;
  // 5xx は、応答だけでは、サーバーで処理されたかどうかを判断できない（kintone の公式ドキュメントに、この場合の記載はない）。
  if (response.status >= 500) error.uncertain = true;
  return error;
}

// ---- リトライ・タイムアウトポリシー --------------------------------------

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3; // 初回＋最大3回リトライ＝計4試行
const DEFAULT_BASE_DELAY_MS = 1_000;
const RETRY_AFTER_CAP_MS = 60_000;
const BACKOFF_CAP_MS = 30_000;

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

// ENOTFOUND / ECONNREFUSED は設定ミス（ドメイン誤り・オフライン）の可能性が高いため即時失敗させる。
const RETRYABLE_NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"]);
const responseRequestIds = new WeakMap<Response, string>();

function recordBinaryResponse(requestId: string, pathname: string, value: Uint8Array): void {
  const bytes = Buffer.from(value);
  const chunkSize = 36 * 1024;
  let chunkIndex = 0;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunkIndex += 1;
    recordRunEvent("http_body_chunk", {
      source: "kint-origin",
      requestId,
      path: pathname,
      encoding: "base64",
      chunkIndex,
      data: bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)).toString("base64")
    });
    assertRunLogWritable();
  }
}

function isRetryableNetworkError(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  return Boolean(cause?.code && RETRYABLE_NETWORK_CODES.has(cause.code));
}

// 再試行までの待機時間。Retry-After ヘッダ（秒数 / HTTP-date）を優先し、
// 無ければ指数バックオフ＋ジッタ（0〜25%）。
export function computeRetryDelayMs(attempt: number, retryAfter: string | null, baseDelayMs: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
    }
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) {
      return Math.min(Math.max(dateMs - Date.now(), 0), RETRY_AFTER_CAP_MS);
    }
  }
  const backoff = baseDelayMs * 2 ** attempt;
  const jitter = backoff * 0.25 * Math.random();
  return Math.min(backoff + jitter, BACKOFF_CAP_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// API 実行ごとの最小間隔（CYBOZU_API_INTERVAL_MS）用のスロット計算。
// 並列実行でも「直前のリクエスト開始から intervalMs 空ける」を全ストリーム共有で保証するため、
// 開始予定時刻(startAt)を予約し、次スロット(nextSlotAt)を intervalMs 先へ進める（純関数・テスト用に export）。
export function computeRequestSlot(
  now: number,
  nextSlotAt: number,
  intervalMs: number
): { startAt: number; nextSlotAt: number } {
  const startAt = Math.max(now, nextSlotAt);
  return { startAt, nextSlotAt: startAt + intervalMs };
}

let nextRequestSlotAt = 0;

async function waitForRequestSlot(intervalMs: number): Promise<void> {
  if (!(intervalMs > 0)) return;
  const now = Date.now();
  const slot = computeRequestSlot(now, nextRequestSlotAt, intervalMs);
  nextRequestSlotAt = slot.nextSlotAt;
  if (slot.startAt > now) await sleep(slot.startAt - now);
}

function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name;
  const causeName = (error as { cause?: { name?: string } } | undefined)?.cause?.name;
  return name === "TimeoutError" || name === "AbortError" || causeName === "TimeoutError";
}

export interface FetchPolicy {
  retries?: number;
  baseDelayMs?: number;
  /** テスト注入用。既定は globalThis.fetch。 */
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  /** 共有パスを機能別に許可する場合、通常のパス分類より先に確認する許可キー。 */
  requiredPermission?: Permission;
  /** 1試行あたりのタイムアウト（既定 60s。CSV エクスポートや添付 DL は呼び出し側で延長する）。 */
  timeoutMs?: number;
}

export async function fetchCybozuResponse(
  env: CybozuEnv,
  urlString: string,
  { method = "GET", query, body, timeoutMs = DEFAULT_TIMEOUT_MS, requiredPermission }: RequestOptions = {},
  policy: FetchPolicy = {}
): Promise<Response> {
  const url = new URL(urlString);
  if (query) appendQuery(url, query);
  // 操作制限: この実行で許可されていない書き込み・User API・レコード API は送信前に遮断する（src/policy.ts）。
  assertRequestAllowed(method, url.pathname, requiredPermission);

  const headers: Record<string, string> = {
    "X-Cybozu-Authorization": base64(`${env.username}:${env.password}`)
  };
  // FormData（ファイルのアップロード）は Content-Type（boundary 付き）を fetch に任せる。
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  if (body != null && !isForm) headers["Content-Type"] = "application/json";

  const fetchImpl = policy.fetchImpl ?? fetch;
  // 多重実行の副作用を避けるため、リトライは GET のみ（書き込み系は即時失敗させる）。
  const maxRetries = method === "GET" ? (policy.retries ?? MAX_RETRIES) : 0;
  const baseDelayMs = policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const requestId = randomUUID();

  for (let attempt = 0; ; attempt++) {
    // 負荷対策: API 実行（リトライの再試行を含む各 HTTP 試行）ごとに最小間隔を空ける。
    await waitForRequestSlot(env.apiIntervalMs ?? 0);
    let response: Response;
    const startedAt = performance.now();
    assertRunLogWritable();
    recordRunEvent("http_request", {
      requestId,
      attempt: attempt + 1,
      source: "kint-origin",
      method,
      host: url.host,
      path: url.pathname
    });
    assertRunLogWritable();
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body == null ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
        // リダイレクトには従わない。X-Cybozu-Authorization（ユーザー名・パスワード）を別のホストへ送らないため。
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      recordRunEvent("http_error", {
        requestId,
        attempt: attempt + 1,
        source: "kint-origin",
        method,
        path: url.pathname,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        text: error instanceof Error ? error.message : String(error)
      });
      assertRunLogWritable();
      if (isTimeoutError(error)) {
        // タイムアウトは再試行しない（60s×複数回のハングを避け、原因確認を促す）。
        throw uncertainError(
          `${method} ${url.pathname} がタイムアウト（${Math.round(timeoutMs / 1000)}s）しました。` +
            "ネットワークと CYBOZU_BASE_URL を確認してください。",
          error
        );
      }
      if (attempt < maxRetries && isRetryableNetworkError(error)) {
        const delay = computeRetryDelayMs(attempt, null, baseDelayMs);
        log(
          `ネットワークエラーのため ${Math.round(delay / 1000)}秒後に再試行します (attempt ${attempt + 2}/${maxRetries + 1}): ${url.pathname}`
        );
        recordRunEvent("http_retry", { requestId, attempt: attempt + 1, delayMs: delay, reason: "network" });
        assertRunLogWritable();
        await sleep(delay);
        continue;
      }
      // 応答を受け取れなかった（接続断など）。書き込み（GET 以外）は、サーバーで処理されたかどうかが分からない。
      if (method !== "GET" && error instanceof Error) (error as CybozuError).uncertain = true;
      throw error;
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });
    recordRunEvent("http_response", {
      requestId,
      attempt: attempt + 1,
      source: "kint-origin",
      method,
      path: url.pathname,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type") ?? "",
      contentLength: response.headers.get("content-length") ?? "",
      headers: responseHeaders,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt))
    });
    assertRunLogWritable();

    if (response.ok) {
      responseRequestIds.set(response, requestId);
      return response;
    }

    if (isRedirectResponse(response)) {
      const redirectText = await response.clone().text().catch((error: unknown) => `[response body read failed: ${error instanceof Error ? error.message : String(error)}]`);
      recordRunEvent("http_body", { requestId, attempt: attempt + 1, path: url.pathname, text: redirectText });
      assertRunLogWritable();
      throw new Error(
        `${method} ${url.pathname} がリダイレクト（HTTP ${response.status}）を返しました。認証情報を別の場所へ送らないよう、従わずに中断しました。` +
          "CYBOZU_BASE_URL（https://<サブドメイン>.cybozu.com など）が正しいか確認してください。"
      );
    }

    if (attempt < maxRetries && isRetryableStatus(response.status)) {
      const retryText = await response.clone().text().catch((error: unknown) => `[response body read failed: ${error instanceof Error ? error.message : String(error)}]`);
      recordRunEvent("http_body", { requestId, attempt: attempt + 1, path: url.pathname, text: retryText });
      assertRunLogWritable();
      const delay = computeRetryDelayMs(attempt, response.headers.get("retry-after"), baseDelayMs);
      log(
        `HTTP ${response.status} のため ${Math.round(delay / 1000)}秒後に再試行します (attempt ${attempt + 2}/${maxRetries + 1}): ${url.pathname}`
      );
      recordRunEvent("http_retry", { requestId, attempt: attempt + 1, delayMs: delay, reason: `HTTP ${response.status}` });
      assertRunLogWritable();
      await sleep(delay);
      continue;
    }

    const text = await response.text();
    recordRunEvent("http_body", { requestId, attempt: attempt + 1, path: url.pathname, text });
    assertRunLogWritable();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    throw buildError({ method, url, response, payload });
  }
}

// fetch の redirect: "manual" は、Node（undici）では 3xx の Response をそのまま返す。
function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

export async function requestCybozuJson(
  env: CybozuEnv,
  urlString: string,
  options: RequestOptions = {}
): Promise<any> {
  const response = await fetchCybozuResponse(env, urlString, options);
  const text = await response.text();
  const url = new URL(urlString);
  const requestId = responseRequestIds.get(response) ?? "";
  if (url.pathname.endsWith("/app/plugin/config.json")) {
    let count: number | undefined;
    try {
      const payload = text ? JSON.parse(text) : null;
      count = Array.isArray(payload?.config) ? payload.config.length : undefined;
    } catch {
      count = undefined;
    }
    recordRunEvent("http_body", { source: "kint-origin", requestId, path: url.pathname, bodyOmitted: "plugin-config-values", count });
  } else {
    recordRunEvent("http_body", { source: "kint-origin", requestId, path: url.pathname, text });
  }
  assertRunLogWritable();
  return text ? JSON.parse(text) : null;
}

export async function requestCybozuText(
  env: CybozuEnv,
  urlString: string,
  options: RequestOptions = {}
): Promise<string> {
  const response = await fetchCybozuResponse(env, urlString, options);
  const text = await response.text();
  recordRunEvent("http_body", { source: "kint-origin", requestId: responseRequestIds.get(response) ?? "", path: new URL(urlString).pathname, text });
  assertRunLogWritable();
  return text;
}

// レスポンスボディをメモリへ載せずファイルへストリーミング保存する（巨大添付の OOM 回避）。
// 転送中に失敗した場合は書きかけファイルを削除してから throw する（壊れた添付を残さない）。
export async function requestCybozuToFile(
  env: CybozuEnv,
  urlString: string,
  destPath: string,
  options: RequestOptions = {}
): Promise<void> {
  const response = await fetchCybozuResponse(env, urlString, options);
  const requestId = responseRequestIds.get(response) ?? "";
  const parent = path.dirname(destPath);
  fs.mkdirSync(parent, { recursive: true });
  const partPath = path.join(parent, `.${path.basename(destPath)}.${process.pid}.${randomUUID()}.part`);
  const install = (): void => {
    const existing = fs.lstatSync(destPath, { throwIfNoEntry: false });
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error(`添付保存先が通常ファイルではありません: ${destPath}`);
    const backupPath = existing ? `${destPath}.${process.pid}.${randomUUID()}.previous` : "";
    let existingMoved = false;
    let newFileInstalled = false;
    try {
      if (backupPath) {
        fs.renameSync(destPath, backupPath);
        existingMoved = true;
      }
      fs.renameSync(partPath, destPath);
      newFileInstalled = true;
    } catch (error) {
      try {
        if (newFileInstalled) fs.rmSync(destPath, { force: true });
        if (existingMoved && backupPath && fs.existsSync(backupPath)) fs.renameSync(backupPath, destPath);
      } catch {
        // Keep the backup file for manual recovery if the filesystem also rejects rollback.
      }
      throw error;
    }
    if (backupPath) {
      try {
        fs.rmSync(backupPath, { force: true });
      } catch {
        // The new file is already installed; a leftover backup is safer than undoing a successful replacement.
      }
    }
  };
  if (!response.body) {
    recordRunEvent("http_body", { source: "kint-origin", requestId, path: new URL(urlString).pathname, bodyEncoding: "base64-chunks", bytes: 0 });
    assertRunLogWritable();
    recordLocalAction("write-api-file", destPath, { requestId, bytes: 0 });
    try {
      fs.writeFileSync(partPath, Buffer.alloc(0), { flag: "wx" });
      install();
    } catch (error) {
      fs.rmSync(partPath, { force: true });
      throw error;
    }
    return;
  }
  let bytes = 0;
  const pathname = new URL(urlString).pathname;
  recordLocalAction("write-api-file", destPath, { requestId });
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk: Uint8Array, controller) {
      bytes += chunk.byteLength;
      recordBinaryResponse(requestId, pathname, chunk);
      controller.enqueue(chunk);
    }
  }));
  try {
    await pipeline(Readable.fromWeb(body as any), fs.createWriteStream(partPath, { flags: "wx" }));
    install();
    recordRunEvent("http_body", { source: "kint-origin", requestId, path: pathname, bodyEncoding: "base64-chunks", bytes });
  } catch (error) {
    recordRunEvent("http_error", { source: "kint-origin", path: new URL(urlString).pathname, bytes, text: error instanceof Error ? error.message : String(error) });
    fs.rmSync(partPath, { force: true });
    throw error;
  }
}
