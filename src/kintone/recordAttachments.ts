import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { ensureDir } from "../fsutil.js";
import { log } from "../log.js";
import { sanitizeFileName } from "../normalize.js";
import { createLimiter, type Limiter } from "../limit.js";
import { KintoneClient } from "./client.js";

const RECORDS_PER_REQUEST = 500;
// 添付 DL の同時実行数。レコード CSV 取得と並走することがあるため控えめにする。
const ATTACHMENT_CONCURRENCY = 4;
const ATTACHMENT_MANIFEST = ".kint-origin-attachments.json";

interface KintoneFileValue {
  fileKey: string;
  name: string;
  contentType?: string;
  size?: string;
}

export interface AttachmentsSummary {
  fields: string[];
  files: number;
  failures: number;
}

interface ManagedAttachment {
  name: string;
  storedName: string;
  sha256: string;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function safeFieldDir(recordsDir: string, recordId: string, fieldCode: string): string {
  if (!/^[1-9]\d*$/.test(recordId) || !fieldCode || fieldCode === "." || fieldCode === ".." || /[\\/]/.test(fieldCode) || sanitizeFileName(fieldCode) !== fieldCode) {
    throw new Error("添付先のレコード ID またはフィールドコードがパスとして不正です");
  }
  return path.join(recordsDir, "attachments", recordId, fieldCode);
}

function readManifest(filePath: string): ManagedAttachment[] {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`添付管理 JSON が通常ファイルではありません: ${filePath}`);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { schemaVersion?: number; files?: unknown };
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.files)) throw new Error(`添付管理 JSON の形式が不正です: ${filePath}`);
  return parsed.files.map((item: any) => {
    if (!item || typeof item.name !== "string" || typeof item.storedName !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw new Error(`添付管理 JSON に不正なファイル情報があります: ${filePath}`);
    }
    if (!item.storedName || item.storedName === "." || item.storedName === ".." || /[\\/]/.test(item.storedName)) {
      throw new Error(`添付管理 JSON の保存名が不正です: ${filePath}`);
    }
    return { name: item.name, storedName: item.storedName, sha256: item.sha256 };
  });
}

function suffixedName(name: string, suffix: string): string {
  const extension = path.extname(name);
  return extension ? `${name.slice(0, -extension.length)}-${suffix}${extension}` : `${name}-${suffix}`;
}

function assertPlainFileOrMissing(filePath: string): boolean {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`添付保存先が通常ファイルではありません: ${filePath}`);
  return true;
}

// フォーム定義から、添付(FILE)フィールドのコードを収集する。
// トップレベルの FILE と、サブテーブル配下の FILE サブフィールドの両方を対象にする。
function collectFileFieldCodes(properties: Record<string, any>): { topLevel: string[]; subtable: string[]; all: string[] } {
  const topLevel: string[] = [];
  const subtable: string[] = [];
  for (const prop of Object.values(properties)) {
    if (!prop || typeof prop !== "object") continue;
    if (prop.type === "FILE" && prop.code) {
      topLevel.push(prop.code);
    } else if (prop.type === "SUBTABLE" && prop.fields) {
      for (const sub of Object.values(prop.fields as Record<string, any>)) {
        if (sub && sub.type === "FILE" && sub.code) subtable.push(sub.code);
      }
    }
  }
  // レコード取得時の fields 指定にはサブテーブル本体のコードが要るため、サブテーブルコードも集める。
  const subtableContainerCodes: string[] = [];
  for (const prop of Object.values(properties)) {
    if (prop && prop.type === "SUBTABLE" && prop.fields) {
      const hasFile = Object.values(prop.fields as Record<string, any>).some((s: any) => s?.type === "FILE");
      if (hasFile && prop.code) subtableContainerCodes.push(prop.code);
    }
  }
  return { topLevel, subtable, all: [...topLevel, ...subtableContainerCodes] };
}

// 1レコード内の指定フィールド値を一時領域へ全件取得してから確定する。
// 同一 fileKey の重複だけをまとめ、同名の別添付はハッシュsuffixで両方保存する。
// limiter を渡すと個々の DL がその並列枠を使う（フィールド間・レコード間の並列は呼び出し側が担う）。
export async function saveAttachmentFiles(
  client: KintoneClient,
  guestSpaceId: string,
  recordsDir: string,
  recordId: string,
  fieldCode: string,
  files: KintoneFileValue[],
  limiter?: Limiter
): Promise<{ saved: number; failed: number }> {
  if (!Array.isArray(files)) return { saved: 0, failed: 1 };
  const dir = safeFieldDir(recordsDir, recordId, fieldCode);
  ensureDir(dir);
  const manifestPath = path.join(dir, ATTACHMENT_MANIFEST);
  let previous: ManagedAttachment[];
  try {
    previous = readManifest(manifestPath);
  } catch (error) {
    log(`添付フィールドを保持: record ${recordId} / ${fieldCode}: ${(error as Error).message}`);
    return { saved: 0, failed: files.length };
  }
  const stageDir = fs.mkdtempSync(path.join(dir, ".kint-origin-stage-"));
  const run: Limiter = limiter ?? ((task) => task());
  const downloaded: Array<ManagedAttachment & { stagedPath: string; fileKey: string }> = [];
  let downloadedCount = 0;
  let failures = 0;
  try {
    for (const [index, file] of files.entries()) {
      if (!file?.fileKey || typeof file.name !== "string") {
        failures += 1;
        continue;
      }
      try {
        const stagedPath = path.join(stageDir, `${index + 1}.blob`);
        await run(() => client.downloadFileTo(file.fileKey, stagedPath, { guestSpaceId }));
        downloaded.push({ name: file.name, storedName: "", sha256: await hashFile(stagedPath), stagedPath, fileKey: file.fileKey });
        downloadedCount += 1;
      } catch (error) {
        failures += 1;
        log(`添付取得失敗 record ${recordId} / ${fieldCode} / ${file.name}: ${(error as Error).message}`);
      }
    }
    if (failures > 0) return { saved: 0, failed: failures };

    // 同じ fileKey の重複参照は1ファイルにまとめる。同名でも fileKey が異なる添付は全て保持する。
    const uniqueByFileKey = new Map<string, (typeof downloaded)[number]>();
    for (const item of downloaded) uniqueByFileKey.set(item.fileKey, item);
    const assigned = new Set<string>();
    const next: ManagedAttachment[] = [];
    const installs: Array<{ src: string; dest: string; replace: boolean }> = [];
    for (const item of uniqueByFileKey.values()) {
      const normalName = sanitizeFileName(item.name);
      let storedName = previous.find((entry) => entry.name === item.name && entry.sha256 === item.sha256)?.storedName || normalName;
      const prior = previous.find((entry) => entry.storedName === storedName);
      const dest = path.join(dir, storedName);
      const exists = assertPlainFileOrMissing(dest);
      const existingHash = exists ? await hashFile(dest) : "";
      const managedAndUntouched = Boolean(prior && existingHash === prior.sha256);
      const sameBytes = exists && existingHash === item.sha256;
      const collision = assigned.has(storedName.toLocaleLowerCase()) || (exists && !managedAndUntouched && !sameBytes);
      if (collision) {
        const base = suffixedName(normalName, item.sha256.slice(0, 12));
        storedName = base;
        let suffix = 2;
        while (assigned.has(storedName.toLocaleLowerCase()) || assertPlainFileOrMissing(path.join(dir, storedName))) {
          storedName = suffixedName(normalName, `${item.sha256.slice(0, 12)}-${suffix++}`);
        }
      }
      assigned.add(storedName.toLocaleLowerCase());
      item.storedName = storedName;
      next.push({ name: item.name, storedName, sha256: item.sha256 });
      const target = path.join(dir, storedName);
      if (!assertPlainFileOrMissing(target) || (await hashFile(target)) !== item.sha256) installs.push({ src: item.stagedPath, dest: target, replace: assertPlainFileOrMissing(target) });
    }

    const backups: Array<{ dest: string; backup: string }> = [];
    const created: string[] = [];
    const manifestPart = path.join(stageDir, ATTACHMENT_MANIFEST);
    fs.writeFileSync(manifestPart, `${JSON.stringify({ schemaVersion: 1, files: next }, null, 2)}\n`, "utf8");
    const manifestExists = assertPlainFileOrMissing(manifestPath);
    const manifestBackup = manifestExists ? path.join(stageDir, "old-manifest.json") : "";
    let manifestInstalled = false;
    try {
      for (const install of installs) {
        if (install.replace) {
          const backup = path.join(stageDir, `backup-${backups.length + 1}`);
          fs.renameSync(install.dest, backup);
          backups.push({ dest: install.dest, backup });
        }
        fs.renameSync(install.src, install.dest);
        created.push(install.dest);
      }
      if (manifestBackup) fs.renameSync(manifestPath, manifestBackup);
      fs.renameSync(manifestPart, manifestPath);
      manifestInstalled = true;
    } catch (error) {
      for (const file of created) fs.rmSync(file, { force: true });
      for (const item of backups.reverse()) if (fs.existsSync(item.backup)) fs.renameSync(item.backup, item.dest);
      if (manifestBackup && fs.existsSync(manifestBackup)) fs.renameSync(manifestBackup, manifestPath);
      throw error;
    }
    if (manifestInstalled) {
      for (const old of previous) {
        if (next.some((item) => item.storedName === old.storedName)) continue;
        const oldPath = path.join(dir, old.storedName);
        try {
          if (assertPlainFileOrMissing(oldPath) && (await hashFile(oldPath)) === old.sha256) fs.rmSync(oldPath, { force: true });
        } catch (error) {
          log(`管理済みの古い添付を削除できませんでした: ${oldPath}: ${(error as Error).message}`);
        }
      }
    }
    return { saved: downloadedCount, failed: 0 };
  } catch (error) {
    log(`添付フィールドを保持: record ${recordId} / ${fieldCode}: ${(error as Error).message}`);
    return { saved: 0, failed: Math.max(1, failures) };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

// 指定アプリの添付ファイル実体を全レコード分ダウンロードし、
// records/attachments/<レコードID>/<フィールドコード>/<ファイル名> に保存する。
export async function downloadAttachments({
  client,
  appId,
  guestSpaceId = "",
  condition = "",
  recordsDir
}: {
  client: KintoneClient;
  appId: string | number;
  guestSpaceId?: string;
  condition?: string;
  recordsDir: string;
}): Promise<AttachmentsSummary> {
  const form = await client.getAppResource("/app/form/fields.json", appId, { guestSpaceId });
  const { topLevel, subtable, all } = collectFileFieldCodes(form?.properties || {});
  const subtableFileCodes = new Map<string, string[]>();
  for (const prop of Object.values(form?.properties || {}) as any[]) {
    if (prop?.type === "SUBTABLE" && prop.code && prop.fields) {
      const codes = Object.values(prop.fields as Record<string, any>).filter((field: any) => field?.type === "FILE" && field.code).map((field: any) => String(field.code));
      if (codes.length) subtableFileCodes.set(String(prop.code), codes);
    }
  }

  if (all.length === 0) {
    log("添付(FILE)フィールドが無いため、添付ファイルのダウンロードはありません。");
    return { fields: [], files: 0, failures: 0 };
  }
  log(`添付フィールド: ${[...topLevel, ...subtable].join(", ")}`);

  let files = 0;
  let failures = 0;
  let lastId = "0";
  const conditionPrefix = condition ? `(${condition}) and ` : "";
  // ページ内の全 DL で共有する limiter（常時最大 ATTACHMENT_CONCURRENCY 本の DL に抑える）。
  const limiter = createLimiter(ATTACHMENT_CONCURRENCY);
  // $id シークで全件走査（offset の1万件上限を回避）。fields は $id と FILE 関連だけに絞る。
  while (true) {
    const query = `${conditionPrefix}$id > ${lastId} order by $id asc limit ${RECORDS_PER_REQUEST}`;
    const payload = await client.request("/records.json", {
      method: "GET",
      guestSpaceId,
      query: { app: appId, fields: ["$id", ...all], query }
    });
    if (!payload || !Array.isArray(payload.records)) throw new Error("添付レコード取得 API の応答に records 配列がありません。添付を変更せず中断しました。");
    const records: any[] = payload.records;
    if (records.length === 0) break;
    let pageLastId = lastId;
    for (const record of records) {
      const recordId = String(record?.$id?.value ?? "");
      if (!/^[1-9]\d*$/.test(recordId) || Number(recordId) <= Number(pageLastId)) throw new Error("添付レコード取得 API の $id が不正または昇順ではありません。添付を変更せず中断しました。");
      pageLastId = recordId;
    }

    // (recordId, fieldCode) 単位でファイルをまとめてから保存する。
    // 同一ディレクトリへの保存は saveAttachmentFiles 内で直列（同名の別添付は両方保持）、
    // レコード間・フィールド間は limiter の範囲で並列に走らせる。
    const saveTasks: Array<Promise<{ saved: number; failed: number }>> = [];
    for (const record of records) {
      const recordId = String(record?.$id?.value ?? "");
      if (!recordId) continue;
      const filesByField = new Map<string, KintoneFileValue[]>();
      // トップレベル FILE
      for (const code of topLevel) {
        const value = record[code]?.value;
        if (Array.isArray(value)) filesByField.set(code, value);
      }
      // サブテーブル内 FILE（全行を <recordId>/<サブフィールドコード>/ に集約。行順を維持）
      for (const [containerCode, prop] of Object.entries(record)) {
        const value = (prop as any)?.value;
        if (!Array.isArray(value)) continue;
        const looksLikeSubtable = value.every((row: any) => row && typeof row === "object" && "value" in row);
        if (!looksLikeSubtable) continue;
        const innerFileCodes = subtableFileCodes.get(containerCode) ?? [];
        for (const code of innerFileCodes) {
          if (!filesByField.has(code)) filesByField.set(code, []);
        }
        for (const row of value) {
          for (const code of innerFileCodes) {
            const cell = row.value?.[code];
            if (cell?.type === "FILE" && Array.isArray(cell.value)) {
              filesByField.set(code, [...(filesByField.get(code) ?? []), ...cell.value]);
            }
          }
        }
      }
      for (const [code, fieldFiles] of filesByField) {
        saveTasks.push(saveAttachmentFiles(client, guestSpaceId, recordsDir, recordId, code, fieldFiles, limiter));
      }
    }
    for (const result of await Promise.all(saveTasks)) {
      files += result.saved;
      failures += result.failed;
    }

    lastId = pageLastId;
    if (records.length < RECORDS_PER_REQUEST) break;
  }

  log(`添付ファイル保存: ${files} 件${failures ? `（失敗 ${failures} 件）` : ""}`);
  return { fields: [...topLevel, ...subtable], files, failures };
}
