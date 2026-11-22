// 更新キー付き CSV の一括取込。バックアップ・実行・検証・復旧は push records と処理を共有する。

import fs from "node:fs";
import path from "node:path";
import { confirmYes } from "../confirm.js";
import { writeJson } from "../fsutil.js";
import { log } from "../log.js";
import { KintoneClient } from "./client.js";
import { assertConfirmable, backupTimestamp, buildRecoveryPlanText } from "./push.js";
import { stringifyCsv } from "./recordCsv.js";
import { executeBulks, failureNote, isUncertain, verifyTargets, writeBackup } from "./recordExec.js";
import { buildImportPlan, estimateImportApiCalls, loadImportJob, resolveImportJob, type ImportPlan } from "./recordImport.js";
import { relativeToCwd } from "./recordPlan.js";
import { recordLocalAction, recordRunEvent } from "../runLog.js";
import { findPriorRuns, newRunDir, PRIOR_STATE_TEXT, restoreRun, type PriorRun, type RestoreFlavor } from "./recordPush.js";

/** push import の実行記録を --restore で戻すための設定（push/import/<ジョブ名>/runs/ の kind: "import"）。 */
const IMPORT_FLAVOR: RestoreFlavor = {
  kind: "import",
  resolveJobDir: (name) => resolveImportJob(name).jobDir,
  root: "push/import",
  command: "push import"
};

function changedFields(plan: ImportPlan): string[] {
  return [...new Set(plan.targets.flatMap((target) => target.touched))].sort((a, b) => a.localeCompare(b, "ja"));
}

function importPlanSummary(plan: ImportPlan, previewPath: string): Record<string, unknown> {
  return {
    job: plan.jobName,
    importFile: relativeToCwd(path.join(plan.jobDir, "import.json")),
    recordsFile: relativeToCwd(path.join(plan.jobDir, "records.csv")),
    app: plan.app,
    guestSpaceId: plan.guestSpaceId,
    updateKey: plan.updateKey,
    rows: plan.rows,
    update: plan.stats.updates,
    create: plan.stats.creates,
    unchanged: plan.stats.unchanged,
    fields: changedFields(plan),
    requests: plan.bulks.reduce((sum, group) => sum + group.requests.length, 0),
    bulks: plan.bulks.length,
    atomic: plan.bulks.length <= 1,
    estimatedApiCalls: estimateImportApiCalls(plan, { push: false }),
    preview: relativeToCwd(previewPath),
    warnings: plan.warnings
  };
}

function logImportPlan(plan: ImportPlan, previewPath: string): void {
  log("ジョブ「" + plan.jobName + "」: app " + plan.app + " / 更新キー「" + plan.updateKey + "」/ CSV " + plan.rows + " 行");
  log("  更新 " + plan.stats.updates + " 件 / 新規 " + plan.stats.creates + " 件 / 変更なし " + plan.stats.unchanged + " 件（フィールド: " + changedFields(plan).join(", ") + "）");
  log("  一括処理（bulkRequest）: " + plan.bulks.length + " 回");
  for (const warning of plan.warnings) log("警告: " + warning);
  log("プレビュー（変更前後）: " + relativeToCwd(previewPath));
}

/** ジョブの検証とプレビュー。GET だけを呼び、runs/<時刻>-diff/preview.csv を書く。 */
export async function diffImport({ name }: { name: string }): Promise<object> {
  const job = loadImportJob(name); // ジョブ名・入力ファイルは、認証値の読み込みや API より先に確認する。
  const client = new KintoneClient();
  const plan = await buildImportPlan({ client, job });
  const runDir = newRunDir(plan.jobDir, backupTimestamp() + "-diff");
  const previewPath = path.join(runDir, "preview.csv");
  recordLocalAction("write-import-preview", previewPath, { rows: plan.preview.length });
  fs.writeFileSync(previewPath, stringifyCsv(plan.preview), "utf8");
  logImportPlan(plan, previewPath);
  if (plan.targets.length === 0) log("変更も追加もありません（push import を実行しても何も送りません）。");
  return importPlanSummary(plan, previewPath);
}

function importPriorRunMessage(name: string, runs: PriorRun[]): string {
  const list = runs.map((run) => "  - " + run.runId + "（" + (PRIOR_STATE_TEXT[run.state] ?? run.state) + "）").join("\n");
  return (
    "同じ内容の import.json と records.csv を、すでに実行しています:\n" +
    list +
    "\n再実行すると、反映の状況によっては新規レコードが重複して作られることがあります（更新キーが環境に無い行は、一致するまで毎回新規追加されます）。何も変更せずに中断しました。\n" +
    "まず kint-origin show records で現在の状態を確認してください。\n" +
    "  - 意図して再実行する場合: records.csv か import.json を編集してから実行してください（内容が変われば別のジョブとして扱います）。\n" +
    "  - 前回の結果を戻してから実行する場合: kint-origin push import --name " + name + " --restore <実行時刻>"
  );
}

/**
 * ジョブ（push/import/<ジョブ名>/）のとおりに、更新キーが一致するレコードは更新、無ければ追加する。
 * 流れ: 計画（GET）→ 実行記録にプレビューと計画を保存 → 確認 → バックアップ → 一括処理で反映 → 検証。
 * レコードの書き込みに動作テスト環境は無く、運用環境へ即時に反映される。復旧は --restore。
 */
export async function pushImport({ name, yes }: { name: string; yes: boolean }): Promise<object> {
  assertConfirmable({ yes });
  const job = loadImportJob(name);
  // 同じ入力の再実行（新規レコードの重複作成）は、API を呼ぶ前に止める。
  const priorRuns = findPriorRuns(job.jobDir, job.hash, "import");
  if (priorRuns.length > 0) throw new Error(importPriorRunMessage(name, priorRuns));
  const client = new KintoneClient();
  const plan = await buildImportPlan({ client, job });
  if (plan.targets.length === 0) {
    for (const warning of plan.warnings) log("警告: " + warning);
    log("変更も追加もありません（CSV " + plan.rows + " 行は、すべて環境の値と同じです）。何も送らずに終了します。");
    return { job: name, applied: false, nothingToDo: true, rows: plan.rows, update: 0, create: 0, unchanged: plan.stats.unchanged, warnings: plan.warnings };
  }

  // 確認の前に、プレビューと計画を実行記録へ書く（確認する人が変更前後を開いて見られるように）。中断したら消す。
  const runDir = newRunDir(plan.jobDir, backupTimestamp());
  const runId = path.basename(runDir);
  const restoreCommand = "kint-origin push import --name " + name + " --restore " + runId;
  const previewPath = path.join(runDir, "preview.csv");
  recordLocalAction("write-import-preview", previewPath, { rows: plan.preview.length });
  fs.writeFileSync(previewPath, stringifyCsv(plan.preview), "utf8");
  writeJson(path.join(runDir, "plan.json"), {
    schemaVersion: 1,
    kind: "import",
    job: name,
    createdAt: new Date().toISOString(),
    app: plan.app,
    guestSpaceId: plan.guestSpaceId,
    updateKey: plan.updateKey,
    targets: plan.targets,
    bulks: plan.bulks.map((group) => ({ index: group.index, guestSpaceId: group.guestSpaceId, requests: group.requests }))
  });
  logImportPlan(plan, previewPath);
  log("推定 REST API 数: 約" + estimateImportApiCalls(plan, { push: true }) + "回（確認・バックアップ・書き込み・検証）");
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
      recordLocalAction("remove-aborted-import-run", runDir);
      fs.rmSync(runDir, { recursive: true, force: true });
      log("中断しました（y が入力されませんでした）。");
      return { job: name, applied: false, aborted: true };
    }
  }

  const atomic = plan.bulks.length <= 1;
  const base = { schemaVersion: 1, kind: "import", job: name, jobHash: job.hash, runId, startedAt: new Date().toISOString(), atomic, restoreCommand };
  let resultWritten = false;
  const writeResult = (extra: Record<string, unknown>): void => {
    writeJson(path.join(runDir, "result.json"), { ...base, ...extra, finishedAt: new Date().toISOString() }, { allowWhenLogUnavailable: true });
    resultWritten = true;
  };
  // 書き込みを始める前に、実行中であることを記録する。強制終了で最終の記録が書けなくても、同じ入力の再実行ガードが働く。
  writeJson(path.join(runDir, "result.json"), { ...base, status: "running", applied: false, note: "実行中、または強制終了（kint-origin show records で状態を確認してください）。" }, { allowWhenLogUnavailable: true });
  try {
    log("バックアップを保存します...");
    await writeBackup(client, runDir, plan.backup, { job: name, runId });
    log("バックアップ: " + relativeToCwd(path.join(runDir, "backup")) + "（" + plan.backup.length + " 件）");

    const executed = await executeBulks({ client, groups: plan.bulks, uploads: [], workDir: path.join(runDir, "work") });
    const before = new Map(plan.targets.flatMap((target) => (target.kind === "update" && target.id ? [[target.app + "|" + target.id, target.revision ?? ""] as const] : [])));
    const updated = executed.updated.map((item) => ({
      app: item.app,
      guestSpaceId: plan.guestSpaceId,
      id: item.id,
      revisionBefore: before.get(item.app + "|" + item.id) ?? "",
      revisionAfter: item.revisionAfter
    }));
    const created = executed.created.map((item) => ({ ...item, guestSpaceId: plan.guestSpaceId }));
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
      rows: plan.rows,
      unchanged: plan.stats.unchanged,
      updated,
      created,
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
    recordRunEvent("local_action", { action: "remove-import-work-directory", path: path.join(runDir, "work") });
    fs.rmSync(path.join(runDir, "work"), { recursive: true, force: true });
  }
}

/**
 * push import の実行をバックアップから元に戻す。更新したレコードはバックアップの値へ、その実行で追加したレコードは削除する。
 * 実行後に他の人が編集したレコードがあれば、一覧を出して中断する（--overwrite-remote で上書きして戻す）。
 */
export function restoreImport(options: { name: string; runId: string; yes: boolean; overwriteRemote: boolean }): Promise<object> {
  return restoreRun({ ...options, flavor: IMPORT_FLAVOR });
}
