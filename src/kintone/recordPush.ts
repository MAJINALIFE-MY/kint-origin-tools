import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { confirmYes } from "../confirm.js";
import { ensureDir, writeJson } from "../fsutil.js";
import { log } from "../log.js";
import { KintoneClient, recordsApiPath } from "./client.js";
import { assertConfirmable, backupTimestamp, buildRecoveryPlanText } from "./push.js";
import { stringifyCsv } from "./recordCsv.js";
import { executeBulks, failureNote, isUncertain, verifyTargets, writeBackup } from "./recordExec.js";
import {
  bulkify,
  buildRecordPlan,
  estimateApiCalls,
  assertLocalUploadPath,
  relativeToCwd,
  RECORDS_PER_REQUEST,
  REQUESTS_PER_BULK,
  resolveJob,
  type BackupRecord,
  type BulkGroup,
  type BulkItem,
  type RecordPlan,
  type TargetRecordPlan,
  type UploadItem
} from "./recordPlan.js";
import { buildSchemaIndex, normalizeForShow, toWritableValue, writableError, type FieldSchema, type SchemaIndex } from "./recordValues.js";
import { recordLocalAction, recordRunEvent } from "../runLog.js";

const SHOW_PAGE_SIZE = 500;
const MAX_OFFSET = 10_000;
// 値を持たない（取得できない）フィールドの型。show の既定の出力から除く。
const NO_VALUE_TYPES = new Set(["LABEL", "SPACER", "HR", "GROUP", "REFERENCE_TABLE"]);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

// ---- 実行記録フォルダ（runs/） ----

/** push/records/<ジョブ>/runs/ を作り、顧客データをコミットしないよう .gitignore（中身は *）を用意する。 */
function ensureRunsDir(jobDir: string): string {
  const runsDir = path.join(jobDir, "runs");
  ensureDir(runsDir);
  const ignore = path.join(runsDir, ".gitignore");
  if (!fs.existsSync(ignore)) {
    recordLocalAction("write-runs-gitignore", ignore);
    fs.writeFileSync(ignore, "# kint-origin: 実行記録（バックアップ・添付・プレビュー。顧客データ）はコミットしない\n*\n", "utf8");
  }
  return runsDir;
}

// ---- 同じジョブの再実行ガード ----

/** job.csv の内容のハッシュ（改行コードの違いは無視する）。 */
export function hashJobFile(jobFile: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(jobFile, "utf8").replace(/\r\n/g, "\n")).digest("hex");
}

export interface PriorRun {
  runId: string;
  state: string;
}

/**
 * 同じ入力（ハッシュが同じ）で、すでに反映された（または反映されたか分からない）実行を探す。
 * 新規レコードの作成（new:）や添付の追記（append）を含むジョブを再実行すると、重複して作られる・追記されるため、実行の前に止める。
 * 戻し済み（restored.json がある）の実行は、再実行してよい。
 */
export function findPriorRuns(jobDir: string, hash: string, kind: "push" | "import" = "push"): PriorRun[] {
  const runsDir = path.join(jobDir, "runs");
  if (!fs.existsSync(runsDir)) return [];
  const found: PriorRun[] = [];
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.endsWith("-diff") || entry.name.endsWith("-restore")) continue;
    const dir = path.join(runsDir, entry.name);
    if (fs.existsSync(path.join(dir, "restored.json"))) continue;
    try {
      const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8").replace(/^\uFEFF/, ""));
      if (result.kind !== kind || result.jobHash !== hash) continue;
      // 反映された・反映の途中・結果が不明・まだ実行中（強制終了を含む）は、再実行の前に確認が要る。確定で未反映（何も変更していない）なら再実行してよい。
      const state = result.status === "running" ? "running" : result.applied ? "applied" : result.partial ? "partial" : result.uncertain ? "uncertain" : "";
      if (state) found.push({ runId: entry.name, state });
    } catch {
      // 読めない実行記録は判断材料にしない。
    }
  }
  return found.sort((a, b) => a.runId.localeCompare(b.runId));
}

export const PRIOR_STATE_TEXT: Record<string, string> = {
  applied: "反映済み",
  partial: "一部だけ反映済み",
  uncertain: "反映されたかどうか不明",
  running: "実行中のまま記録が残っている（強制終了の可能性）"
};

export function priorRunMessage(name: string, runs: PriorRun[]): string {
  const list = runs.map((run) => "  - " + run.runId + "（" + (PRIOR_STATE_TEXT[run.state] ?? run.state) + "）").join("\n");
  return (
    "同じ内容の job.csv を、すでに実行しています:\n" +
    list +
    "\n再実行すると、新規レコードが重複して作られたり、添付が二重に追記されたりすることがあります。何も変更せずに中断しました。\n" +
    "まず kint-origin show records で現在の状態を確認してください。\n" +
    "  - 意図して再実行する場合: job.csv を編集してから実行してください（内容が変われば別のジョブとして扱います）。\n" +
    "  - 前回の結果を戻してから実行する場合: kint-origin push records --name " + name + " --restore <実行時刻>"
  );
}

/** runs/<name>。同名があれば -2, -3 … を付けて、既存の記録を上書きしない。 */
export function newRunDir(jobDir: string, name: string): string {
  const runsDir = ensureRunsDir(jobDir);
  let candidate = path.join(runsDir, name);
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(runsDir, name + "-" + n);
  ensureDir(candidate);
  return candidate;
}

// ---- show records ----

export interface ShowRecordsOptions {
  appId: string;
  guestSpaceId: string;
  recordIds?: string[];
  fields?: string[];
  condition?: string;
  orderBy?: string;
  limit: number;
}

function fieldSummary(field: FieldSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { code: field.code, type: field.type, label: field.label };
  if (field.fields) out.fields = [...field.fields.values()].map((inner) => ({ code: inner.code, type: inner.type, label: inner.label }));
  return out;
}

function andCondition(condition: string | undefined, rest: string): string {
  return condition ? "(" + condition + ") and " + rest : rest;
}

/** レコードの値を標準出力用の JSON にして返す（data/ には何も書かない。添付はファイル名とサイズだけ）。 */
export async function showRecords(options: ShowRecordsOptions): Promise<object> {
  const { appId, guestSpaceId, recordIds, condition, orderBy, limit } = options;
  const client = new KintoneClient();
  const form = await client.getAppResource("/app/form/fields.json", appId, { guestSpaceId });
  const schema = buildSchemaIndex(form?.properties ?? {});

  let shown: FieldSchema[];
  if (options.fields && options.fields.length > 0) {
    shown = options.fields.map((code) => {
      const field = schema.top.get(code);
      if (field) return field;
      throw new Error(
        schema.inner.has(code)
          ? "テーブル内のフィールドはテーブルのコード（例: " + schema.inner.get(code)?.table + "）で指定してください: " + code
          : "app " + appId + " にフィールド「" + code + "」がありません"
      );
    });
  } else {
    shown = [...schema.top.values()].filter((field) => !NO_VALUE_TYPES.has(field.type)).sort((a, b) => a.code.localeCompare(b.code, "ja"));
  }
  const requested = options.fields && options.fields.length > 0 ? ["$id", "$revision", ...options.fields] : undefined;

  const fetchPage = (query: string): Promise<any[]> => client.getRecordsByQuery(appId, { query, fields: requested, guestSpaceId });
  const collected: any[] = [];
  const want = limit + 1; // 1 件多く取って、打ち切ったかどうかを判定する。
  // order by + offset の取得は、offset の上限（10000）で止まる。まだ後ろにレコードがあるのに、上限で止めたかどうか。
  let stoppedAtOffsetCap = false;
  if (recordIds && recordIds.length > 0) {
    const ids = [...new Set(recordIds)];
    for (let i = 0; i < ids.length; i += RECORDS_PER_REQUEST) {
      const chunk = ids.slice(i, i + RECORDS_PER_REQUEST);
      collected.push(...(await fetchPage(andCondition(condition, "$id in (" + chunk.join(",") + ") limit " + RECORDS_PER_REQUEST))));
    }
    collected.sort((a, b) => Number(a.$id.value) - Number(b.$id.value));
  } else if (orderBy) {
    for (let offset = 0; collected.length < want && offset < MAX_OFFSET; offset += SHOW_PAGE_SIZE) {
      const size = Math.min(SHOW_PAGE_SIZE, want - collected.length);
      const page = await fetchPage((condition ? condition + " " : "") + "order by " + orderBy + " limit " + size + " offset " + offset);
      collected.push(...page);
      if (page.length < size) break;
      if (offset + SHOW_PAGE_SIZE >= MAX_OFFSET && collected.length < want) stoppedAtOffsetCap = true;
    }
  } else {
    let lastId = "0";
    while (collected.length < want) {
      const size = Math.min(SHOW_PAGE_SIZE, want - collected.length);
      const page = await fetchPage(andCondition(condition, "$id > " + lastId + " order by $id asc limit " + size));
      collected.push(...page);
      if (page.length < size) break;
      lastId = String(page[page.length - 1].$id.value);
    }
  }

  const truncated = collected.length > limit || stoppedAtOffsetCap;
  const records = collected.slice(0, limit).map((record) => {
    const out: Record<string, unknown> = { $id: record.$id?.value, $revision: record.$revision?.value };
    for (const field of shown) {
      if (field.code in record) out[field.code] = normalizeForShow(field, record[field.code]?.value);
    }
    return out;
  });
  log(
    "アプリ " + appId + ": " + records.length + " 件" +
      (stoppedAtOffsetCap
        ? "（--order-by の取得は先頭 " + MAX_OFFSET + " 件までです。続きは --condition で絞って取得してください）"
        : truncated
          ? "（--limit " + limit + " で打ち切り）"
          : "")
  );
  return { appId, guestSpaceId, count: records.length, truncated, fields: shown.map(fieldSummary), records };
}

// ---- diff records ----

interface AppTally {
  update: number;
  create: number;
  guestSpaceId: string;
  fields: Set<string>;
}

function tallyByApp(plan: RecordPlan): Map<string, AppTally> {
  const perApp = new Map<string, AppTally>();
  for (const target of plan.targets) {
    const entry = perApp.get(target.app) ?? { update: 0, create: 0, guestSpaceId: target.guestSpaceId, fields: new Set<string>() };
    entry[target.kind === "update" ? "update" : "create"] += 1;
    for (const code of target.touched) entry.fields.add(code);
    perApp.set(target.app, entry);
  }
  return perApp;
}

function sortedFields(fields: Set<string>): string[] {
  return [...fields].sort((a, b) => a.localeCompare(b, "ja"));
}

function planSummary(plan: RecordPlan, previewPath: string): Record<string, unknown> {
  return {
    job: plan.jobName,
    jobFile: relativeToCwd(path.join(plan.jobDir, "job.csv")),
    rows: plan.rows.length,
    targets: [...tallyByApp(plan)].map(([app, entry]) => ({
      app,
      guestSpaceId: entry.guestSpaceId,
      update: entry.update,
      create: entry.create,
      fields: sortedFields(entry.fields)
    })),
    sources: [...plan.stats.sources].map(([app, ids]) => ({ app, records: ids.size })),
    uploads: { files: plan.uploads.length, bytes: plan.stats.uploadBytes },
    backupFiles: { files: plan.stats.backupFiles, bytes: plan.stats.backupBytes },
    requests: plan.bulks.reduce((sum, group) => sum + group.requests.length, 0),
    bulks: plan.bulks.length,
    atomic: plan.bulks.length <= 1,
    estimatedApiCalls: estimateApiCalls(plan, { push: false }),
    preview: relativeToCwd(previewPath),
    warnings: plan.warnings
  };
}

function logPlan(plan: RecordPlan, previewPath: string): void {
  log("ジョブ「" + plan.jobName + "」: " + plan.rows.length + " 行");
  for (const [app, entry] of tallyByApp(plan)) {
    log("  app " + app + ": 更新 " + entry.update + " 件 / 新規 " + entry.create + " 件（フィールド: " + sortedFields(entry.fields).join(", ") + "）");
  }
  if (plan.uploads.length > 0) log("  添付のアップロード: " + plan.uploads.length + " ファイル（" + formatBytes(plan.stats.uploadBytes) + "）");
  log("  一括処理（bulkRequest）: " + plan.bulks.length + " 回");
  for (const warning of plan.warnings) log("警告: " + warning);
  log("プレビュー（変更前後）: " + relativeToCwd(previewPath));
}

/** ジョブの検証とプレビュー。GET だけを呼び、runs/<時刻>-diff/preview.csv を書く。 */
export async function diffRecords({ name }: { name: string }): Promise<object> {
  resolveJob(name); // ジョブ名・job.csv の有無は、認証値の読み込みや API より先に確認する。
  const client = new KintoneClient();
  const plan = await buildRecordPlan({ client, jobName: name });
  const runDir = newRunDir(plan.jobDir, backupTimestamp() + "-diff");
  const previewPath = path.join(runDir, "preview.csv");
  recordLocalAction("write-records-preview", previewPath, { rows: plan.preview.length });
  fs.writeFileSync(previewPath, stringifyCsv(plan.preview), "utf8");
  logPlan(plan, previewPath);
  return planSummary(plan, previewPath);
}

// ---- push records ----

/**
 * ジョブ（push/records/<ジョブ名>/job.csv）のとおりにレコードを更新・追加する。
 * 流れ: 計画（GET）→ 実行記録にプレビューと計画を保存 → 確認 → バックアップ → 一括処理で反映 → 検証。
 * レコードの書き込みに動作テスト環境は無く、運用環境へ即時に反映される。復旧は --restore。
 */
export async function pushRecords({ name, yes }: { name: string; yes: boolean }): Promise<object> {
  assertConfirmable({ yes });
  const { jobDir: guardedJobDir, jobFile } = resolveJob(name);
  // 同じ job.csv の再実行（重複作成・二重追記）は、API を呼ぶ前に止める。
  const jobHash = hashJobFile(jobFile);
  const priorRuns = findPriorRuns(guardedJobDir, jobHash);
  if (priorRuns.length > 0) throw new Error(priorRunMessage(name, priorRuns));
  const client = new KintoneClient();
  const plan = await buildRecordPlan({ client, jobName: name });

  // 確認の前に、プレビューと計画を実行記録へ書く（確認する人が変更前後を開いて見られるように）。中断したら消す。
  const runDir = newRunDir(plan.jobDir, backupTimestamp());
  const runId = path.basename(runDir);
  const restoreCommand = "kint-origin push records --name " + name + " --restore " + runId;
  const previewPath = path.join(runDir, "preview.csv");
  recordLocalAction("write-records-preview", previewPath, { rows: plan.preview.length });
  fs.writeFileSync(previewPath, stringifyCsv(plan.preview), "utf8");
  writeJson(path.join(runDir, "plan.json"), {
    schemaVersion: 1,
    job: name,
    createdAt: new Date().toISOString(),
    targets: plan.targets,
    uploads: plan.uploads,
    bulks: plan.bulks.map((group) => ({ index: group.index, guestSpaceId: group.guestSpaceId, requests: group.requests }))
  });
  logPlan(plan, previewPath);
  log("推定 REST API 数: 約" + estimateApiCalls(plan, { push: true }) + "回（確認・バックアップ・転送・書き込み・検証）");
  log(
    buildRecoveryPlanText({
      mode: "records",
      backupRoot: relativeToCwd(runDir) + "/backup/",
      restoreCommand
    })
  );
  log("この操作は運用環境のレコードを書き換えます（動作テスト環境はありません）。");
  if (!yes) {
    const ok = await confirmYes("続行しますか？ [y/N]");
    if (!ok) {
      recordLocalAction("remove-aborted-records-run", runDir);
      fs.rmSync(runDir, { recursive: true, force: true });
      log("中断しました（y が入力されませんでした）。");
      return { job: name, applied: false, aborted: true };
    }
  }

  const atomic = plan.bulks.length <= 1;
  const base = { schemaVersion: 1, kind: "push", job: name, jobHash, runId, startedAt: new Date().toISOString(), atomic, restoreCommand };
  let resultWritten = false;
  const writeResult = (extra: Record<string, unknown>): void => {
    writeJson(path.join(runDir, "result.json"), { ...base, ...extra, finishedAt: new Date().toISOString() }, { allowWhenLogUnavailable: true });
    resultWritten = true;
  };
  // 書き込みを始める前に、実行中であることを記録する。強制終了（Ctrl-C・端末の切断・停電）で最終の記録が書けなくても、
  // 同じジョブの再実行ガードが働き、どの実行かを辿れる（status: running のまま残る）。
  writeJson(path.join(runDir, "result.json"), { ...base, status: "running", applied: false, note: "実行中、または強制終了（反映されたかどうかは kint-origin show records で確認してください）。" }, { allowWhenLogUnavailable: true });
  try {
    log("バックアップを保存します...");
    const backed = await writeBackup(client, runDir, plan.backup, { job: name, runId });
    log("バックアップ: " + relativeToCwd(path.join(runDir, "backup")) + "（添付 " + backed.files + " ファイル）");

    const executed = await executeBulks({ client, groups: plan.bulks, uploads: plan.uploads, workDir: path.join(runDir, "work") });
    const before = new Map(plan.targets.flatMap((target) => (target.kind === "update" && target.id ? [[target.app + "|" + target.id, target.revision ?? ""] as const] : [])));
    const guestOf = (app: string): string => plan.apps.get(app)?.guestSpaceId ?? "";
    const updated = executed.updated.map((item) => ({
      app: item.app,
      guestSpaceId: guestOf(item.app),
      id: item.id,
      revisionBefore: before.get(item.app + "|" + item.id) ?? "",
      revisionAfter: item.revisionAfter
    }));
    const created = executed.created.map((item) => ({ ...item, guestSpaceId: guestOf(item.app) }));
    if (executed.error) {
      const done = executed.bulks.filter((item) => item.status === "ok").length;
      const note = failureNote(executed, "戻す場合: " + restoreCommand);
      writeResult({ applied: false, partial: done > 0, uncertain: isUncertain(executed.error), updated, created, bulks: executed.bulks, error: executed.error.message, note });
      throw new Error(executed.error.message + "\n" + note + "\n実行記録: " + relativeToCwd(runDir));
    }

    const verify = await verifyTargets({ client, targets: plan.targets, created: executed.created, apps: plan.apps });
    if (verify.error) log("検証を完了できませんでした: " + verify.error);
    for (const item of verify.mismatches.slice(0, 10)) {
      log("警告: 反映後の値が計画と異なります app " + item.app + " / レコード " + item.id + " / " + item.field + ": 期待「" + item.expected + "」 実際「" + item.actual + "」");
    }
    const summary = {
      job: name,
      runId,
      runDir: relativeToCwd(runDir),
      applied: true,
      atomic,
      updated,
      created,
      uploads: plan.uploads.length,
      bulks: executed.bulks,
      verify: { checked: verify.checked, mismatches: verify.mismatches, ...(verify.error ? { error: verify.error } : {}) },
      restoreCommand
    };
    writeResult(summary);
    if (verify.mismatches.length > 0 || verify.error) {
      // 反映は完了しているが、反映後の値が計画と違う（または検証できなかった）。成功と区別できるよう終了コードを 1 にする。
      process.exitCode = 1;
      log("要確認: 反映は完了していますが、反映後の値が計画と一致しない項目があります（verify.mismatches）。内容を確認し、問題があれば戻してください: " + restoreCommand);
    } else {
      log("完了しました。戻す場合: " + restoreCommand);
    }
    return summary;
  } catch (error) {
    if (!resultWritten) {
      writeResult({ applied: false, error: error instanceof Error ? error.message : String(error), note: "書き込み前に中断しました（何も変更していません）。" });
    }
    throw error;
  } finally {
    recordRunEvent("local_action", { action: "remove-records-work-directory", path: path.join(runDir, "work") });
    fs.rmSync(path.join(runDir, "work"), { recursive: true, force: true });
  }
}

// ---- push records --restore ----

/**
 * 復旧の対象になる実行の種類。push records（push/records/<ジョブ>/）と push import（push/import/<ジョブ>/）は、
 * 同じ復旧の処理を使うが、実行記録の kind とジョブの置き場が違う（result.json の kind で取り違えを防ぐ）。
 */
export interface RestoreFlavor {
  kind: "push" | "import";
  /** ジョブのフォルダ（push/records/<名前> など）。ジョブが無ければ案内して throw する。 */
  resolveJobDir: (name: string) => string;
  /** メッセージ用のジョブ置き場（例: push/records）。 */
  root: string;
  /** メッセージ用のコマンド名（例: push records）。 */
  command: string;
}

const RECORDS_FLAVOR: RestoreFlavor = {
  kind: "push",
  resolveJobDir: (name) => resolveJob(name).jobDir,
  root: "push/records",
  command: "push records"
};

interface RestoreSource {
  jobDir: string;
  sourceDir: string;
  original: any;
  backup: BackupRecord[];
}

/** 復旧元の実行記録（result.json と backup/records.json）を読む。復旧できない記録なら理由つきで throw する。 */
function loadRestoreSource(name: string, runId: string, flavor: RestoreFlavor): RestoreSource {
  const jobDir = flavor.resolveJobDir(name);
  const sourceDir = path.join(jobDir, "runs", runId);
  const resultFile = path.join(sourceDir, "result.json");
  if (!fs.existsSync(resultFile)) {
    throw new Error("実行記録が見つかりません: " + relativeToCwd(sourceDir) + "（" + flavor.root + "/" + name + "/runs/ のフォルダ名を指定してください）");
  }
  const original = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  if (original.kind === "restore") throw new Error("復旧の実行は元に戻せません: " + runId);
  if (original.kind !== flavor.kind) throw new Error("この実行記録は " + flavor.command + " の実行ではありません: " + runId);
  const restoredFile = path.join(sourceDir, "restored.json");
  if (fs.existsSync(restoredFile)) {
    throw new Error("この実行は復旧済みです（" + JSON.parse(fs.readFileSync(restoredFile, "utf8")).restoredAt + "）: " + runId);
  }
  const backupFile = path.join(sourceDir, "backup", "records.json");
  if (!fs.existsSync(backupFile)) throw new Error("バックアップが見つかりません: " + relativeToCwd(backupFile));
  return { jobDir, sourceDir, original, backup: JSON.parse(fs.readFileSync(backupFile, "utf8")).records ?? [] };
}

/** レコード ID を 100 件ずつ取得する（fields を省くと全フィールド）。ID → レコード。 */
async function fetchByIds(client: KintoneClient, app: string, guestSpaceId: string, ids: string[], fields?: string[]): Promise<Map<string, any>> {
  const found = new Map<string, any>();
  for (let i = 0; i < ids.length; i += RECORDS_PER_REQUEST) {
    const chunk = ids.slice(i, i + RECORDS_PER_REQUEST);
    const records = await client.getRecordsByQuery(app, {
      query: "$id in (" + chunk.join(",") + ") limit " + RECORDS_PER_REQUEST,
      fields: fields ? ["$id", "$revision", ...fields] : undefined,
      guestSpaceId
    });
    for (const record of records) found.set(String(record.$id?.value), record);
  }
  return found;
}

/** 同じゲストスペースの最後の一括処理に空きがあればそこへ、なければ新しい一括処理を作って追加する。 */
function appendToGroups(groups: BulkGroup[], guestSpaceId: string, items: BulkItem[]): void {
  for (const item of items) {
    let last = [...groups].reverse().find((group) => group.guestSpaceId === guestSpaceId);
    if (!last || last.requests.length >= REQUESTS_PER_BULK) {
      last = { index: groups.length + 1, guestSpaceId, requests: [] };
      groups.push(last);
    }
    last.requests.push(item);
  }
}

interface RestoreState {
  overwriteRemote: boolean;
  sourceDir: string;
  guestOf: Map<string, string>;
  schemas: Map<string, SchemaIndex>;
  uploads: UploadItem[];
  /** 復旧の前に保存する、現在の状態（更新を戻すレコードと、削除するレコード）。 */
  snapshot: BackupRecord[];
  skipped: Array<{ app: string; id: string; reason: string }>;
  conflicts: string[];
  targets: TargetRecordPlan[];
  deletes: Map<string, BulkItem[]>;
}

/** バックアップの添付ファイルを、復旧用のアップロード（"@upload:r<n>"）として登録する。 */
function restoreFiles(state: RestoreState, list: unknown, app: string): unknown[] {
  return (Array.isArray(list) ? list : []).map((file: any) => {
    const local = file.local ? path.join(state.sourceDir, ...String(file.local).split("/")) : "";
    if (!local || !fs.existsSync(local)) throw new Error("バックアップの添付ファイルが見つかりません: " + String(file.local ?? file.name));
    assertLocalUploadPath(local, state.sourceDir);
    const size = fs.statSync(local).size;
    const id = "r" + (state.uploads.length + 1);
    state.uploads.push({ id, source: { type: "local", path: local, root: state.sourceDir, name: file.name, size }, targetGuestSpaceId: state.guestOf.get(app) ?? "" });
    return { fileKey: "@upload:" + id };
  });
}

/** バックアップの値で、更新したレコードを元に戻す PUT を組み立てる。実行後に変わっていたレコードは conflicts に入れる。 */
async function collectUpdateRestores(client: KintoneClient, state: RestoreState, source: RestoreSource): Promise<void> {
  const updatedList: Array<{ app: string; id: string; revisionAfter: string }> = source.original.updated ?? [];
  const restorable = new Set(updatedList.map((item) => item.app + "|" + item.id));
  const backups = source.backup.filter((item) => restorable.has(item.app + "|" + item.id));
  for (const app of [...new Set(backups.map((item) => item.app))]) {
    const guestSpaceId = state.guestOf.get(app) ?? "";
    const schema = state.schemas.get(app) as SchemaIndex;
    const mine = backups.filter((item) => item.app === app);
    const codes = [...new Set(mine.flatMap((item) => Object.keys(item.fields)))];
    const current = await fetchByIds(client, app, guestSpaceId, mine.map((item) => item.id), codes);
    for (const item of mine) {
      const now = current.get(item.id);
      if (!now) {
        state.skipped.push({ app, id: item.id, reason: "レコードが存在しません（削除されています）" });
        continue;
      }
      const after = updatedList.find((entry) => entry.app === app && entry.id === item.id)?.revisionAfter;
      const revision = String(now.$revision?.value ?? "");
      if (revision !== after) state.conflicts.push("app " + app + " / レコード " + item.id + "（実行後のリビジョン " + after + " → 現在 " + revision + "）");

      const record: Record<string, { value: unknown }> = {};
      for (const [code, raw] of Object.entries(item.fields)) {
        const field = schema.top.get(code);
        if (!field || writableError(field, { isNew: false })) continue;
        const value = (raw as any)?.value;
        if (field.type === "FILE") {
          record[code] = { value: restoreFiles(state, value, app) };
        } else if (field.type === "SUBTABLE") {
          // 今も残っている行は ID つき（その行を更新）、実行後に消えた行は ID なし（新規行として戻す）。バックアップに無い行は送らない（削除）。
          const existing = new Set(((now[code]?.value as any[]) ?? []).map((row) => String(row.id)));
          record[code] = {
            value: ((value as any[]) ?? []).map((row) => {
              const cells: Record<string, { value: unknown }> = {};
              for (const [innerCode, cell] of Object.entries((row.value ?? {}) as Record<string, any>)) {
                const inner = field.fields?.get(innerCode);
                if (!inner || writableError(inner, { isNew: false })) continue;
                cells[innerCode] = { value: inner.type === "FILE" ? restoreFiles(state, cell?.value, app) : toWritableValue(inner, cell?.value) };
              }
              return existing.has(String(row.id)) ? { id: row.id, value: cells } : { value: cells };
            })
          };
        } else {
          record[code] = { value: toWritableValue(field, value) };
        }
      }
      state.snapshot.push({ app, guestSpaceId, id: item.id, revision, fields: Object.fromEntries(Object.keys(item.fields).map((code) => [code, now[code] ?? { value: null }])) });
      state.targets.push({
        app,
        guestSpaceId,
        kind: "update",
        id: item.id,
        revision: state.overwriteRemote ? undefined : revision,
        firstLine: 0,
        record,
        touched: Object.keys(record),
        expected: []
      });
    }
  }
}

/** 実行で作成したレコードを削除する DELETE を組み立てる。作成後に変わっていたレコードは conflicts に入れる。 */
async function collectDeleteRestores(client: KintoneClient, state: RestoreState, source: RestoreSource): Promise<void> {
  const createdList: Array<{ app: string; id: string; revision: string }> = source.original.created ?? [];
  for (const app of [...new Set(createdList.map((item) => item.app))]) {
    const guestSpaceId = state.guestOf.get(app) ?? "";
    const mine = createdList.filter((item) => item.app === app);
    const current = await fetchByIds(client, app, guestSpaceId, mine.map((item) => item.id));
    const present = mine.filter((item) => {
      const now = current.get(item.id);
      if (!now) state.skipped.push({ app, id: item.id, reason: "作成したレコードは既に存在しません" });
      else if (String(now.$revision?.value) !== item.revision) {
        state.conflicts.push("app " + app + " / 作成したレコード " + item.id + "（作成時のリビジョン " + item.revision + " → 現在 " + now.$revision?.value + "）");
      }
      return Boolean(now);
    });
    for (let i = 0; i < present.length; i += RECORDS_PER_REQUEST) {
      const chunk = present.slice(i, i + RECORDS_PER_REQUEST);
      const ids = chunk.map((item) => item.id);
      const revisions = chunk.map((item) => String(current.get(item.id)?.$revision?.value ?? ""));
      const item: BulkItem = {
        method: "DELETE",
        api: recordsApiPath(guestSpaceId),
        payload: { app, ids, ...(state.overwriteRemote ? {} : { revisions }) },
        meta: { app, kind: "delete", ids }
      };
      state.deletes.set(guestSpaceId, [...(state.deletes.get(guestSpaceId) ?? []), item]);
    }
    // 削除は元に戻せないため、削除する前の値と添付を復旧の実行記録に残す。
    for (const item of present) {
      const fields: Record<string, any> = {};
      for (const [code, value] of Object.entries(current.get(item.id) ?? {})) if (!code.startsWith("$")) fields[code] = value;
      state.snapshot.push({ app, guestSpaceId, id: item.id, revision: String(current.get(item.id)?.$revision?.value ?? ""), fields });
    }
  }
}

/**
 * push records の実行をバックアップから元に戻す。更新したレコードはバックアップの値へ、その実行で作成したレコードは削除する。
 * 実行後に他の人が編集したレコードがあれば、一覧を出して中断する（--overwrite-remote で上書きして戻す）。
 */
export function restoreRecords(options: { name: string; runId: string; yes: boolean; overwriteRemote: boolean }): Promise<object> {
  return restoreRun({ ...options, flavor: RECORDS_FLAVOR });
}

/** push records と push import に共通の復旧。flavor で、実行記録の種類とジョブの置き場を切り替える。 */
export async function restoreRun({
  name,
  runId,
  yes,
  overwriteRemote,
  flavor
}: {
  name: string;
  runId: string;
  yes: boolean;
  overwriteRemote: boolean;
  flavor: RestoreFlavor;
}): Promise<object> {
  assertConfirmable({ yes });
  const source = loadRestoreSource(name, runId, flavor);
  const client = new KintoneClient();

  const guestOf = new Map<string, string>();
  const known = [...source.backup, ...(source.original.updated ?? []), ...(source.original.created ?? [])] as Array<{ app: string; guestSpaceId?: string }>;
  for (const item of known) if (item.guestSpaceId !== undefined) guestOf.set(item.app, item.guestSpaceId);
  const schemas = new Map<string, SchemaIndex>();
  for (const app of [...new Set(known.map((item) => item.app))]) {
    const form = await client.getAppResource("/app/form/fields.json", app, { guestSpaceId: guestOf.get(app) ?? "" });
    schemas.set(app, buildSchemaIndex(form?.properties ?? {}));
  }
  const state: RestoreState = { overwriteRemote, sourceDir: source.sourceDir, guestOf, schemas, uploads: [], snapshot: [], skipped: [], conflicts: [], targets: [], deletes: new Map() };
  await collectUpdateRestores(client, state, source);
  await collectDeleteRestores(client, state, source);
  if (state.conflicts.length > 0 && !overwriteRemote) {
    throw new Error(
      "実行後に他の人が編集したレコードがあります（上書きして戻すと、その編集は失われます）:\n" +
        state.conflicts.map((item) => "  - " + item).join("\n") +
        "\n内容を確認し、上書きして戻してよければ --overwrite-remote を付けて再実行してください。"
    );
  }
  for (const item of state.skipped) log("対象外: app " + item.app + " / レコード " + item.id + "（" + item.reason + "）");
  if (state.targets.length === 0 && state.deletes.size === 0) {
    log("戻す対象がありません。");
    return { job: name, restoreOf: runId, applied: false, nothingToRestore: true, skipped: state.skipped };
  }

  const groups = bulkify(state.targets);
  const guests = [...state.deletes.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : Number(a) - Number(b)));
  for (const guestSpaceId of guests) appendToGroups(groups, guestSpaceId, state.deletes.get(guestSpaceId) ?? []);
  const deleting = [...state.deletes.values()].flat().reduce((sum, item) => sum + (((item.payload as { ids?: unknown[] }).ids ?? []).length), 0);
  log("復旧: 更新を戻す " + state.targets.length + " 件 / 作成したレコードを削除 " + deleting + " 件（一括処理 " + groups.length + " 回）");
  if (overwriteRemote && state.conflicts.length > 0) log("警告: 実行後に編集されたレコードも上書きして戻します（" + state.conflicts.length + " 件）。");
  log("この操作は運用環境のレコードを書き換え、作成したレコードを削除します。削除前の値と添付は復旧の実行記録（runs/）に保存します。");
  if (!yes) {
    const ok = await confirmYes("続行しますか？ [y/N]");
    if (!ok) {
      log("中断しました（y が入力されませんでした）。");
      return { job: name, restoreOf: runId, applied: false, aborted: true };
    }
  }

  const restoreDir = newRunDir(source.jobDir, backupTimestamp() + "-restore");
  const restoreId = path.basename(restoreDir);
  const base = { schemaVersion: 1, kind: "restore", job: name, restoreOf: runId, runId: restoreId, startedAt: new Date().toISOString() };
  let resultWritten = false;
  const writeResult = (extra: Record<string, unknown>): void => {
    writeJson(path.join(restoreDir, "result.json"), { ...base, ...extra, finishedAt: new Date().toISOString() }, { allowWhenLogUnavailable: true });
    resultWritten = true;
  };
  try {
    const saved = await writeBackup(client, restoreDir, state.snapshot, { job: name, restoreOf: runId });
    log("復旧前の状態を保存しました: " + relativeToCwd(path.join(restoreDir, "backup")) + "（添付 " + saved.files + " ファイル）");
    const executed = await executeBulks({ client, groups, uploads: state.uploads, workDir: path.join(restoreDir, "work") });
    if (executed.error) {
      const done = executed.bulks.filter((item) => item.status === "ok").length;
      const note = failureNote(executed, "残りは --overwrite-remote を付けて同じコマンドを再実行してください（戻し済みのレコードも同じ値で上書きされます）。");
      writeResult({ applied: false, partial: done > 0, uncertain: isUncertain(executed.error), updated: executed.updated, deleted: executed.deleted, bulks: executed.bulks, error: executed.error.message, note });
      throw new Error(executed.error.message + "\n" + note + "\n実行記録: " + relativeToCwd(restoreDir));
    }
    writeJson(path.join(source.sourceDir, "restored.json"), { restoredAt: new Date().toISOString(), restoreRunId: restoreId });
    const summary = {
      job: name,
      runId: restoreId,
      restoreOf: runId,
      runDir: relativeToCwd(restoreDir),
      applied: true,
      restored: executed.updated.length,
      deleted: executed.deleted.length,
      skipped: state.skipped,
      bulks: executed.bulks
    };
    writeResult(summary);
    log("復旧しました。");
    return summary;
  } catch (error) {
    if (!resultWritten) writeResult({ applied: false, error: error instanceof Error ? error.message : String(error), note: "書き込み前に中断しました（何も変更していません）。" });
    throw error;
  } finally {
    recordRunEvent("local_action", { action: "remove-records-restore-work-directory", path: path.join(restoreDir, "work") });
    fs.rmSync(path.join(restoreDir, "work"), { recursive: true, force: true });
  }
}
