import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { ensureDir } from "../fsutil.js";
import { kintoneAppRootPath } from "../paths.js";
import { log } from "../log.js";
import { confirmYes } from "../confirm.js";
import { KintoneClient } from "./client.js";
import { runCliKintoneCsvToFile } from "./cliKintone.js";
import { downloadAttachments } from "./recordAttachments.js";
import { assertRecordCsvContainsId, mergeRecordCsv } from "./recordCsv.js";
import { recordsSchemaFromForm } from "./recordsSchema.js";
import { recordLocalAction } from "../runLog.js";

const RECORDS_PER_REQUEST = 500;
const RECORDS_CSV_FILE = "records.csv";
const RECORDS_SCHEMA_FILE = ".kint-origin-records-schema.json";
const RECORDS_LOCK_FILE = ".kint-origin-records.lock";

type PullRecordsOptions = {
  appId: string | number;
  recordId?: string;
  guestSpaceId?: string;
  spaceId?: string;
  condition?: string;
  orderBy?: string;
  attachments?: boolean;
  yes?: boolean;
  confirmed?: boolean;
};

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on("data", (chunk: string | Buffer) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("hex");
}

function assertManagedFile(filePath: string): boolean {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`レコード取得の保存先が通常ファイルではありません: ${filePath}`);
  return true;
}

function removeManagedFile(filePath: string): void {
  if (assertManagedFile(filePath)) fs.unlinkSync(filePath);
}

function commitRecordsPair(recordsDir: string, stagedCsv: string, stagedSchema: string | null, appId: string): void {
  const csvPath = path.join(recordsDir, RECORDS_CSV_FILE);
  const schemaPath = path.join(recordsDir, RECORDS_SCHEMA_FILE);
  assertManagedFile(csvPath);
  assertManagedFile(schemaPath);
  const backupCsv = path.join(path.dirname(stagedCsv), "previous-records.csv");
  const backupSchema = path.join(path.dirname(stagedCsv), "previous-schema.json");
  const hadCsv = fs.existsSync(csvPath);
  const hadSchema = fs.existsSync(schemaPath);
  recordLocalAction("commit-records-csv", csvPath, { appId });
  let installedCsv = false;
  let installedSchema = false;
  try {
    if (hadCsv) fs.renameSync(csvPath, backupCsv);
    if (hadSchema) fs.renameSync(schemaPath, backupSchema);
    fs.renameSync(stagedCsv, csvPath);
    installedCsv = true;
    if (stagedSchema) {
      fs.renameSync(stagedSchema, schemaPath);
      installedSchema = true;
    }
  } catch (error) {
    try {
      if (installedSchema) removeManagedFile(schemaPath);
      if (installedCsv) removeManagedFile(csvPath);
      if (hadCsv && fs.existsSync(backupCsv)) fs.renameSync(backupCsv, csvPath);
      if (hadSchema && fs.existsSync(backupSchema)) fs.renameSync(backupSchema, schemaPath);
    } catch (restoreError) {
      const failure = new Error(`アプリ ${appId} のレコードCSV確定に失敗し、前回ファイルの復元も完了しませんでした。退避先を確認してください: ${path.dirname(stagedCsv)} (${restoreError instanceof Error ? restoreError.message : String(restoreError)})`);
      Object.assign(failure, { preserveStage: true });
      throw failure;
    }
    throw error;
  }
}

function acquireRecordsLock(recordsDir: string): () => void {
  const lockPath = path.join(recordsDir, RECORDS_LOCK_FILE);
  const fd = fs.openSync(lockPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${process.pid}\n`, "utf8");
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
    throw error;
  }
  return () => {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  };
}

export interface RecordsSummary {
  appId: string;
  guestSpaceId: string;
  spaceId: string;
  total: number;
  estimatedApiCalls: number;
  outFile: string;
  attachments: boolean;
  attachmentFiles?: number;
  attachmentFields?: string[];
  attachmentFailures?: number;
  recordId?: string;
  aborted?: boolean;
}

// /records.json を1回だけ叩いて総件数(totalCount)を取得する。
async function fetchTotalCount(client: KintoneClient, appId: string | number, guestSpaceId: string, condition: string): Promise<number> {
  const payload = await client.request("/records.json", {
    method: "GET",
    guestSpaceId,
    query: { app: appId, query: `${condition ? `${condition} ` : ""}limit 1`, totalCount: true }
  });
  const raw = payload?.totalCount;
  const total = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("レコード取得 API の totalCount が不正です。CSV を更新せず中断しました。");
  return total;
}

function combineConditions(condition: string, recordId: string): string {
  if (!recordId) return condition;
  return condition ? `(${condition}) and $id = ${recordId}` : `$id = ${recordId}`;
}

async function getRecordNumberFieldCode(client: KintoneClient, appId: string | number, guestSpaceId: string): Promise<string> {
  const form = await client.getAppResource("/app/form/fields.json", appId, { guestSpaceId });
  const field = Object.values(form?.properties || {}).find((property: any) => property?.type === "RECORD_NUMBER") as
    | { code?: string }
    | undefined;
  if (!field?.code) throw new Error("レコード番号フィールドを取得できませんでした。");
  return field.code;
}

// cli-kintone の record export をラップし、全件保存または指定レコードだけ既存 CSV へ反映する。
// REST API 実行数が増えるため、事前に推定数を表示し（-y でなければ）ユーザー確認を取る。
async function pullRecordsLocked({
  appId,
  recordId = "",
  guestSpaceId = "",
  spaceId = "",
  condition = "",
  orderBy = "",
  attachments = false,
  yes = false,
  confirmed = false
}: PullRecordsOptions): Promise<RecordsSummary> {
  const client = new KintoneClient();
  let downloadAttachmentFiles = attachments;
  if (!confirmed && !attachments) {
    if (yes) {
      downloadAttachmentFiles = true;
    } else {
      if (!process.stdin.isTTY) {
        throw new Error("対話実行ではないため添付確認ができません。添付を取得する場合は --attachments、全確認を省略する場合は -y を付けてください。");
      }
      downloadAttachmentFiles = await confirmYes("添付ファイルをダウンロードしますか？ [Y/n]", { defaultYes: true });
    }
  }

  const effectiveCondition = combineConditions(condition, recordId);
  const total = await fetchTotalCount(client, appId, guestSpaceId, effectiveCondition);
  const recordsDir = path.join(kintoneAppRootPath({ appId, guestSpaceId, spaceId }), "records");
  const outFile = path.join(recordsDir, RECORDS_CSV_FILE);

  // 件数確認(1回・実行済み) + cli-kintone 内部の getFormFields/getFormLayout(2回) + レコード取得(500件/回)。
  const recordCalls = Math.max(1, Math.ceil(total / RECORDS_PER_REQUEST));
  // 単一レコードを既存CSVへマージする場合は、レコード番号フィールド特定にフォーム定義を1回取得する。
  const mergeCalls = recordId && fs.existsSync(outFile) ? 1 : 0;
  // 添付時は自前で フォーム定義1回 + レコード再取得(FILE列のみ)約recordCalls回 + ファイル数ぶん。
  const attachmentCalls = downloadAttachmentFiles ? 1 + recordCalls : 0;
  const schemaCalls = recordId ? 0 : 2;
  const estimatedApiCalls = 1 + 2 + recordCalls + mergeCalls + attachmentCalls + schemaCalls;

  log(recordId ? `アプリ ${appId}: レコードID ${recordId}（取得件数 ${total} 件）` : `アプリ ${appId}: 総レコード ${total} 件`);
  log(
    `推定 REST API 実行数: 約 ${estimatedApiCalls} 回（件数確認1回 + フォーム定義${2 + schemaCalls}回 + レコード取得${recordCalls}回${
      mergeCalls ? " + CSV更新用フォーム定義1回" : ""
    }${
      downloadAttachmentFiles ? ` + 添付: フォーム定義1回 + レコード再取得約${recordCalls}回 + ファイル数ぶん` : ""
    }）`
  );

  if (!yes && !confirmed) {
    if (!process.stdin.isTTY) {
      throw new Error("対話実行ではないため確認できません。実行を許可する場合は -y（または --yes）を付けてください。");
    }
    const ok = await confirmYes("続行しますか？ [y/N]");
    if (!ok) {
      log("中断しました（y が入力されませんでした）。");
      return {
        appId: String(appId),
        recordId: recordId || undefined,
        guestSpaceId,
        spaceId,
        total,
        estimatedApiCalls,
        outFile,
        attachments: downloadAttachmentFiles,
        aborted: true
      };
    }
  }

  ensureDir(recordsDir);

  let initialSchema: ReturnType<typeof recordsSchemaFromForm> | undefined;
  if (!recordId) {
    const before = await client.getAppResource("/app/form/fields.json", appId, { guestSpaceId });
    initialSchema = recordsSchemaFromForm(String(appId), before);
  }
  const stagedDir = recordId ? "" : fs.mkdtempSync(path.join(recordsDir, ".kint-origin-records-stage-"));

  // CSV 本体は cli-kintone（--attachments-dir は付けない＝FILE列はファイル名のまま）。
  const args = ["record", "export", "--app", String(appId), "--encoding", "utf8"];
  if (effectiveCondition) args.push("--condition", effectiveCondition);
  if (orderBy) args.push("--order-by", orderBy);

  if (recordId) {
    const tempDir = fs.mkdtempSync(path.join(recordsDir, ".kint-origin-record-stage-"));
    const tempFile = path.join(tempDir, "download.csv");
    const stagedCsv = path.join(tempDir, RECORDS_CSV_FILE);
    try {
      log(`レコード ${recordId} 取得中... -> ${outFile}`);
      await runCliKintoneCsvToFile(args, { cwd: recordsDir, guestSpaceId, outFile: tempFile });
      if (total === 0) throw new Error(`レコードID ${recordId} は見つかりませんでした。`);
      const recordNumberField = await getRecordNumberFieldCode(client, appId, guestSpaceId);
      if (fs.existsSync(outFile)) {
        const merged = mergeRecordCsv(fs.readFileSync(outFile, "utf8"), fs.readFileSync(tempFile, "utf8"), recordNumberField, recordId);
        recordLocalAction("merge-records-csv", stagedCsv, { appId, recordId, bytes: Buffer.byteLength(merged, "utf8") });
        fs.writeFileSync(stagedCsv, merged, "utf8");
      } else {
        const csv = fs.readFileSync(tempFile, "utf8");
        assertRecordCsvContainsId(csv, recordNumberField, recordId);
        recordLocalAction("create-records-csv", stagedCsv, { appId, recordId });
        fs.copyFileSync(tempFile, stagedCsv);
      }
      commitRecordsPair(recordsDir, stagedCsv, null, String(appId));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } else {
    const stagedCsv = path.join(stagedDir, RECORDS_CSV_FILE);
    try {
      log(`レコード取得中... -> ${outFile}`);
      await runCliKintoneCsvToFile(args, { cwd: recordsDir, guestSpaceId, outFile: stagedCsv });
      const after = await client.getAppResource("/app/form/fields.json", appId, { guestSpaceId });
      const finalSchema = recordsSchemaFromForm(String(appId), after);
      if (initialSchema?.formRevision !== finalSchema.formRevision || JSON.stringify(initialSchema.fields) !== JSON.stringify(finalSchema.fields)) {
        throw new Error(`アプリ ${appId} のフォームがレコードCSV取得中に変更されました。records.csv は更新していません。もう一度 pull records を実行してください。`);
      }
      const schemaFile = path.join(stagedDir, RECORDS_SCHEMA_FILE);
      const schema = { ...finalSchema, csvSha256: await hashFile(stagedCsv) };
      recordLocalAction("write-records-schema", schemaFile, { appId });
      fs.writeFileSync(schemaFile, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
      commitRecordsPair(recordsDir, stagedCsv, schemaFile, String(appId));
    } catch (error) {
      if (!(error instanceof Error && "preserveStage" in error)) fs.rmSync(stagedDir, { recursive: true, force: true });
      throw error;
    }
    fs.rmSync(stagedDir, { recursive: true, force: true });
  }

  // 添付ファイルは自前で attachments/<レコードID>/<フィールドコード>/ に保存する。
  let attachmentFiles: number | undefined;
  let attachmentFields: string[] | undefined;
  let attachmentFailures: number | undefined;
  if (downloadAttachmentFiles) {
    const result = await downloadAttachments({ client, appId, guestSpaceId, condition: effectiveCondition, recordsDir });
    attachmentFiles = result.files;
    attachmentFields = result.fields;
    attachmentFailures = result.failures;
  }

  return {
    appId: String(appId),
    recordId: recordId || undefined,
    guestSpaceId,
    spaceId,
    total,
    estimatedApiCalls,
    outFile,
    attachments: downloadAttachmentFiles,
    attachmentFiles,
    attachmentFields,
    attachmentFailures
  };
}

export async function pullRecords(options: PullRecordsOptions): Promise<RecordsSummary> {
  const recordsDir = path.join(
    kintoneAppRootPath({ appId: options.appId, guestSpaceId: options.guestSpaceId, spaceId: options.guestSpaceId ? "" : options.spaceId }),
    "records"
  );
  ensureDir(recordsDir);
  let release: () => void;
  try {
    release = acquireRecordsLock(recordsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`アプリ ${options.appId} のレコード取得が別の処理で実行中です。完了後に再実行してください。`);
    }
    throw error;
  }
  try {
    return await pullRecordsLocked(options);
  } finally {
    release();
  }
}
