import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";

interface LogMessage {
  type: "kintOriginLogEvent";
  id: string;
  event: Record<string, unknown>;
}

interface LogAck {
  type: "kintOriginLogAck";
  id: string;
  ok: boolean;
}

const childProcess = process as NodeJS.Process & {
  send?: (message: LogMessage, callback?: (error: Error | null) => void) => boolean;
};
const pending = new Map<string, (ok: boolean) => void>();
const requestCounts = new WeakMap<object, number>();
let requestSequence = 0;
let unavailable = false;
let requestQueue = Promise.resolve();

childProcess.on("message", (message: LogAck) => {
  if (!message || message.type !== "kintOriginLogAck") return;
  const resolve = pending.get(message.id);
  if (!resolve) return;
  pending.delete(message.id);
  if (!message.ok) unavailable = true;
  resolve(message.ok);
});
// Parent ACK を受け取れるよう listener は残しつつ、IPC だけで子プロセスが終了しなくなるのを防ぐ。
childProcess.channel?.unref();

function sendEvent(event: Record<string, unknown>, waitForAck: boolean): Promise<boolean> {
  if (typeof childProcess.send !== "function" || !childProcess.connected) {
    unavailable = true;
    return Promise.resolve(false);
  }
  const id = randomUUID();
  const message: LogMessage = { type: "kintOriginLogEvent", id, event };
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(id);
      if (pending.size === 0) childProcess.channel?.unref();
      if (!ok) unavailable = true;
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), 10_000);
    timer.unref();
    if (waitForAck) {
      childProcess.channel?.ref();
      pending.set(id, settle);
    }
    try {
      childProcess.send!(message, (error) => {
        if (error) settle(false);
        else if (!waitForAck) settle(true);
      });
    } catch {
      settle(false);
    }
  });
}

function requestDetails(config: Record<string, any>): { method: string; host: string; path: string } {
  const rawUrl = typeof config.url === "string" ? config.url : "";
  const base = typeof config.baseURL === "string" ? config.baseURL : process.env.KINTONE_BASE_URL || "";
  let url: URL;
  try {
    url = new URL(rawUrl, base);
  } catch {
    return { method: String(config.method || "GET").toUpperCase(), host: "", path: "[invalid-url]" };
  }
  return { method: String(config.method || "GET").toUpperCase(), host: url.host, path: url.pathname };
}

function binaryBuffer(data: unknown): Buffer | undefined {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

function responseBody(data: unknown, contentType: string): string | undefined {
  if (typeof data === "string") return data;
  if (!/json|text\//i.test(contentType)) return undefined;
  const bytes = binaryBuffer(data);
  if (bytes) return bytes.toString("utf8");
  if (data == null) return "";
  try {
    return JSON.stringify(data);
  } catch {
    return "[response body could not be serialized]";
  }
}

function requestInterceptor(config: Record<string, any>): Promise<Record<string, any>> {
  const queued = requestQueue.then(async () => {
    const details = requestDetails(config);
    if (unavailable) throw new Error("RunLogUnavailableError: API リクエストをログ保存障害のため中断しました。");
    requestSequence += 1;
    const attempt = (requestCounts.get(config) ?? 0) + 1;
    requestCounts.set(config, attempt);
    const requestId = String(config._kintOriginLogRequestId ?? `cli-${requestSequence}`);
    config._kintOriginLogRequestId = requestId;
    const allowed = await sendEvent({ type: "http_request", requestId, attempt, source: "cli-kintone", ...details }, true);
    if (!allowed) throw new Error("RunLogUnavailableError: API リクエストをログ保存障害のため中断しました。");
    return config;
  });
  requestQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

async function logBinaryBytes(config: Record<string, any>, requestId: string, bytes: Uint8Array): Promise<void> {
  const details = requestDetails(config);
  const buffer = Buffer.from(bytes);
  const chunkSize = 36 * 1024;
  let chunkIndex = 0;
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunkIndex += 1;
    const ok = await sendEvent({
      type: "http_body_chunk",
      source: "cli-kintone",
      requestId,
      ...details,
      encoding: "base64",
      chunkIndex,
      data: buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length)).toString("base64")
    }, true);
    if (!ok) throw new Error("RunLogUnavailableError: API 応答ログを保存できないため応答データを中断しました。");
  }
}

function loggedBinaryStream(config: Record<string, any>, requestId: string, source: any): any {
  const details = requestDetails(config);
  let bytes = 0;
  let chunkIndex = 0;
  const output = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      void (async () => {
        const chunkSize = 36 * 1024;
        for (let offset = 0; offset < buffer.length; offset += chunkSize) {
          chunkIndex += 1;
          const ok = await sendEvent({
            type: "http_body_chunk",
            source: "cli-kintone",
            requestId,
            ...details,
            encoding: "base64",
            chunkIndex,
            data: buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length)).toString("base64")
          }, true);
          if (!ok) throw new Error("RunLogUnavailableError: API 応答ログを保存できないため応答ストリームを中断しました。");
        }
      })().then(() => callback(null, buffer), (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
    },
    flush(callback) {
      void sendEvent({ type: "http_body_complete", source: "cli-kintone", requestId, ...details, bodyEncoding: "base64-chunks", bytes }, true)
        .then((ok) => ok ? callback() : callback(new Error("RunLogUnavailableError: API 応答ログを保存できませんでした.")));
    }
  });
  source.on("error", (error: Error) => output.destroy(error));
  source.pipe(output);
  return output;
}

async function logResponse(config: Record<string, any>, status: number, data: unknown, headers: Record<string, unknown>, statusText = ""): Promise<unknown> {
  const details = requestDetails(config);
  const requestId = String(config._kintOriginLogRequestId ?? "cli-unknown");
  const contentType = String(headers["content-type"] ?? headers["Content-Type"] ?? "");
  const isReadableStream = Boolean(data && typeof (data as { pipe?: unknown }).pipe === "function" && typeof (data as { on?: unknown }).on === "function");
  const body = isReadableStream ? undefined : responseBody(data, contentType);
  const responseOk = await sendEvent({
    type: "http_response",
    source: "cli-kintone",
    requestId,
    status,
    statusText,
    contentType,
    contentLength: headers["content-length"] ?? headers["Content-Length"] ?? "",
    headers,
    ...details
  }, true);
  if (!responseOk) throw new Error("RunLogUnavailableError: API 応答ログを保存できませんでした。");
  if (details.path.endsWith("/app/plugin/config.json")) {
    let count: number | undefined;
    try {
      const payload = body === undefined ? undefined : JSON.parse(body);
      count = Array.isArray(payload?.config) ? payload.config.length : undefined;
    } catch {
      count = undefined;
    }
    const ok = await sendEvent({ type: "http_body", source: "cli-kintone", requestId, bodyOmitted: "plugin-config-values", count }, true);
    if (!ok) throw new Error("RunLogUnavailableError: API 応答ログを保存できませんでした。");
  } else if (body !== undefined) {
    const ok = await sendEvent({ type: "http_body", source: "cli-kintone", requestId, text: body }, true);
    if (!ok) throw new Error("RunLogUnavailableError: API 応答ログを保存できませんでした。");
  } else if (binaryBuffer(data)) {
    const bytes = binaryBuffer(data)!;
    await logBinaryBytes(config, requestId, bytes);
    const ok = await sendEvent({ type: "http_body_complete", source: "cli-kintone", requestId, ...details, bodyEncoding: "base64-chunks", bytes: bytes.length }, true);
    if (!ok) throw new Error("RunLogUnavailableError: API 応答ログを保存できませんでした。");
  } else if (isReadableStream) {
    return loggedBinaryStream(config, requestId, data);
  } else if (data && typeof data === "object") {
    let text: string;
    try { text = JSON.stringify(data); } catch { text = "[response body could not be serialized]"; }
    const ok = await sendEvent({ type: "http_body", source: "cli-kintone", requestId, text }, true);
    if (!ok) throw new Error("RunLogUnavailableError: API 応答ログを保存できませんでした。");
  } else if (data !== undefined) {
    const ok = await sendEvent({ type: "http_body", source: "cli-kintone", requestId, text: data === null ? "" : String(data) }, true);
    if (!ok) throw new Error("RunLogUnavailableError: API 応答ログを保存できませんでした.");
  }
  return data;
}

async function main(): Promise<void> {
  const cliPath = path.resolve(process.argv[1] ?? "");
  const requireCli = createRequire(cliPath);
  const sdkPath = requireCli.resolve("@kintone/rest-api-client");
  const requireSdk = createRequire(sdkPath);
  const axiosImport = requireSdk("axios") as { default?: any; interceptors?: any };
  const axios = axiosImport.default ?? axiosImport;
  if (!axios?.interceptors?.request?.use || !axios?.interceptors?.response?.use) {
    throw new Error("cli-kintone のHTTPクライアントにログ用インターセプターを登録できません。");
  }
  axios.interceptors.request.use(requestInterceptor);
  axios.interceptors.response.use(
    async (response: Record<string, any>) => {
      response.data = await logResponse(response.config, Number(response.status), response.data, response.headers ?? {}, String(response.statusText ?? ""));
      return response;
    },
    async (error: Record<string, any>) => {
      const response = error?.response;
      if (response) response.data = await logResponse(response.config ?? {}, Number(response.status), response.data, response.headers ?? {}, String(response.statusText ?? ""));
      else {
        const config = error?.config ?? {};
        const details = requestDetails(config);
        await sendEvent({ type: "http_error", source: "cli-kintone", requestId: config._kintOriginLogRequestId ?? "cli-unknown", ...details, text: String(error?.message ?? error) }, true);
      }
      throw error;
    }
  );
}

await main().catch((error: unknown) => {
  process.stderr.write(`kint-origin log preload failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
