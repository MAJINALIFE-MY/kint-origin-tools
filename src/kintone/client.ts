import fs from "node:fs";
import { getEnv, type CybozuEnv } from "../env.js";
import { joinUrl, requestCybozuJson, requestCybozuToFile, type CybozuError, type Query } from "../http.js";

export interface KintoneApp {
  appId?: string;
  code?: string;
  name?: string;
  spaceId?: string | null;
  guestSpaceId?: string | null;
  [key: string]: unknown;
}

export interface KintoneSpace {
  id?: string;
  name?: string;
  body?: string;
  isPrivate?: boolean;
  isGuest?: boolean;
  fixedMember?: boolean;
  useMultiThread?: boolean;
  showAnnouncement?: boolean;
  showThreadList?: boolean;
  showAppList?: boolean;
  showMemberList?: boolean;
  showRelatedLinkList?: boolean;
  permissions?: { createApp?: string } | null;
  defaultThread?: string;
  attachedApps?: unknown;
  [key: string]: unknown;
}

// GAIA_IL25: ゲストスペースを通常 URL（/k/v1/）で操作した。/k/guest/{id}/v1/ で取り直す必要がある。
export function isGuestSpaceRequiredError(error: unknown): boolean {
  return (error as CybozuError | undefined)?.code === "GAIA_IL25";
}

// 権限不足（403 / CB_NO02）。削除判定では「保持」、pull では管理系の拒否として扱う。
export function isPermissionError(error: unknown): boolean {
  const e = error as CybozuError | undefined;
  return e?.status === 403 || e?.code === "CB_NO02";
}

// bulkRequest（最大 20 リクエスト・各 100 件）の待ち時間の上限。
const BULK_REQUEST_TIMEOUT_MS = 300_000;

function guestPrefix(guestSpaceId: string): string {
  return guestSpaceId ? `/k/guest/${guestSpaceId}` : "/k";
}

// bulkRequest の requests[].api に書く、レコード API のパス（ゲストスペースは /k/guest/<id>/ を含む）。
export function recordsApiPath(guestSpaceId: string, endpoint: "records.json" | "record.json" = "records.json"): string {
  return `${guestPrefix(guestSpaceId)}/v1/${endpoint}`;
}

export interface BulkRequestItem {
  method: "PUT" | "POST" | "DELETE";
  api: string;
  payload: unknown;
}

// bulkRequest の失敗応答（results のうち message を持つ要素が失敗した 1 件）を、どの操作で失敗したか分かる文に直す。
function describeBulkError(error: CybozuError, requests: BulkRequestItem[]): Error {
  const payload = error.payload as { results?: Array<Record<string, any>> } | null | undefined;
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const index = results.findIndex((item) => item && typeof item.message === "string");
  if (index < 0) return error;
  const failed = results[index];
  const request = requests[index];
  const appId = (request?.payload as { app?: unknown } | undefined)?.app;
  const lines = [
    `一括処理の ${index + 1} 件目（${request?.method ?? ""} ${request?.api ?? ""}${appId != null ? ` app ${appId}` : ""}）で失敗しました: ${failed.message}${failed.code ? ` (${failed.code})` : ""}`
  ];
  const fieldErrors = failed.errors && typeof failed.errors === "object" ? Object.entries(failed.errors as Record<string, any>) : [];
  for (const [key, value] of fieldErrors.slice(0, 3)) {
    const messages = Array.isArray(value?.messages) ? value.messages : [];
    lines.push(`  ${key}: ${messages[0] ?? ""}`);
  }
  if (failed.code === "GAIA_CO02") {
    lines.push("確認のあとに他の人がレコードを更新しました。diff records からやり直してください。");
  }
  const described = new Error(lines.join("\n")) as CybozuError;
  described.status = error.status;
  described.code = failed.code ?? error.code;
  described.pathname = error.pathname;
  described.payload = error.payload;
  return described;
}

export class KintoneClient {
  env: CybozuEnv;

  constructor(env: CybozuEnv = getEnv()) {
    this.env = env;
  }

  buildUrl(pathname: string, { guestSpaceId = "", preview = false }: { guestSpaceId?: string; preview?: boolean } = {}): string {
    const version = preview ? "v1/preview" : "v1";
    return joinUrl(this.env.baseUrl, `${guestPrefix(guestSpaceId)}/${version}${pathname}`);
  }

  async request(
    pathname: string,
    {
      method = "GET",
      query,
      body,
      guestSpaceId = "",
      preview = false,
      timeoutMs
    }: { method?: string; query?: Query; body?: unknown; guestSpaceId?: string; preview?: boolean; timeoutMs?: number } = {}
  ): Promise<any> {
    return requestCybozuJson(this.env, this.buildUrl(pathname, { guestSpaceId, preview }), { method, query, body, timeoutMs });
  }

  async getAppInfo(appId: string | number, { guestSpaceId = "" }: { guestSpaceId?: string } = {}): Promise<KintoneApp> {
    return this.request("/app.json", { method: "GET", guestSpaceId, query: { id: appId } });
  }

  async getSpace(spaceId: string | number, { guestSpaceId = "" }: { guestSpaceId?: string } = {}): Promise<KintoneSpace> {
    return this.request("/space.json", { method: "GET", guestSpaceId, query: { id: spaceId } });
  }

  // limit/offset 形式のページング GET を共通化。
  async paginate<T = any>(
    pathname: string,
    {
      resultKey,
      query = {},
      guestSpaceId = "",
      limit = 100
    }: {
      resultKey: string;
      query?: Query;
      guestSpaceId?: string;
      limit?: number;
    }
  ): Promise<T[]> {
    const items: T[] = [];
    let offset = 0;
    while (true) {
      const payload = await this.request(pathname, { method: "GET", guestSpaceId, query: { ...query, limit, offset } });
      if (!payload || !Array.isArray(payload[resultKey])) {
        throw new Error(`${pathname}: API 応答に ${resultKey} 配列がありません。ページングを安全に続けられません。`);
      }
      const batch = payload[resultKey] as T[];
      if (batch.length > limit) throw new Error(`${pathname}: API 応答が limit=${limit} を超えました。`);
      if (resultKey === "apps") {
        const seen = new Set<string>(items.map((item: any) => String(item?.appId ?? item?.id ?? "")));
        for (const raw of batch) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${pathname}: app項目の形式が不正です。`);
          const app = raw as KintoneApp;
          const appId = String(app.appId ?? "");
          if (!/^[1-9]\d*$/.test(appId)) throw new Error(`${pathname}: アプリIDが不正です。`);
          if (seen.has(appId)) throw new Error(`${pathname}: アプリID ${appId} が重複しています。`);
          seen.add(appId);
          for (const key of ["spaceId", "guestSpaceId"] as const) {
            const value = app[key];
            if (value != null && value !== "" && !/^[1-9]\d*$/.test(String(value))) throw new Error(`${pathname}: アプリ ${appId} の ${key} が不正です。`);
          }
        }
      }
      items.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }
    return items;
  }

  async listApps({
    guestSpaceId = "",
    spaceId = "",
    ids,
    limit = 100
  }: { guestSpaceId?: string; spaceId?: string; ids?: readonly string[]; limit?: number } = {}): Promise<KintoneApp[]> {
    const query: Query = {};
    if (!guestSpaceId && spaceId) query.spaceIds = [spaceId];
    if (ids && ids.length > 0) query.ids = [...ids];
    return this.paginate<KintoneApp>("/apps.json", { resultKey: "apps", query, guestSpaceId, limit });
  }

  async listAllApps({ limit = 100 }: { limit?: number } = {}): Promise<KintoneApp[]> {
    return this.listApps({ limit });
  }

  async listRequiredPlugins({ limit = 100 }: { limit?: number } = {}): Promise<{ plugins: any[]; apiCalls: number }> {
    const plugins: any[] = [];
    const ids = new Set<string>();
    for (let offset = 0; ; offset += limit) {
      const payload = await this.request("/plugins/required.json", { query: { limit, offset } });
      if (!Array.isArray(payload?.plugins) || payload.plugins.length > limit) {
        throw new Error("インストールが必要なプラグイン一覧 API の応答に有効な plugins 配列がありません。");
      }
      for (const plugin of payload.plugins) {
        if (!plugin || typeof plugin !== "object" || typeof plugin.id !== "string" || !plugin.id || ids.has(plugin.id)) {
          throw new Error("インストールが必要なプラグイン一覧 API の応答に不正または重複したプラグインがあります。");
        }
        ids.add(plugin.id);
        plugins.push({ ...plugin });
      }
      if (payload.plugins.length < limit) return { plugins, apiCalls: offset / limit + 1 };
    }
  }

  async getRecordComments(
    appId: string | number,
    recordId: string | number,
    { offset = 0, limit = 10, guestSpaceId = "" }: { offset?: number; limit?: number; guestSpaceId?: string } = {}
  ): Promise<any> {
    return this.request("/record/comments.json", { guestSpaceId, query: { app: appId, record: recordId, order: "asc", offset, limit } });
  }

  async getAppResource(
    endpoint: string,
    appId: string | number,
    { guestSpaceId = "", preview = false }: { guestSpaceId?: string; preview?: boolean } = {}
  ): Promise<any> {
    return this.request(endpoint, {
      method: "GET",
      guestSpaceId,
      preview,
      query: { app: appId, lang: this.env.language }
    });
  }

  async getPluginConfig(
    appId: string | number,
    pluginId: string,
    { guestSpaceId = "" }: { guestSpaceId?: string } = {}
  ): Promise<any> {
    return this.request("/app/plugin/config.json", {
      method: "GET",
      guestSpaceId,
      query: { app: appId, id: pluginId }
    });
  }

  // ---- push（反映）系: すべて動作テスト環境（preview）に対する操作。運用環境反映は deployApps で行う ----

  async putPreviewAppResource(
    endpoint: string,
    body: unknown,
    { guestSpaceId = "" }: { guestSpaceId?: string } = {}
  ): Promise<any> {
    return this.request(endpoint, { method: "PUT", body, guestSpaceId, preview: true });
  }

  // fields の追加（add）は PUT ではなく POST。
  async postPreviewAppResource(
    endpoint: string,
    body: unknown,
    { guestSpaceId = "" }: { guestSpaceId?: string } = {}
  ): Promise<any> {
    return this.request(endpoint, { method: "POST", body, guestSpaceId, preview: true });
  }

  // 新規アプリを動作テスト環境に作成する。deploy するまで運用環境には現れない。
  async createPreviewApp(
    { name, space, thread }: { name: string; space?: string; thread?: string },
    { guestSpaceId = "" }: { guestSpaceId?: string } = {}
  ): Promise<{ app: string; revision: string }> {
    const body: Record<string, unknown> = { name };
    if (space) body.space = space;
    if (thread) body.thread = thread;
    return this.request("/app.json", { method: "POST", body, guestSpaceId, preview: true });
  }

  // 動作テスト環境の設定を運用環境へ反映（revert=true で変更破棄）。非同期 API。
  async deployApps(
    apps: Array<{ app: string | number; revision?: string | number }>,
    { revert = false, guestSpaceId = "" }: { revert?: boolean; guestSpaceId?: string } = {}
  ): Promise<void> {
    await this.request("/app/deploy.json", {
      method: "POST",
      body: { apps: apps.map(({ app, revision }) => ({ app: String(app), ...(revision === undefined ? {} : { revision }) })), revert },
      guestSpaceId,
      preview: true
    });
  }

  async getDeployStatuses(
    appIds: Array<string | number>,
    { guestSpaceId = "" }: { guestSpaceId?: string } = {}
  ): Promise<Array<{ app: string; status: string }>> {
    const payload = await this.request("/app/deploy.json", {
      method: "GET",
      guestSpaceId,
      preview: true,
      query: { apps: appIds.map(String) }
    });
    return Array.isArray(payload?.apps) ? payload.apps : [];
  }

  // ---- スペース更新系: 動作テスト環境（preview）は無く、運用環境へ即時反映される（push:space のグラントが要る） ----

  async updateSpace(
    body: Record<string, unknown>,
    { guestSpaceId = "" }: { guestSpaceId?: string } = {}
  ): Promise<any> {
    return this.request("/space.json", { method: "PUT", body, guestSpaceId });
  }

  async updateSpaceBody(
    { id, body }: { id: string | number; body: string },
    { guestSpaceId = "" }: { guestSpaceId?: string } = {}
  ): Promise<any> {
    return this.request("/space/body.json", { method: "PUT", body: { id: String(id), body }, guestSpaceId });
  }

  async updateThread(
    { id, body }: { id: string | number; body?: string },
    { guestSpaceId = "" }: { guestSpaceId?: string } = {}
  ): Promise<any> {
    const payload: Record<string, unknown> = { id: String(id) };
    if (body !== undefined) payload.body = body;
    return this.request("/space/thread.json", { method: "PUT", body: payload, guestSpaceId });
  }

  // ---- レコード系: 読み取りは pull:records、書き込み（uploadFile・bulkRequest）は push:records のグラントが要る ----

  // GET /records.json（1 回分）。query は「$id in (...) limit 100」のようにクエリ全体を渡す。
  async getRecordsByQuery(
    appId: string | number,
    { query, fields, guestSpaceId = "" }: { query: string; fields?: string[]; guestSpaceId?: string }
  ): Promise<any[]> {
    const requested = fields && fields.length > 0 ? [...new Set(fields)] : undefined;
    const projections = requested && requested.length > 100
      ? Array.from({ length: Math.ceil(requested.filter((field) => field !== "$id" && field !== "$revision").length / 98) }, (_, index) => {
          const business = requested.filter((field) => field !== "$id" && field !== "$revision");
          return ["$id", "$revision", ...business.slice(index * 98, (index + 1) * 98)];
        })
      : [requested];
    let merged: Map<string, any> | undefined;
    let order: string[] = [];
    let baselineRevisions = new Map<string, string>();
    for (const projection of projections) {
      const params: Query = { app: appId, query };
      if (projection) params.fields = projection;
      const payload = await this.request("/records.json", { method: "GET", guestSpaceId, query: params });
      if (!payload || !Array.isArray(payload.records)) throw new Error("レコード取得 API の応答に records 配列がありません。");
      const page = new Map<string, any>();
      for (const record of payload.records) {
        const id = record?.$id?.value;
        if (id == null || !/^[1-9]\d*$/.test(String(id))) throw new Error("レコード取得 API の応答に有効な $id がありません。");
        const key = String(id);
        if (page.has(key)) throw new Error(`レコード取得 API の応答に $id ${key} が重複しています。`);
        page.set(key, record);
      }
      if (!merged) {
        merged = page;
        order = [...page.keys()];
        baselineRevisions = new Map([...page].map(([id, record]) => [id, String(record?.$revision?.value ?? "")]));
        continue;
      }
      if (page.size !== merged.size || order.some((id) => !page.has(id))) throw new Error("フィールド分割取得の間に対象レコードが変わりました。再実行してください。");
      for (const id of order) {
        const revision = String(page.get(id)?.$revision?.value ?? "");
        if (baselineRevisions.get(id) !== revision) throw new Error(`レコード ${id} はフィールド分割取得中に更新されました。再実行してください。`);
        Object.assign(merged!.get(id), page.get(id));
      }
    }
    return order.map((id) => merged!.get(id));
  }

  // POST /file.json（multipart/form-data、name="file"）。一時保管領域の fileKey を返す（未使用なら 3 日で削除される）。
  // ローカルファイルは openAsBlob で遅延読み込みし、巨大ファイルをメモリへ載せない。
  async uploadFile(
    filePath: string,
    fileName: string,
    { guestSpaceId = "" }: { guestSpaceId?: string } = {}
  ): Promise<string> {
    const form = new FormData();
    form.append("file", await fs.openAsBlob(filePath), fileName);
    const payload = await requestCybozuJson(this.env, this.buildUrl("/file.json", { guestSpaceId }), {
      method: "POST",
      body: form,
      timeoutMs: 600_000
    });
    if (!payload?.fileKey) throw new Error(`ファイルのアップロード結果に fileKey がありません: ${fileName}`);
    return String(payload.fileKey);
  }

  // Customize は records と同じ /file.json を使うため、呼び出し元で push:app を明示する。
  async uploadAppCustomizeFile(filePath: string, fileName: string, { guestSpaceId = "" }: { guestSpaceId?: string } = {}): Promise<string> {
    const bytes = fs.readFileSync(filePath);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)]), fileName);
    const payload = await requestCybozuJson(
      this.env,
      this.buildUrl("/file.json", { guestSpaceId }),
      { method: "POST", body: form, timeoutMs: 600_000, requiredPermission: "push:app" }
    );
    if (!payload?.fileKey) throw new Error(`Customize ファイルのアップロード結果に fileKey がありません: ${fileName}`);
    return String(payload.fileKey);
  }

  // POST /bulkRequest.json。最大 20 リクエストを原子的に処理する（1 件でも失敗すれば全体が取り消される）。
  // 同じゲストスペース内のアプリにだけ使える。results は requests と同じ順序。
  async bulkRequest(requests: BulkRequestItem[], { guestSpaceId = "" }: { guestSpaceId?: string } = {}): Promise<any[]> {
    try {
      // 書き込みはリトライしない。タイムアウトしても、サーバー側で反映されたかどうかは分からないため、既定（60 秒）より長く待つ。
      const payload = await this.request("/bulkRequest.json", { method: "POST", body: { requests }, guestSpaceId, timeoutMs: BULK_REQUEST_TIMEOUT_MS });
      if (!Array.isArray(payload?.results) || payload.results.length !== requests.length || payload.results.some((result: unknown) => !result || typeof result !== "object" || Array.isArray(result))) {
        const failure = new Error("bulkRequest は成功応答を返しましたが、results の件数または形式が不正です。反映された可能性があるため、再実行前に状態を確認してください。") as CybozuError;
        Object.assign(failure, { uncertain: true });
        throw failure;
      }
      return payload.results;
    } catch (error) {
      throw describeBulkError(error as CybozuError, requests);
    }
  }

  // 添付ファイル（FILE フィールド）の実体を fileKey で取得し、destPath へストリーミング保存する。
  // 最大 1GB の添付をメモリへ載せないため Buffer では返さない。タイムアウトは巨大ファイル向けに延長。
  async downloadFileTo(
    fileKey: string,
    destPath: string,
    { guestSpaceId = "" }: { guestSpaceId?: string } = {}
  ): Promise<void> {
    return requestCybozuToFile(this.env, this.buildUrl("/file.json", { guestSpaceId }), destPath, {
      query: { fileKey },
      timeoutMs: 600_000
    });
  }
}
