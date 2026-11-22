import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { mapWithLimit } from "../limit.js";
import { kintoneAppRootPath } from "../paths.js";
import { KintoneClient } from "./client.js";
import { recordLocalAction } from "../runLog.js";

const COMMENT_PAGE_SIZE = 10;
const RECORD_PAGE_SIZE = 500;
const COMMENT_CONCURRENCY = 4;

export interface PullCommentsOptions {
  appId: string;
  recordId?: string;
  guestSpaceId?: string;
  spaceId?: string;
}

export interface PullCommentsSummary {
  appId: string;
  recordId?: string;
  guestSpaceId: string;
  spaceId: string;
  records: number;
  comments: number;
  written: string[];
  unchanged: string[];
  empty: number;
  failures: Array<{ recordId: string; message: string }>;
}

function assertNumericId(value: string, label: string): void {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} は正の整数で指定してください: ${value}`);
}

function compareId(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function recordIdFromRecord(record: unknown): string {
  if (!record || typeof record !== "object") throw new Error("レコード一覧 API の応答に不正なレコードがあります。");
  const field = (record as Record<string, unknown>).$id;
  const value = field && typeof field === "object" && "value" in field ? (field as { value?: unknown }).value : field;
  const id = String(value ?? "");
  assertNumericId(id, "レコード ID");
  return id;
}

async function listRecordIds(client: KintoneClient, appId: string, guestSpaceId: string): Promise<string[]> {
  const result: string[] = [];
  let lastId = "0";
  while (true) {
    const payload = await client.request("/records.json", {
      method: "GET",
      guestSpaceId,
      query: { app: appId, query: `$id > ${lastId} order by $id asc limit ${RECORD_PAGE_SIZE}`, fields: ["$id"] }
    });
    if (!payload || !Array.isArray(payload.records)) throw new Error("レコード一覧 API の応答に records 配列がありません。全件コメント取得を中断しました。");
    const records = payload.records as unknown[];
    if (records.length > RECORD_PAGE_SIZE) throw new Error(`レコード一覧 API が ${RECORD_PAGE_SIZE} 件を超える応答を返しました。`);
    let previousId = lastId;
    for (const record of records) {
      const id = recordIdFromRecord(record);
      if (compareId(id, previousId) <= 0) throw new Error("レコード一覧 API の $id が昇順ではないか、重複しています。");
      result.push(id);
      previousId = id;
    }
    if (records.length < RECORD_PAGE_SIZE) return result;
    if (previousId === lastId) throw new Error("レコード一覧 API のページングが進みませんでした。");
    lastId = previousId;
  }
}

function validateComment(comment: unknown, recordId: string): Record<string, unknown> {
  if (!comment || typeof comment !== "object" || Array.isArray(comment)) throw new Error(`レコード ${recordId} のコメント API に不正な項目があります。`);
  const value = comment as Record<string, unknown>;
  if (!(typeof value.id === "string" || (typeof value.id === "number" && Number.isSafeInteger(value.id)))
    || typeof value.text !== "string"
    || typeof value.createdAt !== "string"
    || !value.creator || typeof value.creator !== "object" || Array.isArray(value.creator)) {
    throw new Error(`レコード ${recordId} のコメント API に必須項目がありません。`);
  }
  assertNumericId(String(value.id), `レコード ${recordId} のコメント ID`);
  if (value.mentions !== undefined && !Array.isArray(value.mentions)) throw new Error(`レコード ${recordId} のコメント API の mentions が不正です。`);
  return value;
}

async function fetchComments(client: KintoneClient, appId: string, recordId: string, guestSpaceId: string): Promise<Record<string, unknown>[]> {
  const comments: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  let offset = 0;
  let previousTail = "";
  for (;;) {
    const payload = await client.getRecordComments(appId, recordId, { offset, limit: COMMENT_PAGE_SIZE, guestSpaceId });
    if (!Array.isArray(payload?.comments) || payload.comments.length > COMMENT_PAGE_SIZE) {
      throw new Error(`レコード ${recordId} のコメント API 応答に有効な comments 配列がありません。`);
    }
    if (typeof payload.older !== "boolean" || typeof payload.newer !== "boolean") {
      throw new Error(`レコード ${recordId} のコメント API 応答に older/newer がありません。ページングの完全性を確認できません。`);
    }
    if (payload.comments.length === 0 && payload.newer) throw new Error(`レコード ${recordId} のコメント API が空ページなのに newer=true を返しました。`);
    const pageIds: string[] = [];
    for (const raw of payload.comments) {
      const comment = validateComment(raw, recordId);
      const id = String(comment.id);
      if (pageIds.length > 0 && compareId(id, pageIds[pageIds.length - 1]) <= 0) throw new Error(`レコード ${recordId} のコメント一覧が昇順ではありません。`);
      pageIds.push(id);
    }
    let start = 0;
    if (previousTail) {
      if (pageIds[0] !== previousTail) throw new Error(`レコード ${recordId} のコメントページが重複境界で一致しません。コメント追加・削除によるページずれの可能性があります。`);
      start = 1;
    } else if (payload.older) {
      throw new Error(`レコード ${recordId} の最初のコメントページで older=true が返りました。`);
    }
    for (let index = start; index < payload.comments.length; index += 1) {
      const comment = payload.comments[index] as Record<string, unknown>;
      const id = String(comment.id);
      if (ids.has(id)) throw new Error(`レコード ${recordId} のコメント一覧に重複 ID があります: ${id}`);
      ids.add(id);
      comments.push(comment);
    }
    if (!payload.newer) break;
    if (payload.comments.length !== COMMENT_PAGE_SIZE) throw new Error(`レコード ${recordId} のコメント API が newer=true と ${payload.comments.length} 件を返しました。`);
    previousTail = pageIds[pageIds.length - 1];
    offset += COMMENT_PAGE_SIZE - 1;
  }
  comments.sort((a, b) => compareId(String(a.id), String(b.id)));
  return comments;
}

function outputPath(root: string, recordId: string): string {
  const directory = path.join(root, "comments");
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`コメント出力先にシンボリックリンクは使えません: ${current}`);
    if (stat && !stat.isDirectory()) throw new Error(`コメント出力先がディレクトリではありません: ${current}`);
  }
  const output = path.join(directory, `record-${recordId}.json`);
  const outputStat = fs.lstatSync(output, { throwIfNoEntry: false });
  if (outputStat?.isSymbolicLink() || (outputStat && !outputStat.isFile())) throw new Error(`コメント出力先が通常ファイルではありません: ${output}`);
  return output;
}

function stableCommentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCommentValue);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort((a, b) => a.localeCompare(b, "en")).map((key) => [key, stableCommentValue(object[key])]));
  }
  return value;
}

function writeCommentsFile(filePath: string, recordId: string, comments: Record<string, unknown>[]): "written" | "unchanged" {
  const parent = path.dirname(filePath);
  const bytes = Buffer.from(`${JSON.stringify(stableCommentValue({ recordId, comments }), null, 2)}\n`, "utf8");
  if (fs.existsSync(filePath) && fs.readFileSync(filePath).equals(bytes)) return "unchanged";
  recordLocalAction("write-record-comments", filePath, { recordId, bytes: bytes.length });
  fs.mkdirSync(parent, { recursive: true });
  const temporary = path.join(parent, `.record-${recordId}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return "written";
}

export async function pullRecordComments(options: PullCommentsOptions): Promise<PullCommentsSummary> {
  const { appId, recordId = "", guestSpaceId = "", spaceId = "" } = options;
  assertNumericId(appId, "アプリ ID");
  if (recordId) assertNumericId(recordId, "レコード ID");
  const client = new KintoneClient();
  const records = recordId ? [recordId] : await listRecordIds(client, appId, guestSpaceId);
  const appRoot = kintoneAppRootPath({ appId, guestSpaceId, spaceId });
  const result: PullCommentsSummary = {
    appId,
    ...(recordId ? { recordId } : {}),
    guestSpaceId,
    spaceId,
    records: records.length,
    comments: 0,
    written: [],
    unchanged: [],
    empty: 0,
    failures: []
  };

  await mapWithLimit(records, COMMENT_CONCURRENCY, async (id) => {
    try {
      const comments = await fetchComments(client, appId, id, guestSpaceId);
      result.comments += comments.length;
      const destination = outputPath(appRoot, id);
      if (comments.length === 0) {
        result.empty += 1;
        if (!fs.existsSync(destination)) return;
      }
      const written = writeCommentsFile(destination, id, comments);
      (written === "written" ? result.written : result.unchanged).push(path.relative(process.cwd(), destination).replaceAll("\\", "/"));
    } catch (error) {
      result.failures.push({ recordId: id, message: error instanceof Error ? error.message : String(error) });
    }
  });
  result.written.sort();
  result.unchanged.sort();
  result.failures.sort((a, b) => compareId(a.recordId, b.recordId));
  return result;
}
