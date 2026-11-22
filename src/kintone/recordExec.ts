// レコード操作の実行部品: バックアップ・添付の転送・一括処理の実行・反映後の検証。
// push records と --restore で共有する（計画は recordPlan.ts、公開関数は recordPush.ts）。

import path from "node:path";
import fs from "node:fs";
import { ensureDir, writeJson } from "../fsutil.js";
import { log } from "../log.js";
import { createLimiter } from "../limit.js";
import { sanitizeFileName } from "../normalize.js";
import type { KintoneClient } from "./client.js";
import { parseFieldPath } from "./recordJob.js";
import { assertLocalUploadPath, RECORDS_PER_REQUEST, type BackupRecord, type BulkGroup, type BulkItem, type TargetRecordPlan, type UploadItem } from "./recordPlan.js";
import { canonicalNumber, displayValue, type FieldSchema, type SchemaIndex } from "./recordValues.js";

const BACKUP_DOWNLOAD_CONCURRENCY = 4;
// 添付の参照は { fileKey: "@upload:<id>" } の fileKey の値だけ。テキストなど他の値に同じ文字列があっても、置換も検出もしない。
const UPLOAD_PLACEHOLDER = /^@upload:([A-Za-z]\d+)$/;

const hasFileKey = (item: unknown): boolean => Boolean(item) && typeof item === "object" && "fileKey" in (item as object);
const isFileList = (value: unknown): value is any[] => Array.isArray(value) && value.length > 0 && value.every(hasFileKey);

/**
 * 対象レコードの現在の値（raw）と添付の実体を backup/ に保存する。添付は backup/files/ へダウンロードし、
 * records.json の各ファイルに runDir からの相対パス（local）を書く。1 件でも失敗したら throw する（書き込み前に中断するため）。
 */
export async function writeBackup(
  client: KintoneClient,
  runDir: string,
  records: BackupRecord[],
  extra: Record<string, unknown> = {}
): Promise<{ files: number; bytes: number }> {
  const limiter = createLimiter(BACKUP_DOWNLOAD_CONCURRENCY);
  const copy: BackupRecord[] = JSON.parse(JSON.stringify(records));
  const tasks: Array<Promise<void>> = [];
  let files = 0;
  let bytes = 0;
  const collect = (record: BackupRecord, items: any[], where: string[]): void => {
    items.forEach((file, index) => {
      const relative = ["backup", "files", "app-" + record.app, record.id, ...where.map(sanitizeFileName), index + 1 + "-" + sanitizeFileName(file.name)].join("/");
      file.local = relative;
      const dest = path.join(runDir, ...relative.split("/"));
      ensureDir(path.dirname(dest));
      tasks.push(limiter(() => client.downloadFileTo(file.fileKey, dest, { guestSpaceId: record.guestSpaceId })));
      files += 1;
      bytes += Number(file.size) || 0;
    });
  };
  for (const record of copy) {
    for (const [code, field] of Object.entries(record.fields)) {
      const value = (field as any)?.value;
      if (isFileList(value)) collect(record, value, [code]);
      else if (Array.isArray(value)) {
        for (const row of value) {
          for (const [innerCode, cell] of Object.entries((row?.value ?? {}) as Record<string, any>)) {
            if (isFileList(cell?.value)) collect(record, cell.value, [code, String(row.id), innerCode]);
          }
        }
      }
    }
  }
  const settled = await Promise.allSettled(tasks);
  const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
  if (failed) {
    const reason = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
    throw new Error("バックアップに失敗したため中断しました（何も変更していません）: " + reason);
  }
  writeJson(path.join(runDir, "backup", "records.json"), { schemaVersion: 1, createdAt: new Date().toISOString(), ...extra, records: copy });
  return { files, bytes };
}

// ---- 添付の転送 ----

interface TransferContext {
  client: KintoneClient;
  /** コピー元の添付を一時的にダウンロードする場所（実行後に削除する）。 */
  workDir: string;
  /** アップロード ID → アップロードで得た fileKey。 */
  uploaded: Map<string, string>;
  /** コピー元の fileKey → ダウンロード済みのローカルパス（同じ添付を複数回コピーしてもダウンロードは 1 回）。 */
  downloaded: Map<string, string>;
  seq: { n: number };
}

/** 1 件を、コピー先アプリの一時保管領域へアップロードして fileKey を返す（コピー元の添付はまずダウンロードする）。 */
async function uploadItem(ctx: TransferContext, item: UploadItem): Promise<string> {
  const cached = ctx.uploaded.get(item.id);
  if (cached) return cached;
  let localPath: string;
  if (item.source.type === "local") {
    assertLocalUploadPath(item.source.path, item.source.root);
    const stat = fs.statSync(item.source.path);
    if (stat.size !== item.source.size) throw new Error(`添付ファイルが計画後に変更されました: ${item.source.name}（サイズが異なります）`);
    localPath = item.source.path;
  } else {
    const key = item.source.guestSpaceId + "|" + item.source.fileKey;
    let existing = ctx.downloaded.get(key);
    if (!existing) {
      ensureDir(ctx.workDir);
      existing = path.join(ctx.workDir, (ctx.seq.n += 1) + "-" + sanitizeFileName(item.source.name));
      await ctx.client.downloadFileTo(item.source.fileKey, existing, { guestSpaceId: item.source.guestSpaceId });
      ctx.downloaded.set(key, existing);
    }
    localPath = existing;
  }
  const fileKey = await ctx.client.uploadFile(localPath, item.source.name, { guestSpaceId: item.targetGuestSpaceId });
  ctx.uploaded.set(item.id, fileKey);
  return fileKey;
}

/** オブジェクトを深く走査する。fileKey というキーの文字列値だけを visit に渡し、返った値で置き換えた複製を返す。 */
function mapFileKeys(node: unknown, visit: (fileKey: string) => string): unknown {
  if (Array.isArray(node)) return node.map((item) => mapFileKeys(item, visit));
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([key, value]) => [
        key,
        key === "fileKey" && typeof value === "string" ? visit(value) : mapFileKeys(value, visit)
      ])
    );
  }
  return node;
}

/** payload 中の { fileKey: "@upload:<id>" } を、アップロードで得た fileKey に置き換える（元の payload は変えない。fileKey 以外の値は触らない）。 */
export function fillUploads(payload: unknown, uploaded: Map<string, string>): unknown {
  return mapFileKeys(payload, (value) => {
    const match = UPLOAD_PLACEHOLDER.exec(value);
    return match ? (uploaded.get(match[1]) ?? value) : value;
  });
}

export function uploadIdsIn(payload: unknown): string[] {
  const ids = new Set<string>();
  mapFileKeys(payload, (value) => {
    const match = UPLOAD_PLACEHOLDER.exec(value);
    if (match) ids.add(match[1]);
    return value;
  });
  return [...ids];
}

// ---- 一括処理の実行 ----

interface BulkOutcome {
  index: number;
  guestSpaceId: string;
  requests: number;
  status: "ok" | "failed" | "skipped";
  error?: string;
}

export interface ExecutedBulks {
  bulks: BulkOutcome[];
  updated: Array<{ app: string; id: string; revisionAfter: string }>;
  created: Array<{ app: string; key: string; id: string; revision: string }>;
  deleted: Array<{ app: string; id: string }>;
  error?: Error;
}

function collectResults(request: BulkItem, result: any, outcome: ExecutedBulks): void {
  const { app, ids, keys } = request.meta;
  if (request.method === "PUT") {
    for (const item of result?.records ?? []) outcome.updated.push({ app, id: String(item.id), revisionAfter: String(item.revision) });
  } else if (request.method === "POST") {
    (result?.ids ?? []).forEach((id: string, index: number) => {
      outcome.created.push({ app, key: keys?.[index] ?? "", id: String(id), revision: String(result?.revisions?.[index] ?? "1") });
    });
  } else {
    for (const id of ids ?? []) outcome.deleted.push({ app, id });
  }
}

function validateBulkAcknowledgement(request: BulkItem, result: unknown, index: number): void {
  const uncertain = (message: string): never => {
    const error = new Error(`bulkRequest の ${index + 1} 件目は成功応答でしたが、結果を確定できません: ${message}。反映された可能性があるため再実行前に確認してください。`) as Error & { uncertain: boolean };
    error.uncertain = true;
    throw error;
  };
  if (!result || typeof result !== "object" || Array.isArray(result)) uncertain("結果がオブジェクトではありません");
  const ack = result as Record<string, any>;
  const isId = (value: unknown): boolean => typeof value === "string" && /^[1-9]\d*$/.test(value);
  const isRevision = (value: unknown): boolean => typeof value === "string" && /^[1-9]\d*$/.test(value);
  if (request.method === "PUT") {
    const expected = Array.isArray((request.payload as any)?.records) ? (request.payload as any).records : [];
    if (!Array.isArray(ack.records) || ack.records.length !== expected.length) uncertain("更新 records の件数が要求と異なります");
    const expectedIds = new Set<string>(expected.map((record: any) => String(record?.id ?? "")));
    const actualIds = new Set<string>();
    for (const item of ack.records) {
      if (!isId(item?.id) || !isRevision(item?.revision) || actualIds.has(item.id)) uncertain("更新レコードの id / revision が不正または重複しています");
      actualIds.add(item.id);
    }
    if (actualIds.size !== expectedIds.size || [...expectedIds].some((id) => !actualIds.has(id))) uncertain("更新結果の id が要求と一致しません");
  } else if (request.method === "POST") {
    const expected = Array.isArray((request.payload as any)?.records) ? (request.payload as any).records : [];
    if (!Array.isArray(ack.ids) || !Array.isArray(ack.revisions) || ack.ids.length !== expected.length || ack.revisions.length !== expected.length) {
      uncertain("追加 ids / revisions の件数が要求と異なります");
    }
    if (ack.ids.some((id: unknown) => !isId(id)) || new Set(ack.ids).size !== ack.ids.length || ack.revisions.some((revision: unknown) => !isRevision(revision))) {
      uncertain("追加 ids / revisions に不正な値または重複があります");
    }
  } else if (Object.keys(ack).length !== 0) {
    uncertain("削除結果が空オブジェクトではありません");
  }
}

/**
 * 一括処理を順に実行する。各回の前に、その回が参照する添付をアップロードして payload の "@upload:" を fileKey に置き換える。
 * 1 回の bulkRequest は原子的（1 件でも失敗すれば全体が取り消される）。失敗したらそこで止め、残りは skipped にする。
 */
export async function executeBulks({
  client,
  groups,
  uploads,
  workDir
}: {
  client: KintoneClient;
  groups: BulkGroup[];
  uploads: UploadItem[];
  workDir: string;
}): Promise<ExecutedBulks> {
  const ctx: TransferContext = { client, workDir, uploaded: new Map(), downloaded: new Map(), seq: { n: 0 } };
  const byId = new Map(uploads.map((item) => [item.id, item]));
  const outcome: ExecutedBulks = {
    bulks: groups.map((group) => ({ index: group.index, guestSpaceId: group.guestSpaceId, requests: group.requests.length, status: "skipped" as const })),
    updated: [],
    created: [],
    deleted: []
  };
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    try {
      for (const id of uploadIdsIn(group.requests.map((request) => request.payload))) {
        const item = byId.get(id);
        if (!item) throw new Error("内部エラー: アップロード " + id + " が計画にありません");
        log("添付を転送: " + item.source.name);
        await uploadItem(ctx, item);
      }
      const requests = group.requests.map(({ method, api, payload }) => ({ method, api, payload: fillUploads(payload, ctx.uploaded) }));
      const results = await client.bulkRequest(requests, { guestSpaceId: group.guestSpaceId });
      group.requests.forEach((request, index) => validateBulkAcknowledgement(request, results[index], index));
      group.requests.forEach((request, index) => collectResults(request, results[index], outcome));
      outcome.bulks[i].status = "ok";
      log("一括処理 " + group.index + "/" + groups.length + " 回目を反映しました（" + group.requests.length + " リクエスト）");
    } catch (error) {
      outcome.bulks[i].status = "failed";
      outcome.bulks[i].error = error instanceof Error ? error.message : String(error);
      outcome.error = error instanceof Error ? error : new Error(String(error));
      break;
    }
  }
  return outcome;
}

/**
 * 反映されたかどうか分からない失敗か（応答が返らなかった・サーバー内部の失敗）。http.ts がエラーに付ける印で判定する。
 * 確定で未反映と言えるのは、サーバーが 4xx で拒否した場合だけ。
 */
export function isUncertain(error: Error | undefined): boolean {
  return Boolean(error && (error as { uncertain?: boolean }).uncertain === true);
}

/**
 * 一括処理が失敗したときのユーザー向けの案内。1 回目の失敗は全体が取り消されるため何も変わらない。
 * 2 回目以降は前の回が反映済み（partialHint で戻し方を示す）。タイムアウトは反映されたかどうか不明なので、確認を促す。
 */
export function failureNote(executed: ExecutedBulks, partialHint: string): string {
  const done = executed.bulks.filter((item) => item.status === "ok").length;
  if (isUncertain(executed.error)) {
    return (
      "応答を受け取れなかった（タイムアウト・通信断・サーバーの内部エラー）ため、失敗した回が反映されたかどうか分かりません。" +
      "同じジョブを再実行する前に、kint-origin show records で対象レコードを確認してください（再実行すると、新規レコードや添付が重複することがあります）。" +
      (done > 0 ? " " + done + " 回目までは反映済みです。" + partialHint : "")
    );
  }
  return done === 0 ? "何も変更していません（一括処理は全体が取り消されました）。" : done + " 回目までは反映済みです。" + partialHint;
}

// ---- 反映後の検証 ----

export interface VerifyResult {
  checked: number;
  mismatches: Array<{ app: string; id: string; field: string; expected: string; actual: string }>;
  error?: string;
}

/** 検証で表示値を比べる。数値は桁の表記（1.50 と 1.5 など）が違っても同じ値として扱う。 */
function sameDisplay(field: FieldSchema | undefined, expected: string, actual: string): boolean {
  if (expected === actual) return true;
  return field?.type === "NUMBER" && canonicalNumber(expected) === canonicalNumber(actual);
}

/** 再取得した値と計画の表示値を照合し、不一致や取得エラーを呼び出し元に返す。 */
export async function verifyTargets({
  client,
  targets,
  created,
  apps
}: {
  client: KintoneClient;
  targets: TargetRecordPlan[];
  created: ExecutedBulks["created"];
  apps: Map<string, { guestSpaceId: string; schema: SchemaIndex }>;
}): Promise<VerifyResult> {
  const result: VerifyResult = { checked: 0, mismatches: [] };
  try {
    const resolved = targets.flatMap((target) => {
      const id = target.kind === "update" ? target.id : created.find((item) => item.app === target.app && item.key === target.newKey)?.id;
      return id ? [{ target, id }] : [];
    });
    const apps_ = [...new Set(resolved.map((item) => item.target.app))];
    for (const app of apps_) {
      const info = apps.get(app);
      if (!info) continue;
      const mine = resolved.filter((item) => item.target.app === app);
      const codes = [...new Set(mine.flatMap((item) => item.target.touched))];
      const fetched = new Map<string, any>();
      for (let i = 0; i < mine.length; i += RECORDS_PER_REQUEST) {
        const ids = mine.slice(i, i + RECORDS_PER_REQUEST).map((item) => item.id);
        const records = await client.getRecordsByQuery(app, {
          query: "$id in (" + ids.join(",") + ") limit " + RECORDS_PER_REQUEST,
          fields: ["$id", ...codes],
          guestSpaceId: info.guestSpaceId
        });
        for (const record of records) fetched.set(String(record.$id?.value), record);
      }
      for (const { target, id } of mine) {
        const record = fetched.get(id);
        for (const expectation of target.expected) {
          const field = parseFieldPath(expectation.field);
          let actual = "";
          let schemaField: FieldSchema | undefined;
          if (field?.table && field.row?.kind === "id") {
            const rowId = field.row.id;
            const rows: any[] = Array.isArray(record?.[field.table]?.value) ? record[field.table].value : [];
            const row = rows.find((item) => String(item.id) === rowId);
            schemaField = info.schema.inner.get(field.code);
            actual = displayValue(schemaField, row?.value?.[field.code]?.value);
          } else {
            schemaField = info.schema.top.get(expectation.field);
            actual = displayValue(schemaField, record?.[expectation.field]?.value);
          }
          result.checked += 1;
          if (!sameDisplay(schemaField, expectation.display, actual)) result.mismatches.push({ app, id, field: expectation.field, expected: expectation.display, actual });
        }
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}
