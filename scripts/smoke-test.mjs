#!/usr/bin/env node
// kint-origin スモークテスト / リグレッションハーネス。
//
// 目的: 改修のたびに、最低限のリグレッション（既存コマンドの振る舞い）を
//       local-test サンドボックス（cwd 基準で data/ と .env を解決）に対して検証する。
//
// 実行: npm run smoke
//   - まず tsc でビルド。
//   - ネットワーク不要の「オフライン検証」を常に実行（引数検証・ヘルプ・未知コマンド等）。
//   - local-test/.env に実ドメイン（xxx 以外）があればindexをライブ取得。
//     recordsには別途SMOKE_APP_IDと取得許可が必要。
//
// 注意: 顧客ドメインに対しては実行しないこと。local-test には専用のテストドメインを設定する。

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syncDevAgents } from "./sync-dev-agents.mjs";
import { checkRepositoryKnowledge, checkDomainKnowledge } from "./check-agent-knowledge.mjs";
import { safetyTests } from "./smoke-safety.mjs";
import { appCreateTests } from "./smoke-app-create.mjs";
import { importTests } from "./smoke-import.mjs";
import { addonTests } from "./smoke-addon.mjs";
import { pluginSourceTests } from "./smoke-plugin-sources.mjs";
import { pullIndexPluginTests } from "./smoke-pull-index-plugins.mjs";
import { commonCommentsTests } from "./smoke-common-comments.mjs";
import { bulkPullTests } from "./smoke-bulk-pull.mjs";
import { rehearsalTests } from "./smoke-rehearsal.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = path.join(ROOT, "local-test");
const CLI = path.join(ROOT, "dist", "cli.js");
const ONLY_GROUPS = new Set((process.env.SMOKE_ONLY || "").split(",").map((name) => name.trim()).filter(Boolean));

// 開発者シェルの実ドメイン認証値が子プロセスに混ざらないよう空で上書きする（空なら loadEnv が .env の値で埋める）。
const NO_SHELL_CREDS = {
  CYBOZU_BASE_URL: "",
  CYBOZU_USERNAME: "",
  CYBOZU_PASSWORD: ""
};

let passed = 0;
let failed = 0;
const failures = [];

function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}
function ng(name, detail) {
  failed += 1;
  failures.push({ name, detail });
  console.log(`  ✗ ${name}\n      ${String(detail).replace(/\n/g, "\n      ")}`);
}

// node dist/cli.js <args> を cwd で実行（既定は SANDBOX。spawnSync は非0終了でも throw しない）。
// env を渡すと process.env にマージして子プロセスへ引き継ぐ（環境変数注入の検証用）。
function runCli(args, cwd = SANDBOX, env = undefined) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : undefined
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// runCli の非同期版。mock HTTP サーバーと同一プロセスで通信するため、spawnSync（イベントループ停止）は使えない。
function runCliAsync(args, cwd, env, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function expect(name, cond, detail) {
  if (cond) ok(name);
  else ng(name, detail);
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return (result.stdout || "").trim();
}

function initGitWithDataSnapshot(cwd, message = "pull app baseline") {
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "kint-origin smoke"]);
  git(cwd, ["config", "user.email", "smoke@example.invalid"]);
  git(cwd, ["add", "--", "data"]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

// ---- 0. ビルド ----------------------------------------------------------
function build() {
  const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", ROOT], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    console.error("ビルド失敗:\n" + (r.stdout || "") + (r.stderr || ""));
    process.exit(1);
  }
  if (!fs.existsSync(CLI)) {
    console.error(`ビルド後に ${CLI} が見つかりません。`);
    process.exit(1);
  }
}

// ---- 1. オフライン検証（ネットワーク不要） ------------------------------
function offlineTests() {
  console.log("[offline] 引数検証・ヘルプ・コマンド振り分け");

  const help = runCli(["help"]);
  expect("help は exit 0", help.status === 0, `status=${help.status}`);
  for (const cmd of [
    "pull app",
    "pull records",
    "pull guestspaces",
    "pull spaces",
    "pull kintone",
    "pull plugins",
    "pull common",
    "pull comments",
    "pull users",
    "pull index",
    "pull tracked-spaces",
    "pull favorite",
    "pull all",
    "push app",
    "push create",
    "diff app",
    "diff create",
    "diff rehearsal",
    "app create",
    "app templates",
    "addon list",
    "addon create",
    "addon install",
    "addon update",
    "addon remove",
    "addon run"
  ]) {
    expect(`help に ${cmd} を含む`, help.stdout.includes(cmd), help.stdout);
  }
  expect("help に push の --no-deploy / --overwrite-remote を含む", help.stdout.includes("--no-deploy") && help.stdout.includes("--overwrite-remote"), help.stdout);
  expect("全体ヘルプから push のヘルプへ案内する", help.stdout.includes("kint-origin push --help"), help.stdout);
  expect("help に pull app の --discard-local を含む", help.stdout.includes("--discard-local"), help.stdout);
  expect("help に「-y は確認を省略」を含む", help.stdout.includes("-y は確認を省略"), help.stdout);
  expect("help に「-y はユーザー専用」を含まない", !help.stdout.includes("ユーザー専用"), help.stdout);
  expect("help に records の CSV 説明を含む", help.stdout.includes("CSV"), help.stdout);
  expect("help に app --plugin / --a を含む", help.stdout.includes("--plugin") && help.stdout.includes("--a"), help.stdout);
  for (const cmd of ["init", "update"]) {
    expect(`help に ${cmd} を含む`, help.stdout.includes(cmd), help.stdout);
  }
  expect("help に policy を含む", help.stdout.includes("policy"), help.stdout);
  expect("help に secret を含む", help.stdout.includes("secret"), help.stdout);
  expect("help に操作制限（KINT_ORIGIN_ALLOW_）を含む", help.stdout.includes("KINT_ORIGIN_ALLOW_"), help.stdout);

  const noArg = runCli([]);
  expect("引数なしは Usage を表示し exit 0", noArg.status === 0 && noArg.stdout.includes("Usage:"), `status=${noArg.status}\n${noArg.stdout}`);

  const unknown = runCli(["bogus-command"]);
  expect("未知コマンドは exit 1", unknown.status === 1, `status=${unknown.status}`);
  expect("未知コマンドは Unknown command を表示", unknown.stderr.includes("Unknown command"), unknown.stderr);

  // pull / push のサブコマンド振り分け（未知・欠落は Usage 付きで exit 1）
  const unknownPull = runCli(["pull", "bogus"]);
  expect("pull の未知サブコマンドは exit 1", unknownPull.status === 1, `status=${unknownPull.status}`);
  expect("pull の未知サブコマンドは Unknown command を表示", unknownPull.stderr.includes("Unknown command: pull bogus"), unknownPull.stderr);
  const barePull = runCli(["pull"]);
  expect("pull 単体（サブコマンド無し）は exit 1", barePull.status === 1, `status=${barePull.status}`);
  const unknownPush = runCli(["push", "bogus"]);
  expect("push の未知サブコマンドは exit 1", unknownPush.status === 1, `status=${unknownPush.status}`);

  const appNoId = runCli(["pull", "app"]);
  expect("pull app --id 無しは exit 1", appNoId.status === 1, `status=${appNoId.status}`);
  expect("pull app --id 無しは Missing required argument", appNoId.stderr.includes("Missing required argument: --id"), appNoId.stderr);
  const pluginFlag = runCli(["pull", "app", "--id", "3", "--plugin"], SANDBOX, NO_SHELL_CREDS);
  expect("pull app --plugin は既存の真偽オプションとして受け付ける", !pluginFlag.stderr.includes("不明なオプション") && !pluginFlag.stderr.includes("不明な引数"), pluginFlag.stderr);

  // pull records は操作制限（既定で禁止）が先に判定されるため、許可キー入りの一時 .env で引数検証する。
  const recordsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-records-args-"));
  try {
    fs.writeFileSync(path.join(recordsTmp, ".env"), "KINT_ORIGIN_ALLOW_PULL_RECORDS=true\n", "utf8");
    const recNoId = runCli(["pull", "records"], recordsTmp, NO_SHELL_CREDS);
    expect("pull records --id 無しは exit 1", recNoId.status === 1, `status=${recNoId.status}`);
    expect("pull records --id 無しは Missing required argument", recNoId.stderr.includes("Missing required argument: --id"), recNoId.stderr);

    const invalidRecordId = runCli(["pull", "records", "--id", "303,abc"], recordsTmp, NO_SHELL_CREDS);
    expect("pull records の不正な appId,recordId は exit 1", invalidRecordId.status === 1, `status=${invalidRecordId.status}`);
    expect("pull records の不正な appId,recordId は形式エラー", invalidRecordId.stderr.includes("<appId>,<recordId>"), invalidRecordId.stderr);
  } finally {
    fs.rmSync(recordsTmp, { recursive: true, force: true });
  }
  expect("help に単一レコード指定を含む", help.stdout.includes("<appId>[,<recordId>]"), help.stdout);
  expect("help に version を含む", help.stdout.includes("--version"), help.stdout);
}

// ---- 1d. --version（オフライン） -----------------------------------------
function versionTests() {
  console.log("[offline] --version");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const arg of ["version", "--version", "-v"]) {
    const r = runCli([arg]);
    expect(`${arg} は exit 0`, r.status === 0, `status=${r.status}\n${r.stderr}`);
    expect(`${arg} は package.json の version を表示`, r.stdout.trim() === pkg.version, `stdout=${r.stdout}`);
  }
}

// ---- 1e. HTTP リトライ・タイムアウト（オフライン・fetch 注入） ------------
async function httpPolicyTests() {
  console.log("[offline] HTTP リトライ・タイムアウト・エラー整形");

  const moduleUrl = pathToFileURL(path.join(ROOT, "dist", "http.js")).href;
  const { isRetryableStatus, computeRetryDelayMs, fetchCybozuResponse } = await import(moduleUrl);
  const env = { baseUrl: "https://example.invalid", username: "u", password: "p", language: "ja" };

  // 純関数: リトライ対象ステータス
  for (const s of [429, 502, 503, 504]) expect(`status ${s} はリトライ対象`, isRetryableStatus(s), String(s));
  for (const s of [400, 401, 403, 404, 500]) expect(`status ${s} はリトライ対象外`, !isRetryableStatus(s), String(s));

  // 純関数: Retry-After（秒数・日付・無し）
  expect("Retry-After 秒数を ms に変換", computeRetryDelayMs(0, "2", 1000) === 2000, String(computeRetryDelayMs(0, "2", 1000)));
  const dateDelay = computeRetryDelayMs(0, new Date(Date.now() + 5000).toUTCString(), 1000);
  expect("Retry-After 日付形式を許容（0〜60s）", dateDelay >= 0 && dateDelay <= 60000, String(dateDelay));
  const d0 = computeRetryDelayMs(0, null, 10);
  const d3 = computeRetryDelayMs(3, null, 10);
  expect("バックオフは attempt に応じて増加", d0 >= 10 && d3 > d0, `d0=${d0} d3=${d3}`);

  // 429 → 200: リトライして成功し、呼び出しは2回
  let calls = 0;
  const retryFetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("{}", { status: 429, headers: { "retry-after": "0" } })
      : new Response("{}", { status: 200 });
  };
  const okResponse = await fetchCybozuResponse(env, "https://example.invalid/k/v1/apps.json", {}, { fetchImpl: retryFetch, baseDelayMs: 1 });
  expect("429 はリトライして成功（2回呼び出し）", okResponse.ok && calls === 2, `calls=${calls}`);

  // 400 は即時失敗（リトライしない）、CybozuError の status/code を保持
  calls = 0;
  const badFetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ code: "CB_VA01", message: "invalid" }), { status: 400 });
  };
  try {
    await fetchCybozuResponse(env, "https://example.invalid/k/v1/apps.json", {}, { fetchImpl: badFetch, baseDelayMs: 1 });
    ng("400 は即時失敗", "throw されなかった");
  } catch (e) {
    expect("400 は即時失敗（1回呼び出し）", calls === 1, `calls=${calls}`);
    expect("CybozuError が status/code を保持", e.status === 400 && e.code === "CB_VA01", `status=${e.status} code=${e.code}`);
  }

  // 401 はエラーメッセージに .env の案内を含む
  const unauthorizedFetch = async () => new Response(JSON.stringify({ message: "auth" }), { status: 401 });
  try {
    await fetchCybozuResponse(env, "https://example.invalid/k/v1/apps.json", {}, { fetchImpl: unauthorizedFetch });
    ng("401 は失敗する", "throw されなかった");
  } catch (e) {
    expect("401 は .env 確認の案内を含む", String(e.message).includes(".env"), e.message);
  }

  // POST はリトライしない（503 でも即時失敗）。POST は操作制限の HTTP 層で push グラントが要るため、この検証の間だけ付与する。
  const { activateGrants } = await import(pathToFileURL(path.join(ROOT, "dist", "policy.js")).href);
  activateGrants(["push:app"]);
  try {
    calls = 0;
    const postFetch = async () => {
      calls += 1;
      return new Response("{}", { status: 503 });
    };
    try {
      await fetchCybozuResponse(env, "https://example.invalid/k/v1/x.json", { method: "POST", body: {} }, { fetchImpl: postFetch, baseDelayMs: 1 });
      ng("POST 503 は失敗する", "throw されなかった");
    } catch (e) {
      expect("POST はリトライしない（1回呼び出し）", calls === 1, `calls=${calls}`);
      expect("POST 503 の CybozuError.status", e.status === 503, `status=${e.status}`);
    }
  } finally {
    activateGrants([]);
  }

  // タイムアウト: AbortSignal を尊重して解決しない fetch → 専用メッセージでリトライせず失敗
  // 注: AbortSignal.timeout の内部タイマーは unref のため、keep-alive タイマーでイベントループを維持する。
  const hangFetch = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await fetchCybozuResponse(env, "https://example.invalid/k/v1/apps.json", { timeoutMs: 50 }, { fetchImpl: hangFetch });
    ng("タイムアウトは失敗する", "throw されなかった");
  } catch (e) {
    expect("タイムアウトは専用メッセージ", String(e.message).includes("タイムアウト"), e.message);
  } finally {
    clearTimeout(keepAlive);
  }

  // API 実行間隔（CYBOZU_API_INTERVAL_MS / env.apiIntervalMs）
  const envModuleUrl = pathToFileURL(path.join(ROOT, "dist", "env.js")).href;
  const { parseApiIntervalMs } = await import(envModuleUrl);
  const { computeRequestSlot } = await import(moduleUrl);

  // 純関数: パース（未設定/空/不正 → 0、非負数 → 整数へ切り捨て）
  expect("interval: '500' は 500", parseApiIntervalMs("500") === 500, String(parseApiIntervalMs("500")));
  expect("interval: 未設定は 0", parseApiIntervalMs(undefined) === 0, String(parseApiIntervalMs(undefined)));
  expect("interval: 空文字は 0", parseApiIntervalMs("") === 0, String(parseApiIntervalMs("")));
  expect("interval: 'abc' は 0（不正値フォールバック）", parseApiIntervalMs("abc") === 0, String(parseApiIntervalMs("abc")));
  expect("interval: '-100' は 0（負数フォールバック）", parseApiIntervalMs("-100") === 0, String(parseApiIntervalMs("-100")));
  expect("interval: '250.9' は 250（切り捨て）", parseApiIntervalMs("250.9") === 250, String(parseApiIntervalMs("250.9")));

  // 純関数: スロット計算（interval ずつ進む・スロットが過去なら即時開始）
  const slot1 = computeRequestSlot(1000, 0, 100);
  expect("interval: 初回スロットは即時開始", slot1.startAt === 1000 && slot1.nextSlotAt === 1100, JSON.stringify(slot1));
  const slot2 = computeRequestSlot(1000, slot1.nextSlotAt, 100);
  expect("interval: 連続スロットは interval ずつ進む", slot2.startAt === 1100 && slot2.nextSlotAt === 1200, JSON.stringify(slot2));
  const slot3 = computeRequestSlot(5000, slot2.nextSlotAt, 100);
  expect("interval: 間が空けば now から再開", slot3.startAt === 5000 && slot3.nextSlotAt === 5100, JSON.stringify(slot3));

  // 統合: apiIntervalMs=30 の env で3回連続 → 60ms 以上かかる（下限のみ検証）
  const intervalEnv = { ...env, apiIntervalMs: 30 };
  const okFetch = async () => new Response("{}", { status: 200 });
  const seqStart = Date.now();
  for (let i = 0; i < 3; i++) {
    await fetchCybozuResponse(intervalEnv, "https://example.invalid/k/v1/apps.json", {}, { fetchImpl: okFetch });
  }
  const seqElapsed = Date.now() - seqStart;
  expect("interval: 連続3回は 2 間隔（60ms）以上", seqElapsed >= 60, `elapsed=${seqElapsed}ms`);

  // 統合: 3並列でもグローバル間隔が効き 60ms 以上かかる（開始が直列化される）
  const parStart = Date.now();
  await Promise.all(
    Array.from({ length: 3 }, () =>
      fetchCybozuResponse(intervalEnv, "https://example.invalid/k/v1/apps.json", {}, { fetchImpl: okFetch })
    )
  );
  const parElapsed = Date.now() - parStart;
  expect("interval: 3並列でもグローバルに 60ms 以上空く", parElapsed >= 60, `elapsed=${parElapsed}ms`);

  // 「未指定なら待機なし」は parseApiIntervalMs（未設定は 0）の純関数検証で担保する（実時間の上限判定は高負荷でフレークするため持たない）。
}

// ---- 1f. 並列制限ユーティリティ（オフライン） ------------------------------
async function limitTests() {
  console.log("[offline] 並列制限（mapWithLimit / createLimiter）");

  const moduleUrl = pathToFileURL(path.join(ROOT, "dist", "limit.js")).href;
  const { mapWithLimit, createLimiter } = await import(moduleUrl);

  // 遅延をばらつかせても結果は入力順
  const items = Array.from({ length: 10 }, (_, i) => i);
  const results = await mapWithLimit(items, 3, async (n) => {
    await new Promise((resolve) => setTimeout(resolve, (10 - n) * 3));
    return n * 2;
  });
  expect("mapWithLimit は結果を入力順で返す", results.join(",") === items.map((n) => n * 2).join(","), results.join(","));

  // 同時実行数が上限以下
  let active = 0;
  let maxActive = 0;
  await mapWithLimit(items, 3, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  });
  expect("mapWithLimit の同時実行が上限(3)以下", maxActive <= 3 && maxActive > 1, `maxActive=${maxActive}`);

  // createLimiter を複数ストリームで共有しても合計が上限以下
  const limiter = createLimiter(2);
  active = 0;
  maxActive = 0;
  const task = () =>
    limiter(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
  await Promise.all([...items.map(task), ...items.map(task)]);
  expect("共有 limiter で合計同時実行が上限(2)以下", maxActive <= 2, `maxActive=${maxActive}`);
}

// ---- 1g. users の PII 警告（オフライン・即時失敗ドメイン） ------------------
function usersPiiWarningTests() {
  console.log("[offline] users の個人情報警告");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-users-pii-"));
  try {
    // ECONNREFUSED で即時失敗するダミードメイン（リトライ対象外なので高速に終わる）。
    fs.writeFileSync(
      path.join(tmp, ".env"),
      "CYBOZU_BASE_URL=https://127.0.0.1:9\nCYBOZU_USERNAME=u\nCYBOZU_PASSWORD=p\nCYBOZU_LANGUAGE=ja\nKINT_ORIGIN_ALLOW_PULL_USERS=true\n",
      "utf8"
    );
    const r = runCli(["pull", "users"], tmp, NO_SHELL_CREDS);
    expect("pull users は実行前に個人情報の警告を表示", r.stderr.includes("個人情報"), r.stderr);
    expect("pull users は接続失敗で exit 1", r.status === 1, `status=${r.status}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- 1c. API ラボ プラグイン設定保存（オフライン・一時dir） ------------
async function pluginConfigTests() {
  console.log("[offline] API ラボ プラグイン設定保存");

  const moduleUrl = pathToFileURL(path.join(ROOT, "dist", "kintone", "pluginConfigs.js")).href;
  const { exportPluginConfigs } = await import(moduleUrl);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-plugin-configs-"));
  try {
    const outDir = path.join(tmp, "customize", "plugin-configs");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "removed.json"), "{}\n", "utf8");
    const client = {
      async getPluginConfig(appId, pluginId, options) {
        return { config: { appId: String(appId), pluginId, guestSpaceId: options.guestSpaceId }, revision: "12" };
      }
    };
    const result = await exportPluginConfigs({
      client,
      appId: "303",
      appDir: tmp,
      guestSpaceId: "10",
      pluginsPayload: { plugins: [{ id: "plugin-b" }, { id: "plugin-a" }] }
    });
    expect("プラグイン設定を ID 別に2件保存", result.count === 2 && result.files.length === 2, JSON.stringify(result));
    const saved = JSON.parse(fs.readFileSync(path.join(outDir, "plugin-a.json"), "utf8"));
    expect("プラグイン設定の revision を正規化", saved.revision === "-", JSON.stringify(saved));
    expect("削除済みプラグイン設定ファイルを除去", !fs.existsSync(path.join(outDir, "removed.json")), fs.readdirSync(outDir).join(","));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- 1a. 単一レコードCSV更新・確認既定値（オフライン） -------------------
async function recordCsvTests() {
  console.log("[offline] 単一レコード CSV 更新・確認既定値");

  const csvModuleUrl = pathToFileURL(path.join(ROOT, "dist", "kintone", "recordCsv.js")).href;
  const confirmModuleUrl = pathToFileURL(path.join(ROOT, "dist", "confirm.js")).href;
  const { mergeRecordCsv } = await import(csvModuleUrl);
  const { isYesAnswer } = await import(confirmModuleUrl);
  const existing = '\ufeff*,レコード番号,文字列,テーブル値\n*,"53","before","row1"\n,"53","before","row2"\n*,"54","old","old row"\n*,"55","keep","line1\nline2"\n';
  const replacement = '\ufeff*,レコード番号,文字列,テーブル値\n*,"54","new","new row1"\n,"54","new","new row2"\n';
  const merged = mergeRecordCsv(existing, replacement, "レコード番号", "54");
  expect("単一レコード更新は旧行を除去", !merged.includes('"old"'), merged);
  expect("単一レコード更新はサブテーブル全行を置換", merged.includes('"new row1"') && merged.includes('"new row2"'), merged);
  expect("単一レコード更新は他レコードの改行値を保持", merged.includes('"line1\nline2"'), merged);
  expect("添付確認は Enter を Yes とする", isYesAnswer("", true) === true, "empty answer was not yes");
  expect("添付確認は n を No とする", isYesAnswer("n", true) === false, "n answer was not no");
}

// ---- 1b. 添付ファイル保存（オフライン・一時dir） -------------------------
async function attachmentTests() {
  console.log("[offline] 添付ファイル上書き・並列上限・失敗集計");

  const moduleUrl = pathToFileURL(path.join(ROOT, "dist", "kintone", "recordAttachments.js")).href;
  const limitUrl = pathToFileURL(path.join(ROOT, "dist", "limit.js")).href;
  const { saveAttachmentFiles } = await import(moduleUrl);
  const { createLimiter } = await import(limitUrl);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-attachments-"));
  try {
    // downloadFileTo（ストリーミング保存）を模したモック: 指定パスへファイルを書く。
    const contents = new Map([
      ["old-key", "old"],
      ["new-key", "new"]
    ]);
    const client = {
      async downloadFileTo(fileKey, dest) {
        if (!contents.has(fileKey)) throw new Error(`missing fileKey: ${fileKey}`);
        fs.writeFileSync(dest, contents.get(fileKey), "utf8");
      }
    };
    const result = await saveAttachmentFiles(client, "", tmp, "1", "添付", [
      { fileKey: "old-key", name: "sample.txt" },
      { fileKey: "new-key", name: "sample.txt" }
    ]);
    const dir = path.join(tmp, "attachments", "1", "添付");
    const names = fs.readdirSync(dir).filter((name) => name !== ".kint-origin-attachments.json").sort();
    expect("同名の別添付は通常名と内容ハッシュ付き名で両方保存", names.length === 2 && names[0] === "sample-11507a0e2f5e.txt" && names[1] === "sample.txt", names.join(","));
    expect("同名添付の内容を両方保持", names.map((name) => fs.readFileSync(path.join(dir, name), "utf8")).sort().join(",") === "new,old", names.map((name) => `${name}:${fs.readFileSync(path.join(dir, name), "utf8")}`).join(","));
    expect("同名添付2件を保存成功として集計", result.saved === 2 && result.failed === 0, JSON.stringify(result));
    await saveAttachmentFiles(client, "", tmp, "1", "添付", [
      { fileKey: "old-key", name: "sample.txt" },
      { fileKey: "new-key", name: "sample.txt" }
    ]);
    expect("同名添付の再取得で内容別ファイル名を維持", fs.readdirSync(dir).filter((name) => name !== ".kint-origin-attachments.json").sort().join(",") === names.join(","), fs.readdirSync(dir).join(","));

    // 失敗（存在しない fileKey）は failed に集計し、処理は続行する
    const mixed = await saveAttachmentFiles(client, "", tmp, "2", "添付", [
      { fileKey: "bogus-key", name: "broken.txt" },
      { fileKey: "new-key", name: "ok.txt" }
    ]);
    expect("同じ添付フィールド内の失敗では部分保存せず、field failure に集計", mixed.saved === 0 && mixed.failed === 1 && !fs.existsSync(path.join(tmp, "attachments", "2", "添付", "ok.txt")), JSON.stringify(mixed));

    await saveAttachmentFiles(client, "", tmp, "4", "添付", [{ fileKey: "old-key", name: "stable.txt" }]);
    const failedRefresh = await saveAttachmentFiles(client, "", tmp, "4", "添付", [
      { fileKey: "new-key", name: "replacement.txt" },
      { fileKey: "bogus-key", name: "broken.txt" }
    ]);
    const preservedDir = path.join(tmp, "attachments", "4", "添付");
    expect("添付再取得の途中失敗では既存管理ファイルを維持", failedRefresh.failed === 1 && fs.readFileSync(path.join(preservedDir, "stable.txt"), "utf8") === "old" && !fs.existsSync(path.join(preservedDir, "replacement.txt")), JSON.stringify(failedRefresh));

    // limiter 共有時、複数フィールドの並列 DL が上限を超えない
    let active = 0;
    let maxActive = 0;
    const slowClient = {
      async downloadFileTo(fileKey, dest) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        fs.writeFileSync(dest, "x", "utf8");
        active -= 1;
      }
    };
    const limiter = createLimiter(4);
    const fields = Array.from({ length: 8 }, (_, i) => `field-${i}`);
    await Promise.all(
      fields.map((code) =>
        saveAttachmentFiles(slowClient, "", tmp, "3", code, [{ fileKey: `k-${code}`, name: `${code}.bin` }], limiter)
      )
    );
    expect("添付 DL の同時実行が limiter の上限(4)以下", maxActive <= 4 && maxActive > 1, `maxActive=${maxActive}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ダウンロード中断時は既存ファイルを維持し、完了後だけ置き換える（オフライン・一時dir）。
async function fileDownloadAtomicTests() {
  console.log("[offline] 添付ストリームの中断時に既存ファイルを保護");
  const { requestCybozuToFile } = await import(pathToFileURL(path.join(ROOT, "dist", "http.js")).href);
  const { activateGrants } = await import(pathToFileURL(path.join(ROOT, "dist", "policy.js")).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-file-atomic-"));
  const dest = path.join(tmp, "attachment.bin");
  let mode = "partial";
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    if (mode === "partial") {
      res.write("partial");
      setTimeout(() => res.destroy(), 5);
    } else {
      res.end("complete");
    }
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const env = { baseUrl: `http://127.0.0.1:${server.address().port}`, username: "u", password: "p", language: "ja", apiIntervalMs: 0 };
    const url = `${env.baseUrl}/k/v1/file.json`;
    activateGrants(["pull:records"]);
    fs.writeFileSync(dest, "previous", "utf8");
    let interrupted = false;
    try {
      await requestCybozuToFile(env, url, dest, { query: { fileKey: "broken" } });
    } catch {
      interrupted = true;
    }
    expect("ストリーム中断で失敗し、既存添付を維持", interrupted && fs.readFileSync(dest, "utf8") === "previous", fs.readdirSync(tmp).join(","));
    expect("ストリーム中断で part ファイルを残さない", fs.readdirSync(tmp).length === 1, fs.readdirSync(tmp).join(","));
    mode = "complete";
    await requestCybozuToFile(env, url, dest, { query: { fileKey: "complete" } });
    expect("完全取得後だけ添付を置き換える", fs.readFileSync(dest, "utf8") === "complete", fs.readFileSync(dest, "utf8"));
    expect("置換後に part / previous ファイルを残さない", fs.readdirSync(tmp).length === 1, fs.readdirSync(tmp).join(","));
  } finally {
    activateGrants([]);
    server.closeAllConnections();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- 1d. kintone documentation MCP の設定確認（警告。オフライン・一時dir） ----------
function docsMcpTests() {
  console.log("[offline] kintone documentation MCP の設定確認（警告）");
  const GUIDE = "https://cybozu.dev/ja/kintone/ai/kintone-documentation-mcp-overview/";
  const DOCS_URL = "https://mcp.cybozu.dev/mcp";
  const domain = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-docsmcp-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-docsmcp-home-"));
  // 開発機のユーザー設定（~/.claude.json 等）の影響を受けないよう、ホームと CODEX_HOME を空の一時ディレクトリに向ける。
  const homeEnv = { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex") };
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`, "utf8");
  };
  const docsServers = (name = "kintone-docs") => ({ mcpServers: { [name]: { type: "http", url: DOCS_URL } } });
  const warns = (args = ["policy"]) => {
    const r = runCli(args, domain, homeEnv);
    return { warned: r.stderr.includes("kintone documentation MCP"), r };
  };
  const reset = () => {
    for (const dir of [domain, home]) {
      for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  };
  try {
    const none = warns();
    let stdoutJson = false;
    try {
      JSON.parse(none.r.stdout);
      stdoutJson = true;
    } catch {
      stdoutJson = false;
    }
    expect("docsMcp: 設定が無いと policy の stderr に警告と案内 URL を出す", none.warned && none.r.stderr.includes(GUIDE) && none.r.stderr.includes("KINT_ORIGIN_DOCS_MCP_WARNING=false"), none.r.stderr);
    expect("docsMcp: 警告があっても stdout は JSON のまま", none.r.status === 0 && stdoutJson, none.r.stdout.slice(0, 200));

    const found = [
      ["ドメインの .mcp.json", () => write(path.join(domain, ".mcp.json"), docsServers())],
      ["ドメインの .cursor/mcp.json", () => write(path.join(domain, ".cursor", "mcp.json"), docsServers())],
      ["ドメインの .codex/config.toml", () => write(path.join(domain, ".codex", "config.toml"), `[mcp_servers.kintone-docs]\nurl = "${DOCS_URL}"\n`)],
      ["ホームの .claude.json（トップの mcpServers）", () => write(path.join(home, ".claude.json"), docsServers())],
      ["ホームの .claude.json（projects[<cwd>]）", () => write(path.join(home, ".claude.json"), { projects: { [domain.replaceAll(path.sep, "/")]: docsServers() } })],
      ["ホームの .cursor/mcp.json", () => write(path.join(home, ".cursor", "mcp.json"), docsServers())],
      ["CODEX_HOME/config.toml", () => write(path.join(home, ".codex", "config.toml"), `[mcp_servers.docs]\nurl = "${DOCS_URL}"\n`)],
      ["サーバー名が違っても URL が mcp.cybozu.dev", () => write(path.join(domain, ".mcp.json"), docsServers("cybozu-docs"))]
    ];
    for (const [label, setup] of found) {
      reset();
      setup();
      const { warned, r } = warns();
      expect(`docsMcp: ${label} があれば警告しない`, !warned && r.status === 0, r.stderr);
    }

    reset();
    write(path.join(home, ".claude.json"), { projects: { [path.join(os.tmpdir(), "other-domain").replaceAll(path.sep, "/")]: docsServers() } });
    expect("docsMcp: projects の別パスにだけある設定では警告する", warns().warned, "no warning");

    reset();
    write(path.join(domain, ".mcp.json"), "{ broken json");
    const broken = warns();
    expect("docsMcp: 壊れた .mcp.json でも落ちずに警告する", broken.warned && broken.r.status === 0, `status=${broken.r.status}\n${broken.r.stderr}`);

    for (const value of ["false", "FALSE", " False "]) {
      reset();
      write(path.join(domain, ".env"), `KINT_ORIGIN_DOCS_MCP_WARNING=${value}\n`);
      const off = warns();
      const summary = JSON.parse(off.r.stdout || "{}");
      expect(`docsMcp: .env の KINT_ORIGIN_DOCS_MCP_WARNING=${value.trim()} で警告しない`, !off.warned && off.r.status === 0, off.r.stderr);
      expect(
        `docsMcp: KINT_ORIGIN_DOCS_MCP_WARNING=${value.trim()} は policy の errors / warnings に出ない`,
        !JSON.stringify(summary.errors ?? []).includes("DOCS_MCP") && !JSON.stringify(summary.warnings ?? []).includes("DOCS_MCP"),
        off.r.stdout
      );
    }

    reset();
    for (const args of [["--version"], ["help"]]) {
      const { warned, r } = warns(args);
      expect(`docsMcp: ${args[0]} は警告しない`, !warned && r.status === 0, r.stderr);
    }
  } finally {
    fs.rmSync(domain, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ---- 1c. init / update（AIエージェント設定生成）検証（オフライン・一時dir） ----------
function agentsTests() {
  console.log("[offline] init / update（AIエージェント設定生成）");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-agents-"));
  try {
    const init = runCli(["init"], tmp);
    checkDomainKnowledge(tmp, fs.readdirSync(path.join(ROOT, "template/agents/common/skills")));
    ok("init: 本体ソース無しで入口と参照資料を辿れる");
    expect("init は exit 0", init.status === 0, `status=${init.status}\n${init.stderr}`);

    const required = [
      ".agents/hooks/kint-origin-guard-core.mjs",
      "CLAUDE.md",
      "AGENTS.md",
      // 共有ドキュメント・ルール・スキル（Claude と Codex/Cursor 共有 .agents）
      path.join(".claude", "rules", "kint-origin.md"),
      path.join(".claude", "skills", "kint-origin-commands", "SKILL.md"),
      path.join(".claude", "settings.json"),
      path.join(".agents", "rules", "kint-origin.md"),
      path.join(".agents", "skills", "kint-origin-commands", "SKILL.md"),
      // 独自スキル・ルールの名前と置き場を案内するスキル（Claude と Codex/Cursor 共有）
      path.join(".claude", "skills", "kint-origin-extend", "SKILL.md"),
      path.join(".agents", "skills", "kint-origin-extend", "SKILL.md"),
      // push を起動前に止める設定（Cursor=hook / Codex=rules）
      path.join(".cursor", "hooks.json"),
      path.join(".cursor", "hooks", "kint-origin-guard.mjs"),
      path.join(".codex", "rules", "kint-origin.rules"),
      // 独自スキル・ルールを kint-origin-local- の名前で作らせる hook（Codex。.codex/ の信頼と /hooks での信頼が要る）
      path.join(".codex", "hooks.json"),
      path.join(".codex", "hooks", "kint-origin-guard.mjs")
    ];
    for (const rel of required) {
      expect(`init: ${rel.replaceAll(path.sep, "/")} を生成`, fs.existsSync(path.join(tmp, rel)), `missing: ${rel}`);
    }

    // サブエージェント・knowledge は生成しない（配布テンプレートに無い）
    const unexpected = [".claude", ".cursor", ".codex"]
      .flatMap((dir) => [path.join(dir, "agents"), path.join(dir, "knowledge")])
      .filter((rel) => fs.existsSync(path.join(tmp, rel)));
    expect("init: サブエージェント・knowledge を生成しない", unexpected.length === 0, unexpected.join("\n"));

    // プレースホルダ未置換が残らないこと
    const claudeDoc = fs.readFileSync(path.join(tmp, "CLAUDE.md"), "utf8");
    const codexDoc = fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8");
    expect("init: CLAUDE.md にプレースホルダ {{ が残らない", !claudeDoc.includes("{{"), claudeDoc.slice(0, 200));
    expect("init: AGENTS.md にプレースホルダ {{ が残らない", !codexDoc.includes("{{"), codexDoc.slice(0, 200));
    expect("init: AGENTS.md は .agents/skills を参照", codexDoc.includes(".agents/skills/"), codexDoc);
    expect("init: AGENTS.md は .agents/rules を参照", codexDoc.includes(".agents/rules/"), codexDoc);
    expect("init: CLAUDE.md は .claude/skills を参照", claudeDoc.includes(".claude/skills/"), claudeDoc);

    // ルールとスキルの参照先がエージェントごとの配置になっていること
    const claudeRule = fs.readFileSync(path.join(tmp, ".claude", "rules", "kint-origin.md"), "utf8");
    const agentsRule = fs.readFileSync(path.join(tmp, ".agents", "rules", "kint-origin.md"), "utf8");
    expect("init: .claude ルールに .claude パスを含む", claudeRule.includes(".claude/"), claudeRule);
    expect("init: .claude ルールに .codex が混ざらない", !claudeRule.includes(".codex"), claudeRule);
    expect("init: 共通ルールは .agents/skills を参照", agentsRule.includes(".agents/skills/"), agentsRule);
    expect("init: .agents ルールに .claude が混ざらない", !agentsRule.includes(".claude"), agentsRule);
    const gitignore = fs.readFileSync(path.join(tmp, ".gitignore"), "utf8");
    expect("init: .gitignore は .env を除外", gitignore.split("\n").includes(".env"), gitignore);

    // スキルの命名規則: 配布スキルは kint-origin-*。kint-origin-local-* は利用者の独自スキル・ルール用、kint-origin-addon-* は外部addon用に予約
    const templateSkillDirs = fs
      .readdirSync(path.join(ROOT, "template", "agents", "common", "skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect("template: 配布スキルはすべて kint-origin- で始まる", templateSkillDirs.length > 0 && templateSkillDirs.every((n) => n.startsWith("kint-origin-")), templateSkillDirs.join(", "));
    expect(
      "template: 配布スキルは予約接頭辞（kint-origin-local- / kint-origin-addon-）で始まらない",
      templateSkillDirs.every((n) => !n.startsWith("kint-origin-local-") && !n.startsWith("kint-origin-addon-")),
      templateSkillDirs.join(", ")
    );
    expect("template: 配布スキルに kint-origin-extend がある", templateSkillDirs.includes("kint-origin-extend"), templateSkillDirs.join(", "));
    expect(
      "init: ルールがスキルの命名規則（kint-origin-local-）と kint-origin-extend を案内",
      claudeRule.includes("kint-origin-local-") && claudeRule.includes("kint-origin-extend") && agentsRule.includes("kint-origin-local-") && agentsRule.includes("kint-origin-extend"),
      agentsRule.slice(-800)
    );

    // 権限ポリシー: 参照系は許可、kint-origin は確認(ask)。
    // data/ 保護は hook（kint-origin-guard.mjs）が deny を担い、permissions は
    // _agentdata・push 対象ファイルの allow ＋ push 対象外の取得物の ask（hook が働かないときのフォールバック）構成。
    // Claude Code は deny → ask → allow の順で最初に一致したルールを採用し、より具体的な allow でも ask を覆せない。
    // そのため ask に広い Edit(data/**) を置かない（allow が全て無効になる）。ファイルの書き込み規則は Edit(...) で書く（Write(...) は一致しない。Claude Code 2.1.318 で確認）。
    const claudeSettings = JSON.parse(fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8"));
    const allow = claudeSettings.permissions?.allow || [];
    const ask = claudeSettings.permissions?.ask || [];
    const deny = claudeSettings.permissions?.deny || [];
    expect("init: settings.json の deny に Edit(data/**) が無い（hook 方式へ移管）", !deny.includes("Edit(data/**)"), JSON.stringify(deny));
    expect("init: settings.json の ask に広い Edit(data/**) が無い（allow を無効にしてしまうため）", !ask.includes("Edit(data/**)"), JSON.stringify(ask));
    expect("init: settings.json は Write(...) の規則を持たない（Claude Code では一致しない。ファイルの規則は Edit(...)）", ![...allow, ...ask, ...deny].some((rule) => rule.startsWith("Write(")), JSON.stringify([...allow, ...ask].filter((rule) => rule.startsWith("Write("))));
    expect(
      "init: settings.json は push 対象外の取得物（index・app.json・records・plugins.json 等）への Edit を ask（フォールバック）",
      ["data/kintone/index/**", "data/kintone/plugin/installed.json", "data/**/app.json", "data/**/form/form.json", "data/**/records/**", "data/**/customize/plugins.json", "data/**/customize/customize.json", "data/**/customize/plugin-configs/**", "data/**/.kint-origin-pull.json"].every(
        (p) => ask.includes(`Edit(${p})`)
      ),
      JSON.stringify(ask)
    );
    expect(
      "init: settings.json は push 対象ファイル（fields・views・reports・app_settings・customize の JS 等）への Edit を allow",
      ["data/**/form/fields.json", "data/**/form/layout.json", "data/**/views/views.json", "data/**/reports/reports.json", "data/**/app_settings/**", "data/**/notifications/**", "data/**/acl/**", "data/**/customize/customize-manifest.json", "data/**/customize/desktop/**", "data/**/customize/mobile/**"].every(
        (p) => allow.includes(`Edit(${p})`)
      ),
      JSON.stringify(allow)
    );
    expect("init: settings.json は _agentdata への Edit を allow", allow.includes("Edit(data/**/_agentdata/**)"), JSON.stringify(allow));
    expect("init: settings.json はプラグイン台帳・ソースへの Edit を allow", allow.includes("Edit(data/kintone/plugin/**)"), JSON.stringify(allow));
    expect("init: settings.json は push/（ドラフト）への Edit を allow", allow.includes("Edit(push/**)"), JSON.stringify(allow));
    expect("init: settings.json は favorites/（お気に入り定義）への Edit を allow", allow.includes("Edit(favorites/**)"), JSON.stringify(allow));
    // push 用 hook（PreToolUse）の定義と実体
    const hookDefs = claudeSettings.hooks?.PreToolUse || [];
    const hookDef = hookDefs[0] || {};
    expect("init: settings.json に hooks.PreToolUse がある", hookDefs.length > 0, JSON.stringify(claudeSettings.hooks));
    expect("init: hook の matcher が Bash と Write を含む", String(hookDef.matcher || "").includes("Bash") && String(hookDef.matcher || "").includes("Write"), JSON.stringify(hookDef));
    expect("init: hook が kint-origin-guard.mjs を起動", JSON.stringify(hookDef).includes("kint-origin-guard.mjs"), JSON.stringify(hookDef));
    const guardPath = path.join(tmp, ".claude", "hooks", "kint-origin-guard.mjs");
    expect("init: .claude/hooks/kint-origin-guard.mjs を生成", fs.existsSync(guardPath), guardPath);

    // guard.mjs 単体駆動: push→ask（-y 付きも）/ 連結した push→deny / pull→無出力 / push 対象外の data Write→deny / push 対象・_agentdata Write→無出力
    const runGuard = (input) => {
      const r = spawnSync(process.execPath, [guardPath], { encoding: "utf8", input: JSON.stringify(input) });
      const out = (r.stdout || "").trim();
      if (!out) return { decision: "", raw: out };
      try {
        return { decision: JSON.parse(out).hookSpecificOutput?.permissionDecision || "", raw: out };
      } catch {
        return { decision: "(parse error)", raw: out };
      }
    };
    const g1 = runGuard({ tool_name: "Bash", tool_input: { command: "kint-origin push app --id 3" }, cwd: tmp });
    expect("guard: kint-origin push は ask", g1.decision === "ask", g1.raw);
    // -y は CLI の y/N 確認を省略するだけ。ユーザー承認（ask）は -y の有無を問わず必須で、deny にはしない。
    for (const [tool, command] of [
      ["PowerShell", "kint-origin push app --id 3 -y"],
      ["Bash", "kint-origin push create --all --yes"],
      ["Bash", "kint-origin push app --id 3 --only customize -y"],
      ["PowerShell", '"C:\\tools\\kint-origin.cmd" push app --id 3 -y']
    ]) {
      const g = runGuard({ tool_name: tool, tool_input: { command }, cwd: tmp });
      expect(`guard: ${command} も ask（-y を理由に deny しない）`, g.decision === "ask" && g.raw.includes("kint-origin diff") && g.raw.includes("y/N 確認を省略"), g.raw);
    }
    // 他のコマンドと連結した push は、承認ダイアログで実行内容が分からなくなるため deny
    for (const command of [
      "kint-origin push app --id 3 -y; echo done",
      "echo a && kint-origin push app --id 3",
      "kint-origin push app --id 3 -y | Out-Null",
      "kint-origin push app --id 3 -y\nGet-Date",
      "kint-origin push app --id 3 -y `whoami`",
      "kint-origin push app --id 3 -y $(whoami)"
    ]) {
      const g = runGuard({ tool_name: "Bash", tool_input: { command }, cwd: tmp });
      expect(`guard: 連結した push は deny: ${JSON.stringify(command)}`, g.decision === "deny" && g.raw.includes("単体"), g.raw);
    }
    // 引用符付きの push、PowerShell の呼び出し演算子（先頭の &）、リダイレクト（2>&1）は連結ではない（ask）
    for (const command of ['kint-origin "push" app --id 3 -y', "kint-origin 'push' app --id 3", '& "C:\\tools\\kint-origin.cmd" push app --id 3 -y', "kint-origin push app --id 3 -y 2>&1"]) {
      const g = runGuard({ tool_name: "PowerShell", tool_input: { command }, cwd: tmp });
      expect(`guard: ${command} は ask（引用符・呼び出し演算子・リダイレクトを連結や素通りにしない）`, g.decision === "ask", g.raw);
    }
    const g3 = runGuard({ tool_name: "Bash", tool_input: { command: "kint-origin pull app --id 3" }, cwd: tmp });
    expect("guard: pull は無出力（通常の権限評価へ）", g3.decision === "", g3.raw);
    const g3b = runGuard({ tool_name: "Bash", tool_input: { command: "kint-origin diff app --id 3" }, cwd: tmp });
    expect("guard: diff は無出力（読み取りだけ）", g3b.decision === "", g3b.raw);
    const g3c = runGuard({ tool_name: "Bash", tool_input: { command: "kint-origin pull app --id 3 && kint-origin diff app --id 3" }, cwd: tmp });
    expect("guard: push を含まない連結は deny しない（1 コマンド主義は権限設定側の責務）", g3c.decision === "", g3c.raw);
    const dataFile = (...parts) => path.join(tmp, "data", "kintone", "apps", "app-1", ...parts);
    const g4 = runGuard({ tool_name: "Write", tool_input: { file_path: dataFile("app.json") }, cwd: tmp });
    expect("guard: push 対象外の data/（app.json）への Write は deny", g4.decision === "deny", g4.raw);
    expect("guard: data/ の deny は編集できる範囲と取得物を案内", g4.raw.includes("push 対象") && g4.raw.includes("_agentdata"), g4.raw);
    // data/ は作業コピー: push 対象の設定ファイル（fields・layout・views・reports・app_settings・notifications・acl・customize）は編集できる
    for (const parts of [
      ["form", "fields.json"],
      ["form", "layout.json"],
      ["views", "views.json"],
      ["reports", "reports.json"],
      ["app_settings", "settings.json"],
      ["app_settings", "app_actions.json"],
      ["notifications", "notifications_perRecord.json"],
      ["acl", "record_acl.json"],
      ["customize", "customize-manifest.json"],
      ["customize", "desktop", "js", "main.js"],
      ["customize", "mobile", "css", "sub", "style.css"]
    ]) {
      const w = runGuard({ tool_name: "Write", tool_input: { file_path: dataFile(...parts) }, cwd: tmp });
      expect(`guard: push 対象 ${parts.join("/")} への Write は無出力（作業コピーとして編集できる）`, w.decision === "", w.raw);
    }
    // 取得物（push 対象外）は deny のまま
    for (const parts of [
      ["form", "form.json"],
      ["customize", "plugins.json"],
      ["customize", "customize.json"],
      ["customize", "plugin-configs", "p.json"],
      ["records", "records.csv"],
      [".kint-origin-pull.json"]
    ]) {
      const w = runGuard({ tool_name: "Write", tool_input: { file_path: dataFile(...parts) }, cwd: tmp });
      expect(`guard: 取得物 ${parts.join("/")} への Write は deny`, w.decision === "deny", w.raw);
    }
    // Windows のパスは大文字小文字を区別しないため、Data/ や DATA\ でも取得物は deny。_agentdata は各アプリ直下だけ
    for (const file of [
      path.join(tmp, "Data", "kintone", "apps", "app-1", "app.json"),
      "C:\\proj\\DATA\\kintone\\apps\\app-1\\records\\records.csv",
      dataFile("records", "_agentdata", "x.json"),
      path.join(tmp, "data", "kintone", "index", "_agentdata", "x.json")
    ]) {
      const w = runGuard({ tool_name: "Write", tool_input: { file_path: file }, cwd: tmp });
      expect(`guard: 大文字小文字違い・誤った位置の _agentdata でも取得物は deny: ${file.replace(tmp, "<tmp>")}`, w.decision === "deny", w.raw);
    }
    expect("guard: 大文字小文字違いの push 対象（DATA/…/Views/views.json）は無出力", runGuard({ tool_name: "Write", tool_input: { file_path: "C:\\proj\\DATA\\kintone\\apps\\app-1\\Views\\views.json" }, cwd: tmp }).decision === "", "case-insensitive target");
    // `..` で push 対象や _agentdata の外（取得物）へ抜けるパスは deny（path.join で正規化せず、そのままの文字列を渡す）
    const appRoot = dataFile();
    for (const traversal of ["/customize/desktop/js/../../../app.json", "/_agentdata/../app.json", "/views/views.json/../../app.json"]) {
      const w = runGuard({ tool_name: "Write", tool_input: { file_path: appRoot + traversal }, cwd: tmp });
      expect(`guard: .. を含む data/ のパスは deny: ${traversal}`, w.decision === "deny", w.raw);
    }
    const spaceApp = path.join(tmp, "data", "kintone", "spaces", "guestspace-62", "apps", "app-9");
    expect("guard: ゲストスペース配下のアプリでも push 対象は編集できる", runGuard({ tool_name: "Edit", tool_input: { file_path: path.join(spaceApp, "views", "views.json") }, cwd: tmp }).decision === "", "guestspace views");
    expect("guard: スペース配下の push 対象外（space.json）は deny", runGuard({ tool_name: "Write", tool_input: { file_path: path.join(tmp, "data", "kintone", "spaces", "space-5", "space.json") }, cwd: tmp }).decision === "deny", "space.json");
    expect("guard: お気に入り定義（favorites/）への Write は無出力", runGuard({ tool_name: "Write", tool_input: { file_path: path.join(tmp, "favorites", "group1.json") }, cwd: tmp }).decision === "", "favorites");
    expect("guard: ソース台帳とソースは編集できるがinstalled.jsonと..で取得物へ出るパスはdeny", ["sources.json", "sources.local.json", "custom/src/app.js"].every((p) => runGuard({ tool_name: "Write", tool_input: { file_path: path.join(tmp, "data", "kintone", "plugin", p) }, cwd: tmp }).decision === "")
      && runGuard({ tool_name: "Write", tool_input: { file_path: path.join(tmp, "data", "kintone", "plugin", "installed.json") }, cwd: tmp }).decision === "deny"
      && runGuard({ tool_name: "Write", tool_input: { file_path: "data/kintone/plugin/../index/apps.json" }, cwd: tmp }).decision === "deny", "plugin paths");
    expect("guard: 索引（data/kintone/index/）は deny", runGuard({ tool_name: "Write", tool_input: { file_path: path.join(tmp, "data", "kintone", "index", "apps.json") }, cwd: tmp }).decision === "deny", "index");
    const g5 = runGuard({ tool_name: "Write", tool_input: { file_path: path.join(tmp, "data", "kintone", "apps", "app-1", "_agentdata", "notes", "memo.md") }, cwd: tmp });
    expect("guard: _agentdata への Write は無出力（allow 評価へ）", g5.decision === "", g5.raw);
    const g6 = runGuard({ tool_name: "Edit", tool_input: { file_path: "data/kintone/index/apps.json" }, cwd: tmp });
    expect("guard: 相対パスの data/ Edit も deny", g6.decision === "deny", g6.raw);

    // .env（認証情報と操作制限）の保護
    const g7 = runGuard({ tool_name: "Write", tool_input: { file_path: path.join(tmp, ".env") }, cwd: tmp });
    expect("guard: .env への Write は deny", g7.decision === "deny", g7.raw);
    const g8 = runGuard({ tool_name: "Edit", tool_input: { file_path: ".env" }, cwd: tmp });
    expect("guard: 相対パスの .env Edit も deny", g8.decision === "deny", g8.raw);
    const g9 = runGuard({ tool_name: "Write", tool_input: { file_path: path.join(tmp, ".env.local") }, cwd: tmp });
    expect("guard: .env.local への Write も deny", g9.decision === "deny", g9.raw);
    const g10 = runGuard({ tool_name: "Write", tool_input: { file_path: path.join(tmp, ".env.example") }, cwd: tmp });
    expect("guard: .env.example への Write は無出力", g10.decision === "", g10.raw);
    const g11 = runGuard({ tool_name: "PowerShell", tool_input: { command: 'Set-Content .env "KINT_ORIGIN_ALLOW_PUSH_APP=true"' }, cwd: tmp });
    expect("guard: PowerShell の Set-Content .env は deny", g11.decision === "deny", g11.raw);
    const g12 = runGuard({ tool_name: "Bash", tool_input: { command: "echo KINT_ORIGIN_ALLOW_PUSH_APP=true >> .env" }, cwd: tmp });
    expect("guard: Bash の >> .env は deny", g12.decision === "deny", g12.raw);
    const g13 = runGuard({ tool_name: "Bash", tool_input: { command: "cp .env.example .env" }, cwd: tmp });
    expect("guard: cp で .env を作るのは deny", g13.decision === "deny", g13.raw);
    const g14 = runGuard({ tool_name: "PowerShell", tool_input: { command: "Get-Content .env.example" }, cwd: tmp });
    expect("guard: .env.example の参照は無出力", g14.decision === "", g14.raw);
    const g15 = runGuard({ tool_name: "Bash", tool_input: { command: "kint-origin policy" }, cwd: tmp });
    expect("guard: kint-origin policy は無出力", g15.decision === "", g15.raw);
    // レコード操作: push records は -y・--restore の有無を問わず ask、連結は deny、show / diff は無出力。実行記録 runs/ への Write は deny。
    const recordsAsk = runGuard({ tool_name: "Bash", tool_input: { command: "kint-origin push records --name 添付移行 -y" }, cwd: tmp });
    const recordsRestore = runGuard({ tool_name: "PowerShell", tool_input: { command: "kint-origin push records --name 添付移行 --restore 20261103-101530" }, cwd: tmp });
    const recordsChained = runGuard({ tool_name: "Bash", tool_input: { command: "kint-origin diff records --name x && kint-origin push records --name x -y" }, cwd: tmp });
    expect("guard: kint-origin push records は ask（-y・--restore の有無を問わない）", recordsAsk.decision === "ask" && recordsRestore.decision === "ask", `${recordsAsk.raw} / ${recordsRestore.raw}`);
    expect("guard: 連結した push records は deny", recordsChained.decision === "deny", recordsChained.raw);
    const readCommands = ["kint-origin show records --id 3 --records 1", "kint-origin diff records --name x"];
    expect("guard: show records と diff records は無出力", readCommands.every((command) => runGuard({ tool_name: "Bash", tool_input: { command }, cwd: tmp }).decision === ""), "show/diff records");
    const runsWrite = runGuard({ tool_name: "Write", tool_input: { file_path: path.join(tmp, "push", "records", "x", "runs", "20261103-101530", "result.json") }, cwd: tmp });
    const runsRelative = runGuard({ tool_name: "Edit", tool_input: { file_path: "push/records/x/runs/.gitignore" }, cwd: tmp });
    expect("guard: push/records/<ジョブ>/runs/ への Write / Edit は deny（理由に job.csv と --restore を案内）", runsWrite.decision === "deny" && runsRelative.decision === "deny" && runsWrite.raw.includes("job.csv") && runsWrite.raw.includes("--restore"), `${runsWrite.raw} / ${runsRelative.raw}`);
    // CSV 取込: push import は -y・--restore の有無を問わず ask、連結は deny、diff import は無出力。実行記録 runs/ への Write は deny（import.json・records.csv・雛形は無出力）。
    const importAsk = runGuard({ tool_name: "Bash", tool_input: { command: "kint-origin push import --name 社員取込 -y" }, cwd: tmp });
    const importRestore = runGuard({ tool_name: "PowerShell", tool_input: { command: "kint-origin push import --name 社員取込 --restore 20261103-101530" }, cwd: tmp });
    const importChained = runGuard({ tool_name: "Bash", tool_input: { command: "kint-origin diff import --name x && kint-origin push import --name x -y" }, cwd: tmp });
    expect("guard: kint-origin push import は ask（-y・--restore の有無を問わない）", importAsk.decision === "ask" && importRestore.decision === "ask", `${importAsk.raw} / ${importRestore.raw}`);
    expect("guard: 連結した push import は deny", importChained.decision === "deny", importChained.raw);
    expect("guard: diff import は無出力", runGuard({ tool_name: "Bash", tool_input: { command: "kint-origin diff import --name x" }, cwd: tmp }).decision === "", "diff import");
    const importRunsWrite = runGuard({ tool_name: "Write", tool_input: { file_path: path.join(tmp, "push", "import", "x", "runs", "20261103-101530", "result.json") }, cwd: tmp });
    const importRunsRelative = runGuard({ tool_name: "Edit", tool_input: { file_path: "push/import/x/runs/.gitignore" }, cwd: tmp });
    expect(
      "guard: push/import/<ジョブ>/runs/ への Write / Edit は deny（理由に import.json・records.csv と push import --restore を案内）",
      importRunsWrite.decision === "deny" && importRunsRelative.decision === "deny" && importRunsWrite.raw.includes("import.json") && importRunsWrite.raw.includes("push import --restore"),
      `${importRunsWrite.raw} / ${importRunsRelative.raw}`
    );
    const importInputs = ["push/import/x/import.json", "push/import/x/records.csv", "push/import/_example/import.json"];
    expect("guard: 取込ジョブの入力（import.json・records.csv）と雛形への Write は無出力", importInputs.every((p) => runGuard({ tool_name: "Write", tool_input: { file_path: path.join(tmp, ...p.split("/")) }, cwd: tmp }).decision === ""), "import inputs");
    const jobInputs = ["push/records/x/job.csv", "push/records/x/files/契約書.pdf", "push/records/_example/job.csv"];
    expect("guard: ジョブの入力（job.csv・files/）と雛形への Write は無出力", jobInputs.every((p) => runGuard({ tool_name: "Write", tool_input: { file_path: path.join(tmp, ...p.split("/")) }, cwd: tmp }).decision === ""), "job inputs");

    // Cursor の hook（beforeShellExecution）。push は -y の有無を問わず deny（ユーザーが自分のターミナルで実行する運用）、それ以外は allow。
    const cursorHooks = JSON.parse(fs.readFileSync(path.join(tmp, ".cursor", "hooks.json"), "utf8"));
    const cursorHookDef = cursorHooks.hooks?.beforeShellExecution?.[0] || {};
    expect("init: .cursor/hooks.json は version 1", cursorHooks.version === 1, JSON.stringify(cursorHooks));
    expect("init: Cursor hook が beforeShellExecution で kint-origin-guard.mjs を起動", String(cursorHookDef.command || "").includes(".cursor/hooks/kint-origin-guard.mjs"), JSON.stringify(cursorHookDef));
    expect("init: Cursor hook は failClosed で matcher なし", cursorHookDef.failClosed === true && !("matcher" in cursorHookDef), JSON.stringify(cursorHookDef));
    const cursorPreToolUse = cursorHooks.hooks?.preToolUse?.[0] || {};
    expect(
      "init: Cursor hook が preToolUse（matcher Write）で kint-origin-guard.mjs を起動（接頭辞なしのスキル・ルールの新規作成を拒否）",
      cursorPreToolUse.matcher === "Write" && String(cursorPreToolUse.command || "").includes(".cursor/hooks/kint-origin-guard.mjs"),
      JSON.stringify(cursorPreToolUse)
    );
    const cursorGuardPath = path.join(tmp, ".cursor", "hooks", "kint-origin-guard.mjs");
    const runCursorGuard = (stdin) => {
      const r = spawnSync(process.execPath, [cursorGuardPath], { encoding: "utf8", input: stdin });
      const out = (r.stdout || "").trim();
      try {
        const parsed = JSON.parse(out);
        return { status: r.status, permission: parsed.permission || "", userMessage: parsed.user_message || "", agentMessage: parsed.agent_message || "", raw: out };
      } catch {
        return { status: r.status, permission: "(parse error)", userMessage: "", agentMessage: "", raw: out };
      }
    };
    // 同じ表を Claude の guard にも流し、push の判定が一致すること（Claude が ask / deny ⇔ Cursor が deny）も確かめる。
    const cursorCases = [
      { command: "kint-origin push app --id 3", want: "deny" },
      { command: "kint-origin push app --id 3 -y", want: "deny" },
      { command: "kint-origin push create --all --yes", want: "deny" },
      { command: "kint-origin push app --id 3 --only customize", want: "deny" },
      { command: "kint-origin push app --id 3 --only customize -y", want: "deny" },
      { command: '"C:\\tools\\kint-origin.cmd" push app --id 3', want: "deny" },
      { command: "kint-origin.ps1 push app --id 3 -y", want: "deny" },
      { command: "kint-origin pull app --id 3", want: "allow" },
      { command: "kint-origin diff app --id 3", want: "allow" },
      { command: "kint-origin diff create --all", want: "allow" },
      { command: "kint-origin push records --name 添付移行 -y", want: "deny" },
      { command: "kint-origin push records --name 添付移行 --restore 20261103-101530", want: "deny" },
      { command: "kint-origin diff records --name 添付移行", want: "allow" },
      { command: "kint-origin push import --name 社員取込 -y", want: "deny" },
      { command: "kint-origin push import --name 社員取込 --restore 20261103-101530", want: "deny" },
      { command: "kint-origin diff import --name 社員取込", want: "allow" },
      { command: "kint-origin show records --id 303 --records 12", want: "allow" },
      { command: "kint-origin policy", want: "allow" },
      { command: "git status", want: "allow" }
    ];
    for (const { command, want } of cursorCases) {
      const c = runCursorGuard(JSON.stringify({ hook_event_name: "beforeShellExecution", command, cwd: "", workspace_roots: [tmp] }));
      expect(`cursor guard: ${command} は ${want}`, c.status === 0 && c.permission === want, c.raw);
      if (want === "deny") {
        expect(`cursor guard: ${command} の拒否は理由と対処（diff で確認・ユーザーが端末で実行）を返す`, c.userMessage.includes("kint-origin diff") && c.userMessage.includes("ターミナル") && c.agentMessage !== "", c.raw);
        expect(`cursor guard: ${command} の拒否は対象コマンドを示し、-y をユーザー専用とは言わない`, c.userMessage.includes(command) && !c.userMessage.includes("ユーザー専用") && !c.agentMessage.includes("ユーザー専用"), c.raw);
      }
      const claude = runGuard({ tool_name: "PowerShell", tool_input: { command }, cwd: tmp });
      expect(`cursor guard と Claude guard の push 判定が一致: ${command}`, (claude.decision !== "") === (c.permission === "deny"), `claude=${claude.raw} cursor=${c.raw}`);
    }
    const cursorBad = runCursorGuard("not json");
    expect("cursor guard: 不正な入力は deny（fail closed）", cursorBad.status === 0 && cursorBad.permission === "deny" && cursorBad.userMessage !== "", cursorBad.raw);

    // Codex の実行ポリシー（.codex/ を信頼したときだけ有効）。push は prompt、forbidden は使わない。
    const codexRules = fs.readFileSync(path.join(tmp, ".codex", "rules", "kint-origin.rules"), "utf8");
    expect(
      "init: .codex/rules/kint-origin.rules は kint-origin push を prompt",
      codexRules.includes("prefix_rule(") && codexRules.includes('decision = "prompt"') && codexRules.includes('"kint-origin"') && codexRules.includes('"push"'),
      codexRules
    );
    expect("init: .codex/rules/kint-origin.rules は forbidden を使わない", !codexRules.includes('decision = "forbidden"'), codexRules);
    expect("init: .codex/rules/kint-origin.rules は diff を止めない（not_match）", codexRules.includes("kint-origin diff app"), codexRules);
    expect(
      "init: .codex/rules/kint-origin.rules は push records（--restore を含む）を match、diff records と show records を not_match に含む",
      codexRules.includes("kint-origin push records --name 添付移行 -y") && codexRules.includes("--restore 20261103-101530") && codexRules.includes("kint-origin diff records --name 添付移行") && codexRules.includes("kint-origin show records --id 303 --records 12"),
      codexRules
    );

    expect(
      "init: .codex/rules/kint-origin.rules は push import（--restore を含む）を match、diff import を not_match に含む",
      codexRules.includes("kint-origin push import --name 社員取込 -y") && codexRules.includes("kint-origin push import --name 社員取込 --restore 20261103-101530") && codexRules.includes("kint-origin diff import --name 社員取込"),
      codexRules
    );

    // Codex の hook（.codex/ の信頼と /hooks での信頼が要る）。独自スキル・ルールを kint-origin-local- の名前で作らせる。
    const codexHooks = JSON.parse(fs.readFileSync(path.join(tmp, ".codex", "hooks.json"), "utf8"));
    const codexPre = codexHooks.hooks?.PreToolUse?.[0] || {};
    const codexPreHook = codexPre.hooks?.[0] || {};
    expect(
      "init: .codex/hooks.json は PreToolUse の ^apply_patch$ で kint-origin-guard.mjs を起動",
      codexPre.matcher === "^apply_patch$" && codexPreHook.type === "command" && String(codexPreHook.command || "").includes(".codex/hooks/kint-origin-guard.mjs"),
      JSON.stringify(codexHooks)
    );

    // 操作制限の配布物（.env.example・ルール・コマンド索引）
    const envExample = fs.readFileSync(path.join(tmp, ".env.example"), "utf8");
    // キー行はコメントアウトせず、policy.ts の既定値と一致させる（使う側が行を外す手間を無くす）。
    const envExampleDefaults = { PULL_KINTONE: "true", PULL_RECORDS: "false", BULK_RECORDS: "false", PULL_RECORDS_ALL_ONCE: "false", PULL_COMMENTS_ALL_ONCE: "false", PULL_USERS: "false", PUSH_APP: "false", PUSH_SPACE: "false", PUSH_RECORDS: "false" };
    expect(
      "init: .env.example に操作制限 9 キーを有効な行で既定値どおり含む",
      Object.entries(envExampleDefaults).every(([k, v]) => new RegExp(`^KINT_ORIGIN_ALLOW_${k}=${v}$`, "m").test(envExample)),
      envExample
    );
    expect("init: .env.example の操作制限行に行内コメントが無い", !/KINT_ORIGIN_ALLOW_\w+=\S+[ \t]+#/.test(envExample), envExample);
    const policyRule = fs.readFileSync(path.join(tmp, ".agents", "rules", "kint-origin.md"), "utf8");
    expect("init: ルールに kint-origin policy を含む", policyRule.includes("kint-origin policy"), policyRule.slice(0, 300));
    const policySkill = fs.readFileSync(path.join(tmp, ".claude", "skills", "kint-origin-commands", "SKILL.md"), "utf8");
    expect("init: コマンド索引に KINT_ORIGIN_ALLOW_ の表を含む", policySkill.includes("KINT_ORIGIN_ALLOW_PULL_RECORDS"), policySkill.slice(0, 300));

    // push 配布物（スキル・_example・ドラフト置き場）
    for (const rel of [
      path.join(".claude", "skills", "kint-origin-push", "SKILL.md"),
      path.join(".agents", "skills", "kint-origin-push", "SKILL.md"),
      path.join(".claude", "skills", "kint-origin-push", "references", "space-html-trials.md"),
      path.join(".agents", "skills", "kint-origin-push", "references", "space-html-trials.md"),
      ...["README.md", "form/fields.json", "form/layout.json", "views/views.json"].flatMap((rel) =>
        [".claude", ".agents"].map((root) => path.join(root, "skills", "kint-origin-push", "references", "app-blank", ...rel.split("/")))
      ),
      path.join("push", "new-apps", "_example", "README.md"),
      path.join("push", "new-apps", "_example", "app.json"),
      path.join("push", "new-apps", "_example", "form", "fields.json"),
      path.join("push", "new-apps", "_example", "views", "views.json"),
      path.join(".claude", "skills", "kint-origin-records", "SKILL.md"),
      path.join(".agents", "skills", "kint-origin-records", "SKILL.md"),
      path.join(".claude", "skills", "kint-origin-pull", "SKILL.md"),
      path.join(".agents", "skills", "kint-origin-pull", "SKILL.md"),
      path.join("push", "records", "_example", "job.csv"),
      path.join("push", "records", "_example", "README.md"),
      path.join("favorites", "_example.json")
    ]) {
      expect(`init: ${rel.replaceAll(path.sep, "/")} を生成`, fs.existsSync(path.join(tmp, rel)), `missing: ${rel}`);
    }
    const domainReadme = fs.readFileSync(path.join(tmp, "README.md"), "utf8");
    const approvalGuide = domainReadme.split("\n## 反映前の確認\n")[1]?.split("\n## ")[0] ?? "";
    const guideCommands = ["diff app", "diff create", "diff space", "diff records", "diff import", "diff rehearsal", "push --help", "push import --help", "policy"];
    expect(
      "init: README の反映前の確認から差分・ヘルプ・許可の確認を始められる",
      domainReadme.includes("](#反映前の確認)") && guideCommands.every((command) => approvalGuide.includes(`kint-origin ${command}`)),
      approvalGuide
    );
    expect("init: push/new-apps ディレクトリを作成", fs.existsSync(path.join(tmp, "push", "new-apps")), "push/new-apps missing");
    const commonCustomizeDirs = [
      "data/kintone/common/customize/desktop/js",
      "data/kintone/common/customize/desktop/css",
      "data/kintone/common/customize/mobile/js",
      "data/kintone/common/customize/mobile/css"
    ];
    expect("init: 共通カスタマイズの保存先を作成", commonCustomizeDirs.every((rel) => fs.existsSync(path.join(tmp, rel))), commonCustomizeDirs.join("\n"));
    expect("init: push/records ディレクトリを作成", fs.existsSync(path.join(tmp, "push", "records")), "push/records missing");
    expect("init: push/import ディレクトリと雛形（import.json・records.csv・README.md）を作成", ["import.json", "records.csv", "README.md"].every((name) => fs.existsSync(path.join(tmp, "push", "import", "_example", name))), "push/import/_example missing");
    expect("init: .gitignore は CSV 取込の実行記録（push/import/*/runs/）を除外", gitignore.includes("push/import/*/runs/"), gitignore);
    const importExample = JSON.parse(fs.readFileSync(path.join(tmp, "push", "import", "_example", "import.json"), "utf8"));
    expect("init: 雛形の import.json は app と updateKey を持つ", importExample.app !== undefined && typeof importExample.updateKey === "string", JSON.stringify(importExample));
    const importSkill = fs.readFileSync(path.join(tmp, ".claude", "skills", "kint-origin-records", "SKILL.md"), "utf8");
    expect(
      "init: レコード操作スキルに CSV 取込（push import・更新キー・job.csv では更新キーの上書き追加ができない）がある",
      importSkill.includes("push import") && importSkill.includes("diff import") && importSkill.includes("更新キー") && importSkill.includes("import.json") && importSkill.includes("references/import-csv.md") && importSkill.includes("PUSH_RECORDS"),
      importSkill.slice(0, 300)
    );
    const importRule = fs.readFileSync(path.join(tmp, ".claude", "rules", "kint-origin.md"), "utf8");
    expect("init: ルールが push import と push/import/<ジョブ名>/runs/ の編集禁止を述べる", importRule.includes("push import") && importRule.includes("push/import/<ジョブ名>/runs/"), importRule.slice(0, 200));
    expect("init: .gitignore はレコード操作の実行記録（push/records/*/runs/）を除外", gitignore.includes("push/records/*/runs/"), gitignore);
    const recordsSkill = fs.readFileSync(path.join(tmp, ".claude", "skills", "kint-origin-records", "SKILL.md"), "utf8");
    expect(
      "init: レコード操作スキル（show / diff / push records・ジョブ CSV・--restore・ループ禁止）",
      recordsSkill.includes("name: kint-origin-records") && recordsSkill.includes("show records") && recordsSkill.includes("diff records") && recordsSkill.includes("push records") && recordsSkill.includes("job.csv") && recordsSkill.includes("--restore") && recordsSkill.includes("ループ") && recordsSkill.includes("new:<キー>"),
      recordsSkill.slice(0, 300)
    );
    const exampleJob = fs.readFileSync(path.join(tmp, "push", "records", "_example", "job.csv"), "utf8");
    expect("init: 雛形の job.csv は必須列のヘッダーを持つ", exampleJob.startsWith("op,from_app,from_record,from_field,to_app,to_record,to_field,mode,value"), exampleJob.slice(0, 120));
    const recordsRuleBody = fs.readFileSync(path.join(tmp, ".claude", "rules", "kint-origin.md"), "utf8");
    expect("init: ルールがレコード操作スキルを参照し、runs/ の編集禁止を述べる", recordsRuleBody.includes("kint-origin-records") && recordsRuleBody.includes("runs/"), recordsRuleBody.slice(0, 200));
    const recordsDoc = fs.readFileSync(path.join(tmp, "CLAUDE.md"), "utf8");
    expect("init: CLAUDE.md がレコード操作スキルを案内", recordsDoc.includes("kint-origin-records"), recordsDoc.slice(0, 200));
    const pushSkill = fs.readFileSync(path.join(tmp, ".claude", "skills", "kint-origin-push", "SKILL.md"), "utf8");
    expect("init: push スキルが README の案内と -y の確認省略を参照", pushSkill.includes("README") && pushSkill.includes("-y"), pushSkill.slice(0, 300));
    expect("init: push スキルが {{app:名前}} 構文を記述", pushSkill.includes("{{app:"), pushSkill.slice(0, 300));
    const cmdSkillPush = fs.readFileSync(path.join(tmp, ".claude", "skills", "kint-origin-commands", "SKILL.md"), "utf8");
    expect("init: コマンド索引に push app / push create を含む", cmdSkillPush.includes("push app") && cmdSkillPush.includes("push create"), cmdSkillPush.slice(0, 300));
    expect("init: favorites ディレクトリを作成", fs.existsSync(path.join(tmp, "favorites")), "favorites missing");
    expect("init: コマンド索引に pull favorite と favorites/ を含む", cmdSkillPush.includes("pull favorite") && cmdSkillPush.includes("favorites/"), cmdSkillPush.slice(0, 300));
    expect("init: settings.json は参照系(grep)を許可", allow.includes("Bash(grep:*)"), JSON.stringify(allow));
    expect("init: settings.json は PowerShell 参照系を許可", allow.includes("PowerShell(Get-ChildItem:*)"), JSON.stringify(allow));
    expect("init: settings.json は kint-origin を ask", ask.some((p) => p.includes("kint-origin")), JSON.stringify(ask));
    expect("init: settings.json は kint-origin を allow しない", !allow.some((p) => p.includes("kint-origin")), JSON.stringify(allow));
    // サブエージェント廃止に伴い gh の許可は持たない
    expect("init: settings.json は gh を allow しない", !allow.some((p) => /\bgh /.test(p)), JSON.stringify(allow));
    // Codex も Cursor も .agents/rules/project.rules を読まない（Codex の正式な置き場は信頼済みの .codex/rules/）ため生成しない。
    expect("init: 効かない .agents/rules/project.rules を生成しない", !fs.existsSync(path.join(tmp, ".agents", "rules", "project.rules")), "project.rules exists");
    // 共通ルールがコマンド索引スキルを参照する
    const claudeRuleBody = fs.readFileSync(path.join(tmp, ".claude", "rules", "kint-origin.md"), "utf8");
    expect("init: ルールがコマンド索引スキルを参照", claudeRuleBody.includes("kint-origin-commands"), claudeRuleBody);

    // 操作スキルがURL→ローカルパス、結果の参照資料が_errorスタブを案内
    const cmdSkill = fs.readFileSync(path.join(tmp, ".claude", "skills", "kint-origin-commands", "SKILL.md"), "utf8");
    expect("init: コマンド索引にゲストスペースのパスを含む", cmdSkill.includes("guestspace-<") || cmdSkill.includes("/k/guest/"), cmdSkill.slice(0, 200));
    const resultGuide = fs.readFileSync(path.join(tmp, ".claude/skills/kint-origin-commands/references/results.md"), "utf8");
    expect("init: 結果の参照資料に _error スタブの注意を含む", resultGuide.includes("_error"), resultGuide.slice(0, 200));

    // 未置換プレースホルダが生成物に残らないこと（{{app: は push の構文なので対象外）。
    {
      const leftovers = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else {
            const body = fs.readFileSync(p, "utf8");
            if (/\{\{[A-Z_]+\}\}/.test(body)) leftovers.push(`${p}: 未置換プレースホルダ`);
          }
        }
      };
      walk(tmp);
      expect("init: 生成物に未置換プレースホルダが残らない", leftovers.length === 0, leftovers.join("\n"));
    }

    // agents/ 雛形がドメイン直下へフラットコピーされないこと
    expect("init: agents/ がフラットコピーされない", !fs.existsSync(path.join(tmp, "agents")), "agents/ exists");
    expect("init: AGENT_DOC.md が直置きされない", !fs.existsSync(path.join(tmp, "AGENT_DOC.md")), "AGENT_DOC.md exists");

    // init 再実行で既存は温存（上書きされない）
    const sentinel = "// user edit sentinel\n";
    fs.appendFileSync(path.join(tmp, "CLAUDE.md"), sentinel, "utf8");
    const distSkill = path.join(".claude", "skills", "kint-origin-commands", "SKILL.md");
    fs.appendFileSync(path.join(tmp, distSkill), sentinel, "utf8");
    const commonCustomizeFile = path.join(tmp, commonCustomizeDirs[0], "domain.js");
    fs.writeFileSync(commonCustomizeFile, "// domain customization\n", "utf8");
    fs.rmSync(path.join(tmp, commonCustomizeDirs[2]), { recursive: true, force: true });
    // 利用者の独自スキル（kint-origin-local-*）。init の再実行でも update でも触られない
    const localSkills = [path.join(".claude", "skills", "kint-origin-local-sample", "SKILL.md"), path.join(".agents", "skills", "kint-origin-local-sample", "SKILL.md")];
    const localSkillBody = "---\nname: kint-origin-local-sample\ndescription: user skill\n---\n\nuser skill body\n";
    for (const rel of localSkills) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), localSkillBody, "utf8");
    }
    const pushGuardFiles = [
      ".agents/hooks/kint-origin-guard-core.mjs",
      ".claude/hooks/kint-origin-guard.mjs",
      path.join(".cursor", "hooks.json"),
      path.join(".cursor", "hooks", "kint-origin-guard.mjs"),
      path.join(".codex", "rules", "kint-origin.rules"),
      path.join(".codex", "hooks.json"),
      path.join(".codex", "hooks", "kint-origin-guard.mjs")
    ];
    for (const rel of pushGuardFiles) fs.appendFileSync(path.join(tmp, rel), sentinel, "utf8");
    const reinit = runCli(["init"], tmp);
    expect("init 再実行は exit 0", reinit.status === 0, `status=${reinit.status}\n${reinit.stderr}`);
    expect("init 再実行は共通カスタマイズの既存ファイルを温存", fs.readFileSync(commonCustomizeFile, "utf8") === "// domain customization\n", commonCustomizeFile);
    expect("init 再実行は不足した共通カスタマイズの保存先を作成", fs.existsSync(path.join(tmp, commonCustomizeDirs[2])), commonCustomizeDirs[2]);
    expect("init 再実行は既存 CLAUDE.md を温存", fs.readFileSync(path.join(tmp, "CLAUDE.md"), "utf8").includes(sentinel), "sentinel lost");
    expect("init 再実行は既存の配布スキルを温存（上書きしない）", fs.readFileSync(path.join(tmp, distSkill), "utf8").includes(sentinel), "dist skill sentinel lost");
    for (const rel of localSkills) {
      expect(`init 再実行は ${rel.replaceAll(path.sep, "/")} を温存`, fs.readFileSync(path.join(tmp, rel), "utf8") === localSkillBody, "local skill changed");
    }
    for (const rel of pushGuardFiles) {
      expect(`init 再実行は既存 ${rel.replaceAll(path.sep, "/")} を温存`, fs.readFileSync(path.join(tmp, rel), "utf8").includes(sentinel), "sentinel lost");
    }

    // update は生成ファイルを上書きするが、無関係なユーザーファイルは温存する
    const codexUserFile = path.join(tmp, ".codex", "config.toml");
    const cursorUserFile = path.join(tmp, ".cursor", "rules", "user.mdc");
    const domainGitignore = path.join(tmp, ".gitignore");
    fs.mkdirSync(path.dirname(cursorUserFile), { recursive: true });
    fs.writeFileSync(codexUserFile, "codex user config\n", "utf8");
    fs.writeFileSync(cursorUserFile, "cursor user rule\n", "utf8");
    fs.writeFileSync(domainGitignore, "# domain-specific rule\nprivate-domain-file.txt\n", "utf8");

    // 独自に書き換えた README を、update が配布版へ戻すことを検証する。
    const readmePath = path.join(tmp, "README.md");
    fs.writeFileSync(readmePath, "# 独自に書き換えた README\n", "utf8");

    // 管理対象の雛形のみ再配布し、利用者の実ドラフトは温存する。
    const examplePath = path.join(tmp, "push", "new-apps", "_example", "README.md");
    const userDraftPath = path.join(tmp, "push", "new-apps", "my-app", "app.json");
    fs.writeFileSync(examplePath, "user broke example\n", "utf8");
    const recordsExamplePath = path.join(tmp, "push", "records", "_example", "job.csv");
    const userJobPath = path.join(tmp, "push", "records", "my-job", "job.csv");
    fs.mkdirSync(path.dirname(userJobPath), { recursive: true });
    fs.writeFileSync(recordsExamplePath, "user broke records example\n", "utf8");
    const importExamplePath = path.join(tmp, "push", "import", "_example", "records.csv");
    const userImportJobPath = path.join(tmp, "push", "import", "my-import", "records.csv");
    fs.mkdirSync(path.dirname(userImportJobPath), { recursive: true });
    fs.writeFileSync(importExamplePath, "user broke import example\n", "utf8");
    fs.writeFileSync(userImportJobPath, "id\nuser import job\n", "utf8");
    fs.writeFileSync(userJobPath, "op,from_app\nuser job\n", "utf8");
    fs.mkdirSync(path.dirname(userDraftPath), { recursive: true });
    fs.writeFileSync(userDraftPath, '{"name": "my-app"}\n', "utf8");
    // お気に入りの雛形（favorites/_example.json）は上書き再配布、ユーザーの定義（favorites/group1.json）は温存されること。
    const favExamplePath = path.join(tmp, "favorites", "_example.json");
    const favUserPath = path.join(tmp, "favorites", "group1.json");
    fs.writeFileSync(favExamplePath, "user broke favorite example\n", "utf8");
    fs.writeFileSync(favUserPath, '{"apps": [1]}\n', "utf8");
    // ドメイン独自のアプリテンプレート zip（push/app-templates/）は update の上書き対象にしない。
    const userZipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80]);
    const userZipPath = path.join(tmp, "push", "app-templates", "my.zip");
    fs.mkdirSync(path.dirname(userZipPath), { recursive: true });
    fs.writeFileSync(userZipPath, userZipBytes);

    const update = runCli(["update", "-y"], tmp);
    expect("update は exit 0", update.status === 0, `status=${update.status}\n${update.stderr}`);
    expect("update は CLAUDE.md を上書き復元（編集が消える）", !fs.readFileSync(path.join(tmp, "CLAUDE.md"), "utf8").includes(sentinel), "sentinel remained");
    expect("update は配布スキル kint-origin-commands を上書き復元", !fs.readFileSync(path.join(tmp, distSkill), "utf8").includes(sentinel), "dist skill sentinel remained");
    for (const rel of localSkills) {
      expect(`update: ${rel.replaceAll(path.sep, "/")} を温存（kint-origin-local- は上書き・削除しない）`, fs.existsSync(path.join(tmp, rel)) && fs.readFileSync(path.join(tmp, rel), "utf8") === localSkillBody, "local skill changed or removed");
    }
    for (const rel of pushGuardFiles) {
      expect(`update は ${rel.replaceAll(path.sep, "/")} を上書き復元`, !fs.readFileSync(path.join(tmp, rel), "utf8").includes(sentinel), "sentinel remained");
    }
    expect("update: 書き換えた README を配布版（反映前の確認を含む）へ戻す",fs.existsSync(readmePath) && fs.readFileSync(readmePath, "utf8") === domainReadme, "README.md not updated");
    checkDomainKnowledge(tmp, fs.readdirSync(path.join(ROOT, "template/agents/common/skills")));
    ok("update: 配布した入口・スキル・参照資料のリンクと到達性");
    expect("update: 無関係な .codex/config.toml は温存", fs.readFileSync(codexUserFile, "utf8") === "codex user config\n", ".codex/config.toml changed");
    expect("update: 無関係な .cursor のユーザーファイルは温存", fs.readFileSync(cursorUserFile, "utf8") === "cursor user rule\n", ".cursor user file changed");
    expect("update: .gitignore は既存ルールを保って .env と全件取得用の一時ファイルを除外", fs.readFileSync(domainGitignore, "utf8").includes("private-domain-file.txt")
      && fs.readFileSync(domainGitignore, "utf8").includes(".env\n")
      && fs.readFileSync(domainGitignore, "utf8").includes(".env.kint-origin-all.*.tmp")
      && fs.readFileSync(domainGitignore, "utf8").includes("data/kintone/index/.bulk-source.json")
      && fs.readFileSync(domainGitignore, "utf8").includes("captures/kintone-common/"), fs.readFileSync(domainGitignore, "utf8"));
    expect("update: 結果 JSON は updated・unchanged・preserved・warnings・addons を持つ（removed は無い）", (() => { try { const j = JSON.parse(update.stdout); return Array.isArray(j.updated) && typeof j.unchanged === "number" && Array.isArray(j.preserved) && Array.isArray(j.warnings) && Array.isArray(j.addons) && !("plugins" in j) && !("removed" in j); } catch { return false; } })(), update.stdout.slice(0, 500));
    expect("update: push/new-apps/_example を上書き再配布", !fs.readFileSync(examplePath, "utf8").includes("user broke example"), "_example not restored");
    expect("update: ユーザーの実ドラフト（push/new-apps/my-app）は温存", fs.readFileSync(userDraftPath, "utf8").includes('"name": "my-app"'), "user draft changed");
    expect("update: push/records/_example を上書き再配布", fs.readFileSync(recordsExamplePath, "utf8").startsWith("op,from_app"), "records _example not restored");
    expect("update: ドメイン独自のアプリテンプレート zip（push/app-templates/my.zip）は温存（バイナリも壊さない）", fs.existsSync(userZipPath) && fs.readFileSync(userZipPath).equals(userZipBytes), "user zip changed");
    expect("update: push/import/_example を上書き再配布", fs.readFileSync(importExamplePath, "utf8").startsWith("社員番号,"), "import _example not restored");
    expect("update: ユーザーの取込ジョブ（push/import/my-import）は温存", fs.readFileSync(userImportJobPath, "utf8").includes("user import job"), "user import job changed");
    expect("update: ユーザーのジョブ（push/records/my-job）は温存", fs.readFileSync(userJobPath, "utf8").includes("user job"), "user job changed");
    expect("update: favorites/_example.json を上書き再配布", !fs.readFileSync(favExamplePath, "utf8").includes("user broke favorite example"), "favorites/_example.json not restored");
    expect("update: ユーザーの定義（favorites/group1.json）は温存", fs.readFileSync(favUserPath, "utf8") === '{"apps": [1]}\n', "favorites/group1.json changed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- 1h. push 変換層（オフライン・純関数） --------------------------------
async function pushItemsTests() {
  console.log("[offline] push 変換層（pushItems）");

  const moduleUrl = pathToFileURL(path.join(ROOT, "dist", "kintone", "pushItems.js")).href;
  const { PUSH_ITEMS, PUSH_KEYS, isErrorStub, stripRevision, splitFieldProperties } = await import(moduleUrl);
  const item = (key) => PUSH_ITEMS.find((i) => i.key === key);

  // stripRevision / isErrorStub
  expect("push: stripRevision が revision('-') を除去", !("revision" in stripRevision({ a: 1, revision: "-" })), "revision remained");
  expect("push: isErrorStub が _error スタブを判定", isErrorStub({ _error: "GAIA_IL23" }) && !isErrorStub({ properties: {} }), "stub detection failed");
  expect("push: PUSH_KEYS に fields を含む", PUSH_KEYS.includes("fields") && PUSH_KEYS.includes("views"), PUSH_KEYS.join(","));

  // fields の add/update/missing 振り分け（組み込みフィールド除外・lookup 参照正規化）
  const local = {
    レコード番号: { type: "RECORD_NUMBER", code: "レコード番号" },
    作成者: { type: "CREATOR", code: "作成者" },
    既存: { type: "SINGLE_LINE_TEXT", code: "既存" },
    新規: { type: "SINGLE_LINE_TEXT", code: "新規", lookup: { relatedApp: { app: "12", code: "CUST" }, relatedKeyField: "会社名" } }
  };
  const remote = {
    レコード番号: { type: "RECORD_NUMBER", code: "レコード番号" },
    ステータス: { type: "STATUS", code: "ステータス" },
    既存: { type: "SINGLE_LINE_TEXT", code: "既存" },
    リモートのみ: { type: "NUMBER", code: "リモートのみ" }
  };
  const split = splitFieldProperties(local, remote);
  expect("push: fields add はローカルのみ（組み込み除外）", Object.keys(split.add).join(",") === "新規", JSON.stringify(Object.keys(split.add)));
  expect("push: fields update は両方に存在", Object.keys(split.update).join(",") === "既存", JSON.stringify(Object.keys(split.update)));
  expect("push: missingOnLocal はリモートのみ（組み込み除外）", split.missingOnLocal.join(",") === "リモートのみ", JSON.stringify(split.missingOnLocal));
  expect("push: lookup.relatedApp は app 優先で code を落とす", split.add["新規"].lookup.relatedApp.app === "12" && !("code" in split.add["新規"].lookup.relatedApp), JSON.stringify(split.add["新規"].lookup));

  // settings: icon(FILE) は除去、PRESET は保持
  const ctxU = { appId: "3", mode: "update" };
  const sFile = item("settings").buildBody({ name: "x", icon: { type: "FILE", key: { fileKey: "-" } }, revision: "-" }, ctxU);
  expect("push: settings の icon(FILE) を除去", "body" in sFile && !("icon" in sFile.body) && sFile.body.app === "3" && sFile.body.name === "x", JSON.stringify(sFile));
  const sPreset = item("settings").buildBody({ name: "x", icon: { type: "PRESET", key: "APP72" }, revision: "-" }, ctxU);
  expect("push: settings の icon(PRESET) は保持", "body" in sPreset && sPreset.body.icon?.key === "APP72", JSON.stringify(sPreset));
  expect("push: settings の revision を送らない", !("revision" in sPreset.body), JSON.stringify(sPreset.body));

  // views: create は id 除去・update は保持・空はスキップ
  const viewsPayload = { views: { 一覧: { id: "20", type: "LIST", name: "一覧" } }, revision: "-" };
  const vCreate = item("views").buildBody(viewsPayload, { appId: "3", mode: "create" });
  const vUpdate = item("views").buildBody(viewsPayload, ctxU);
  expect("push: views は create で id 除去", "body" in vCreate && !("id" in vCreate.body.views["一覧"]), JSON.stringify(vCreate));
  expect("push: views は update で id 保持", "body" in vUpdate && vUpdate.body.views["一覧"].id === "20", JSON.stringify(vUpdate));
  expect("push: views 空はスキップ", "skip" in item("views").buildBody({ views: {}, revision: "-" }, ctxU), "empty views not skipped");

  // status: states null はスキップ、設定ありは enable/states/actions を送る
  expect("push: status(states null) はスキップ", "skip" in item("status").buildBody({ enable: false, states: null, actions: null, revision: "-" }, ctxU), "null states not skipped");
  const st = item("status").buildBody({ enable: true, states: { 未処理: {} }, actions: [], revision: "-" }, ctxU);
  expect("push: status は enable/states を送る", "body" in st && st.body.enable === true && st.body.states, JSON.stringify(st));

  // actions: destApp は app 優先で code を落とす
  const act = item("actions").buildBody(
    { actions: { 転記: { id: "9", index: "0", destApp: { app: "77", code: "DEST" }, mappings: [] } }, revision: "-" },
    ctxU
  );
  expect("push: actions の destApp は app 優先", "body" in act && act.body.actions["転記"].destApp.app === "77" && !("code" in act.body.actions["転記"].destApp), JSON.stringify(act));

  // acl: rights 空はスキップ
  expect("push: app_acl 空はスキップ", "skip" in item("app_acl").buildBody({ rights: [], revision: "-" }, ctxU), "empty rights not skipped");
}

// ---- 1i. 新規アプリドラフト（オフライン・純関数＋一時dir） -----------------
async function appDraftTests() {
  console.log("[offline] 新規アプリドラフト（appDraft）");

  const moduleUrl = pathToFileURL(path.join(ROOT, "dist", "kintone", "appDraft.js")).href;
  const { collectAppRefs, resolveAppRefsDeep, createAppRefResolver, orderDraftsByDependency, listNewAppDrafts, readAppDraft } =
    await import(moduleUrl);

  // 収集と全置換（文字列内埋め込みも）
  const refs = collectAppRefs({ a: [{ b: "{{app:顧客}}" }], c: "url https://x/k/{{app:案件}}/", d: 1 });
  expect("draft: collectAppRefs が入れ子から収集", refs.sort().join(",") === "案件,顧客", refs.join(","));
  const resolved = resolveAppRefsDeep({ x: "app={{app:A}} and {{app:A}}" }, () => "9");
  expect("draft: resolveAppRefsDeep が全置換", resolved.x === "app=9 and 9", JSON.stringify(resolved));

  // 解決の優先順位: 作成分 > 数値 > code > 一意 name。重複・未解決はエラー
  const index = new Map([
    ["5", { appId: "5", code: "CUST", name: "顧客" }],
    ["6", { appId: "6", code: "", name: "重複" }],
    ["7", { appId: "7", code: "", name: "重複" }]
  ]);
  const resolver = createAppRefResolver({ createdByName: new Map([["A", "101"]]), index });
  expect("draft: 作成分を最優先で解決", resolver("A") === "101", resolver("A"));
  expect("draft: 数値はそのまま appId", resolver("123") === "123", resolver("123"));
  expect("draft: code 一致で解決", resolver("CUST") === "5", resolver("CUST"));
  expect("draft: name 一意一致で解決", resolver("顧客") === "5", resolver("顧客"));
  for (const [label, ref, needle] of [
    ["重複 name はエラー", "重複", "複数"],
    ["未解決はエラー", "存在しない", "解決できません"]
  ]) {
    try {
      resolver(ref);
      ng(`draft: ${label}`, "throw されなかった");
    } catch (e) {
      expect(`draft: ${label}`, String(e.message).includes(needle), e.message);
    }
  }

  // 依存順（参照される側が先）・循環はエラー
  const dA = { draftName: "A", meta: { name: "アプリA" }, refs: [] };
  const dB = { draftName: "B", meta: { name: "アプリB" }, refs: ["アプリA"] };
  const ordered = orderDraftsByDependency([dB, dA]);
  expect("draft: 依存順は A → B", ordered.map((d) => d.draftName).join(",") === "A,B", ordered.map((d) => d.draftName).join(","));
  try {
    orderDraftsByDependency([
      { draftName: "A", meta: { name: "アプリA" }, refs: ["B"] },
      { draftName: "B", meta: { name: "アプリB" }, refs: ["A"] }
    ]);
    ng("draft: 循環参照はエラー", "throw されなかった");
  } catch (e) {
    expect("draft: 循環参照はエラー（回避手順つき）", String(e.message).includes("循環") && String(e.message).includes("push app"), e.message);
  }

  // 一時 dir: 列挙（_ 始まり除外）・app.json 検証・created.json・refs 収集
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-drafts-"));
  try {
    const fooDir = path.join(tmp, "foo");
    fs.mkdirSync(path.join(fooDir, "form"), { recursive: true });
    fs.writeFileSync(path.join(fooDir, "app.json"), JSON.stringify({ name: "Foo" }), "utf8");
    fs.writeFileSync(
      path.join(fooDir, "form", "fields.json"),
      JSON.stringify({ properties: { x: { type: "SINGLE_LINE_TEXT", lookup: { relatedApp: { app: "{{app:Bar}}" } } } } }),
      "utf8"
    );
    fs.mkdirSync(path.join(tmp, "_example"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "_example", "app.json"), JSON.stringify({ name: "sample" }), "utf8");

    const drafts = listNewAppDrafts(tmp);
    expect("draft: _ 始まりのディレクトリを除外して列挙", drafts.length === 1 && drafts[0].draftName === "foo", JSON.stringify(drafts.map((d) => d.draftName)));
    expect("draft: refs を全 JSON から収集", drafts[0].refs.join(",") === "Bar", drafts[0].refs.join(","));
    expect("draft: created 未作成は undefined", !drafts[0].created, JSON.stringify(drafts[0].created));

    fs.writeFileSync(path.join(fooDir, "created.json"), JSON.stringify({ appId: "55", createdAt: "2026-01-01" }), "utf8");
    const withCreated = readAppDraft(fooDir);
    expect("draft: created.json を読み込む", withCreated.created?.appId === "55", JSON.stringify(withCreated.created));

    const badDir = path.join(tmp, "bad");
    fs.mkdirSync(badDir, { recursive: true });
    try {
      readAppDraft(badDir);
      ng("draft: app.json 無しはエラー", "throw されなかった");
    } catch (e) {
      expect("draft: app.json 無しはエラー", String(e.message).includes("app.json"), e.message);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- 1j. push CLI 引数検証（オフライン） -----------------------------------
function pushCliTests() {
  console.log("[offline] push CLI 引数検証・非TTY 早期チェック");

  // push app / create は操作制限が先に判定されるため、許可キー入りの一時 .env で引数検証する。
  const allowTmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-push-allow-"));
  try {
    fs.writeFileSync(
      path.join(allowTmp, ".env"),
      "KINT_ORIGIN_ALLOW_PUSH_APP=true\n",
      "utf8"
    );
    const appNoId = runCli(["push", "app"], allowTmp, NO_SHELL_CREDS);
    expect("push app --id 無しは exit 1", appNoId.status === 1, `status=${appNoId.status}`);
    expect("push app --id 無しは Missing required argument", appNoId.stderr.includes("Missing required argument: --id"), appNoId.stderr);

    // 非TTY×-y なしは API 前に早期エラー（diff で確認し、承認したうえで -y を付ける案内つき。-y はユーザー専用ではない）
    for (const args of [
      ["push", "app", "--id", "3"],
      ["push", "create", "--all"]
    ]) {
      const noTty = runCli(args, allowTmp, NO_SHELL_CREDS);
      expect(`${args.slice(0, 2).join(" ")} 非TTY×-y なしは exit 1`, noTty.status === 1, `status=${noTty.status}\n${noTty.stderr}`);
      expect(
        `${args.slice(0, 2).join(" ")} 非TTY は diff の確認と -y を案内（ユーザー専用とは言わない）`,
        noTty.stderr.includes("kint-origin diff") && noTty.stderr.includes("-y を付けて") && !noTty.stderr.includes("ユーザー専用"),
        noTty.stderr
      );
    }

    // --only の未知キーは有効キー一覧つきエラー（-y で非TTY チェックを通過させて検証）
    const badOnly = runCli(["push", "app", "--id", "3", "--only", "bogus", "-y"], allowTmp, NO_SHELL_CREDS);
    expect("push app --only 未知キーは exit 1", badOnly.status === 1, `status=${badOnly.status}`);
    expect("push app --only 未知キーは有効キー一覧を表示", badOnly.stderr.includes("--only に不明なキー") && badOnly.stderr.includes("views"), badOnly.stderr);

    // 未取得のアプリは pull を案内する（API・認証値の前に判定）
    const noApp = runCli(["push", "app", "--id", "517", "-y"], allowTmp, NO_SHELL_CREDS);
    expect("push app: 未取得アプリは exit 1", noApp.status === 1, `status=${noApp.status}`);
    expect("push app: 未取得アプリは pull app を案内（_agentdata/push は使わない）", noApp.stderr.includes("未取得") && noApp.stderr.includes("pull app --id 517") && !noApp.stderr.includes("_agentdata/push"), noApp.stderr);
  } finally {
    fs.rmSync(allowTmp, { recursive: true, force: true });
  }

  // 不明なオプション・余分な引数は、操作制限の判定や API・認証値の読み込みより前に中断する。
  // diff create は API を呼ばず許可も不要。local-test の中身に左右されないよう、空の一時 dir で実行する。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-push-cli-"));
  try {
    for (const args of [
      ["push", "app", "--id", "3", "--bogus"],
      ["push", "create", "--all", "--bogus"],
      ["pull", "kintone", "extra"],
      ["pull", "app", "--id", "3", "--bogus"],
      ["pull", "records", "--id", "3", "-f"],
      ["diff", "app", "--id", "3", "-y"],
      ["diff", "create", "--bogus"],
      ["init", "foo"],
      ["update", "--force"],
      ["policy", "--json"]
    ]) {
      const r = runCli(args, tmp, NO_SHELL_CREDS);
      expect(
        `${args.join(" ")} は不明なオプション・引数で exit 1（操作制限・認証値より前）`,
        r.status === 1 && r.stderr.includes("不明な") && !r.stderr.includes("操作制限:") && !r.stderr.includes("Missing required"),
        `status=${r.status}\n${r.stderr}`
      );
    }
    const hint = runCli(["push", "app", "--id", "3", "--bogus"], tmp, NO_SHELL_CREDS);
    expect("不明なオプションは、そのコマンドで使えるオプションを案内", hint.stderr.includes("push app で使えるオプション") && hint.stderr.includes("--base") && hint.stderr.includes("-y/--yes"), hint.stderr);
    expect("不明なオプションの拒否では init / update の生成物を作らない", !fs.existsSync(path.join(tmp, "CLAUDE.md")) && !fs.existsSync(path.join(tmp, "data")), fs.readdirSync(tmp).join(","));

    // diff create: ドラフト無し／対象指定なしのエラー
    const noDrafts = runCli(["diff", "create"], tmp, NO_SHELL_CREDS);
    expect("diff create: ドラフト無しは exit 1", noDrafts.status === 1, `status=${noDrafts.status}`);
    expect("diff create: ドラフト無しは new-apps の案内", noDrafts.stderr.includes("push/new-apps"), noDrafts.stderr);

    const draftDir = path.join(tmp, "push", "new-apps", "foo");
    fs.mkdirSync(draftDir, { recursive: true });
    fs.writeFileSync(path.join(draftDir, "app.json"), JSON.stringify({ name: "Foo" }), "utf8");
    const noTarget = runCli(["diff", "create"], tmp, NO_SHELL_CREDS);
    expect("diff create: --name/--all 無しは exit 1", noTarget.status === 1, `status=${noTarget.status}`);
    expect("diff create: --name/--all 無しはドラフト一覧を表示", noTarget.stderr.includes("--name") && noTarget.stderr.includes("foo"), noTarget.stderr);

    const notFound = runCli(["diff", "create", "--name", "zzz"], tmp, NO_SHELL_CREDS);
    expect("diff create: 存在しないドラフト名は exit 1", notFound.status === 1, `status=${notFound.status}`);

    // diff create は作成せず終了（ネットワーク不要・許可不要・認証値不要）。作成順と復旧プランを出す
    const plan = runCli(["diff", "create", "--name", "foo"], tmp, NO_SHELL_CREDS);
    expect("diff create は許可・認証値なしで exit 0", plan.status === 0, `status=${plan.status}\n${plan.stderr}`);
    expect("diff create は作成順のサマリ JSON を出す", plan.stdout.includes('"order"') && plan.stdout.includes('"draftName": "foo"'), plan.stdout);
    expect("diff create は復旧プランを表示", plan.stderr.includes("復旧プラン"), plan.stderr);
    expect("diff create は created.json を書かない", !fs.existsSync(path.join(draftDir, "created.json")), "created.json exists");

    // 依存順（参照される側が先）
    const barDir = path.join(tmp, "push", "new-apps", "bar");
    fs.mkdirSync(path.join(barDir, "form"), { recursive: true });
    fs.writeFileSync(path.join(barDir, "app.json"), JSON.stringify({ name: "Bar" }), "utf8");
    fs.writeFileSync(
      path.join(barDir, "form", "fields.json"),
      JSON.stringify({ properties: { x: { type: "SINGLE_LINE_TEXT", lookup: { relatedApp: { app: "{{app:Foo}}" } } } } }),
      "utf8"
    );
    const all = runCli(["diff", "create", "--all"], tmp, NO_SHELL_CREDS);
    let order = "";
    try {
      order = JSON.parse(all.stdout).order.map((o) => o.draftName).join(",");
    } catch {
      order = `(parse error) ${all.stdout}`;
    }
    expect("diff create --all は依存順（参照される Foo が先）で並べ、refs を出す", all.status === 0 && order === "foo,bar" && all.stdout.includes('"Foo"'), `${order}\n${all.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function pushCreatePreflightTests() {
  console.log("[offline] push create の事前依存・作成済みマーカー検証");
  const mock = await startMockKintone((url) => {
    if (url.pathname === "/k/v1/app.json" && url.searchParams.get("id") === "88") return [404, { code: "GAIA_AP01", message: "not found" }];
    return [200, {}];
  });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-create-preflight-"));
  const makeDomain = (name) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".env"), Object.entries(mockEnv(mock.baseUrl)).map(([k, v]) => `${k}=${v}`).join("\n") + "\nKINT_ORIGIN_ALLOW_PUSH_APP=true\n", "utf8");
    return dir;
  };
  const makeDraft = (root, folder, appName, reference) => {
    const dir = path.join(root, "push", "new-apps", folder);
    fs.mkdirSync(path.join(dir, "form"), { recursive: true });
    writeJsonFile(path.join(dir, "app.json"), { name: appName });
    if (reference) writeJsonFile(path.join(dir, "form", "fields.json"), { properties: { lookup: { type: "SINGLE_LINE_TEXT", lookup: { relatedApp: { app: `{{app:${reference}}}` } } } } });
    return dir;
  };
  const run = (dir, args) => runCliAsync(["push", "create", ...args, "-y"], dir, mockEnv(mock.baseUrl));
  try {
    // 同じ app.json 名を持つ複数のドラフトへの参照は、どちらを作るか決められないため作成前に拒否する。
    let dir = makeDomain("duplicate-alias");
    makeDraft(dir, "source-a", "Source");
    makeDraft(dir, "source-b", "Source");
    makeDraft(dir, "child", "Child", "Source");
    mock.requests.length = 0;
    let result = await run(dir, ["--name", "child"]);
    expect("push create: 重複するドラフト別名を作成前に拒否", result.status === 1 && result.stderr.includes("複数のドラフトに一致") && mock.requests.length === 0, `${result.stderr}\n${mock.requests.join("\n")}`);

    // 未作成の依存ドラフトが選択外なら、先に依存先を作成するよう案内し、API POST は行わない。
    dir = makeDomain("unselected-dependency");
    makeDraft(dir, "source", "Source");
    makeDraft(dir, "child", "Child", "Source");
    mock.requests.length = 0;
    result = await run(dir, ["--name", "child"]);
    expect("push create: 選択外の未作成依存を作成前に拒否", result.status === 1 && result.stderr.includes("今回の対象に含まれていません") && mock.requests.length === 0, `${result.stderr}\n${mock.requests.join("\n")}`);

    // domain 記録が不一致の created.json は、既存 appId の再利用や作成を行う前に拒否する。
    dir = makeDomain("wrong-marker-domain");
    const sourceDir = makeDraft(dir, "source", "Source");
    writeJsonFile(path.join(sourceDir, "created.json"), { appId: "88", createdAt: "2026-01-01T00:00:00Z", domain: "other.example" });
    makeDraft(dir, "child", "Child", "Source");
    mock.requests.length = 0;
    result = await run(dir, ["--name", "child"]);
    expect("push create: 接続先の異なる created.json を事前拒否", result.status === 1 && result.stderr.includes("別のドメイン用") && mock.requests.length === 0, `${result.stderr}\n${mock.requests.join("\n")}`);

    // --all で既作成ドラフトを依存先に使う場合、deploy 前に運用環境側の存在を確認する。
    dir = makeDomain("created-dependency");
    const createdDir = makeDraft(dir, "source", "Source");
    writeJsonFile(path.join(createdDir, "created.json"), { appId: "88", createdAt: "2026-01-01T00:00:00Z", domain: new URL(mock.baseUrl).host });
    makeDraft(dir, "child", "Child", "Source");
    mock.requests.length = 0;
    result = await run(dir, ["--all"]);
    expect("push create --all: 既作成依存が運用環境に無ければ新規作成前に中断", result.status === 1 && result.stderr.includes("動作テスト環境にだけ存在") && mock.requests.some((request) => request.startsWith("GET ")) && !mock.requests.some((request) => request.startsWith("POST ")), `${result.stderr}\n${mock.requests.join("\n")}`);
  } finally {
    mock.server.closeAllConnections();
    mock.server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ---- 1k. deploy 集約・復旧プラン（オフライン・純関数） ---------------------
async function pushDeployTests() {
  console.log("[offline] deploy 集約・復旧プラン文言");

  const moduleUrl = pathToFileURL(path.join(ROOT, "dist", "kintone", "push.js")).href;
  const { summarizeDeployStatuses, buildRecoveryPlanText } = await import(moduleUrl);

  const success = summarizeDeployStatuses([
    { app: "1", status: "SUCCESS" },
    { app: "2", status: "SUCCESS" }
  ]);
  expect("deploy: 全 SUCCESS は success", success.state === "success", JSON.stringify(success));
  const processing = summarizeDeployStatuses([
    { app: "1", status: "SUCCESS" },
    { app: "2", status: "PROCESSING" }
  ]);
  expect("deploy: PROCESSING 混在は processing", processing.state === "processing", JSON.stringify(processing));
  const failedResult = summarizeDeployStatuses([
    { app: "1", status: "FAIL" },
    { app: "2", status: "CANCEL" },
    { app: "3", status: "SUCCESS" }
  ]);
  expect("deploy: FAIL/CANCEL は failed＋appId 列挙", failedResult.state === "failed" && failedResult.failed.join(",") === "1,2", JSON.stringify(failedResult));

  const planCreate = buildRecoveryPlanText({ mode: "create" });
  expect("復旧プラン(create): アプリ削除の案内を含む", planCreate.includes("削除"), planCreate);
  const planRecords = buildRecoveryPlanText({
    mode: "records",
    backupRoot: "push/records/t/runs/20261103-101530/backup/",
    restoreCommand: "kint-origin push records --name t --restore 20261103-101530"
  });
  expect(
    "復旧プラン(records): バックアップパス・--restore・即時反映・分割時の注意・更新者の注意を含む",
    planRecords.includes("runs/20261103-101530/backup/") &&
      planRecords.includes("--restore 20261103-101530") &&
      planRecords.includes("即時") &&
      planRecords.includes("複数回に分かれる") &&
      planRecords.includes("Webhook"),
    planRecords
  );
}

// ---- 1n. 操作制限（.env の KINT_ORIGIN_ALLOW_*）（オフライン・一時dir） ----
async function policyTests() {
  console.log("[offline] 操作制限（.env の KINT_ORIGIN_ALLOW_*）");

  const policyUrl = pathToFileURL(path.join(ROOT, "dist", "policy.js")).href;
  const httpUrl = pathToFileURL(path.join(ROOT, "dist", "http.js")).href;
  const { parsePolicy, requiredPermissions, classifyRequest, activateGrants, assertCliKintoneAllowed } = await import(policyUrl);
  const { fetchCybozuResponse } = await import(httpUrl);

  // 純関数: 既定値と値の解釈
  const def = parsePolicy({}, {});
  expect("policy: 未設定は pull:kintone だけ許可", [...def.allowed].join(",") === "pull:kintone" && def.errors.length === 0, JSON.stringify([...def.allowed]));
  const custom = parsePolicy({ KINT_ORIGIN_ALLOW_PULL_USERS: "TRUE", KINT_ORIGIN_ALLOW_PULL_KINTONE: " false " }, {});
  expect("policy: true/false は大文字小文字・前後空白を無視", custom.allowed.has("pull:users") && !custom.allowed.has("pull:kintone"), JSON.stringify([...custom.allowed]));
  const empty = parsePolicy({ KINT_ORIGIN_ALLOW_PULL_KINTONE: "" }, {});
  expect("policy: 空値は既定値", empty.allowed.has("pull:kintone") && empty.errors.length === 0, JSON.stringify([...empty.allowed]));
  const invalid = parsePolicy({ KINT_ORIGIN_ALLOW_PUSH_APP: "1" }, {});
  expect("policy: true/false 以外は errors（許可しない）", invalid.errors.length === 1 && invalid.errors[0].includes("KINT_ORIGIN_ALLOW_PUSH_APP") && !invalid.allowed.has("push:app"), JSON.stringify(invalid.errors));
  const inlineComment = parsePolicy({ KINT_ORIGIN_ALLOW_PUSH_APP: "true # push app" }, {});
  expect("policy: 行内コメント付きの値も不正値", inlineComment.errors.length === 1, JSON.stringify(inlineComment.errors));
  const unknown = parsePolicy({ KINT_ORIGIN_ALLOW_PUL_USERS: "true" }, {});
  expect("policy: 未知キーは warnings（許可は既定のまま）", unknown.warnings.some((w) => w.includes("KINT_ORIGIN_ALLOW_PUL_USERS")) && !unknown.allowed.has("pull:users"), JSON.stringify(unknown.warnings));
  const fromProcess = parsePolicy({}, { KINT_ORIGIN_ALLOW_PUSH_APP: "true" });
  expect("policy: プロセス環境変数は無視して警告", !fromProcess.allowed.has("push:app") && fromProcess.warnings.some((w) => w.includes("無視")), JSON.stringify(fromProcess.warnings));
  const sameAsFile = parsePolicy({ KINT_ORIGIN_ALLOW_PUSH_APP: "true" }, { KINT_ORIGIN_ALLOW_PUSH_APP: "true" });
  expect("policy: .env と同値のプロセス環境変数は警告しない", sameAsFile.warnings.length === 0, JSON.stringify(sameAsFile.warnings));

  // 純関数: コマンド → 必要な許可
  const req = (c, s, a = {}) => requiredPermissions(c, s, a).join(",");
  expect("policy: pull kintone は kintone", req("pull", "kintone") === "pull:kintone", req("pull", "kintone"));
  expect("policy: pull plugins は kintone", req("pull", "plugins") === "pull:kintone", req("pull", "plugins"));
  expect("policy: pull common API は kintone、--from はローカルのみ", req("pull", "common") === "pull:kintone" && req("pull", "common", { from: "captures/kintone-common" }) === "", req("pull", "common"));
  expect("policy: pull all は kintone と users", req("pull", "all") === "pull:kintone,pull:users", req("pull", "all"));
  expect("policy: pull app --a は records も要る", req("pull", "app", { a: true }) === "pull:kintone,pull:records", req("pull", "app", { a: true }));
  expect("policy: pull records は records", req("pull", "records") === "pull:records", req("pull", "records"));
  expect("policy: pull comments は records", req("pull", "comments") === "pull:records", req("pull", "comments"));
  expect("policy: pull users は users", req("pull", "users") === "pull:users", req("pull", "users"));
  expect("policy: pull favorite は kintone", req("pull", "favorite") === "pull:kintone", req("pull", "favorite"));
  expect("policy: push app は push:app", req("push", "app") === "push:app", req("push", "app"));
  expect("policy: push create は push:app", req("push", "create") === "push:app", req("push", "create"));
  expect("policy: diff app はローカル処理のため許可不要", req("diff", "app") === "", req("diff", "app"));
  expect("policy: diff create は許可不要（API を呼ばない）", req("diff", "create") === "", req("diff", "create"));
  expect("policy: show records は pull:records だけ", req("show", "records") === "pull:records", req("show", "records"));
  expect("policy: diff records は pull:kintone と pull:records", req("diff", "records") === "pull:kintone,pull:records", req("diff", "records"));
  expect("policy: push records は pull:records と push:records", req("push", "records") === "pull:records,push:records", req("push", "records"));
  expect("policy: diff import は pull:kintone と pull:records", req("diff", "import") === "pull:kintone,pull:records", req("diff", "import"));
  expect("policy: diff rehearsal は API・権限を要求しない", req("diff", "rehearsal") === "", req("diff", "rehearsal"));
  expect("policy: push import は pull:records と push:records", req("push", "import") === "pull:records,push:records", req("push", "import"));
  expect("policy: PUSH_APP は app / create をまとめて許可しcustomizeもappに含む", ["app", "create"].every((sub) => req("push", sub) === "push:app"), "");
  expect("policy: PUSH_RECORDS は records / import をまとめて許可", ["records", "import"].every((sub) => req("push", sub) === "pull:records,push:records"), "");
  expect("policy: PULL_RECORDS_ALL_ONCE / PULL_COMMENTS_ALL_ONCE / BULK_RECORDS は既定で拒否", !def.allowed.has("pull:bulk-records") && !def.allowed.has("pull:records-all-once") && !def.allowed.has("pull:comments-all-once"), JSON.stringify([...def.allowed]));
  expect("policy: PUSH_RECORDS は既定で許可されない", !def.allowed.has("push:records") && parsePolicy({ KINT_ORIGIN_ALLOW_PUSH_RECORDS: "true" }, {}).allowed.has("push:records"), JSON.stringify([...def.allowed]));
  try {
    requiredPermissions("diff", "bogus", {});
    ng("policy: 未登録の diff サブコマンドはエラー", "throw されなかった");
  } catch (e) {
    expect("policy: 未登録の diff サブコマンドはエラー", String(e.message).includes("未登録"), e.message);
  }

  // 純関数: API の分類
  const cls = (m, p) => classifyRequest(m, p)?.anyOf.join(",") ?? "";
  expect("policy: POST は push:app が必要", cls("POST", "/k/v1/preview/app.json") === "push:app", cls("POST", "/k/v1/preview/app.json"));
  expect("policy: PUT も push:app が必要", cls("PUT", "/k/v1/preview/app/settings.json") === "push:app", cls("PUT", "/k/v1/preview/app/settings.json"));
  expect("policy: User API は users", cls("GET", "/v1/users.json") === "pull:users", cls("GET", "/v1/users.json"));
  expect("policy: records.json は records", cls("GET", "/k/v1/records.json") === "pull:records", cls("GET", "/k/v1/records.json"));
  expect("policy: record.json は records", cls("GET", "/k/v1/record.json") === "pull:records", cls("GET", "/k/v1/record.json"));
  expect("policy: record/comments.json は records", cls("GET", "/k/v1/record/comments.json") === "pull:records", cls("GET", "/k/v1/record/comments.json"));
  expect("policy: plugins/required.json は kintone", cls("GET", "/k/v1/plugins/required.json") === "pull:kintone", cls("GET", "/k/v1/plugins/required.json"));
  expect("policy: records/cursor.json は records", cls("GET", "/k/v1/records/cursor.json") === "pull:records", cls("GET", "/k/v1/records/cursor.json"));
  expect("policy: guest の file.json は records", cls("GET", "/k/guest/5/v1/file.json") === "pull:records", cls("GET", "/k/guest/5/v1/file.json"));
  expect("policy: guest ID の形式を問わず records は遮断対象", cls("GET", "/k/guest/abc/v1/records.json") === "pull:records", cls("GET", "/k/guest/abc/v1/records.json"));
  expect("policy: preview 接頭辞の records も遮断対象", cls("GET", "/k/v1/preview/records.json") === "pull:records" && cls("GET", "/k/guest/5/v1/preview/file.json") === "pull:records", cls("GET", "/k/v1/preview/records.json"));
  const recordAclPaths = ["/k/v1/record/acl.json", "/k/guest/5/v1/record/acl.json", "/k/v1/preview/record/acl.json"];
  expect(
    "policy: レコードのアクセス権設定 record/acl.json は制限外（guest・preview も）",
    recordAclPaths.every((p) => cls("GET", p) === ""),
    recordAclPaths.map((p) => `${p}=${cls("GET", p)}`).join(" ")
  );
  expect("policy: record/comments.json は records", cls("GET", "/k/v1/record/comments.json") === "pull:records", cls("GET", "/k/v1/record/comments.json"));
  expect("policy: app.json の GET は制限外（小文字 get も）", cls("GET", "/k/v1/app.json") === "" && cls("get", "/k/v1/app.json") === "", "");
  const recordWrites = [
    ["PUT", "/k/v1/records.json"],
    ["POST", "/k/v1/record.json"],
    ["POST", "/k/v1/file.json"],
    ["POST", "/k/guest/5/v1/file.json"],
    ["POST", "/k/v1/bulkRequest.json"],
    ["POST", "/k/guest/5/v1/bulkRequest.json"],
    ["DELETE", "/k/v1/records.json"]
  ];
  expect(
    "policy: レコード・添付・一括処理の書き込みは push:records だけ（push app の許可では通らない）",
    recordWrites.every(([m, p]) => cls(m, p) === "push:records"),
    recordWrites.map(([m, p]) => `${m} ${p}=${cls(m, p)}`).join(" ")
  );
  expect(
    "policy: アプリ設定の書き込み（record/acl.json の PUT を含む）は push:app",
    cls("PUT", "/k/v1/preview/record/acl.json") === "push:app" && cls("POST", "/k/v1/preview/app.json") === "push:app",
    `${cls("PUT", "/k/v1/preview/record/acl.json")} / ${cls("POST", "/k/v1/preview/app.json")}`
  );
  const spaceWrites = [
    ["PUT", "/k/v1/space.json"],
    ["PUT", "/k/v1/space/body.json"],
    ["PUT", "/k/v1/space/thread.json"],
    ["PUT", "/k/guest/5/v1/space.json"],
    ["PUT", "/k/guest/5/v1/space/body.json"],
    ["PUT", "/k/guest/5/v1/space/thread.json"]
  ];
  expect(
    "policy: スペース設定・本文の書き込みは push:space だけ（push app / create の許可では通らない）",
    spaceWrites.every(([m, p]) => cls(m, p) === "push:space"),
    spaceWrites.map(([m, p]) => `${m} ${p}=${cls(m, p)}`).join(" ")
  );

  // HTTP 層: グラント無しは fetch を呼ばずに遮断、グラント後は通る
  const env = { baseUrl: "https://example.invalid", username: "u", password: "p", language: "ja" };
  let calls = 0;
  const okFetch = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };
  const blocked = async (label, url, options) => {
    calls = 0;
    try {
      await fetchCybozuResponse(env, url, options, { fetchImpl: okFetch });
      ng(label, "throw されなかった");
    } catch (e) {
      expect(label, String(e.message).startsWith("操作制限:") && calls === 0, `calls=${calls} ${e.message}`);
    }
  };
  activateGrants([]);
  await blocked("http: グラント無しの POST は送信前に遮断", "https://example.invalid/k/v1/preview/app.json", { method: "POST", body: {} });
  await blocked("http: グラント無しの User API は遮断", "https://example.invalid/v1/users.json", {});
  await blocked("http: グラント無しのプラグイン一覧 API は遮断", "https://example.invalid/k/v1/plugins.json", {});
  await blocked("http: グラント無しの records.json は遮断", "https://example.invalid/k/v1/records.json", {});
  await blocked("http: グラント無しの guest file.json は遮断", "https://example.invalid/k/guest/5/v1/file.json", {});
  calls = 0;
  await fetchCybozuResponse(env, "https://example.invalid/k/v1/app.json", {}, { fetchImpl: okFetch });
  expect("http: アプリ設定の GET はグラント無しで通る", calls === 1, `calls=${calls}`);
  activateGrants(["pull:kintone"]);
  calls = 0;
  await fetchCybozuResponse(env, "https://example.invalid/k/v1/plugins.json", {}, { fetchImpl: okFetch });
  expect("http: pull:kintone の許可でプラグイン一覧 API が通る", calls === 1, `calls=${calls}`);
  activateGrants(["push:app", "pull:records"]);
  await blocked("http: push:app の許可ではレコードの PUT を遮断", "https://example.invalid/k/v1/records.json", { method: "PUT", body: {} });
  await blocked("http: push:app の許可では bulkRequest を遮断", "https://example.invalid/k/v1/bulkRequest.json", { method: "POST", body: {} });
  activateGrants(["push:records"]);
  calls = 0;
  await fetchCybozuResponse(env, "https://example.invalid/k/v1/records.json", { method: "PUT", body: {} }, { fetchImpl: okFetch });
  await fetchCybozuResponse(env, "https://example.invalid/k/v1/bulkRequest.json", { method: "POST", body: {} }, { fetchImpl: okFetch });
  expect("http: push:records の許可ではレコードの PUT と bulkRequest が通る", calls === 2, `calls=${calls}`);
  // push:records: レコード書き込み・添付アップロード・bulkRequest は通るが、アプリ設定の書き込みは通らない。
  activateGrants(["pull:records", "push:records"]);
  calls = 0;
  await fetchCybozuResponse(env, "https://example.invalid/k/v1/records.json", { method: "PUT", body: {} }, { fetchImpl: okFetch });
  await fetchCybozuResponse(env, "https://example.invalid/k/v1/records.json", { method: "POST", body: {} }, { fetchImpl: okFetch });
  await fetchCybozuResponse(env, "https://example.invalid/k/v1/records.json", { method: "DELETE", body: {} }, { fetchImpl: okFetch });
  await fetchCybozuResponse(env, "https://example.invalid/k/guest/5/v1/bulkRequest.json", { method: "POST", body: {} }, { fetchImpl: okFetch });
  await fetchCybozuResponse(env, "https://example.invalid/k/v1/file.json", { method: "POST", body: {} }, { fetchImpl: okFetch });
  expect("http: push:records の許可ではレコードの PUT / POST / DELETE・bulkRequest・添付のアップロードが通る", calls === 5, `calls=${calls}`);
  await blocked("http: push:records の許可ではアプリ設定の PUT を遮断", "https://example.invalid/k/v1/preview/app/settings.json", { method: "PUT", body: {} });
  await blocked("http: push:records の許可ではアプリ作成の POST を遮断", "https://example.invalid/k/v1/preview/app.json", { method: "POST", body: {} });
  await blocked("http: push:records の許可ではレコードのアクセス権設定の PUT（アプリ設定）を遮断", "https://example.invalid/k/v1/preview/record/acl.json", { method: "PUT", body: {} });
  activateGrants(["pull:records", "pull:users", "push:app"]);
  calls = 0;
  try {
    await fetchCybozuResponse(env, "https://example.invalid/k/v1/records.json", {}, { fetchImpl: okFetch });
    await fetchCybozuResponse(env, "https://example.invalid/v1/users.json", {}, { fetchImpl: okFetch });
    await fetchCybozuResponse(env, "https://example.invalid/k/v1/preview/app.json", { method: "POST", body: {} }, { fetchImpl: okFetch });
    expect("http: グラント後は records / users / POST が通る", calls === 3, `calls=${calls}`);
  } catch (e) {
    ng("http: グラント後は records / users / POST が通る", e.message);
  } finally {
    activateGrants([]);
  }

  // cli-kintone 層
  const cliBlocked = (label, args) => {
    try {
      assertCliKintoneAllowed(args);
      ng(label, "throw されなかった");
    } catch (e) {
      expect(label, String(e.message).startsWith("操作制限:"), e.message);
    }
  };
  const cliAllowed = (label, args) => {
    try {
      assertCliKintoneAllowed(args);
      ok(label);
    } catch (e) {
      ng(label, e.message);
    }
  };
  activateGrants([]);
  cliBlocked("cli-kintone: 未登録の操作（customize apply）は遮断", ["customize", "apply", "--app", "1"]);
  cliBlocked("cli-kintone: グラント無しの record export は遮断", ["record", "export", "--app", "1"]);
  cliBlocked("cli-kintone: 未登録の操作（record import）は遮断", ["record", "import", "--app", "1"]);
  cliAllowed("cli-kintone: customize export はグラント不要", ["customize", "export", "--app", "1"]);
  cliAllowed("cli-kintone: customize init はグラント不要", ["customize", "init", "--output", "m.json", "--yes"]);
  activateGrants(["push:app"]);
  cliBlocked("cli-kintone: push:app グラントがあっても未登録の customize apply は遮断", ["customize", "apply", "--app", "1"]);
  activateGrants(["pull:records"]);
  cliAllowed("cli-kintone: pull:records グラント後の record export は通る", ["record", "export", "--app", "1"]);
  activateGrants([]);

  // CLI: 一時 dir（.env の有無・内容を切り替える）
  const DUMMY_CREDS = "CYBOZU_BASE_URL=https://127.0.0.1:9\nCYBOZU_USERNAME=u\nCYBOZU_PASSWORD=p\nCYBOZU_LANGUAGE=ja\n";
  const withTmp = (envText, fn) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-policy-"));
    try {
      if (envText != null) fs.writeFileSync(path.join(tmp, ".env"), envText, "utf8");
      fn(tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
  const parseJson = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  };

  withTmp(null, (tmp) => {
    // 拒否された実行の結果は1度だけ起動して保持し、メッセージの検査で使い回す（同じコマンドを再起動しない）。
    const denied = new Map();
    for (const args of [
      ["pull", "users"],
      ["pull", "all"],
      ["pull", "records", "--id", "3"],
      ["pull", "app", "--id", "3", "--a"],
      ["push", "app", "--id", "3"],
      ["push", "space", "--id", "3"],
      ["push", "create", "--all"],
      ["push", "import", "--name", "x"]
    ]) {
      const r = runCli(args, tmp, NO_SHELL_CREDS);
      denied.set(args.join(" "), r);
      expect(
        `policy: .env 無しの ${args.join(" ")} は操作制限で exit 1（認証値の読み込み前）`,
        r.status === 1 && r.stderr.includes("操作制限:") && !r.stderr.includes("Missing required environment variable"),
        `status=${r.status}\n${r.stderr}`
      );
    }
    const users = denied.get("pull users");
    expect("policy: 拒否メッセージに必要な設定行", users.stderr.includes("KINT_ORIGIN_ALLOW_PULL_USERS=true"), users.stderr);
    expect("policy: 拒否メッセージは現在の許可を表示", users.stderr.includes("pull=kintone / push=なし"), users.stderr);
    expect("policy: 拒否メッセージは AI に .env を変更させない", users.stderr.includes("AI エージェントは .env を変更せず"), users.stderr);
    expect("policy: pull users は拒否時に PII 警告を出さない（実行前に止まる）", !users.stderr.includes("個人情報が含まれます"), users.stderr);
    const all = denied.get("pull all");
    expect("policy: pull all の拒否は pull kintone を案内", all.stderr.includes("kint-origin pull kintone"), all.stderr);
    const appA = denied.get("pull app --id 3 --a");
    expect("policy: pull app --a の拒否は records の設定行と --a を外す案内", appA.stderr.includes("KINT_ORIGIN_ALLOW_PULL_RECORDS=true") && appA.stderr.includes("--a を外して"), appA.stderr);
    const push = denied.get("push app --id 3");
    expect("policy: push app の拒否は diff app を案内（許可不要）", push.stderr.includes("kint-origin diff app") && push.stderr.includes("許可は不要"), push.stderr);
    const pushSpace = denied.get("push space --id 3");
    expect("policy: push space の拒否は PUSH_SPACE の設定行と diff space を案内", pushSpace.stderr.includes("KINT_ORIGIN_ALLOW_PUSH_SPACE=true") && pushSpace.stderr.includes("kint-origin diff space"), pushSpace.stderr);
    expect("policy: push create の拒否は diff create を案内", denied.get("push create --all").stderr.includes("kint-origin diff create"), denied.get("push create --all").stderr);
    const pushImport = denied.get("push import --name x");
    expect(
      "policy: push import の拒否は PULL_RECORDS と PUSH_RECORDS の設定行と diff import を案内",
      pushImport.stderr.includes("KINT_ORIGIN_ALLOW_PUSH_RECORDS=true") && pushImport.stderr.includes("KINT_ORIGIN_ALLOW_PULL_RECORDS=true") && pushImport.stderr.includes("kint-origin diff import"),
      pushImport.stderr
    );
    // 既定で pull kintone は判定を通過し、認証値の不足で失敗する（操作制限ではない）
    const kintone = runCli(["pull", "kintone"], tmp, NO_SHELL_CREDS);
    expect(
      "policy: .env 無しでも pull kintone は判定を通過",
      kintone.status === 1 && !kintone.stderr.includes("操作制限:") && kintone.stderr.includes("Missing required environment variable"),
      kintone.stderr
    );
    const summary = runCli(["policy"], tmp, NO_SHELL_CREDS);
    const json = parseJson(summary.stdout);
    expect(
      "policy コマンド: .env 無しは pull=kintone・push なし・envFile=false",
      summary.status === 0 && json.envFile === false && (json.allowed?.pull || []).join(",") === "kintone" && (json.allowed?.push || []).length === 0 && (json.settings || []).length === 9,
      summary.stdout
    );
  });

  withTmp(DUMMY_CREDS + "KINT_ORIGIN_ALLOW_PULL_USERS=true\n", (tmp) => {
    const r = runCli(["pull", "users"], tmp, NO_SHELL_CREDS);
    // PII 警告は usersPiiWarningTests で検査する。ここでは操作制限で止まらないことだけを見る。
    expect("policy: ALLOW_PULL_USERS=true なら pull users は操作制限で止まらない", r.status === 1 && !r.stderr.includes("操作制限:"), r.stderr);
  });

  withTmp(DUMMY_CREDS, (tmp) => {
    const r = runCli(["push", "app", "--id", "3"], tmp, { ...NO_SHELL_CREDS, KINT_ORIGIN_ALLOW_PUSH_APP: "true" });
    expect("policy: 環境変数での許可は無視され拒否", r.status === 1 && r.stderr.includes("操作制限:") && r.stderr.includes("無視"), r.stderr);
  });

  withTmp(DUMMY_CREDS + "KINT_ORIGIN_ALLOW_PUSH_APP=yes\n", (tmp) => {
    const r = runCli(["pull", "kintone"], tmp, NO_SHELL_CREDS);
    expect("policy: 不正値は無関係のコマンドも設定エラーで中断", r.status === 1 && r.stderr.includes("不正") && r.stderr.includes("KINT_ORIGIN_ALLOW_PUSH_APP"), r.stderr);
    const summary = runCli(["policy"], tmp, NO_SHELL_CREDS);
    const json = parseJson(summary.stdout);
    expect("policy コマンド: 不正値は exit 1 で errors を出す", summary.status === 1 && (json.errors || []).length === 1, summary.stdout);
  });

  withTmp("KINT_ORIGIN_ALLOW_PUSH_APP=true\n", (tmp) => {
    const summary = runCli(["policy"], tmp, NO_SHELL_CREDS);
    const json = parseJson(summary.stdout);
    const setting = (json.settings || []).find((s) => s.key === "KINT_ORIGIN_ALLOW_PUSH_APP");
    expect(
      "policy コマンド: .env の許可を反映（source=.env）",
      summary.status === 0 && json.envFile === true && (json.allowed?.push || []).join(",") === "app" && setting?.value === true && setting?.source === ".env",
      summary.stdout
    );
  });

  // pull all は users 未許可なら API を 1 回も呼ばない（mock サーバーで確認）
  const mock = await startMockKintone(() => [200, { apps: [] }]);
  const mockTmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-policy-mock-"));
  try {
    fs.writeFileSync(
      path.join(mockTmp, ".env"),
      Object.entries(mockEnv(mock.baseUrl)).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
      "utf8"
    );
    const r = await runCliAsync(["pull", "all"], mockTmp, mockEnv(mock.baseUrl));
    expect(
      "policy: users 未許可の pull all は API を呼ばない",
      r.status === 1 && r.stderr.includes("操作制限:") && mock.requests.length === 0,
      `requests=${mock.requests.join(",")}\n${r.stderr}`
    );
  } finally {
    mock.server.close();
    fs.rmSync(mockTmp, { recursive: true, force: true });
  }
}

// ---- 1o. KintoneClient の実 URL と操作制限（オフライン・mock HTTP サーバー） ----
// classifyRequest の手書きパス検証だけでは、KintoneClient が組み立てる実 URL（ゲスト接頭辞・preview）との食い違いに気づけない。
// 公開メソッドを表駆動で mock サーバーへ実際に送り、グラント無し／有りで遮断・通過を確かめる。
async function kintoneClientPolicyTests() {
  console.log("[offline] KintoneClient の実 URL と操作制限");

  const { KintoneClient } = await import(pathToFileURL(path.join(ROOT, "dist", "kintone", "client.js")).href);
  const { activateGrants } = await import(pathToFileURL(path.join(ROOT, "dist", "policy.js")).href);

  // 5xx / 429 はリトライで遅くなるため返さない。未定義のパスは 200 {}。
  let recordsResponse = { records: [] };
  const mock = await startMockKintone((url) => {
    const p = url.pathname.replace(/^\/k\/guest\/\d+\//, "/k/");
    if (p === "/k/v1/records.json") return [200, recordsResponse];
    if (p === "/k/v1/record/comments.json") return [200, { comments: [] }];
    if (p === "/k/v1/plugins/required.json") return [200, { plugins: [] }];
    if (p === "/k/v1/bulkRequest.json") return [200, { results: [{ records: [] }] }];
    // POST（アップロード）は fileKey を返す。GET（ダウンロード）はこの JSON がそのままファイルに書かれる。
    if (p === "/k/v1/file.json") return [200, { fileKey: "fk1" }];
    if (p === "/k/v1/apps.json") return [200, { apps: [] }];
    if (p === "/k/v1/preview/app.json") return [200, { app: "10", revision: "1" }];
    if (p === "/k/v1/preview/app/deploy.json") return [200, { apps: [{ app: "1", status: "SUCCESS" }] }];
    if (p === "/k/v1/app/plugin/config.json") return [200, { config: {}, revision: "1" }];
    return [200, {}];
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-client-policy-"));
  // env は明示する（省略すると getEnv() が cwd の .env を読む）。
  const client = new KintoneClient({ baseUrl: mock.baseUrl, username: "u", password: "p", language: "ja", apiIntervalMs: 0 });

  // need: null はグラント無しで通る。配列は「無しなら遮断、各グラント単独で通る」。
  const RECORDS = ["pull:records"];
  const KINTONE = ["pull:kintone"];
  const PUSH = ["push:app"];
  const SPACE_WRITE = ["push:space"];
  const RECORD_WRITE = ["push:records"];
  const uploadSource = path.join(tmp, "upload-source.txt");
  fs.writeFileSync(uploadSource, "upload body", "utf8");
  const cases = [
    { method: "getAppInfo", call: (g) => client.getAppInfo(1, g), http: "GET", path: "/v1/app.json", need: null },
    { method: "getSpace", call: (g) => client.getSpace(1, g), http: "GET", path: "/v1/space.json", need: null },
    { method: "listApps", call: (g) => client.listApps(g), http: "GET", path: "/v1/apps.json", need: null },
    { method: "listAllApps", call: () => client.listAllApps(), http: "GET", path: "/v1/apps.json", need: null, noGuest: true },
    { method: "getAppResource", call: (g) => client.getAppResource("/app/form/fields.json", 1, g), http: "GET", path: "/v1/app/form/fields.json", need: null },
    { method: "getAppResource", label: "getAppResource(preview)", call: (g) => client.getAppResource("/app/form/fields.json", 1, { ...g, preview: true }), http: "GET", path: "/v1/preview/app/form/fields.json", need: null },
    { method: "getAppResource", label: "getAppResource(record acl)", call: (g) => client.getAppResource("/record/acl.json", 1, g), http: "GET", path: "/v1/record/acl.json", need: null },
    { method: "getPluginConfig", call: (g) => client.getPluginConfig(1, "plugin", g), http: "GET", path: "/v1/app/plugin/config.json", need: null },
    { method: "getDeployStatuses", call: (g) => client.getDeployStatuses([1], g), http: "GET", path: "/v1/preview/app/deploy.json", need: null },
    { method: "request", call: (g) => client.request("/records.json", { ...g, query: { app: 1 } }), http: "GET", path: "/v1/records.json", need: RECORDS },
    { method: "request", label: "request(preview records)", call: (g) => client.request("/records.json", { ...g, preview: true, query: { app: 1 } }), http: "GET", path: "/v1/preview/records.json", need: RECORDS },
    { method: "paginate", call: (g) => client.paginate("/records.json", { ...g, resultKey: "records", query: { app: 1 } }), http: "GET", path: "/v1/records.json", need: RECORDS },
    { method: "downloadFileTo", call: (g, dest) => client.downloadFileTo("fk", dest, g), http: "GET", path: "/v1/file.json", need: RECORDS, file: true },
    { method: "getRecordsByQuery", call: (g) => client.getRecordsByQuery(1, { query: "$id in (1) limit 100", fields: ["$id"], ...g }), http: "GET", path: "/v1/records.json", need: RECORDS },
    { method: "getRecordComments", call: (g) => client.getRecordComments(1, 1, g), http: "GET", path: "/v1/record/comments.json", need: RECORDS },
    { method: "listRequiredPlugins", call: () => client.listRequiredPlugins(), http: "GET", path: "/v1/plugins/required.json", need: KINTONE, noGuest: true },
    { method: "uploadFile", call: (g) => client.uploadFile(uploadSource, "up.txt", g), http: "POST", path: "/v1/file.json", need: RECORD_WRITE },
    { method: "uploadAppCustomizeFile", call: (g) => client.uploadAppCustomizeFile(uploadSource, "custom.js", g), http: "POST", path: "/v1/file.json", need: PUSH },
    { method: "bulkRequest", call: (g) => client.bulkRequest([{ method: "PUT", api: "/k/v1/records.json", payload: { app: 1, records: [] } }], g), http: "POST", path: "/v1/bulkRequest.json", need: RECORD_WRITE },
    { method: "putPreviewAppResource", call: (g) => client.putPreviewAppResource("/app/settings.json", { app: 1 }, g), http: "PUT", path: "/v1/preview/app/settings.json", need: PUSH },
    { method: "postPreviewAppResource", call: (g) => client.postPreviewAppResource("/app/form/fields.json", { app: 1, properties: {} }, g), http: "POST", path: "/v1/preview/app/form/fields.json", need: PUSH },
    { method: "createPreviewApp", call: (g) => client.createPreviewApp({ name: "x" }, g), http: "POST", path: "/v1/preview/app.json", need: PUSH },
    { method: "deployApps", call: (g) => client.deployApps([{ app: 1 }], g), http: "POST", path: "/v1/preview/app/deploy.json", need: PUSH },
    { method: "updateSpace", call: (g) => client.updateSpace({ id: "1", name: "x" }, g), http: "PUT", path: "/v1/space.json", need: SPACE_WRITE },
    { method: "updateSpaceBody", call: (g) => client.updateSpaceBody({ id: "1", body: "<p>x</p>" }, g), http: "PUT", path: "/v1/space/body.json", need: SPACE_WRITE },
    { method: "updateThread", call: (g) => client.updateThread({ id: "10", body: "<p>x</p>" }, g), http: "PUT", path: "/v1/space/thread.json", need: SPACE_WRITE }
  ];
  const variants = [
    { label: "通常", opts: {}, prefix: "/k" },
    { label: "ゲスト", opts: { guestSpaceId: "5" }, prefix: "/k/guest/5" }
  ];

  let seq = 0;
  const attempt = async (c, v) => {
    mock.requests.length = 0;
    const dest = path.join(tmp, `file-${++seq}.bin`);
    let error = null;
    try {
      await c.call(v.opts, dest);
    } catch (e) {
      error = e;
    }
    return { error, requests: [...mock.requests], dest };
  };
  const detail = (r) => `error=${r.error?.message ?? ""}\nrequests=${r.requests.join(",")}`;
  const expectPassed = (name, c, v, r) => {
    const [httpMethod, target = ""] = (r.requests[0] ?? "").split(" ");
    expect(
      name,
      !r.error && r.requests.length === 1 && httpMethod === c.http && target.split("?")[0] === v.prefix + c.path && (!c.file || fs.existsSync(r.dest)),
      detail(r)
    );
  };
  const expectBlocked = (name, c, r) => {
    expect(name, String(r.error?.message ?? "").startsWith("操作制限:") && r.requests.length === 0 && (!c.file || !fs.existsSync(r.dest)), detail(r));
  };

  try {
    for (const c of cases) {
      for (const v of variants) {
        if (c.noGuest && v.opts.guestSpaceId) continue;
        const name = `client: ${c.label ?? c.method}（${v.label}）`;
        activateGrants([]);
        if (!c.need) {
          expectPassed(`${name} はグラント無しで通る`, c, v, await attempt(c, v));
          continue;
        }
        expectBlocked(`${name} はグラント無しで遮断`, c, await attempt(c, v));
        for (const grant of c.need) {
          activateGrants([grant]);
          expectPassed(`${name} は ${grant} で通る`, c, v, await attempt(c, v));
        }
      }
    }

    activateGrants(["pull:records"]);
    mock.requests.length = 0;
    await client.getRecordsByQuery(1, { query: "$id in (1) limit 100", fields: Array.from({ length: 101 }, (_, i) => `field-${i}`) });
    const projectionUrls = mock.requests.map((entry) => new URL(entry.split(" ")[1], mock.baseUrl));
    const projectionSizes = projectionUrls.map((url) => [...url.searchParams.keys()].filter((key) => /^fields\[\d+\]$/.test(key)).length);
    expect("client: 100項目を超える fields は上限内へ分割して取得", projectionUrls.length === 2 && projectionSizes.every((size) => size <= 100) && Math.max(...projectionSizes) === 100, JSON.stringify({ requests: mock.requests, projectionSizes }));

    mock.requests.length = 0;
    recordsResponse = {};
    let malformedRejected = false;
    try {
      await client.getRecordsByQuery(1, { query: "$id in (1) limit 100" });
    } catch {
      malformedRejected = true;
    }
    expect("client: records 配列の無い応答を空一覧として扱わない", malformedRejected && mock.requests.length === 1, JSON.stringify(mock.requests));
    recordsResponse = { records: [] };
  } finally {
    activateGrants([]);
    mock.server.closeAllConnections();
    mock.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 網羅: KintoneClient に公開メソッドを足したら上の表への追加を求める（操作制限の分類漏れの検知）。
  const covered = new Set(cases.map((c) => c.method));
  const uncovered = Object.getOwnPropertyNames(KintoneClient.prototype).filter((m) => m !== "constructor" && m !== "buildUrl" && !covered.has(m));
  expect("client: 公開メソッドがすべて表に載っている", uncovered.length === 0, `未登録: ${uncovered.join(", ")}`);
}

// ---- 1l. ゲストスペース判定（オフライン・mock client） --------------------
function cybozuError(status, code) {
  return Object.assign(new Error(`GET /k/v1/space.json failed (${code})`), { status, code });
}

async function guestSpaceTests() {
  console.log("[offline] ゲストスペース判定（GAIA_IL25）・スペース失敗の続行");

  const clientUrl = pathToFileURL(path.join(ROOT, "dist", "kintone", "client.js")).href;
  const indexUrl = pathToFileURL(path.join(ROOT, "dist", "kintone", "appIndex.js")).href;
  const appsUrl = pathToFileURL(path.join(ROOT, "dist", "kintone", "apps.js")).href;
  const { isGuestSpaceRequiredError } = await import(clientUrl);
  const { withGuestSpaceIds, normalizeRemoteApp, normalizeRemoteApps, buildSpaces } = await import(indexUrl);
  const { fetchSpaceDetails } = await import(appsUrl);

  expect(
    "GAIA_IL25 だけがゲスト要求エラー",
    isGuestSpaceRequiredError(cybozuError(400, "GAIA_IL25")) &&
      !isGuestSpaceRequiredError(cybozuError(400, "GAIA_IL23")) &&
      !isGuestSpaceRequiredError(undefined),
    "isGuestSpaceRequiredError mismatch"
  );

  const raw = [
    { appId: "1188", spaceId: "62" },
    { appId: "5", spaceId: "14" },
    { appId: "9", spaceId: null }
  ];
  const injected = withGuestSpaceIds(raw, new Set(["62"]));
  expect("withGuestSpaceIds は判明済みスペースのアプリへ guestSpaceId を注入", injected[0].guestSpaceId === "62" && !injected[1].guestSpaceId && !injected[2].guestSpaceId, JSON.stringify(injected));
  expect("withGuestSpaceIds は入力を変更しない", raw[0].guestSpaceId === undefined, JSON.stringify(raw));

  const previousGuest = { appId: "1188", code: "", name: "", spaceId: "62", guestSpaceId: "62", modifiedAt: "" };
  expect("normalizeRemoteApp は同じスペースのゲスト判定を引き継ぐ", normalizeRemoteApp({ appId: "1188", spaceId: "62" }, previousGuest).guestSpaceId === "62", "guest lost");
  expect("normalizeRemoteApp は別スペースへ移動したらゲスト判定を引き継がない", normalizeRemoteApp({ appId: "1188", spaceId: "14" }, previousGuest).guestSpaceId === "", "guest kept after move");

  const spaces = buildSpaces(normalizeRemoteApps(withGuestSpaceIds(raw, new Set(["62"])), new Map()));
  const space62 = spaces.find((s) => s.id === "62");
  expect("buildSpaces は注入済みスペースを guestspace として返す", space62?.type === "guestspace" && space62.spaceId === "" && !spaces.some((s) => s.type === "space" && s.id === "62"), JSON.stringify(spaces));

  const calls = [];
  const client = {
    async getSpace(id, { guestSpaceId = "" } = {}) {
      calls.push(`${id}|${guestSpaceId}`);
      if (id === "3") return { name: "通常" };
      if (id === "62") {
        if (!guestSpaceId) throw cybozuError(400, "GAIA_IL25");
        return { name: "ゲスト", isGuest: true };
      }
      if (id === "64") throw cybozuError(403, "CB_NO02");
      if (id === "70") {
        if (!guestSpaceId) throw cybozuError(400, "GAIA_IL25");
        return { name: "既知ゲスト" };
      }
      if (id === "80") {
        if (!guestSpaceId) throw cybozuError(400, "GAIA_IL25");
        throw cybozuError(403, "CB_NO02");
      }
      throw cybozuError(404, "GAIA_SP01");
    }
  };
  const result = await fetchSpaceDetails({
    client,
    spaces: [
      { id: "3", spaceId: "3", guestSpaceId: "", type: "space", appCount: 1 },
      { id: "62", spaceId: "62", guestSpaceId: "", type: "space", appCount: 1 },
      { id: "64", spaceId: "64", guestSpaceId: "", type: "space", appCount: 1 },
      { id: "70", spaceId: "", guestSpaceId: "70", type: "guestspace", appCount: 1 },
      { id: "80", spaceId: "80", guestSpaceId: "", type: "space", appCount: 1 }
    ]
  });
  expect(
    "fetchSpaceDetails は成功分を入力順で返す（通常・ゲスト再取得・既知ゲスト）",
    result.details.map((d) => `${d.id}:${d.guestSpaceId}`).join(",") === "3:,62:62,70:70",
    JSON.stringify(result.details.map((d) => [d.id, d.guestSpaceId]))
  );
  expect("fetchSpaceDetails は GAIA_IL25 のスペースをゲストと判定", result.detectedGuestSpaceIds.join(",") === "62,80", JSON.stringify(result.detectedGuestSpaceIds));
  expect(
    "fetchSpaceDetails は失敗を spaceFailures 形式で残して続行",
    result.failures.map((f) => f.space).join(",") === "space-64,guestspace-80",
    JSON.stringify(result.failures)
  );
  expect("fetchSpaceDetails の API 呼び出し数（再取得を含む）", result.apiCalls === 7, `apiCalls=${result.apiCalls}`);
  expect("fetchSpaceDetails は既知ゲストを最初からゲスト URL で取得", calls.includes("62|62") && calls.includes("70|70") && !calls.includes("70|"), calls.join(","));
}

// ---- 1m. pull kintone のゲスト判定 E2E（オフライン・mock HTTP サーバー） ------
// 子プロセスの env へ mock の URL・認証値を明示し、開発者シェルの実ドメイン設定が混ざらないようにする。
async function startMockKintone(handler, { tls = false } = {}) {
  const requests = [];
  const onRequest = (req, res) => {
    const url = new URL(req.url, `${tls ? "https" : "http"}://localhost`);
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const hit = handler(url);
    const [status, body] = hit ?? [404, { code: "GAIA_AP01", message: "not found" }];
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = tls
    ? https.createServer({ pfx: fs.readFileSync(path.join(ROOT, "scripts", "fixtures", "kintone-mock-localhost.pfx")), passphrase: "kint-origin-smoke" }, onRequest)
    : http.createServer(onRequest);
  const host = tls ? "localhost" : "127.0.0.1";
  await new Promise((resolve) => server.listen(0, host, resolve));
  const baseUrl = `${tls ? "https" : "http"}://${host}:${server.address().port}`;
  return { server, requests, baseUrl };
}

function mockEnv(baseUrl) {
  return {
    CYBOZU_BASE_URL: baseUrl,
    CYBOZU_USERNAME: "u",
    CYBOZU_PASSWORD: "p",
    CYBOZU_LANGUAGE: "ja",
    CYBOZU_API_INTERVAL_MS: "0"
  };
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function listFilesRecursive(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : [];
}

async function pullKintoneGuestE2ETests() {
  console.log("[offline] pull kintone: ゲスト判定・判定前の space-<id>/ の deleted 移動・スペース失敗の続行");

  const GAIA_IL25 = { code: "GAIA_IL25", message: "ゲストスペースを操作する場合、リクエストの送信先に「/guest/（ゲストスペースのID）」を含める必要があります。" };
  const MODIFIED = "2026-01-01T00:00:00Z";
  const makeTmp = (baseUrl) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-guest-"));
    fs.writeFileSync(
      path.join(tmp, ".env"),
      Object.entries(mockEnv(baseUrl)).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
      "utf8"
    );
    return tmp;
  };

  // シナリオ1: 索引にゲスト判明済み＋pull index が作った判定前の space-62/ が残っている（差分対象なし）。
  {
    const mock = await startMockKintone((url) => {
      if (url.pathname === "/k/v1/apps.json") {
        return [200, { apps: [{ appId: "1188", code: "", name: "名刺一覧", spaceId: "62", modifiedAt: MODIFIED }] }];
      }
      if (url.pathname === "/k/guest/62/v1/space.json" && url.searchParams.get("id") === "62") return [200, { name: "ゲスト", isGuest: true }];
      if (url.pathname === "/k/v1/space.json" && url.searchParams.get("id") === "62") return [400, GAIA_IL25];
      return null;
    });
    const tmp = makeTmp(mock.baseUrl);
    try {
      const kdata = path.join(tmp, "data", "kintone");
      writeJsonFile(path.join(kdata, "index", "apps.json"), [
        { appId: "1188", code: "", name: "名刺一覧", spaceId: "62", guestSpaceId: "62", modifiedAt: MODIFIED, lastPulledModifiedAt: MODIFIED, lastPulledAt: "2026-01-02T00:00:00.000Z" }
      ]);
      writeJsonFile(path.join(kdata, "spaces", "guestspace-62", "apps", "app-1188", "app_settings", "settings.json"), {});
      writeJsonFile(path.join(kdata, "spaces", "space-62", "apps.json"), [{ appId: "1188", code: "", name: "名刺一覧", spaceId: "62" }]);
      fs.mkdirSync(path.join(kdata, "spaces", "space-62", "apps"), { recursive: true });

      const r = await runCliAsync(["pull", "kintone"], tmp, mockEnv(mock.baseUrl));
      expect("ゲスト判明済み: pull kintone は exit 0", r.status === 0, `status=${r.status}\n${r.stderr}`);
      let summary = {};
      try {
        summary = JSON.parse(r.stdout);
      } catch {
        ng("ゲスト判明済み: stdout は JSON サマリ", r.stdout.slice(0, 300));
      }
      expect(
        "ゲスト判明済み: 判定前の space-62 を deleted へ移動",
        (summary.deleted?.spaces || []).some((s) => s.id === "62" && s.spaceId === "62") && (summary.spaceFailures || []).length === 0,
        JSON.stringify(summary.deleted) + JSON.stringify(summary.spaceFailures)
      );
      expect("ゲスト判明済み: guestspace-62 のアプリは誤移動されない", fs.existsSync(path.join(kdata, "spaces", "guestspace-62", "apps", "app-1188", "app_settings", "settings.json")), "guest app moved");
      expect("ゲスト判明済み: space-62/ は spaces から消え deleted/spaces/ にある", !fs.existsSync(path.join(kdata, "spaces", "space-62")) && fs.existsSync(path.join(kdata, "deleted", "spaces", "space-62", "apps.json")), listFilesRecursive(kdata).join("\n"));
      const idx = JSON.parse(fs.readFileSync(path.join(kdata, "index", "apps.json"), "utf8"));
      const spacesIdx = JSON.parse(fs.readFileSync(path.join(kdata, "index", "spaces.json"), "utf8"));
      expect("ゲスト判明済み: 索引の guestSpaceId を維持", idx.find((a) => a.appId === "1188")?.guestSpaceId === "62", JSON.stringify(idx));
      expect(
        "ゲスト判明済み: spaces.json は guestspace-62 のみ",
        spacesIdx.some((s) => s.id === "62" && s.type === "guestspace") && !spacesIdx.some((s) => s.id === "62" && s.type === "space"),
        JSON.stringify(spacesIdx)
      );
    } finally {
      mock.server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // シナリオ2: 初回（索引なし）。ゲスト検出・スペース失敗の続行・レコード非取得。
  {
    const mock = await startMockKintone((url) => {
      if (url.pathname === "/k/v1/apps.json") {
        return [
          200,
          {
            apps: [
              { appId: "1188", code: "", name: "名刺一覧", spaceId: "62", modifiedAt: MODIFIED },
              { appId: "5", code: "", name: "通常アプリ", spaceId: "14", modifiedAt: MODIFIED },
              { appId: "7", code: "", name: "権限なしスペース", spaceId: "64", modifiedAt: MODIFIED }
            ]
          }
        ];
      }
      const id = url.searchParams.get("id");
      if (url.pathname === "/k/v1/space.json") {
        if (id === "14") return [200, { name: "通常スペース" }];
        if (id === "62") return [400, GAIA_IL25];
        if (id === "64") return [403, { code: "CB_NO02", message: "権限がありません" }];
      }
      if (url.pathname === "/k/guest/62/v1/space.json" && id === "62") return [200, { name: "ゲスト", isGuest: true }];
      return null;
    });
    const tmp = makeTmp(mock.baseUrl);
    try {
      const r = await runCliAsync(["pull", "kintone"], tmp, mockEnv(mock.baseUrl));
      expect("初回: 途中の GAIA_IL25 でも完了サマリを返し exit 0", r.status === 0 && r.stderr.includes("✓ 完了"), `status=${r.status}\n${r.stderr.slice(-800)}`);
      let summary = {};
      try {
        summary = JSON.parse(r.stdout);
      } catch {
        ng("初回: stdout は JSON サマリ", r.stdout.slice(0, 300));
      }
      const kdata = path.join(tmp, "data", "kintone");
      expect("初回: guestSpacesDetected に 62", (summary.guestSpacesDetected || []).join(",") === "62", JSON.stringify(summary.guestSpacesDetected));
      expect("初回: スペース失敗は spaceFailures に残る", (summary.spaceFailures || []).map((f) => f.space).join(",") === "space-64", JSON.stringify(summary.spaceFailures));
      expect("初回: spacesRefreshed に通常とゲスト", (summary.spacesRefreshed || []).includes("14") && (summary.spacesRefreshed || []).includes("guest:62"), JSON.stringify(summary.spacesRefreshed));
      const guestSpaceJson = path.join(kdata, "spaces", "guestspace-62", "space.json");
      const guest = fs.existsSync(guestSpaceJson) ? JSON.parse(fs.readFileSync(guestSpaceJson, "utf8")) : {};
      expect("初回: guestspace-62/space.json を type=guestspace で保存", guest.type === "guestspace" && guest.isGuest === true, JSON.stringify(guest).slice(0, 200));
      expect("初回: 通常スペースは space-14 に保存、space-62 は作らない", fs.existsSync(path.join(kdata, "spaces", "space-14", "space.json")) && !fs.existsSync(path.join(kdata, "spaces", "space-62", "space.json")), listFilesRecursive(path.join(kdata, "spaces")).slice(0, 20).join("\n"));
      const idx = fs.existsSync(path.join(kdata, "index", "apps.json")) ? JSON.parse(fs.readFileSync(path.join(kdata, "index", "apps.json"), "utf8")) : [];
      expect("初回: 索引の 1188 が guestSpaceId=62", idx.find((a) => a.appId === "1188")?.guestSpaceId === "62", JSON.stringify(idx));
      expect(
        "初回: 配下アプリはゲスト URL で取得を試みる",
        mock.requests.some((q) => q.startsWith("GET /k/guest/62/v1/app/") && q.includes("app=1188")),
        mock.requests.join("\n")
      );
      // アクセス権の取得先 /record/acl.json はアプリ設定なので除外し、レコード本体・添付の API だけを見る。
      expect(
        "初回: レコード・添付の API を呼ばない",
        !mock.requests.some((q) => /\/v1\/(records?|bulkRequest|file)\.json/.test(q.split("?")[0])),
        mock.requests.join("\n")
      );
      expect("初回: records.csv を作らない", !listFilesRecursive(tmp).some((f) => f.endsWith("records.csv")), listFilesRecursive(tmp).join("\n"));
    } finally {
      mock.server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// ---- 1p. 権限不足の記録とスキップ（オフライン・mock HTTP サーバー） ----------
// アプリ管理権限が無いアカウントの管理系 403 / CB_NO02 は、失敗にせず data/kintone/index/permission-denies.json へ記録し、
// 次回以降は要求しない。-f のときだけ再判定する。それ以外のエラー（404 / 500 / 401）は記録しない。
async function permissionDenyTests() {
  console.log("[offline] 権限不足の記録とスキップ（permission-denies.json）");

  // src/kintone/exportItems.ts の管理系 endpoint と一致させる（customize export は cli-kintone で REST の customize と同じ権限）。
  const ADMIN_EPS = [
    "/app/actions.json",
    "/app/notifications/general.json",
    "/app/notifications/perRecord.json",
    "/app/notifications/reminder.json",
    "/app/plugins.json",
    "/app/customize.json",
    "/app/acl.json",
    "/record/acl.json",
    "/field/acl.json"
  ];
  const ALL_DENIED =
    "actions,notifications_general,notifications_per_record,notifications_reminder,plugins,customize,customize_export,app_acl,record_acl,field_acl";
  const VIEW_BODIES = {
    "/app/form/fields.json": { properties: {}, revision: "1" },
    "/app/form/layout.json": { layout: [], revision: "1" },
    "/form.json": { properties: [] },
    "/app/views.json": { views: {}, revision: "1" },
    "/app/reports.json": { reports: {}, revision: "1" },
    "/app/settings.json": { name: "x", revision: "1" },
    "/app/status.json": { enable: false, revision: "1" }
  };
  const EMPTY_CUSTOMIZE = { scope: "ALL", desktop: { js: [], css: [] }, mobile: { js: [], css: [] } };
  const ADMIN_OK = {
    "/app/acl.json": { rights: [], revision: "1" },
    "/record/acl.json": { rights: [], revision: "1" },
    "/field/acl.json": { rights: [], revision: "1" },
    "/app/plugins.json": { plugins: [], revision: "1" },
    "/app/customize.json": { ...EMPTY_CUSTOMIZE, revision: "1" }
  };
  const ERROR_BODIES = {
    401: { code: "CB_AU01", message: "ログイン名またはパスワードが正しくありません。" },
    403: { code: "CB_NO02", message: "権限がありません。" },
    404: { code: "GAIA_AP01", message: "指定したアプリが見つかりません。" },
    500: { code: "GAIA_IN01", message: "内部エラーです。" }
  };

  const parseJson = (r) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return {};
    }
  };
  const readJsonOr = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };
  const isStub = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && "_error" in value;
  const stubFiles = (dir) => listFilesRecursive(dir).filter((f) => f.endsWith(".json") && isStub(readJsonOr(path.join(dir, f))));
  const endpointOf = (q) => q.split(" ")[1].split("?")[0].replace(/^\/k(?:\/guest\/\d+)?\/v1/, "");
  const adminHits = (requests) => requests.filter((q) => ADMIN_EPS.includes(endpointOf(q)));
  const hasHit = (requests, endpoint, appId, guestSpaceId = "") =>
    requests.some(
      (q) =>
        q.startsWith(`GET ${guestSpaceId ? `/k/guest/${guestSpaceId}` : "/k"}/v1${endpoint}?`) && new RegExp(`[?&]app=${appId}(&|$)`).test(q)
    );
  const makeTmp = (baseUrl, prefix) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.writeFileSync(path.join(tmp, ".env"), Object.entries(mockEnv(baseUrl)).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", "utf8");
    return tmp;
  };
  const adminFilesOf = (dir) => listFilesRecursive(dir).filter((f) => /^(acl|notifications)[\\/]/.test(f) || f.endsWith("app_actions.json"));

  // P. モジュール単体（子プロセス。KINTONE_DATA_ROOT が cwd 基準のため一時 dir を cwd にする）
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-deny-unit-"));
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-deny-script-"));
    try {
      const moduleUrl = pathToFileURL(path.join(ROOT, "dist", "kintone", "permissionDenies.js")).href;
      const script = `
import fs from "node:fs";
const m = await import(${JSON.stringify(moduleUrl)});
const file = m.permissionDeniesPath();
const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
const writeRaw = (value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const out = {};
m.recordDeniedKeys({ appId: "12", guestSpaceId: "3", denied: ["customize"] });
m.recordDeniedKeys({ appId: "5", denied: ["app_acl", "fields", "actions"] });
out.written = read();
out.read5 = [...m.readDeniedKeys("5")];
m.recordDeniedKeys({ appId: "5", denied: [] });
m.recordDeniedKeys({ appId: "12", denied: [] });
out.removedAfterEmpty = !fs.existsSync(file);
writeRaw({ account: { baseUrlHost: "example.invalid", username: "other" }, apps: [{ appId: "9", guestSpaceId: "", denied: ["plugins"] }] });
out.otherUserKeys = [...m.readDeniedKeys("9")];
const before = fs.readFileSync(file, "utf8");
m.recordDeniedKeys({ appId: "9", denied: [] });
out.otherUserUntouched = fs.readFileSync(file, "utf8") === before;
m.recordDeniedKeys({ appId: "7", denied: ["plugins"] });
out.rebuilt = read();
writeRaw({ account: { baseUrlHost: "other.invalid", username: "u" }, apps: [{ appId: "9", guestSpaceId: "", denied: ["plugins"] }] });
out.otherHostKeys = [...m.readDeniedKeys("9")];
console.log(JSON.stringify(out));
`;
      const scriptPath = path.join(scriptDir, "probe.mjs");
      fs.writeFileSync(scriptPath, script, "utf8");
      const r = spawnSync(process.execPath, [scriptPath], {
        cwd: tmp,
        encoding: "utf8",
        env: { ...process.env, ...NO_SHELL_CREDS, ...mockEnv("https://example.invalid") }
      });
      let out = {};
      try {
        out = JSON.parse(r.stdout);
      } catch {
        ng("権限リスト: 単体検証の出力は JSON", `status=${r.status}\n${r.stdout}\n${r.stderr}`);
      }
      expect(
        "権限リスト: アカウント（ホスト・ログイン名のみ）を保存し、appId の数値順・denied は定義順・管理系以外は捨てる",
        JSON.stringify(out.written) ===
          JSON.stringify({
            account: { baseUrlHost: "example.invalid", username: "u" },
            apps: [
              { appId: "5", guestSpaceId: "", denied: ["actions", "app_acl"] },
              { appId: "12", guestSpaceId: "3", denied: ["customize"] }
            ]
          }),
        JSON.stringify(out.written)
      );
      expect("権限リスト: readDeniedKeys は保存した管理系キーを返す", JSON.stringify(out.read5) === JSON.stringify(["actions", "app_acl"]), JSON.stringify(out.read5));
      expect("権限リスト: 全アプリの denied が空になるとファイルを消す", out.removedAfterEmpty === true, String(out.removedAfterEmpty));
      expect("権限リスト: 別のログイン名のリストは使わない", Array.isArray(out.otherUserKeys) && out.otherUserKeys.length === 0, JSON.stringify(out.otherUserKeys));
      expect("権限リスト: 別アカウントのリストは、記録するものが無ければ触らない", out.otherUserUntouched === true, String(out.otherUserUntouched));
      expect(
        "権限リスト: 別アカウントのリストは現在のアカウント用に作り直す",
        JSON.stringify(out.rebuilt) ===
          JSON.stringify({ account: { baseUrlHost: "example.invalid", username: "u" }, apps: [{ appId: "7", guestSpaceId: "", denied: ["plugins"] }] }),
        JSON.stringify(out.rebuilt)
      );
      expect("権限リスト: 別ホストのリストは使わない", Array.isArray(out.otherHostKeys) && out.otherHostKeys.length === 0, JSON.stringify(out.otherHostKeys));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(scriptDir, { recursive: true, force: true });
    }
  }

  // A. 管理系が 403 / CB_NO02 のアカウント（1 つの mock・同じ一時 dir で順に進める。リストは host:port で照合される）
  {
    const APPS = [
      { appId: "43", code: "", name: "案件管理", spaceId: null },
      { appId: "44", code: "", name: "顧客管理", spaceId: null },
      { appId: "1188", code: "", name: "名刺一覧", spaceId: "62" }
    ];
    let modifiedAt = "2026-01-01T00:00:00Z";
    const adminStatus = new Map(); // endpoint → status（未設定は 403）
    const mock = await startMockKintone((url) => {
      const m = /^\/k(?:\/guest\/(\d+))?\/v1(\/.+)$/.exec(url.pathname);
      if (!m) return null;
      const ep = m[2];
      if (ep === "/apps.json") return [200, { apps: APPS.map((a) => ({ ...a, modifiedAt })) }];
      if (ep === "/space.json") return [200, { name: "ゲスト", isGuest: true }];
      if (ep === "/app.json") {
        const found = APPS.find((a) => a.appId === url.searchParams.get("id"));
        return found ? [200, { ...found, modifiedAt }] : null;
      }
      if (ADMIN_EPS.includes(ep)) {
        const status = adminStatus.get(ep) ?? 403;
        return status === 200 ? [200, ADMIN_OK[ep] ?? { revision: "1" }] : [status, ERROR_BODIES[status]];
      }
      if (VIEW_BODIES[ep]) return [200, VIEW_BODIES[ep]];
      return null;
    });
    const tmp = makeTmp(mock.baseUrl, "kint-origin-deny-");
    const run = (args) => runCliAsync(args, tmp, mockEnv(mock.baseUrl));
    const kdata = path.join(tmp, "data", "kintone");
    const denyPath = path.join(kdata, "index", "permission-denies.json");
    const dirOf = (id) => (id === "1188" ? path.join(kdata, "spaces", "guestspace-62", "apps", "app-1188") : path.join(kdata, "apps", `app-${id}`));
    const deniedOf = (id) => (readJsonOr(denyPath)?.apps || []).find((a) => a.appId === id)?.denied?.join(",") ?? "";
    const setAdmin = (status, except = {}) => {
      for (const ep of ADMIN_EPS) adminStatus.set(ep, except[ep] ?? status);
    };
    try {
      // 事前データ。43: _error スタブ、44: 正常な app_acl とスタブ customize＋実ファイルのマニフェスト、
      // 1188（ゲスト・索引で判明済み）: 正常な customize.json とマニフェスト
      const stubOf = (p) => ({ _error: `GET ${p} failed (CB_NO02): 権限がありません。` });
      writeJsonFile(path.join(kdata, "index", "apps.json"), [
        { appId: "1188", code: "", name: "名刺一覧", spaceId: "62", guestSpaceId: "62", modifiedAt }
      ]);
      writeJsonFile(path.join(dirOf("43"), "acl", "app_acl.json"), stubOf("/k/v1/app/acl.json"));
      writeJsonFile(path.join(dirOf("43"), "customize", "customize.json"), stubOf("/k/v1/app/customize.json"));
      writeJsonFile(path.join(dirOf("44"), "acl", "app_acl.json"), { rights: [{ entity: { type: "CREATOR" } }], revision: "-" });
      writeJsonFile(path.join(dirOf("44"), "customize", "customize.json"), stubOf("/k/v1/app/customize.json"));
      writeJsonFile(path.join(dirOf("44"), "customize", "customize-manifest.json"), {
        scope: "ALL",
        desktop: { js: ["desktop/js/a.js"], css: [] },
        mobile: { js: [], css: [] }
      });
      writeJsonFile(path.join(dirOf("1188"), "customize", "customize.json"), { ...EMPTY_CUSTOMIZE, revision: "-" });
      writeJsonFile(path.join(dirOf("1188"), "customize", "customize-manifest.json"), EMPTY_CUSTOMIZE);

      // A1. 初回の pull kintone
      mock.requests.length = 0;
      const r1 = await run(["pull", "kintone"]);
      const s1 = parseJson(r1);
      const skips1 = s1.permissionSkips || [];
      const hits1 = adminHits(mock.requests);
      const list1 = readJsonOr(denyPath);
      const idx1 = readJsonOr(path.join(kdata, "index", "apps.json")) || [];
      expect("403 初回: pull kintone は exit 0 で failures が空", r1.status === 0 && (s1.failures || []).length === 0 && s1.failed === 0, `status=${r1.status} ${JSON.stringify(s1.failures)}\n${r1.stderr.slice(-600)}`);
      expect(
        "403 初回: permissionSkips に 3 アプリ（管理系すべて）、ログは 1 行の要約",
        skips1.map((s) => s.appId).sort().join(",") === "1188,43,44" && skips1.every((s) => s.denied.join(",") === ALL_DENIED) && r1.stderr.includes("権限がないためスキップ: 3 apps"),
        JSON.stringify(skips1) + r1.stderr.slice(-400)
      );
      expect(
        "403 初回: 閲覧系の JSON は書かれ、管理系の _error スタブは 1 つも無い",
        ["43", "44", "1188"].every(
          (id) => fs.existsSync(path.join(dirOf(id), "form", "fields.json")) && fs.existsSync(path.join(dirOf(id), "app_settings", "settings.json")) && stubFiles(dirOf(id)).length === 0
        ),
        ["43", "44", "1188"].map((id) => `${id}: ${stubFiles(dirOf(id)).join(",")}`).join("\n")
      );
      expect("403 初回: 管理系 JSON（acl/ notifications/ app_actions）は作らない（正常な 44 の app_acl.json を除く）", ["43", "1188"].every((id) => adminFilesOf(dirOf(id)).length === 0), ["43", "1188"].map((id) => adminFilesOf(dirOf(id)).join(",")).join(" / "));
      expect(
        "403 初回: 既存の _error スタブは削除し、正常な JSON とマニフェストは残す",
        !fs.existsSync(path.join(dirOf("43"), "acl", "app_acl.json")) &&
          !fs.existsSync(path.join(dirOf("43"), "customize", "customize.json")) &&
          Array.isArray(readJsonOr(path.join(dirOf("44"), "acl", "app_acl.json"))?.rights) &&
          fs.existsSync(path.join(dirOf("44"), "customize", "customize-manifest.json")) &&
          !fs.existsSync(path.join(dirOf("44"), "customize", "customize.json")) &&
          fs.existsSync(path.join(dirOf("1188"), "customize", "customize.json")) &&
          fs.existsSync(path.join(dirOf("1188"), "customize", "customize-manifest.json")),
        listFilesRecursive(kdata).join("\n")
      );
      expect(
        "403 初回: permission-denies.json に account・appId 順・全管理系キー、ゲストは guestSpaceId 付き",
        list1?.account?.username === "u" &&
          list1?.account?.baseUrlHost === new URL(mock.baseUrl).host &&
          (list1?.apps || []).map((a) => a.appId).join(",") === "43,44,1188" &&
          (list1?.apps || []).every((a) => a.denied.join(",") === ALL_DENIED) &&
          list1.apps.find((a) => a.appId === "1188")?.guestSpaceId === "62" &&
          list1.apps.find((a) => a.appId === "43")?.guestSpaceId === "",
        JSON.stringify(list1)
      );
      expect(
        "403 初回: 管理系の要求は代表 /app/acl.json だけ（ゲストは guest URL）で、customize は呼ばず cli-kintone も起動しない",
        hits1.length === 3 &&
          hits1.every((q) => endpointOf(q) === "/app/acl.json") &&
          hasHit(mock.requests, "/app/acl.json", "43") &&
          hasHit(mock.requests, "/app/acl.json", "44") &&
          hasHit(mock.requests, "/app/acl.json", "1188", "62") &&
          !mock.requests.some((q) => endpointOf(q) === "/app/customize.json"),
        hits1.join("\n")
      );
      expect("403 初回: 索引の lastPulledModifiedAt が入る（毎回の再取得にならない）", idx1.length === 3 && idx1.every((a) => a.lastPulledModifiedAt === a.modifiedAt), JSON.stringify(idx1));
      expect("403 初回: record_acl は操作制限で _error にならない（リストの対象でも要求されない）", !r1.stderr.includes("操作制限:"), r1.stderr.slice(-400));

      // A2. modifiedAt が変わった再 pull と pull app（-f なし）は、拒否キーを要求しない
      modifiedAt = "2026-02-01T00:00:00Z";
      mock.requests.length = 0;
      const r2 = await run(["pull", "kintone"]);
      const s2 = parseJson(r2);
      expect(
        "403 再取得: modifiedAt 更新で再取得しても管理系 API を呼ばず、failures・取得失敗ログも出ない",
        r2.status === 0 && s2.pulled === 3 && (s2.failures || []).length === 0 && adminHits(mock.requests).length === 0 && !r2.stderr.includes("取得失敗") && (s2.permissionSkips || []).length === 3,
        `status=${r2.status} pulled=${s2.pulled} hits=${adminHits(mock.requests).join(",")}\n${r2.stderr.slice(-400)}`
      );
      mock.requests.length = 0;
      const r2b = await run(["pull", "app", "--id", "43"]);
      const s2b = parseJson(r2b);
      expect(
        "403 pull app: -f なしは管理系 API を呼ばず exit 0、summary の denied とログで案内する",
        r2b.status === 0 && adminHits(mock.requests).length === 0 && s2b.denied?.join(",") === ALL_DENIED && r2b.stderr.includes("権限がないためスキップ") && stubFiles(dirOf("43")).length === 0,
        `status=${r2b.status} hits=${adminHits(mock.requests).join(",")}\n${r2b.stderr.slice(-400)}`
      );

      // A3. -f は再判定する。まだ 403 ならリストは変わらず、代表 1 本だけを要求する
      const listBefore = fs.readFileSync(denyPath, "utf8");
      mock.requests.length = 0;
      const r3 = await run(["pull", "kintone", "-f"]);
      const hits3 = adminHits(mock.requests);
      expect(
        "403 -f: 再判定は代表 /app/acl.json だけ。まだ 403 ならリストは変わらず、スタブも作らない",
        r3.status === 0 &&
          hits3.length === 3 &&
          hits3.every((q) => endpointOf(q) === "/app/acl.json") &&
          fs.readFileSync(denyPath, "utf8") === listBefore &&
          ["43", "44", "1188"].every((id) => stubFiles(dirOf(id)).length === 0),
        `status=${r3.status}\n${hits3.join("\n")}`
      );

      // A4. 権限が付いた（customize だけ 403 のまま）。pull app -f で取れたキーはリストから外れ、正常な JSON が書かれる
      setAdmin(200, { "/app/customize.json": 403 });
      mock.requests.length = 0;
      const r4 = await run(["pull", "app", "--id", "43", "-f"]);
      const s4 = parseJson(r4);
      expect(
        "403 解除: -f で取れたキーはリストから外れ、customize 系だけ残る。cli-kintone は起動しない",
        r4.status === 0 &&
          deniedOf("43") === "customize,customize_export" &&
          s4.denied?.join(",") === "customize,customize_export" &&
          deniedOf("44") === ALL_DENIED &&
          deniedOf("1188") === ALL_DENIED &&
          !fs.existsSync(path.join(dirOf("43"), "customize", "customize-manifest.json")),
        `status=${r4.status} 43=${deniedOf("43")} 44=${deniedOf("44")}\n${r4.stderr.slice(-400)}`
      );
      expect(
        "403 解除: 取れたキーの正常な JSON を書く（record_acl を含む）",
        ["app_acl", "record_acl", "field_acl"].every((k) => Array.isArray(readJsonOr(path.join(dirOf("43"), "acl", `${k}.json`))?.rights)) &&
          fs.existsSync(path.join(dirOf("43"), "app_settings", "app_actions.json")) &&
          fs.existsSync(path.join(dirOf("43"), "notifications", "notifications_general.json")) &&
          stubFiles(dirOf("43")).length === 0,
        listFilesRecursive(dirOf("43")).join("\n")
      );

      // A5. あとから権限が外れた（-f なし）。リストに無いキーは要求され、403 ならリストへ追加される。取得済みの正常な JSON は消さない
      setAdmin(403);
      mock.requests.length = 0;
      const r5 = await run(["pull", "app", "--id", "43"]);
      expect(
        "403 追加: あとから権限が外れたら代表を要求して全管理系をリストへ追加する。取得済みの正常な JSON は残す",
        r5.status === 0 &&
          hasHit(mock.requests, "/app/acl.json", "43") &&
          deniedOf("43") === ALL_DENIED &&
          Array.isArray(readJsonOr(path.join(dirOf("43"), "acl", "app_acl.json"))?.rights),
        `status=${r5.status} 43=${deniedOf("43")}\n${r5.stderr.slice(-400)}`
      );

      // A6. 全キーが取れた -f はアプリの条目を消す（customize export は mock では成否を問わない。記録は export より前）
      setAdmin(200);
      const r6 = await run(["pull", "app", "--id", "43", "-f"]);
      const list6 = readJsonOr(denyPath);
      expect(
        "403 全解除: 全キーが取れた -f はそのアプリの条目だけを外し、他のアプリは残す",
        deniedOf("43") === "" && (list6?.apps || []).map((a) => a.appId).join(",") === "44,1188",
        `status=${r6.status} ${JSON.stringify(list6)}\n${r6.stderr.slice(-400)}`
      );

      // A7. リストのログイン名が違うと使わない（現在のアカウントで再判定し、書き直す）
      setAdmin(403);
      writeJsonFile(denyPath, { ...readJsonOr(denyPath), account: { ...readJsonOr(denyPath).account, username: "other" } });
      mock.requests.length = 0;
      const r7 = await run(["pull", "app", "--id", "44"]);
      const list7 = readJsonOr(denyPath);
      expect(
        "403 アカウント不一致: 別のログイン名のリストではスキップせず、現在のアカウント用に書き直す",
        r7.status === 0 && hasHit(mock.requests, "/app/acl.json", "44") && list7?.account?.username === "u" && (list7?.apps || []).map((a) => a.appId).join(",") === "44",
        `status=${r7.status} ${JSON.stringify(list7)}\n${r7.stderr.slice(-400)}`
      );
    } finally {
      mock.server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // B. 403 以外（404 / 500 / 401）は記録せず従来どおり。ローカルにしか無いアプリの 404 は deleted/ へ移る
  {
    const APPS = [
      { appId: "45", code: "", name: "アプリ45", spaceId: null },
      { appId: "46", code: "", name: "アプリ46", spaceId: null },
      { appId: "47", code: "", name: "アプリ47", spaceId: null }
    ];
    const statusByApp = { 45: 404, 46: 500, 47: 401 };
    const mock = await startMockKintone((url) => {
      const m = /^\/k(?:\/guest\/(\d+))?\/v1(\/.+)$/.exec(url.pathname);
      if (!m) return null;
      const ep = m[2];
      if (ep === "/apps.json") return [200, { apps: APPS.map((a) => ({ ...a, modifiedAt: "2026-01-01T00:00:00Z" })) }];
      if (ADMIN_EPS.includes(ep)) {
        const status = statusByApp[url.searchParams.get("app")] ?? 404;
        return [status, ERROR_BODIES[status]];
      }
      if (VIEW_BODIES[ep]) return [200, VIEW_BODIES[ep]];
      return null; // /app.json?id=48 などは 404（既定）
    });
    const tmp = makeTmp(mock.baseUrl, "kint-origin-deny-other-");
    try {
      const kdata = path.join(tmp, "data", "kintone");
      writeJsonFile(path.join(kdata, "apps", "app-48", "app_settings", "settings.json"), {});
      const r = await runCliAsync(["pull", "kintone"], tmp, mockEnv(mock.baseUrl));
      const s = parseJson(r);
      expect("403 以外: 404/500/401 は権限リストに入れない（permissionSkips も空）", !fs.existsSync(path.join(kdata, "index", "permission-denies.json")) && (s.permissionSkips || []).length === 0, `status=${r.status} ${JSON.stringify(s.permissionSkips)}`);
      expect(
        "403 以外: 代表が 403 でなければ残りの管理系も要求し、_error スタブを従来どおり書く",
        hasHit(mock.requests, "/app/actions.json", "45") && isStub(readJsonOr(path.join(kdata, "apps", "app-45", "acl", "app_acl.json"))) && isStub(readJsonOr(path.join(kdata, "apps", "app-46", "acl", "app_acl.json"))),
        mock.requests.filter((q) => endpointOf(q) === "/app/actions.json").join("\n")
      );
      expect(
        "403 以外: 404 のローカルアプリは従来どおり deleted/ へ移る",
        (s.deleted?.apps || []).some((a) => a.appId === "48") && fs.existsSync(path.join(kdata, "deleted", "apps", "app-48", "app_settings", "settings.json")),
        JSON.stringify(s.deleted)
      );
    } finally {
      mock.server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// method・本体つきで応答する mock サーバー。handle(method, url, body, raw) は [status, payload] を返す。
// payload が Buffer なら生のバイト列で返す（ファイルのダウンロード用）。body は JSON のときだけ解析する。
// cli-kintone（@kintone/rest-api-client）は https か localhost の baseUrl しか受け付けないため、localhost で待ち受ける。
// ---- 1p2. お気に入りグループ（pull favorite。純関数・CLI 引数検証・mock HTTP サーバー） ----
// favorites/<グループ名>.json に定義したアプリ・スペースだけを差分取得する。検証は API・認証値より前。削除判定はしない。
async function favoriteTests() {
  console.log("[offline] お気に入りグループ（pull favorite）");

  const fav = await import(pathToFileURL(path.join(ROOT, "dist", "kintone", "favorites.js")).href);
  const errorOf = (fn) => {
    try {
      fn();
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const mkTmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const parseJson = (r) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return {};
    }
  };
  const writeFav = (dir, name, body) => writeJsonFile(path.join(dir, "favorites", name), body);

  // A. 純関数
  const grp = fav.parseFavoriteGroup("g", { description: "x", apps: [303, "154", { id: 1188, guestSpaceId: 62 }, "007", 303], spaces: ["26"], guestSpaces: [10] });
  expect(
    "favorite: 数値・数字の文字列・{id, guestSpaceId} を正規化し、重複をまとめる",
    JSON.stringify(grp.apps) ===
      JSON.stringify([
        { appId: "303", guestSpaceId: "" },
        { appId: "154", guestSpaceId: "" },
        { appId: "1188", guestSpaceId: "62" },
        { appId: "7", guestSpaceId: "" }
      ]) &&
      grp.spaces.join() === "26" &&
      grp.guestSpaces.join() === "10" &&
      grp.description === "x",
    JSON.stringify(grp)
  );
  const dupGuest = fav.parseFavoriteGroup("g", { apps: [1, { id: 1, guestSpaceId: 9 }] });
  expect("favorite: 同じアプリは 1 件にまとめ、片方だけの guestSpaceId を採用する", JSON.stringify(dupGuest.apps) === JSON.stringify([{ appId: "1", guestSpaceId: "9" }]), JSON.stringify(dupGuest.apps));
  const badCases = [
    ["配列", [], "オブジェクト"],
    ["null", null, "オブジェクト"],
    ["空の定義", {}, "取得対象がありません"],
    ["不明なキー", { app: [1] }, "不明なキーがあります: app"],
    ["description が文字列でない", { description: 1, apps: [1] }, "description は文字列"],
    ["apps が配列でない", { apps: "303" }, "apps は配列"],
    ["spaces が配列でない", { spaces: 5 }, "spaces は配列"],
    ["ID が 0", { apps: [0] }, "apps[0] が不正"],
    ["ID が負数", { apps: [-1] }, "apps[0] が不正"],
    ["ID が小数", { apps: [1.5] }, "apps[0] が不正"],
    ["ID が数字以外", { apps: [1, "abc"] }, "apps[1] が不正"],
    ["spaces の ID が不正", { spaces: [5, 0] }, "spaces[1] が不正"],
    ["guestSpaces の ID が不正", { guestSpaces: ["x"] }, "guestSpaces[0] が不正"],
    ["apps[i] の不明なキー", { apps: [{ id: 1, guest: 2 }] }, "apps[0] に不明なキーがあります: guest"],
    ["apps[i].id が無い", { apps: [{ guestSpaceId: 2 }] }, "apps[0].id が不正"],
    ["apps[i].guestSpaceId が不正", { apps: [{ id: 1, guestSpaceId: 0 }] }, "apps[0].guestSpaceId が不正"],
    ["guestSpaceId の食い違い", { apps: [{ id: 1, guestSpaceId: 2 }, { id: 1, guestSpaceId: 3 }] }, "食い違っています"],
    ["spaces と guestSpaces の重複", { spaces: [5], guestSpaces: [5] }, "両方にあります"]
  ];
  for (const [label, input, needle] of badCases) {
    const message = errorOf(() => fav.parseFavoriteGroup("g", input));
    expect(`favorite: 不正な定義（${label}）はファイル名付きのエラー`, message.includes("favorites/g.json") && message.includes(needle), message);
  }
  for (const [raw, expected] of [["group1", "group1"], ["営業部", "営業部"], [" group1.json ", "group1"]]) {
    expect(`favorite: グループ名「${raw}」は通る`, errorOf(() => fav.normalizeFavoriteGroupName(raw)) === "" && fav.normalizeFavoriteGroupName(raw) === expected, fav.normalizeFavoriteGroupName(raw));
  }
  for (const raw of ["", "  ", "../x", "a/b", "a\\b", "_example", ".hidden", "a:b"]) {
    expect(`favorite: グループ名「${raw}」は拒否する`, errorOf(() => fav.normalizeFavoriteGroupName(raw)).includes("使えません"), errorOf(() => fav.normalizeFavoriteGroupName(raw)));
  }
  const g1 = fav.parseFavoriteGroup("g1", { apps: [1, 2], spaces: [5] });
  const g2 = fav.parseFavoriteGroup("g2", { apps: [2, { id: 3, guestSpaceId: 7 }], spaces: [5, 6], guestSpaces: [8] });
  const merged = fav.mergeFavoriteGroups([g1, g2]);
  expect(
    "favorite: 複数グループをグループ順に合算し、重複を除く",
    merged.groups.join() === "g1,g2" &&
      merged.apps.map((a) => `${a.appId}:${a.guestSpaceId}`).join() === "1:,2:,3:7" &&
      merged.spaces.join() === "5,6" &&
      merged.guestSpaces.join() === "8",
    JSON.stringify(merged)
  );
  const clash = errorOf(() => fav.mergeFavoriteGroups([g1, fav.parseFavoriteGroup("g3", { guestSpaces: [5] })]));
  expect("favorite: グループをまたぐ spaces と guestSpaces の衝突はエラー", clash.includes("両方にあります") && clash.includes("g1, g3"), clash);
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, "template", "favorites", "_example.json"), "utf8"));
  expect("favorite: 雛形 template/favorites/_example.json は検証を通る", errorOf(() => fav.parseFavoriteGroup("_example", example)) === "", errorOf(() => fav.parseFavoriteGroup("_example", example)));

  // B. favorites/ の列挙と選択（一時 dir を root にする）
  {
    const root = mkTmp("kint-origin-fav-root-");
    try {
      for (const [file, body] of [["group2.json", { apps: [2] }], ["group1.json", { apps: [1] }], ["_example.json", { apps: [9] }], [".hidden.json", { apps: [9] }], ["営業部.json", { apps: [3] }]]) {
        writeJsonFile(path.join(root, file), body);
      }
      fs.writeFileSync(path.join(root, "README.md"), "x", "utf8");
      fs.mkdirSync(path.join(root, "dir.json"));
      expect("favorite: 列挙は _ / . 始まり・.json 以外・ディレクトリを除く", fav.listFavoriteGroupNames(root).join() === "group1,group2,営業部", fav.listFavoriteGroupNames(root).join());
      expect("favorite: --name は大文字小文字を無視して照合する", fav.selectFavoriteGroups({ name: "GROUP1" }, root)[0]?.name === "group1", "case-insensitive");
      expect("favorite: --all は雛形を対象にしない", fav.selectFavoriteGroups({ all: true }, root).map((g) => g.name).join() === "group1,group2,営業部", "all");
      expect("favorite: 存在しない名前は一覧付きのエラー", errorOf(() => fav.selectFavoriteGroups({ name: "nope" }, root)).includes("定義済み: group1, group2, 営業部"), "unknown");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // C. CLI の引数・定義の検証（.env 無し。認証値を読む前に exit 1 で止まり、data/ を作らない）
  const cliCases = [
    { label: "--name も --all も無い", args: ["pull", "favorite"], needles: ["--name <グループ名> か --all"] },
    { label: "--name と --all の両方", setup: (d) => writeFav(d, "group1.json", { apps: [1] }), args: ["pull", "favorite", "--name", "group1", "--all"], needles: ["どちらか一方", "group1"] },
    { label: "値の無い --name", args: ["pull", "favorite", "--name"], needles: ["--name にグループ名を指定"] },
    { label: "favorites/ が無い", args: ["pull", "favorite", "--name", "group1"], needles: ["お気に入りグループが定義されていません", "_example.json"] },
    { label: "存在しないグループ名", setup: (d) => writeFav(d, "group1.json", { apps: [1] }), args: ["pull", "favorite", "--name", "nope"], needles: ["「nope」がありません", "定義済み: group1"] },
    { label: "不正なグループ名", args: ["pull", "favorite", "--name", "../x"], needles: ["使えません"] },
    { label: "雛形だけで --all", setup: (d) => writeFav(d, "_example.json", { apps: [1] }), args: ["pull", "favorite", "--all"], needles: ["定義されていません"] },
    {
      label: "JSON の構文エラー",
      setup: (d) => {
        fs.mkdirSync(path.join(d, "favorites"), { recursive: true });
        fs.writeFileSync(path.join(d, "favorites", "bad.json"), "{\n", "utf8");
      },
      args: ["pull", "favorite", "--name", "bad"],
      needles: ["JSON の読み込みに失敗しました"]
    },
    { label: "不明なキー", setup: (d) => writeFav(d, "typo.json", { app: [1] }), args: ["pull", "favorite", "--name", "typo"], needles: ["不明なキーがあります: app"] },
    { label: "使えないオプション（--id）", args: ["pull", "favorite", "--name", "group1", "--id", "3"], needles: ["不明なオプションです: --id"] }
  ];
  for (const c of cliCases) {
    const tmp = mkTmp("kint-origin-fav-cli-");
    try {
      if (c.setup) c.setup(tmp);
      const r = runCli(c.args, tmp, NO_SHELL_CREDS);
      expect(`favorite CLI: ${c.label}は exit 1 で案内を出す`, r.status === 1 && c.needles.every((n) => r.stderr.includes(n)), `status=${r.status}\n${r.stderr}`);
      expect(`favorite CLI: ${c.label}は認証値の前に止まり data/ を作らない`, !r.stderr.includes("Missing required environment variable") && !fs.existsSync(path.join(tmp, "data")), r.stderr);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // D. E2E（mock HTTP サーバー。1 つの mock・同じ一時 dir で順に進める）
  const GAIA_IL25 = { code: "GAIA_IL25", message: "ゲストスペースを操作する場合、リクエストの送信先に「/guest/（ゲストスペースのID）」を含める必要があります。" };
  const MODIFIED = "2026-01-01T00:00:00Z";
  const ADMIN_EPS = [
    "/app/actions.json",
    "/app/notifications/general.json",
    "/app/notifications/perRecord.json",
    "/app/notifications/reminder.json",
    "/app/plugins.json",
    "/app/customize.json",
    "/app/acl.json",
    "/record/acl.json",
    "/field/acl.json"
  ];
  const VIEW_BODIES = {
    "/app/form/fields.json": { properties: {}, revision: "1" },
    "/app/form/layout.json": { layout: [], revision: "1" },
    "/form.json": { properties: [] },
    "/app/views.json": { views: {}, revision: "1" },
    "/app/reports.json": { reports: {}, revision: "1" },
    "/app/settings.json": { name: "x", revision: "1" },
    "/app/status.json": { enable: false, revision: "1" }
  };
  const APPS = [
    { appId: "5", code: "", name: "通常スペースのアプリ", spaceId: "14" },
    { appId: "6", code: "", name: "スペース外のアプリ", spaceId: null },
    { appId: "7", code: "", name: "定義外のアプリ", spaceId: null },
    { appId: "9", code: "", name: "未判定のゲストアプリ", spaceId: "80" },
    { appId: "1188", code: "", name: "判明済みのゲストアプリ", spaceId: "62" }
  ];
  const appsQueries = [];
  const mock = await startMockKintone((url) => {
    const m = /^\/k(?:\/guest\/(\d+))?\/v1(\/.+)$/.exec(url.pathname);
    if (!m) return null;
    const gid = m[1] || "";
    const ep = m[2];
    if (ep === "/apps.json") {
      const listParam = (name) => [...url.searchParams.entries()].filter(([k]) => k.startsWith(`${name}[`)).map(([, v]) => v);
      const ids = listParam("ids");
      const spaceIds = listParam("spaceIds");
      appsQueries.push({ gid, ids, spaceIds });
      if (Number(url.searchParams.get("offset") || 0) > 0) return [200, { apps: []}];
      const apps = APPS.filter((a) => (!gid || a.spaceId === gid) && (!ids.length || ids.includes(a.appId)) && (!spaceIds.length || spaceIds.includes(a.spaceId)));
      return [200, { apps: apps.map((a) => ({ ...a, modifiedAt: MODIFIED })) }];
    }
    if (ep === "/space.json") {
      const id = url.searchParams.get("id");
      if (!gid) {
        if (id === "14") return [200, { name: "通常スペース" }];
        if (id === "80" || id === "62") return [400, GAIA_IL25];
        return null;
      }
      return gid === id ? [200, { name: `ゲスト${id}`, isGuest: true }] : null;
    }
    if (ADMIN_EPS.includes(ep)) return [403, { code: "CB_NO02", message: "権限がありません。" }];
    if (VIEW_BODIES[ep]) return [200, VIEW_BODIES[ep]];
    return null;
  });
  const tmp = mkTmp("kint-origin-fav-e2e-");
  const kdata = path.join(tmp, "data", "kintone");
  const run = (args) => runCliAsync(args, tmp, mockEnv(mock.baseUrl));
  const resetLog = () => {
    mock.requests.length = 0;
    appsQueries.length = 0;
  };
  const fieldsHits = (appId, prefix = "/k") =>
    mock.requests.filter((q) => q.startsWith(`GET ${prefix}/v1/app/form/fields.json?`) && new RegExp(`[?&]app=${appId}(&|$)`).test(q)).length;
  const recordApi = (q) => ["/v1/records.json", "/v1/record.json", "/v1/bulkRequest.json", "/v1/file.json"].some((suffix) => q.split("?")[0].endsWith(suffix));
  const settingsOf = (...parts) => path.join(kdata, ...parts, "app_settings", "settings.json");
  try {
    fs.writeFileSync(path.join(tmp, ".env"), Object.entries(mockEnv(mock.baseUrl)).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", "utf8");
    // 索引: 1188 はゲスト判明済み。7 は定義外で取得済み（変わらないことを確かめる）。
    const outsider = { appId: "7", code: "", name: "定義外のアプリ", spaceId: "", guestSpaceId: "", modifiedAt: MODIFIED, lastPulledModifiedAt: MODIFIED, lastPulledAt: "2026-01-02T00:00:00.000Z" };
    writeJsonFile(path.join(kdata, "index", "apps.json"), [
      { appId: "1188", code: "", name: "判明済みのゲストアプリ", spaceId: "62", guestSpaceId: "62", modifiedAt: MODIFIED },
      outsider
    ]);
    writeFav(tmp, "group1.json", { description: "E2E", apps: [5, 6, 1188, 9, 999], spaces: [14] });

    // D1. 1 回目
    const r1 = await run(["pull", "favorite", "--name", "group1"]);
    const s1 = parseJson(r1);
    const idx1 = JSON.parse(fs.readFileSync(path.join(kdata, "index", "apps.json"), "utf8"));
    expect("favorite E2E 1回目: exit 0", r1.status === 0 && r1.stderr.includes("✓ 完了"), `status=${r1.status}\n${r1.stderr.slice(-800)}`);
    expect(
      "favorite E2E 1回目: groups・coveredBySpace・missing・guestSpacesDetected",
      s1.groups?.join() === "group1" && s1.coveredBySpace?.join() === "5" && s1.missing?.join() === "999" && s1.guestSpacesDetected?.join() === "80",
      JSON.stringify({ groups: s1.groups, coveredBySpace: s1.coveredBySpace, missing: s1.missing, guestSpacesDetected: s1.guestSpacesDetected })
    );
    expect(
      "favorite E2E 1回目: apps は requested 5・total 3・pulled 3・skipped 0、スペース 14 は 1 件取得",
      s1.apps?.requested === 5 && s1.apps?.total === 3 && s1.apps?.pulled === 3 && s1.apps?.skipped === 0 && s1.spaces?.[0]?.id === "14" && s1.spaces?.[0]?.pulled === 1,
      JSON.stringify({ apps: s1.apps, spaces: s1.spaces })
    );
    expect(
      "favorite E2E 1回目: /apps.json は ids で絞り込み、全件列挙しない",
      appsQueries.some((q) => q.gid === "" && ["6", "9", "999"].every((id) => q.ids.includes(id))) &&
        appsQueries.some((q) => q.gid === "62" && q.ids.join() === "1188") &&
        appsQueries.some((q) => q.gid === "" && q.spaceIds.join() === "14") &&
        !appsQueries.some((q) => q.ids.length === 0 && q.spaceIds.length === 0),
      JSON.stringify(appsQueries)
    );
    expect(
      "favorite E2E 1回目: スペースで取得済みの 5 は二重に取得せず、定義外の 7・999 は取得しない",
      fieldsHits("5") === 1 && fieldsHits("7") === 0 && fieldsHits("999") === 0 && !mock.requests.some((q) => new RegExp("[?&]app=7(&|$)").test(q)),
      mock.requests.join("\n")
    );
    expect(
      "favorite E2E 1回目: ゲストアプリは guest URL で取得し、未判定の 9 は GAIA_IL25 で判定して guestspace-80 に保存する",
      fieldsHits("1188", "/k/guest/62") === 1 &&
        fieldsHits("9", "/k/guest/80") === 1 &&
        fieldsHits("9") === 0 &&
        fs.existsSync(settingsOf("spaces", "guestspace-80", "apps", "app-9")) &&
        fs.existsSync(settingsOf("spaces", "guestspace-62", "apps", "app-1188")),
      mock.requests.join("\n")
    );
    expect(
      "favorite E2E 1回目: 5（space-14）・6 は通常パスに保存し、9 と 7 を通常パスに作らず、deleted/ へ移さない",
      fs.existsSync(settingsOf("spaces", "space-14", "apps", "app-5")) &&
        fs.existsSync(settingsOf("apps", "app-6")) &&
        !fs.existsSync(path.join(kdata, "apps", "app-9")) &&
        !fs.existsSync(path.join(kdata, "apps", "app-7")) &&
        !fs.existsSync(path.join(kdata, "deleted")),
      listFilesRecursive(kdata).join("\n")
    );
    expect(
      "favorite E2E 1回目: 索引は定義外の 7 を変えず、取得したアプリに取得済みを記録し、9 のゲスト判定を残す",
      JSON.stringify(idx1.find((a) => a.appId === "7")) === JSON.stringify(outsider) &&
        ["5", "6", "9", "1188"].every((id) => Boolean(idx1.find((a) => a.appId === id)?.lastPulledAt)) &&
        idx1.find((a) => a.appId === "9")?.guestSpaceId === "80",
      JSON.stringify(idx1)
    );
    expect("favorite E2E 1回目: レコード・添付の API を呼ばない", !mock.requests.some(recordApi), mock.requests.join("\n"));

    // D2. 2 回目（変更なし）: 設定 API を呼ばず skipped。ゲスト判明済みなので space.json?id=80 も呼ばない
    resetLog();
    const r2 = await run(["pull", "favorite", "--name", "group1"]);
    const s2 = parseJson(r2);
    expect(
      "favorite E2E 2回目（変更なし）: 取得せず skipped、設定 API もゲスト判定も呼ばない",
      r2.status === 0 &&
        s2.apps?.pulled === 0 &&
        s2.apps?.skipped === 3 &&
        s2.spaces?.[0]?.pulled === 0 &&
        s2.spaces?.[0]?.skipped === 1 &&
        s2.coveredBySpace?.join() === "5" &&
        s2.missing?.join() === "999" &&
        !mock.requests.some((q) => q.includes("/app/form/fields.json")) &&
        !mock.requests.some((q) => q.includes("/space.json?id=80")) &&
        appsQueries.some((q) => q.gid === "80" && q.ids.join() === "9"),
      `status=${r2.status} ${JSON.stringify({ apps: s2.apps, spaces: s2.spaces })}\n${mock.requests.join("\n")}`
    );

    // D3. -f で取り直し。ローカル編集（views.json）は保持して localEdits に出す
    const viewsPath = path.join(kdata, "apps", "app-6", "views", "views.json");
    const editedViews = { views: { edited: { type: "LIST", name: "edited", index: "0" } }, revision: "-" };
    writeJsonFile(viewsPath, editedViews);
    resetLog();
    const r3 = await run(["pull", "favorite", "--name", "group1", "-f"]);
    const s3 = parseJson(r3);
    expect(
      "favorite E2E 3回目（-f）: 強制再取得（apps 3 件・スペース 1 件）。スペース配下の 5 は 1 回だけ取得する",
      r3.status === 0 && s3.apps?.pulled === 3 && s3.spaces?.[0]?.pulled === 1 && fieldsHits("5") === 1 && fieldsHits("6") === 1,
      `status=${r3.status} ${JSON.stringify({ apps: s3.apps, spaces: s3.spaces })}\n${mock.requests.join("\n")}`
    );
    expect(
      "favorite E2E 3回目（-f）: ローカル編集は保持し、localEdits に出す",
      JSON.stringify(JSON.parse(fs.readFileSync(viewsPath, "utf8"))) === JSON.stringify(editedViews) &&
        (s3.localEdits || []).some((e) => e.appId === "6" && e.edits.some((x) => x.file === "views/views.json" && x.conflict === false)),
      JSON.stringify(s3.localEdits)
    );

    // D4. --all: 雛形（_example.json）は対象外。グループをまたぐ重複は除く
    resetLog();
    fs.copyFileSync(path.join(ROOT, "template", "favorites", "_example.json"), path.join(tmp, "favorites", "_example.json"));
    writeFav(tmp, "group2.json", { apps: [6] });
    const r4 = await run(["pull", "favorite", "--all"]);
    const s4 = parseJson(r4);
    expect(
      "favorite E2E --all: グループ名の順に合算し、重複を除き、雛形（_example.json）の ID は取得しない",
      r4.status === 0 &&
        s4.groups?.join() === "group1,group2" &&
        s4.apps?.requested === 5 &&
        !mock.requests.some((q) => q.includes("/space.json?id=26") || q.includes("app=303")) &&
        !appsQueries.some((q) => q.ids.includes("303") || q.spaceIds.includes("26")),
      `status=${r4.status} ${JSON.stringify({ groups: s4.groups, apps: s4.apps })}\n${mock.requests.join("\n")}`
    );
  } finally {
    mock.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function startStatefulMock(handle) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const raw = Buffer.concat(chunks);
      const body = raw.length && String(req.headers["content-type"] || "").includes("json") ? JSON.parse(raw.toString("utf8")) : undefined;
      requests.push(`${req.method} ${url.pathname}`);
      const [status, payload] = handle(req.method, url, body, raw) ?? [404, { code: "GAIA_AP01", message: "not found" }];
      if (Buffer.isBuffer(payload)) {
        res.writeHead(status, { "Content-Type": "application/octet-stream" });
        res.end(payload);
      } else {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "localhost", resolve));
  return { server, requests, baseUrl: `http://localhost:${server.address().port}` };
}

// ---- 1q. pull 状態・diff・push（ローカル編集の保持と三方比較。mock HTTP サーバー） ----
// data/ を作業コピーとして編集し、diff で環境との差分（local / remote / conflict）を見て、push はローカル編集だけを送る。
// 管理系は 403 にして cli-kintone を起動しない（customize の比較は appDiffPureTests の単体検証で担保する）。
async function appDiffTests() {
  console.log("[offline] Git基準によるアプリ差分・限定push（mock HTTP）");
  const VIEW = (name, index) => ({ id: String(10 + index), type: "LIST", name, index: String(index), sort: "", fields: [] });
  const production = {
    "/app/form/fields.json": { properties: { 氏名: { type: "SINGLE_LINE_TEXT", code: "氏名", label: "氏名" } }, revision: "1" },
    "/app/form/layout.json": { layout: [], revision: "1" },
    "/form.json": { properties: [] },
    "/app/views.json": { views: { 一覧: VIEW("一覧", 0) }, revision: "1" },
    "/app/reports.json": { reports: {}, revision: "1" },
    "/app/settings.json": { name: "案件", description: "", icon: { type: "PRESET", key: "APP72" }, revision: "1" },
    "/app/status.json": { enable: false, states: null, actions: null, revision: "1" }
  };
  const admin = ["/app/actions.json", "/app/notifications/general.json", "/app/notifications/perRecord.json", "/app/notifications/reminder.json", "/app/plugins.json", "/app/customize.json", "/app/acl.json", "/record/acl.json", "/field/acl.json"];
  const writes = [];
  const mock = await startStatefulMock((method, url, body) => {
    const m = /^\/k\/v1(\/preview)?(\/.+)$/.exec(url.pathname);
    if (!m) return null;
    const preview = Boolean(m[1]);
    const ep = m[2];
    if (method === "GET" && !preview) {
      if (ep === "/app.json") return [200, { appId: "3", name: "案件", spaceId: null }];
      if (ep === "/apps.json") return [200, { apps: [{ appId: "3", code: "", name: "app", spaceId: null }] }];
      if (admin.includes(ep)) return [403, { code: "CB_NO02", message: "権限がありません。" }];
      return production[ep] ? [200, production[ep]] : null;
    }
    if (method === "GET" && preview && ep === "/app/deploy.json") return [200, { apps: [{ app: "3", status: "SUCCESS" }] }];
    if (preview && method !== "GET") {
      writes.push({ method, path: url.pathname, body });
      return [200, { revision: "2" }];
    }
    return null;
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-app-git-diff-"));
  fs.writeFileSync(path.join(tmp, ".env"), Object.entries(mockEnv(mock.baseUrl)).map(([k, v]) => `${k}=${v}`).join("\n") + "\nKINT_ORIGIN_ALLOW_PUSH_APP=true\n", "utf8");
  const run = (args) => runCliAsync(args, tmp, mockEnv(mock.baseUrl));
  const parse = (result) => { try { return JSON.parse(result.stdout); } catch (error) { throw new Error(`invalid JSON, status=${result.status} stdout=${result.stdout} stderr=${result.stderr} requests=${JSON.stringify(mock.requests)}`, { cause: error }); } };
  const appDir = path.join(tmp, "data", "kintone", "apps", "app-3");
  const file = (rel) => path.join(appDir, rel);
  const editJson = (rel, edit) => {
    const value = JSON.parse(fs.readFileSync(file(rel), "utf8"));
    edit(value);
    fs.writeFileSync(file(rel), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  try {
    const pulled = await run(["pull", "app", "--id", "3"]);
    expect("Git diff E2E: pull app で基準ファイルとpull状態を作る", pulled.status === 0 && !pulled.stderr.includes("failed"), `${pulled.stdout}\n${pulled.stderr}\n${JSON.stringify(mock.requests)}`);
    expect("app pull endpoints", mock.requests.some((request) => request.includes("/app/form/fields.json")), JSON.stringify(mock.requests));
    const base = initGitWithDataSnapshot(tmp);
    mock.requests.length = 0;
    const clean = await run(["diff", "app", "--id", "3"]);
    const cleanSummary = parse(clean);
    expect("Git diff E2E: diff app はAPIを呼ばず同一状態を返す", clean.status === 0 && mock.requests.length === 0 && cleanSummary.baseCommit === base && cleanSummary.resources.filter((r) => r.state === "same").length === 6, `${clean.stdout}\n${JSON.stringify(mock.requests)}`);

    editJson("views/views.json", (value) => { value.views["追加一覧"] = VIEW("追加一覧", 1); });
    editJson("app_settings/settings.json", (value) => { value.description = "ローカルの変更"; });
    editJson("form/fields.json", (value) => {
      value.properties.追加 = { type: "SINGLE_LINE_TEXT", code: "追加", label: "追加" };
    });
    const edited = await run(["diff", "app", "--id", "3", "--base", base]);
    const editedSummary = parse(edited);
    expect("Git diff E2E: base commitから変わった fields・views・settingsだけlocal", edited.status === 0 && ["fields", "views", "settings"].every((key) => editedSummary.resources.find((r) => r.key === key)?.state === "local") && mock.requests.length === 0, `${edited.stdout}\n${edited.stderr}`);

    // リモート側に別の変更があっても照合GETを行わず、Git差分をそのまま送る。
    production["/app/settings.json"] = { ...production["/app/settings.json"], description: "pull後の環境変更", revision: "99" };
    git(tmp, ["add", "--", "data"]);
    git(tmp, ["commit", "-q", "-m", "local app edits"]);
    const headDiff = await run(["diff", "app", "--id", "3"]);
    expect("Git diff E2E: 変更後のHEADを誤って基準にすると止め、--baseを案内", headDiff.status === 1 && headDiff.stderr.includes("編集前のコミットを --base に指定"), `${headDiff.stderr}`);

    mock.requests.length = 0;
    writes.length = 0;
    const pushed = await run(["push", "app", "--id", "3", "--base", base, "-y"]);
    const summary = parse(pushed);
    expect("Git diff E2E: push app はGit基準との差分をdeployする", pushed.status === 0 && summary.status === "deployed" && summary.deployed === true, `${pushed.stdout}\n${pushed.stderr}`);
    expect("Git diff E2E: API書き込みはfields追加・views・settings・deployだけ", writes.map((w) => `${w.method} ${w.path}`).join("|") === ["POST /k/v1/preview/app/form/fields.json", "PUT /k/v1/preview/app/views.json", "PUT /k/v1/preview/app/settings.json", "POST /k/v1/preview/app/deploy.json"].join("|"), JSON.stringify(writes));
    expect("Git diff E2E: 事前照合・全件バックアップ・検証pullはなく、deploy状態GETだけ", mock.requests.filter((request) => request.startsWith("GET ")).join("|") === "GET /k/v1/preview/app/deploy.json" && !summary.backupDir && !summary.verified, JSON.stringify({ requests: mock.requests, summary }));
    const settingsWrite = writes.find((w) => w.path.endsWith("/app/settings.json"));
    expect("Git diff E2E: settings APIにはGit基準と違うdescriptionだけを含める", settingsWrite?.body.description === "ローカルの変更" && Object.keys(settingsWrite.body).join(",") === "app,description", JSON.stringify(settingsWrite?.body));
    const after = parse(await run(["diff", "app", "--id", "3", "--base", base]));
    expect("Git diff E2E: deploy成功後はpull状態を進めて同じ内容を再送しない", ["fields", "views", "settings"].every((key) => after.resources.find((r) => r.key === key)?.state === "same"), JSON.stringify(after.resources));

    git(tmp, ["add", "--", "data"]);
    git(tmp, ["commit", "-q", "-m", "deployed app state"]);
    editJson("app_settings/settings.json", (value) => { value.description = "次の変更"; });
    const stale = await run(["diff", "app", "--id", "3", "--base", base]);
    expect("Git diff E2E: pull状態が進んだ後に古い基準を使うと止める", stale.status === 1 && stale.stderr.includes("Git 基準が pull app の取得時点と一致しません"), stale.stderr);
    const next = parse(await run(["diff", "app", "--id", "3"]));
    expect("Git diff E2E: 次の編集は新しいHEADを基準にlocal", next.resources.find((r) => r.key === "settings")?.state === "local", JSON.stringify(next.resources));
    mock.requests.length = 0;
    writes.length = 0;
    const previewOnly = await run(["push", "app", "--id", "3", "--no-deploy", "-y"]);
    expect("Git diff E2E: --no-deploy はpreview_savedを返しdeployしない", previewOnly.status === 0 && parse(previewOnly).status === "preview_saved" && !parse(previewOnly).deployed && !writes.some((w) => w.path.endsWith("/deploy.json")), `${previewOnly.stdout}\n${JSON.stringify(writes)}`);
    expect("Git diff E2E: --no-deploy中も対象settings以外をGETしない", mock.requests.every((request) => !request.startsWith("GET ")), JSON.stringify(mock.requests));
  } finally {
    mock.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
async function appDiffGuestTests() {
  console.log("[offline] ゲストスペース配下のアプリでGit差分を使う");
  const guestId = "62";
  const appId = "9";
  const resources = {
    "/app/form/fields.json": { properties: {}, revision: "1" },
    "/app/form/layout.json": { layout: [], revision: "1" },
    "/form.json": { properties: [] },
    "/app/views.json": { views: { 一覧: { id: "10", type: "LIST", name: "一覧", index: "0", sort: "", fields: [] } }, revision: "1" },
    "/app/reports.json": { reports: {}, revision: "1" },
    "/app/settings.json": { name: "ゲスト案件", revision: "1" },
    "/app/status.json": { enable: false, states: null, actions: null, revision: "1" }
  };
  const admin = ["/app/actions.json", "/app/notifications/general.json", "/app/notifications/perRecord.json", "/app/notifications/reminder.json", "/app/plugins.json", "/app/customize.json", "/app/acl.json", "/record/acl.json", "/field/acl.json"];
  const writes = [];
  const mock = await startStatefulMock((method, url, body) => {
    const m = /^\/k(?:\/guest\/(\d+))?\/v1(\/preview)?(\/.+)$/.exec(url.pathname);
    if (!m) return null;
    const guest = m[1] || "";
    const preview = Boolean(m[2]);
    const ep = m[3];
    if (method === "GET" && !preview) {
      if (ep === "/apps.json") return [200, { apps: [{ appId, code: "", name: "guest", spaceId: guestId }] }];
      if (guest !== guestId) return [404, { code: "GAIA_IL23", message: "ゲストスペースのアプリです。" }];
      if (ep === "/app.json") return [200, { appId, guestSpaceId: guestId, name: "ゲスト案件" }];
      if (admin.includes(ep)) return [403, { code: "CB_NO02", message: "権限がありません。" }];
      return resources[ep] ? [200, resources[ep]] : null;
    }
    if (method === "GET" && preview && ep === "/app/deploy.json") return [200, { apps: [{ app: appId, status: "SUCCESS" }] }];
    if (preview && method !== "GET") {
      writes.push({ method, path: url.pathname, body });
      return [200, { revision: "2" }];
    }
    return null;
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-guest-git-diff-"));
  fs.writeFileSync(path.join(tmp, ".env"), Object.entries(mockEnv(mock.baseUrl)).map(([k, v]) => `${k}=${v}`).join("\n") + "\nKINT_ORIGIN_ALLOW_PUSH_APP=true\n", "utf8");
  const run = (args) => runCliAsync(args, tmp, mockEnv(mock.baseUrl));
  const parse = (result) => JSON.parse(result.stdout);
  const appDir = path.join(tmp, "data", "kintone", "spaces", `guestspace-${guestId}`, "apps", `app-${appId}`);
  const viewsPath = path.join(appDir, "views", "views.json");
  try {
    const pulled = await run(["pull", "app", "--id", appId, "--guestspace", guestId]);
    expect("guest Git diff: pull app はguestspace配下にデータを保存", pulled.status === 0 && fs.existsSync(path.join(appDir, ".kint-origin-pull.json")), `${pulled.stdout}\n${pulled.stderr}`);
    const base = initGitWithDataSnapshot(tmp);
    const views = JSON.parse(fs.readFileSync(viewsPath, "utf8"));
    views.views["ゲスト追加"] = { id: "11", type: "LIST", name: "ゲスト追加", index: "1", sort: "", fields: [] };
    fs.writeFileSync(viewsPath, `${JSON.stringify(views, null, 2)}\n`, "utf8");
    mock.requests.length = 0;
    const diff = await run(["diff", "app", "--id", appId, "--guestspace", guestId]);
    expect("guest Git diff: diff app はlocal差分を返し、APIを呼ばない", diff.status === 0 && parse(diff).guestSpaceId === guestId && parse(diff).resources.find((r) => r.key === "views")?.state === "local" && mock.requests.length === 0, `${diff.stdout}\n${JSON.stringify(mock.requests)}`);
    const pushed = await run(["push", "app", "--id", appId, "--guestspace", guestId, "--base", base, "--only", "views", "-y"]);
    expect("guest Git diff: push app はguest previewへ差分だけ送りdeployする", pushed.status === 0 && parse(pushed).status === "deployed" && writes.some((w) => w.path === `/k/guest/${guestId}/v1/preview/app/views.json`) && writes.some((w) => w.path === `/k/guest/${guestId}/v1/preview/app/deploy.json`), `${pushed.stdout}\n${pushed.stderr}\n${JSON.stringify(writes)}`);
    expect("guest Git diff: push時のGETはdeploy状態だけ", mock.requests.filter((r) => r.startsWith("GET ")).join("|") === `GET /k/guest/${guestId}/v1/preview/app/deploy.json`, JSON.stringify(mock.requests));
  } finally {
    mock.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
// ---- 1q2. customize の取得・diff・push（実際の cli-kintone を mock HTTP サーバーへ向けて実行） ----
// customize 一式（マニフェストと JS）は環境 → 一時ディレクトリ → data/ へ取り込み、ローカル編集は保持する。
// push app は Git 基準との差分にある customize 設定だけを反映する。
async function customizeE2ETests() {
  console.log("[offline] customizeをpush appへ統合（mock HTTP）");
  const blobs = new Map([
    ["fk1", { name: "a.js", content: "console.log('env-a');\n" }],
    ["fk2", { name: "b.js", content: "console.log('env-b');\n" }]
  ]);
  const environment = { fileKeys: ["fk1", "fk2"], pending: null, lastCustomizeBody: null };
  const writes = [];
  let uploads = 0;
  const admin = ["/app/actions.json", "/app/notifications/general.json", "/app/notifications/perRecord.json", "/app/notifications/reminder.json", "/app/plugins.json", "/app/acl.json", "/record/acl.json", "/field/acl.json"];
  const resources = {
    "/app/form/fields.json": { properties: {}, revision: "1" },
    "/app/form/layout.json": { layout: [], revision: "1" },
    "/form.json": { properties: [] },
    "/app/views.json": { views: {}, revision: "1" },
    "/app/reports.json": { reports: {}, revision: "1" },
    "/app/settings.json": { name: "案件", revision: "1" },
    "/app/status.json": { enable: false, states: null, actions: null, revision: "1" }
  };
  const customizeBody = () => ({
    scope: "ALL",
    permissions: [{ permission: "kintone.app.record.read" }],
    allowedHosts: ["api.example.com"],
    desktop: { js: environment.fileKeys.map((key) => ({ type: "FILE", file: { fileKey: key, name: blobs.get(key).name, contentType: "text/javascript", size: String(Buffer.byteLength(blobs.get(key).content)) } })), css: [] },
    mobile: { js: [], css: [] },
    revision: "1"
  });
  const mock = await startStatefulMock((method, url, body, raw) => {
    const m = /^\/k\/v1(\/preview)?(\/.+)$/.exec(url.pathname);
    if (!m) return null;
    const preview = Boolean(m[1]);
    const ep = m[2];
    if (method === "GET" && !preview) {
      if (ep === "/app/acl.json") return [200, { rights: [] }];
      if (ep === "/app.json") return [200, { appId: "3", name: "案件", spaceId: null }];
      if (ep === "/apps.json") return [200, { apps: [{ appId: "3", code: "", name: "app", spaceId: null }] }];
      if (ep === "/app/customize.json") return [200, customizeBody()];
      if (ep === "/file.json") {
        const blob = blobs.get(url.searchParams.get("fileKey"));
        return blob ? [200, Buffer.from(blob.content)] : null;
      }
      if (admin.includes(ep)) return [403, { code: "CB_NO02", message: "権限がありません。" }];
      return resources[ep] ? [200, resources[ep]] : null;
    }
    if (method === "GET" && preview && ep === "/app/deploy.json") return [200, { apps: [{ app: "3", status: "SUCCESS" }] }];
    if (method === "POST" && ep === "/file.json") {
      const found = /filename="([^"]*)"[\s\S]*?\r\n\r\n([\s\S]*)\r\n--[^\r\n]*--\s*$/.exec(raw.toString("utf8"));
      const key = `uploaded-${++uploads}`;
      blobs.set(key, { name: found?.[1] || "unknown", content: found?.[2] || "" });
      writes.push(`${method} ${url.pathname}`);
      return [200, { fileKey: key }];
    }
    if (preview && method === "PUT" && ep === "/app/customize.json") {
      environment.pending = body.desktop?.js?.map((entry) => entry.file.fileKey) ?? environment.fileKeys;
      environment.lastCustomizeBody = body;
      writes.push(`${method} ${url.pathname}`);
      return [200, { revision: "2" }];
    }
    if (preview && method === "POST" && ep === "/app/deploy.json") {
      if (environment.pending) environment.fileKeys = environment.pending;
      environment.pending = null;
      writes.push(`${method} ${url.pathname}`);
      return [200, {}];
    }
    return null;
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-customize-git-e2e-"));
  fs.writeFileSync(path.join(tmp, ".env"), Object.entries(mockEnv(mock.baseUrl)).map(([k, v]) => `${k}=${v}`).join("\n") + "\nKINT_ORIGIN_ALLOW_PUSH_APP=true\n", "utf8");
  const run = (args) => runCliAsync(args, tmp, mockEnv(mock.baseUrl), 180_000);
  const parse = (result) => JSON.parse(result.stdout);
  const appDir = path.join(tmp, "data", "kintone", "apps", "app-3");
  const jsPath = (name) => path.join(appDir, "customize", "desktop", "js", name);
  const manifestPath = path.join(appDir, "customize", "customize-manifest.json");
  try {
    const pulled = await run(["pull", "app", "--id", "3"]);
    expect("customize Git E2E: pull appでマニフェストとJS/CSSを取得", pulled.status === 0 && fs.existsSync(jsPath("a.js")) && fs.existsSync(jsPath("b.js")), `${pulled.stdout}\n${pulled.stderr}\n${JSON.stringify(mock.requests)}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect("customize Git E2E: manifest entries", manifest.desktop?.js?.join(",") === "desktop/js/a.js,desktop/js/b.js", JSON.stringify({ manifest, files: listFilesRecursive(path.join(appDir, "customize")), requests: mock.requests }));
    expect("customize Git E2E: pull app は sandbox customize 設定もmanifestへ保存", JSON.stringify(manifest.permissions) === JSON.stringify([{ permission: "kintone.app.record.read" }]) && JSON.stringify(manifest.allowed_hosts) === JSON.stringify(["api.example.com"]), JSON.stringify(manifest));
    expect("customize Git E2E: pull状態にcustomizeハッシュを保存", /^[0-9a-f]{64}$/.test(JSON.parse(fs.readFileSync(path.join(appDir, ".kint-origin-pull.json"), "utf8")).customize || ""), JSON.stringify(manifest));
    const base = initGitWithDataSnapshot(tmp);
    fs.writeFileSync(jsPath("a.js"), "console.log('local-a');\n", "utf8");
    mock.requests.length = 0;
    const diff = await run(["diff", "app", "--id", "3", "--only", "customize"]);
    const diffSummary = parse(diff);
    expect("customize Git E2E: diff app はJS差分を検出しAPIを呼ばない", diff.status === 0 && diffSummary.customize.state === "local" && diffSummary.customize.changed.includes("desktop/js/a.js") && mock.requests.length === 0, `${diff.stdout}\n${diff.stderr}`);

    // pull後の環境変更も事前照合せず、Git基準の変更グループで上書きする。
    blobs.set("fk3", { name: "remote.js", content: "console.log('remote');\n" });
    environment.fileKeys = ["fk3"];
    mock.requests.length = 0;
    writes.length = 0;
    const pushed = await run(["push", "app", "--id", "3", "--base", base, "--only", "customize", "-y"]);
    const summary = parse(pushed);
    expect("customize Git E2E: push app --only customize はdeploy済みを返す", pushed.status === 0 && summary.status === "deployed" && summary.deployed === true, `${pushed.stdout}\n${pushed.stderr}`);
    expect("customize Git E2E: 変更グループ内のFILE2件をアップロード", uploads === 2 && summary.uploadedCustomizeFiles.join(",") === "a.js,b.js", JSON.stringify({ uploads, names: summary.uploadedCustomizeFiles }));
    expect("customize Git E2E: customize設定APIはdesktop.jsだけを置き換える", writes.includes("PUT /k/v1/preview/app/customize.json") && !writes.some((write) => write.includes("/app/views.json")) && environment.fileKeys.length === 2 && environment.fileKeys.every((key) => key.startsWith("uploaded-")), `${JSON.stringify({ writes, fileKeys: environment.fileKeys })}`);
    expect("customize Git E2E: customize PUT は permissions と allowed_hosts も保持", JSON.stringify(environment.lastCustomizeBody?.permissions) === JSON.stringify([{ permission: "kintone.app.record.read" }]) && JSON.stringify(environment.lastCustomizeBody?.allowedHosts) === JSON.stringify(["api.example.com"]), JSON.stringify(environment.lastCustomizeBody));
    expect("customize Git E2E: APIはupload・customize PUT・deploy・deploy状態GETだけ", mock.requests.join("|") === ["POST /k/v1/file.json", "POST /k/v1/file.json", "PUT /k/v1/preview/app/customize.json", "POST /k/v1/preview/app/deploy.json", "GET /k/v1/preview/app/deploy.json"].join("|"), JSON.stringify(mock.requests));
    const after = await run(["diff", "app", "--id", "3", "--base", base, "--only", "customize"]);
    expect("customize Git E2E: deploy後はpull状態が進み再送差分なし", after.status === 0 && parse(after).customize.state === "same", `${after.stdout}\n${after.stderr}`);
  } finally {
    mock.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
// ---- 1r. pull 状態・diff の純関数（オフライン） ---------------------------
async function appDiffPureTests() {
  console.log("[offline] pull 状態・diff の純関数（ハッシュ・三方比較・customize 比較単位）");

  const dist = (...parts) => pathToFileURL(path.join(ROOT, "dist", ...parts)).href;
  const { canonicalJson } = await import(dist("normalize.js"));
  const { classify, hashJson, hashBytes } = await import(dist("kintone", "pullState.js"));
  const { PUSHABLE_FILES, PUSH_ITEMS, diffFieldProperties } = await import(dist("kintone", "pushItems.js"));
  const { customizeUnit, manifestFiles } = await import(dist("kintone", "customize.js"));

  expect(
    "state: canonicalJson はオブジェクトのキー順に依存しない",
    canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }) === canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }),
    canonicalJson({ b: 1, a: 2 })
  );
  expect("state: canonicalJson は配列の順序を区別する", canonicalJson([1, 2]) !== canonicalJson([2, 1]), canonicalJson([1, 2]));
  expect(
    "state: hashJson は revision / fileKey の違いを無視し、内容の違いは区別する",
    hashJson({ a: 1, revision: "5" }) === hashJson({ revision: "-", a: 1 }) &&
      hashJson({ k: { fileKey: "x" } }) === hashJson({ k: { fileKey: "y" } }) &&
      hashJson({ a: 1 }) !== hashJson({ a: 2 }),
    hashJson({ a: 1 })
  );
  expect(
    "state: hashBytes はテキストの CRLF と LF を同じ内容とみなし（autocrlf 対策）、内容の違いとバイナリは区別する",
    hashBytes(Buffer.from("a\r\nb\r\n")) === hashBytes(Buffer.from("a\nb\n")) &&
      hashBytes(Buffer.from("a\nb")) !== hashBytes(Buffer.from("a\nc")) &&
      hashBytes(Buffer.from([0, 13, 10])) !== hashBytes(Buffer.from([0, 10])),
    hashBytes(Buffer.from("a"))
  );

  // 三方比較: base（前回 pull）・local・remote
  const c = (base, local, remote) => classify({ base, local, remote });
  expect("state: classify は local と remote が同じなら same", c("a", "b", "b") === "same" && c(undefined, undefined, undefined) === "same" && c("a", "a", "a") === "same", c("a", "b", "b"));
  expect("state: classify はローカルだけ変更なら local", c("a", "b", "a") === "local", c("a", "b", "a"));
  expect("state: classify は環境だけ変更なら remote", c("a", "a", "b") === "remote", c("a", "a", "b"));
  expect("state: classify は両方変更なら conflict", c("a", "b", "c") === "conflict", c("a", "b", "c"));
  expect("state: classify は base が無いとき、環境に無ければ local・両方あって違えば conflict", c(undefined, "a", undefined) === "local" && c(undefined, "a", "b") === "conflict", `${c(undefined, "a", undefined)} ${c(undefined, "a", "b")}`);
  expect("state: classify はローカルに無いファイルを編集とみなさず remote（環境から取り直す）", c("a", undefined, "a") === "remote" && c("a", undefined, "b") === "remote" && c(undefined, undefined, "b") === "remote", c("a", undefined, "b"));
  expect("state: classify は環境の取得失敗（remote なし）でローカル編集があれば conflict（保持）、無ければ remote", c("a", "b", undefined) === "conflict" && c("a", "a", undefined) === "remote", `${c("a", "b", undefined)} ${c("a", "a", undefined)}`);

  expect(
    "state: PUSHABLE_FILES は fields と PUSH_ITEMS の全ファイル（取得専用の form.json・plugins・customize.json を含まない）",
    PUSHABLE_FILES.length === PUSH_ITEMS.length + 1 &&
      PUSHABLE_FILES[0].key === "fields" &&
      PUSHABLE_FILES.some((f) => f.folder === "form" && f.file === "layout.json") &&
      !PUSHABLE_FILES.some((f) => ["form.json", "plugins.json", "customize.json"].includes(f.file)),
    PUSHABLE_FILES.map((f) => `${f.folder}/${f.file}`).join(",")
  );

  // フィールド単位の差分（キー順・組み込み型・環境のみ）
  const fieldsDiff = diffFieldProperties(
    {
      既存: { type: "NUMBER", code: "既存", label: "新ラベル" },
      同じ: { label: "同", type: "SINGLE_LINE_TEXT", code: "同じ" },
      新規: { type: "DATE", code: "新規" },
      レコード番号: { type: "RECORD_NUMBER", code: "レコード番号" }
    },
    {
      既存: { type: "NUMBER", code: "既存", label: "旧" },
      同じ: { type: "SINGLE_LINE_TEXT", code: "同じ", label: "同" },
      リモートのみ: { type: "NUMBER", code: "リモートのみ" },
      ステータス: { type: "STATUS", code: "ステータス" }
    }
  );
  expect(
    "state: diffFieldProperties は追加・変更・環境のみを分け、キー順と組み込み型の違いは無視する",
    JSON.stringify(fieldsDiff) === JSON.stringify({ added: ["新規"], changed: ["既存"], missingOnLocal: ["リモートのみ"] }),
    JSON.stringify(fieldsDiff)
  );

  // Claude の guard が編集を許可する data/ のファイルは PUSHABLE_FILES と一致する（push 対象を増減したときの更新漏れを検知）
  const { generateAgents } = await import(pathToFileURL(path.join(ROOT, "dist", "agents.js")).href);
  const guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-pushable-guard-"));
  try {
    generateAgents({ targetRoot: guardRoot });
    const guardFile = path.join(guardRoot, ".claude", "hooks", "kint-origin-guard.mjs");
    const guardDecision = (filePath) => {
      const r = spawnSync(process.execPath, [guardFile], { encoding: "utf8", input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath }, cwd: ROOT }) });
      return (r.stdout || "").trim() ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : "";
    };
    const layouts = [["apps", "app-1"], ["spaces", "space-5", "apps", "app-2"], ["spaces", "guestspace-7", "apps", "app-3"]];
    const notAllowed = layouts.flatMap((layout) =>
      PUSHABLE_FILES.map((f) => path.join("data", "kintone", ...layout, f.folder, f.file)).filter((p) => guardDecision(p) !== "")
    );
    expect("hook: Claude の guard は PUSHABLE_FILES の全ファイルを通常・スペース・ゲストの配置で編集可にする", notAllowed.length === 0, notAllowed.join("\n"));
    expect(
      "hook: Claude の guard はスペースの settings.json・body.html・_agentdata を編集可にし、space.json・apps.json は deny にする",
      ["data/kintone/spaces/space-5/settings.json", "data/kintone/spaces/space-5/body.html", "data/kintone/spaces/guestspace-7/settings.json", "data/kintone/spaces/guestspace-7/body.html", "data/kintone/spaces/space-5/_agentdata/notes/a.md"].every((p) => guardDecision(p) === "") &&
        ["data/kintone/spaces/space-5/space.json", "data/kintone/spaces/space-5/apps.json", "data/kintone/spaces/guestspace-7/space.json"].every((p) => guardDecision(p) === "deny"),
      "space guard decision mismatch"
    );
  } finally {
    fs.rmSync(guardRoot, { recursive: true, force: true });
  }

  // settings.json の allow（push 対象・_agentdata）と ask（push 対象外の取得物）の整合。
  // Claude Code は deny → ask → allow の順で最初に一致したルールを採用し、具体的な allow でも ask を覆せない。
  // そのため、編集してよいパスは ask のどれにも一致せず、取得物は ask のどれかに一致することを、実際のパスで確かめる。
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, "template", "agents", "claude", ".claude", "settings.json"), "utf8"));
  // gitignore 風: `**/` は 0 個以上のディレクトリ、`**` は任意、`*` は区切り以外。置換済みの記号を再変換しないよう、いったん別の文字に置く。
  const globToRegExp = (glob) =>
    new RegExp(
      "^" +
        glob
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*\//g, "\u0000")
          .replace(/\*\*/g, "\u0001")
          .replace(/\*/g, "[^/]*")
          .replace(/\u0000/g, "(?:.*/)?")
          .replace(/\u0001/g, ".*") +
        "$"
    );
  const patternsOf = (list, tool) => list.filter((p) => p.startsWith(`${tool}(`)).map((p) => globToRegExp(p.slice(tool.length + 1, -1)));
  const writeAsk = patternsOf(settings.permissions.ask, "Edit"); // ファイルの規則は Edit(...)（Write(...) は Claude Code では一致しない）
  const writeAllow = patternsOf(settings.permissions.allow, "Edit");
  const editableSamples = [
    ...PUSHABLE_FILES.flatMap((f) => [
      `data/kintone/apps/app-1/${f.folder}/${f.file}`,
      `data/kintone/spaces/guestspace-7/apps/app-3/${f.folder}/${f.file}`
    ]),
    "data/kintone/apps/app-1/customize/customize-manifest.json",
    "data/kintone/apps/app-1/customize/desktop/js/main.js",
    "data/kintone/apps/app-1/customize/mobile/css/sub/style.css",
    "data/kintone/apps/app-1/_agentdata/backup/20260101-000000/views/views.json",
    "data/kintone/apps/app-1/_agentdata/notes/memo.md",
    "data/kintone/spaces/space-5/settings.json",
    "data/kintone/spaces/space-5/body.html",
    "data/kintone/spaces/guestspace-7/settings.json",
    "data/kintone/spaces/guestspace-7/body.html",
    "data/kintone/spaces/space-5/_agentdata/notes/memo.md"
  ];
  const askedButEditable = editableSamples.filter((p) => writeAsk.some((re) => re.test(p)));
  const editableNotAllowed = editableSamples.filter((p) => !writeAllow.some((re) => re.test(p)));
  expect("settings: 編集してよい data/ のパス（push 対象・_agentdata）は ask に一致しない（一致すると allow が無効になる）", askedButEditable.length === 0, askedButEditable.join("\n"));
  expect("settings: 編集してよい data/ のパス（push 対象・_agentdata）は allow に一致する", editableNotAllowed.length === 0, editableNotAllowed.join("\n"));
  const retrieved = [
    "data/kintone/index/apps.json",
    "data/kintone/apps/app-1/app.json",
    "data/kintone/apps/app-1/form/form.json",
    "data/kintone/apps/app-1/records/records.csv",
    "data/kintone/apps/app-1/records/attachments/1/f/a.pdf",
    "data/kintone/apps/app-1/customize/plugins.json",
    "data/kintone/apps/app-1/customize/customize.json",
    "data/kintone/apps/app-1/customize/plugin-configs/p.json",
    "data/kintone/apps/app-1/.kint-origin-pull.json",
    "data/kintone/spaces/guestspace-7/apps/app-3/app.json",
    "data/kintone/spaces/space-5/space.json",
    "data/kintone/spaces/space-5/apps.json",
    "data/kintone/spaces/space-5/.kint-origin-pull.json",
    "data/kintone/spaces/guestspace-7/space.json",
    "data/kintone/deleted/apps/app-9/app.json",
    "data/cybozu-common/users/users.json"
  ];
  const retrievedNotAsked = retrieved.filter((p) => !writeAsk.some((re) => re.test(p)));
  expect("settings: 取得物（push 対象外）への Edit は ask に一致する（hook が働かないときのフォールバック）", retrievedNotAsked.length === 0, retrievedNotAsked.join("\n"));

  // customize の比較単位（マニフェストと、マニフェストに載っている JS/CSS）
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-cunit-"));
  try {
    expect("state: customize のマニフェストが無ければ undefined", customizeUnit(cdir) === undefined, String(customizeUnit(cdir)));
    const manifest = { scope: "ALL", desktop: { js: ["desktop/js/a.js", "https://example.com/cdn.js", "../escape.js"], css: [] }, mobile: { js: [], css: [] } };
    fs.mkdirSync(path.join(cdir, "customize", "desktop", "js"), { recursive: true });
    fs.writeFileSync(path.join(cdir, "customize", "customize-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    fs.writeFileSync(path.join(cdir, "customize", "desktop", "js", "a.js"), "console.log(1);\n", "utf8");
    const u1 = customizeUnit(cdir);
    expect(
      "state: customize の比較単位はマニフェストと、載っている JS のハッシュを持つ（URL と customize/ の外を指す項目は除く）",
      Boolean(u1?.hash) && Boolean(u1?.manifest) && Object.keys(u1?.files || {}).join() === "desktop/js/a.js",
      JSON.stringify(u1)
    );
    fs.writeFileSync(path.join(cdir, "customize", "desktop", "js", "a.js"), "console.log(1);\r\n", "utf8");
    expect("state: customize の JS は CRLF と LF を同じ内容とみなす", customizeUnit(cdir).hash === u1.hash, "hash changed by CRLF");
    fs.mkdirSync(path.join(cdir, "customize", "plugin-configs"), { recursive: true });
    fs.writeFileSync(path.join(cdir, "customize", "plugin-configs", "p.json"), "{}", "utf8");
    fs.writeFileSync(path.join(cdir, "customize", "customize.json"), "{}", "utf8");
    fs.writeFileSync(path.join(cdir, "customize", "desktop", "js", ".gitkeep"), "", "utf8");
    fs.writeFileSync(path.join(cdir, "customize", "desktop", "js", "a.js.map"), "{}", "utf8");
    expect("state: customize の比較単位は plugin-configs・customize.json・マニフェストに載っていない付随ファイル（.gitkeep・.map）を含めない", customizeUnit(cdir).hash === u1.hash, "hash changed by non-unit files");
    fs.writeFileSync(path.join(cdir, "customize", "desktop", "js", "a.js"), "console.log(2);\n", "utf8");
    expect("state: customize の JS を編集するとハッシュが変わる", customizeUnit(cdir).hash !== u1.hash, "hash unchanged");
    fs.rmSync(path.join(cdir, "customize", "desktop", "js", "a.js"));
    expect("state: マニフェストに載っている JS が無ければ missing として区別する", customizeUnit(cdir).files["desktop/js/a.js"] === "(missing)", JSON.stringify(customizeUnit(cdir)));
    expect(
      "state: manifestFiles は URL・絶対パス・.. を含む項目を除き、区切りを / に揃える",
      JSON.stringify(manifestFiles({ desktop: { js: ["a.js", "https://x/y.js", "/abs.js", "../b.js", "c\\d.js"], css: [] }, mobile: { js: [], css: ["m.css"] } })) === JSON.stringify(["a.js", "c/d.js", "m.css"]),
      JSON.stringify(manifestFiles({ desktop: { js: ["a.js", "https://x/y.js", "/abs.js", "../b.js", "c\\d.js"], css: [] }, mobile: { js: [], css: ["m.css"] } }))
    );
  } finally {
    fs.rmSync(cdir, { recursive: true, force: true });
  }
}

// ---- 2. ライブ検証（実ドメイン設定時のみ） ------------------------------
function readEnv() {
  const envPath = path.join(SANDBOX, ".env");
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function liveTests() {
  const env = readEnv();
  const baseUrl = env.CYBOZU_BASE_URL || "";
  const isReal = baseUrl && !/xxx\.cybozu\.com/.test(baseUrl);
  if (!isReal) {
    console.log("[live] スキップ: local-test/.env が実ドメイン未設定（xxx.cybozu.com）。");
    console.log("       実ドメインのテスト環境を設定し、SMOKE_APP_ID=<appId> を指定すると records 等を検証します。");
    return;
  }
  console.log(`[live] 実ドメイン検証: ${baseUrl}`);

  const index = runCli(["pull", "index"]);
  expect("pull index は exit 0", index.status === 0, `status=${index.status}\n${index.stderr}`);

  // 操作制限: records は local-test/.env の KINT_ORIGIN_ALLOW_PULL_RECORDS=true がないと拒否されるためスキップする。
  if (String(env.KINT_ORIGIN_ALLOW_PULL_RECORDS || "").trim().toLowerCase() !== "true") {
    console.log("[live] records・添付はスキップ: local-test/.env に KINT_ORIGIN_ALLOW_PULL_RECORDS=true が未設定。");
    return;
  }

  const appId = process.env.SMOKE_APP_ID;
  if (!appId) {
    console.log("[live] records はスキップ: 環境変数 SMOKE_APP_ID 未指定。");
  } else {
    const guest = process.env.SMOKE_GUESTSPACE_ID ? ["--guestspace", process.env.SMOKE_GUESTSPACE_ID] : [];
    const rec = runCli(["pull", "records", "--id", String(appId), ...guest, "-y"]);
    expect("pull records -y は exit 0", rec.status === 0, `status=${rec.status}\n${rec.stderr}`);
    try {
      const summary = JSON.parse(rec.stdout);
      const outFile = summary.outFile;
      expect("records 出力ファイルが存在", outFile && fs.existsSync(outFile), `outFile=${outFile}`);
      if (outFile && fs.existsSync(outFile)) {
        const head = fs.readFileSync(outFile);
        const hasBom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
        expect("records.csv は UTF-8 BOM 始まり", hasBom, `先頭バイト=${head.slice(0, 3).toString("hex")}`);
      }
    } catch (e) {
      ng("records の JSON サマリを解析", `${e}\nstdout=${rec.stdout}`);
    }
  }

  // 添付ファイル検証（SMOKE_ATTACHMENT_APP_ID 指定時のみ）
  const attachAppId = process.env.SMOKE_ATTACHMENT_APP_ID;
  if (!attachAppId) {
    console.log("[live] records --attachments はスキップ: 環境変数 SMOKE_ATTACHMENT_APP_ID 未指定。");
    return;
  }
  const guest2 = process.env.SMOKE_ATTACHMENT_GUESTSPACE_ID ? ["--guestspace", process.env.SMOKE_ATTACHMENT_GUESTSPACE_ID] : [];
  const rec2 = runCli(["pull", "records", "--id", String(attachAppId), ...guest2, "--attachments", "-y"]);
  expect("pull records --attachments -y は exit 0", rec2.status === 0, `status=${rec2.status}\n${rec2.stderr}`);
  try {
    const summary = JSON.parse(rec2.stdout);
    const attachmentsDir = path.join(path.dirname(summary.outFile), "attachments");
    expect("attachments ディレクトリが生成", fs.existsSync(attachmentsDir), `dir=${attachmentsDir}`);
    if (fs.existsSync(attachmentsDir)) {
      // attachments/<recordId>/<fieldCode>/<file> の3階層にファイルが1つ以上あること
      let found = 0;
      for (const recId of fs.readdirSync(attachmentsDir)) {
        const recDir = path.join(attachmentsDir, recId);
        if (!fs.statSync(recDir).isDirectory()) continue;
        for (const field of fs.readdirSync(recDir)) {
          const fieldDir = path.join(recDir, field);
          if (fs.statSync(fieldDir).isDirectory()) found += fs.readdirSync(fieldDir).length;
        }
      }
      expect("attachments/<recordId>/<fieldCode>/ にファイルが存在", found > 0, `見つかったファイル数=${found}`);
    }
  } catch (e) {
    ng("records --attachments の JSON サマリを解析", `${e}\nstdout=${rec2.stdout}`);
  }
}

// ---- 2b. push ライブ E2E（実ドメイン＋SMOKE_PUSH_LIVE=1 のときのみ） --------
// 新規アプリ作成 → ルックアップ依存アプリ作成 → 作成アプリの変更 push を実 API で検証する。
// 注: kintone にアプリ削除 API は無いため、作成したアプリ（smoke-*）はテストドメインに残る。
//     不要になったら kintone の画面から手動削除すること。
function pushLiveTests() {
  const env = readEnv();
  const baseUrl = env.CYBOZU_BASE_URL || "";
  const isReal = baseUrl && !/xxx\.cybozu\.com/.test(baseUrl);
  if (!isReal || process.env.SMOKE_PUSH_LIVE !== "1") {
    console.log("[live] push E2E はスキップ: SMOKE_PUSH_LIVE=1 未指定（実ドメイン設定時のみ・作成アプリはドメインに残る）。");
    return;
  }
  const allowTrue = (key) => String(env[key] || "").trim().toLowerCase() === "true";
  if (!allowTrue("KINT_ORIGIN_ALLOW_PUSH_APP")) {
    console.log("[live] push E2E はスキップ: local-test/.env に KINT_ORIGIN_ALLOW_PUSH_APP=true が未設定。");
    return;
  }
  console.log(`[live] push E2E: ${baseUrl}`);

  const ts = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const nameA = `smoke-a-${ts}`;
  const nameB = `smoke-b-${ts}`;
  const draftsRoot = path.join(SANDBOX, "push", "new-apps");

  const writeDraft = (name, fieldsProperties) => {
    const dir = path.join(draftsRoot, name);
    fs.mkdirSync(path.join(dir, "form"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app.json"), JSON.stringify({ name }, null, 2) + "\n", "utf8");
    fs.writeFileSync(
      path.join(dir, "form", "fields.json"),
      JSON.stringify({ properties: fieldsProperties, revision: "-" }, null, 2) + "\n",
      "utf8"
    );
    return dir;
  };
  const parseSummary = (label, r) => {
    try {
      return JSON.parse(r.stdout);
    } catch (e) {
      ng(`${label} の JSON サマリを解析`, `${e}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
      return null;
    }
  };
  const pulledAppDir = (appId) => path.join(SANDBOX, "data", "kintone", "apps", `app-${appId}`);

  // ① 新規アプリ A（ルックアップ先。キー項目は重複禁止）
  const dirA = writeDraft(nameA, {
    会社名: { type: "SINGLE_LINE_TEXT", code: "会社名", label: "会社名", required: true, unique: true },
    備考: { type: "MULTI_LINE_TEXT", code: "備考", label: "備考" }
  });
  const createA = runCli(["push", "create", "--name", nameA, "-y"]);
  expect("E2E①: push create A は exit 0", createA.status === 0, `status=${createA.status}\n${createA.stderr}`);
  const summaryA = parseSummary("push create A", createA);
  const appIdA = summaryA?.created?.[0]?.appId || "";
  expect("E2E①: A の appId が返る", /^\d+$/.test(appIdA), JSON.stringify(summaryA?.created));
  expect("E2E①: A の created.json を書く", fs.existsSync(path.join(dirA, "created.json")), "created.json missing");
  expect("E2E①: deploy まで完了", summaryA?.deployed === true, JSON.stringify(summaryA));
  if (appIdA) {
    expect("E2E①: 検証 pull で data/ に A が生成", fs.existsSync(path.join(pulledAppDir(appIdA), "form", "fields.json")), pulledAppDir(appIdA));
    const indexJson = fs.readFileSync(path.join(SANDBOX, "data", "kintone", "index", "apps.json"), "utf8");
    expect("E2E①: 索引に A が登録", indexJson.includes(`"appId": "${appIdA}"`), `appId=${appIdA}`);
  }

  // ② A を {{app:名前}} で参照するルックアップ入りアプリ B
  writeDraft(nameB, {
    顧客名: {
      type: "SINGLE_LINE_TEXT",
      code: "顧客名",
      label: "顧客名",
      lookup: {
        relatedApp: { app: `{{app:${nameA}}}` },
        relatedKeyField: "会社名",
        fieldMappings: [],
        lookupPickerFields: ["会社名"],
        filterCond: "",
        // 注: 組み込みフィールドのコードは API ユーザーの表示言語で決まる（日本語なら「レコード番号」）。ドラフトでは、自分で追加したフィールドのコードを使う。
        sort: "会社名 asc"
      }
    },
    金額: { type: "NUMBER", code: "金額", label: "金額" }
  });
  const createB = runCli(["push", "create", "--name", nameB, "-y"]);
  expect("E2E②: push create B（ルックアップ依存）は exit 0", createB.status === 0, `status=${createB.status}\n${createB.stderr}`);
  const summaryB = parseSummary("push create B", createB);
  const appIdB = summaryB?.created?.[0]?.appId || "";
  expect("E2E②: B の appId が返る", /^\d+$/.test(appIdB), JSON.stringify(summaryB?.created));
  if (appIdB) {
    const bFieldsPath = path.join(pulledAppDir(appIdB), "form", "fields.json");
    expect("E2E②: 検証 pull で data/ に B が生成", fs.existsSync(bFieldsPath), bFieldsPath);
    if (fs.existsSync(bFieldsPath)) {
      const bFields = JSON.parse(fs.readFileSync(bFieldsPath, "utf8"));
      const relatedApp = bFields?.properties?.["顧客名"]?.lookup?.relatedApp?.app || "";
      expect("E2E②: B のルックアップ参照先が A の実 appId に解決", String(relatedApp) === String(appIdA), `relatedApp=${relatedApp} expected=${appIdA}`);
    }
  }

  // ③ 作成した A の data/ を Git 基準として保存したうえで直接編集し、diff app / push app（設定変更＋フィールド追加）
  if (appIdA) {
    const aDir = pulledAppDir(appIdA);
    if (!fs.existsSync(path.join(SANDBOX, ".git"))) {
      initGitWithDataSnapshot(SANDBOX, `smoke push create A baseline ${ts}`);
    } else {
      git(SANDBOX, ["add", "--", path.relative(SANDBOX, aDir)]);
      git(SANDBOX, ["commit", "-q", "-m", `smoke push create A baseline ${ts}`]);
    }
    const settings = JSON.parse(fs.readFileSync(path.join(aDir, "app_settings", "settings.json"), "utf8"));
    settings.description = `smoke push app 検証 ${ts}`;
    fs.writeFileSync(path.join(aDir, "app_settings", "settings.json"), JSON.stringify(settings, null, 2) + "\n", "utf8");
    const fields = JSON.parse(fs.readFileSync(path.join(aDir, "form", "fields.json"), "utf8"));
    fields.properties["追加項目"] = { type: "SINGLE_LINE_TEXT", code: "追加項目", label: "追加項目" };
    fs.writeFileSync(path.join(aDir, "form", "fields.json"), JSON.stringify(fields, null, 2) + "\n", "utf8");

    const diffA = runCli(["diff", "app", "--id", appIdA]);
    expect("E2E③: diff app はローカル変更（settings・fields）を検出", diffA.status === 0 && diffA.stderr.includes("ローカル変更（push 対象）") && diffA.stderr.includes("fields"), `status=${diffA.status}\n${diffA.stderr}`);
    const pushA = runCli(["push", "app", "--id", appIdA, "-y"]);
    expect("E2E③: push app（変更反映）は exit 0", pushA.status === 0, `status=${pushA.status}\n${pushA.stderr}`);
    const summaryPush = parseSummary("push app A", pushA);
    expect("E2E③: フィールド追加が add に振り分け", (summaryPush?.fieldsAdded ?? 0) >= 1, JSON.stringify(summaryPush));
    expect("E2E③: deploy まで完了", summaryPush?.status === "deployed" && summaryPush?.deployed === true, JSON.stringify(summaryPush));
    const pullAfter = runCli(["pull", "app", "--id", appIdA, "--discard-local"]);
    expect("E2E③: 反映後の pull app が成功", pullAfter.status === 0, `status=${pullAfter.status}\n${pullAfter.stderr}`);
    const pulledSettings = JSON.parse(fs.readFileSync(path.join(aDir, "app_settings", "settings.json"), "utf8"));
    expect("E2E③: 反映後の settings に変更が反映", pulledSettings.description === settings.description, pulledSettings.description);
    const pulledFields = JSON.parse(fs.readFileSync(path.join(aDir, "form", "fields.json"), "utf8"));
    expect("E2E③: 反映後の fields に追加フィールドが存在", Boolean(pulledFields.properties?.["追加項目"]), Object.keys(pulledFields.properties || {}).join(","));
  }

  console.log(`[live] push E2E 完了。作成アプリ（app-${appIdA} / app-${appIdB}）はテストドメインに残ります。不要なら kintone の画面から削除してください。`);
}

// ---- 1i. html（静的HTMLビューア生成・オフライン） -------------------------
function htmlTests() {
  console.log("[offline] html（静的HTMLビューア生成）");

  const help = runCli(["help"]);
  expect("help に html [--open] を含む", help.stdout.includes("html [--open]"), help.stdout);

  // ハーネス内で組み立てた最小フィクスチャで一時サンドボックスを組む（local-test の取得データに依存しない）。
  const APP588_NAME = "顧客管理（スモーク）";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-html-"));
  try {
    const dataRoot = path.join(tmp, "data", "kintone");
    const appMeta = (appId, name, spaceId, type) => ({ exportedAt: "-", domain: "smoke.example", appId, code: "", name, spaceId, guestSpaceId: "", type });

    // 通常アプリ app-588: 1行文字列フィールド（フィールドコードと日本語型ラベルの検証用）。索引も置いて読み込み経路を通す。
    writeJsonFile(path.join(dataRoot, "index", "apps.json"), [
      { appId: "588", code: "", name: APP588_NAME, spaceId: "", guestSpaceId: "", modifiedAt: "2026-01-01T00:00:00Z" }
    ]);
    writeJsonFile(path.join(dataRoot, "apps", "app-588", "app.json"), appMeta("588", APP588_NAME, "", "domain-app"));
    writeJsonFile(path.join(dataRoot, "apps", "app-588", "form", "fields.json"), {
      revision: "-",
      properties: { 会社名: { type: "SINGLE_LINE_TEXT", code: "会社名", label: "会社名" } }
    });

    // space-40 配下の app-537: FILE フィールド＋records.csv＋添付実体（添付リンク生成の CSV セル→実体突合を検証可能にする）。
    const space40 = path.join(dataRoot, "spaces", "space-40");
    writeJsonFile(path.join(space40, "space.json"), { id: "40", name: "スモーク用スペース", isPrivate: false, body: "<p>お知らせ</p>" });
    writeJsonFile(path.join(space40, "settings.json"), { name: "スモーク用スペース", isPrivate: false });
    fs.writeFileSync(path.join(space40, "body.html"), "<p>お知らせ</p>\n", "utf8");
    const app537 = path.join(space40, "apps", "app-537");
    writeJsonFile(path.join(app537, "app.json"), appMeta("537", "提案管理（スモーク）", "40", "space-app"));
    writeJsonFile(path.join(app537, "form", "fields.json"), {
      revision: "-",
      properties: {
        レコード番号: { type: "RECORD_NUMBER", code: "レコード番号", label: "レコード番号" },
        File: { type: "FILE", code: "File", label: "File" }
      }
    });
    const attachmentDir = path.join(app537, "records", "attachments", "1", "File");
    fs.mkdirSync(attachmentDir, { recursive: true });
    fs.writeFileSync(path.join(app537, "records", "records.csv"), '﻿"レコード番号","File"\n"1","提案書.pptx"\n', "utf8");
    fs.writeFileSync(path.join(attachmentDir, "提案書.pptx"), "dummy attachment for smoke test\n", "utf8");

    // XSS フィクスチャ: アプリ名に <script> を含む。
    const app901 = path.join(dataRoot, "apps", "app-901");
    fs.mkdirSync(app901, { recursive: true });
    fs.writeFileSync(
      path.join(app901, "app.json"),
      JSON.stringify({ exportedAt: "-", domain: "smoke.example", appId: "901", code: "", name: "<script>alert(1)</script>アプリ", spaceId: "", guestSpaceId: "", type: "domain-app" }, null, 2) + "\n",
      "utf8"
    );

    // 取得エラーフィクスチャ: views.json が {"_error": ...}。
    const app902 = path.join(dataRoot, "apps", "app-902");
    fs.mkdirSync(path.join(app902, "views"), { recursive: true });
    fs.writeFileSync(
      path.join(app902, "app.json"),
      JSON.stringify({ exportedAt: "-", domain: "smoke.example", appId: "902", code: "", name: "エラー検証", spaceId: "", guestSpaceId: "", type: "domain-app" }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(app902, "views", "views.json"), JSON.stringify({ _error: "403 権限がありません" }, null, 2) + "\n", "utf8");

    // 削除済みフィクスチャ。
    const app903 = path.join(tmp, "data", "kintone", "deleted", "apps", "app-903");
    fs.mkdirSync(app903, { recursive: true });
    fs.writeFileSync(
      path.join(app903, "app.json"),
      JSON.stringify({ exportedAt: "-", domain: "smoke.example", appId: "903", code: "", name: "削除済みアプリ", spaceId: "", guestSpaceId: "", type: "domain-app" }, null, 2) + "\n",
      "utf8"
    );

    const first = runCli(["html"], tmp);
    expect("html は exit 0", first.status === 0, `status=${first.status}\n${first.stderr}`);
    let summary;
    try {
      summary = JSON.parse(first.stdout);
    } catch {
      summary = undefined;
    }
    expect("html の stdout は JSON サマリ", Boolean(summary?.outDir && summary?.pages > 0), first.stdout);

    const indexHtml = fs.readFileSync(path.join(tmp, "html", "index.html"), "utf8");
    const app588Name = APP588_NAME;
    expect("index.html にアプリ名を含む", indexHtml.includes(app588Name), app588Name);
    expect("index.html に app-588 ページへの href を含む", indexHtml.includes('href="apps/app-588.html"'), "href=apps/app-588.html");
    expect("index.html に削除済みバッジを含む", indexHtml.includes("削除済み"), indexHtml.slice(0, 500));
    expect(
      "index.html にアプリ設定画面への歯車リンクを含む",
      indexHtml.includes("/k/admin/app/flow?app=901#section=form"),
      "admin/app/flow link for app-901"
    );
    expect("削除済みアプリには設定画面リンクを付けない", !indexHtml.includes("app=903#section=form"), "admin link for deleted app-903");

    const app588Html = fs.readFileSync(path.join(tmp, "html", "apps", "app-588.html"), "utf8");
    expect("アプリページにフィールドコードを含む", app588Html.includes("会社名"), "会社名");
    expect("アプリページに日本語型ラベルを含む", app588Html.includes("文字列（1行）"), "文字列（1行）");

    const app901Html = fs.readFileSync(path.join(tmp, "html", "apps", "app-901.html"), "utf8");
    expect("XSS: script タグはエスケープされる", app901Html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), app901Html.slice(0, 800));
    expect("XSS: 生の <script>alert を含まない", !app901Html.includes("<script>alert"), "raw script tag found");

    const app902Html = fs.readFileSync(path.join(tmp, "html", "apps", "app-902.html"), "utf8");
    expect("_error は取得エラー表示になる", app902Html.includes("取得エラー") && app902Html.includes("403 権限がありません"), app902Html.slice(0, 800));

    const app537Html = fs.readFileSync(path.join(tmp, "html", "apps", "app-537.html"), "utf8");
    const encodedName = encodeURIComponent("提案書.pptx");
    expect("添付ファイルへの percent-encoded リンクを含む", app537Html.includes(encodedName), encodedName);
    const recordsJsPath = path.join(tmp, "html", "apps", "app-537.records.js");
    expect("records.csv ありアプリに records.js が生成される", fs.existsSync(recordsJsPath), recordsJsPath);
    const recordsJs = fs.readFileSync(recordsJsPath, "utf8");
    expect("records.js は window.__kintRecords 呼び出し", recordsJs.startsWith("window.__kintRecords("), recordsJs.slice(0, 60));
    expect("records.js に生の < を含まない（\\u003c エスケープ）", !recordsJs.includes("<"), "raw < found");
    expect("records.js に添付 href を含む", recordsJs.includes(encodedName), encodedName);

    const space40Html = fs.readFileSync(path.join(tmp, "html", "spaces", "space-40.html"), "utf8");
    expect("スペースページが app-537 へリンクする", space40Html.includes("app-537.html"), "app-537.html link");
    expect("スペースページが body.html と settings.json を参照する", space40Html.includes("body.html") && space40Html.includes("settings.json"), space40Html.slice(0, 800));

    // フル再生成: 前回生成物（ダミー）は消える。
    fs.writeFileSync(path.join(tmp, "html", "apps", "app-99999.html"), "dummy", "utf8");
    const second = runCli(["html"], tmp);
    expect("html 再実行は exit 0", second.status === 0, `status=${second.status}\n${second.stderr}`);
    expect("再実行でダミーページが消える（フル再生成）", !fs.existsSync(path.join(tmp, "html", "apps", "app-99999.html")), "dummy survived");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // data/ が無い cwd でも exit 0 で案内ページを生成する。
  const emptyTmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-html-empty-"));
  try {
    const empty = runCli(["html"], emptyTmp);
    expect("data 無しでも exit 0", empty.status === 0, `status=${empty.status}\n${empty.stderr}`);
    const indexHtml = fs.readFileSync(path.join(emptyTmp, "html", "index.html"), "utf8");
    expect("data 無しの index.html は pull kintone を案内", indexHtml.includes("pull kintone"), indexHtml.slice(0, 500));
  } finally {
    fs.rmSync(emptyTmp, { recursive: true, force: true });
  }

  // 生成物でない html/ は誤削除防止のため上書きしない。
  const foreignTmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-html-foreign-"));
  try {
    fs.mkdirSync(path.join(foreignTmp, "html"), { recursive: true });
    fs.writeFileSync(path.join(foreignTmp, "html", "user-file.txt"), "keep me", "utf8");
    const guarded = runCli(["html"], foreignTmp);
    expect("生成物でない html/ は exit 1 で保護", guarded.status === 1, `status=${guarded.status}`);
    expect("保護時は日本語メッセージを表示", guarded.stderr.includes("上書きしません"), guarded.stderr);
    expect("既存ファイルは残る", fs.existsSync(path.join(foreignTmp, "html", "user-file.txt")), "user file deleted");
  } finally {
    fs.rmSync(foreignTmp, { recursive: true, force: true });
  }
}

// ---- 1s. レコード操作ジョブ（オフライン・純関数） --------------------------
// job.csv の解析。API もファイルも触らない。
async function recordJobTests() {
  console.log("[offline] レコード操作ジョブ: job.csv の解析（構文・行番号・ジョブ名）");

  const modUrl = (...p) => pathToFileURL(path.join(ROOT, "dist", ...p)).href;
  const job = await import(modUrl("kintone", "recordJob.js"));

  // フィールド記法
  const plain = job.parseFieldPath("資料");
  expect("job: フィールド記法（通常のコード）", plain?.code === "資料" && !plain.table && !plain.row, JSON.stringify(plain));
  const cell = job.parseFieldPath("明細[5039].金額");
  expect("job: フィールド記法（既存の行 ID のセル）", cell?.table === "明細" && cell.code === "金額" && cell.row?.kind === "id" && cell.row.id === "5039", JSON.stringify(cell));
  const newCell = job.parseFieldPath("明細[new:r1].金額");
  expect("job: フィールド記法（新しい行 new:キー のセル）", newCell?.row?.kind === "new" && newCell.row.key === "r1", JSON.stringify(newCell));
  expect(
    "job: フィールド記法の不正（行 ID が数字でない・ドット・空・セル名なし）は null",
    ["明細[x].金額", "a.b", "", "明細[1]", "明細[new:].金額"].every((raw) => job.parseFieldPath(raw) === null),
    ""
  );

  // 正常系（雛形 _example と同じ構成）
  const HEADER = "op,from_app,from_record,from_field,to_app,to_record,to_field,mode,value,note";
  const EXAMPLE = [
    HEADER,
    "copy,303,12,添付資料,450,7,資料,append,,旧アプリの添付を追記",
    "copy,303,12,顧客名,450,7,取引先名,,,値の転記",
    "set,,,,450,7,移行状況,,移行済,固定値",
    "clear,,,,450,8,資料,,,添付をすべて外す",
    "copy,303,15,添付資料,450,new:a,資料,,,新規レコード a に添付",
    "set,,,,450,new:a,取引先名,,株式会社サンプル,新規レコード a の値",
    "copy,303,12,明細[5039].金額,450,7,明細[new:r1].金額,,,テーブルに行を追加",
    "set,,,,450,7,明細[5040].備考,,確認済,既存の行を更新"
  ];
  const parsed = job.parseJobCsv(EXAMPLE.join("\n"));
  expect("job: 正常な 8 行は issues 0 件・rows 8 件", parsed.issues.length === 0 && parsed.rows.length === 8, JSON.stringify(parsed.issues));
  const [r0, , r2, , r4] = parsed.rows;
  expect(
    "job: 行の内容（copy の from/to/mode、set の value、new: のレコード参照、行番号）",
    r0.op === "copy" && r0.from?.app === "303" && r0.from.record === "12" && r0.mode === "append" && r0.line === 2 &&
      r2.op === "set" && r2.value === "移行済" && r4.to.record.kind === "new" && r4.to.record.key === "a",
    JSON.stringify([r0, r2, r4])
  );
  const withBom = job.parseJobCsv("\ufeff" + EXAMPLE.join("\r\n") + "\r\n");
  expect("job: BOM と CRLF でも同じ結果", withBom.issues.length === 0 && withBom.rows.length === 8, JSON.stringify(withBom.issues));
  const withComment = job.parseJobCsv([EXAMPLE[0], "# メモ", "", ...EXAMPLE.slice(1)].join("\n"));
  expect("job: # で始まる op の行と空行は無視", withComment.issues.length === 0 && withComment.rows.length === 8, JSON.stringify(withComment.issues));
  const trimmed = job.parseJobCsv([HEADER, "set,,,,450,7,メモ,,  前後に空白  ,"].join("\n"));
  expect("job: value は前後の空白を保つ", trimmed.rows[0]?.value === "  前後に空白  ", JSON.stringify(trimmed.rows));

  // 異常系: 行番号（ヘッダーが 1、最初のデータ行が 2）と原因が出る
  const bad = (name, line, keyword) => {
    const result = job.parseJobCsv([HEADER, line].join("\n"));
    expect(
      name,
      result.issues.some((issue) => issue.message.includes(keyword) && issue.lines[0] === 2) && result.rows.length === 0,
      JSON.stringify(result.issues)
    );
  };
  bad("job: op が copy / set / clear 以外", "move,,,,450,7,x,,,", "op は");
  bad("job: copy で from_field が空", "copy,303,12,,450,7,資料,,,", "copy には");
  bad("job: set で value が空", "set,,,,450,7,x,,,", "set には value");
  bad("job: clear で value がある", "clear,,,,450,7,x,,abc,", "clear では value");
  bad("job: clear で mode がある", "clear,,,,450,7,x,append,,", "clear では mode");
  bad("job: to_record が数字でも new: でもない", "set,,,,450,12a,x,,v,", "to_record");
  bad("job: to_app が数字でない", "set,,,,x,7,x,,v,", "to_app");
  bad("job: mode が append / replace 以外", "copy,303,12,a,450,7,b,both,,", "mode は");
  bad("job: 新規レコードのテーブルに既存の行 ID", "set,,,,450,new:a,明細[5039].備考,,x,", "新規レコード");
  bad("job: set に from_* がある", "set,303,,,450,7,x,,v,", "from_* を空");
  bad("job: copy に value がある", "copy,303,12,a,450,7,b,,v,", "copy では value");
  bad("job: from_record に new: は指定できない", "copy,303,new:a,a,450,7,b,,,", "from_record");
  bad("job: from_field に new: の行は指定できない", "copy,303,12,明細[new:r1].金額,450,7,b,,,", "from_field");
  bad("job: to_field の記法が不正", "set,,,,450,7,a.b,,v,", "to_field");
  bad("job: 列数がヘッダーと違う", "set,,,,450,7,x", "列数");
  const missingHeader = job.parseJobCsv("op,to_app\nset,1\n");
  expect("job: 必須列の欠落はヘッダーの問題として報告", missingHeader.issues.some((i) => i.message.includes("必須列がありません") && i.lines[0] === 1), JSON.stringify(missingHeader.issues));
  const unknownHeader = job.parseJobCsv(HEADER + ",extra\n");
  expect("job: 不明な列は使える列を案内", unknownHeader.issues.some((i) => i.message.includes("不明な列") && i.message.includes("note")), JSON.stringify(unknownHeader.issues));
  expect("job: 空のファイルは問題として報告", job.parseJobCsv("").issues.some((i) => i.message.includes("空")), "");
  expect("job: ヘッダーだけで操作の行が無いと問題", job.parseJobCsv(HEADER + "\n").issues.some((i) => i.message.includes("操作の行がありません")), "");

  // ジョブ名・キー・問題の整形
  const nameOk = ["添付移行", "job-1"].every((n) => { try { job.validateJobName(n); return true; } catch { return false; } });
  const backslashName = "a" + String.fromCharCode(92) + "b";
  const nameBad = ["", "_example", ".x", "a/b", "a..b", "../x", " x", backslashName].every((n) => { try { job.validateJobName(n); return false; } catch (e) { return String(e.message).includes("ジョブ名が不正"); } });
  expect("job: ジョブ名は通常の名前だけ許し、空・_ や . 始まり・区切り文字・.. は拒否", nameOk && nameBad, `ok=${nameOk} bad=${nameBad}`);
  expect("job: recordKey / cellKey", job.recordKey("450", { kind: "new", key: "a" }) === "450|new:a" && job.cellKey(r4) === "450|new:a|資料", `${job.cellKey(r4)}`);
  const text = job.formatIssues("添付移行", [{ lines: [7], message: "b" }, { lines: [3, 5], message: "a" }, { lines: [], message: "c" }]);
  expect("job: 問題の整形（件数・行番号の昇順・「何も変更していません」）", text.includes("3 件") && text.includes("何も変更していません") && text.indexOf("行 3, 5: a") < text.indexOf("行 7: b"), text);
  const many = job.formatIssues("x", Array.from({ length: 60 }, (_, i) => ({ lines: [i + 2], message: "m" })));
  expect("job: 問題が 50 件を超えたら件数で省略", many.includes("…ほか 10 件") && many.split("\n").length === 52, many);
}

// ---- 1s2. レコード操作の値（オフライン・純関数） ---------------------------
// スキーマ索引・書き込み可否・値の解釈・型変換・表示。
async function recordValuesTests() {
  console.log("[offline] レコード操作の値: スキーマ索引・書き込み可否・値の解釈・型変換");

  const values = await import(pathToFileURL(path.join(ROOT, "dist", "kintone", "recordValues.js")).href);
  const field = (type, code, extra = {}) => ({ type, code, label: code, ...extra });
  const properties = {
    取引先名: field("SINGLE_LINE_TEXT", "取引先名", { required: true, defaultValue: "" }),
    メモ: field("MULTI_LINE_TEXT", "メモ"),
    金額: field("NUMBER", "金額"),
    開始日: field("DATE", "開始日"),
    状態: field("DROP_DOWN", "状態", { options: { 未着手: { label: "未着手", index: "0" }, 完了: { label: "完了", index: "1" } } }),
    区分: field("RADIO_BUTTON", "区分", { required: true, defaultValue: "A", options: { A: { label: "A", index: "0" }, B: { label: "B", index: "1" } } }),
    タグ: field("CHECK_BOX", "タグ", { options: { x: { label: "x", index: "0" }, y: { label: "y", index: "1" } } }),
    複数: field("MULTI_SELECT", "複数", { options: { x: { label: "x", index: "0" }, z: { label: "z", index: "1" } } }),
    担当: field("USER_SELECT", "担当"),
    作成者: field("CREATOR", "作成者"),
    合計: field("CALC", "合計", { expression: "a+b" }),
    番号: field("RECORD_NUMBER", "番号"),
    自動: field("SINGLE_LINE_TEXT", "自動", { expression: "A&B" }),
    顧客コード: field("SINGLE_LINE_TEXT", "顧客コード", { lookup: { fieldMappings: [{ field: "顧客名", relatedField: "名" }] } }),
    顧客名: field("SINGLE_LINE_TEXT", "顧客名"),
    資料: field("FILE", "資料"),
    明細: field("SUBTABLE", "明細", { fields: { 明細金額: field("NUMBER", "明細金額"), 備考: field("SINGLE_LINE_TEXT", "備考") } })
  };
  const schema = values.buildSchemaIndex(properties);
  const f = (code) => schema.top.get(code);

  expect(
    "values: スキーマ索引（選択肢・ルックアップのコピー先・自動計算・テーブルの内側）",
    f("状態").options.join(",") === "未着手,完了" && f("顧客名").lookupCopyTarget && !f("顧客コード").lookupCopyTarget &&
      f("自動").autoCalc && !f("取引先名").autoCalc && f("明細").fields.size === 2 && schema.inner.get("備考")?.table === "明細" && f("取引先名").required,
    ""
  );
  expect("values: resolveField（通常・テーブルのセル）", values.resolveField(schema, { raw: "資料", code: "資料" }, "450") === f("資料") && values.resolveField(schema, { raw: "明細[1].備考", code: "備考", table: "明細", row: { kind: "id", id: "1" } }, "450") === schema.inner.get("備考"), "");
  const missing = values.resolveField(schema, { raw: "x", code: "x" }, "450");
  const missingCell = values.resolveField(schema, { raw: "明細[1].x", code: "x", table: "明細", row: { kind: "id", id: "1" } }, "450");
  const notTable = values.resolveField(schema, { raw: "資料[1].x", code: "x", table: "資料", row: { kind: "id", id: "1" } }, "450");
  expect(
    "values: resolveField の不在・テーブルでない・内側に無い場合はエラー文（app を含む）",
    [missing, missingCell, notTable].every((m) => typeof m === "string" && m.includes("app 450")) && missing.includes("がありません") && notTable.includes("テーブルではありません"),
    JSON.stringify([missing, missingCell, notTable])
  );

  // 書き込み可否
  const wr = (code, isNew = false) => values.writableError(f(code), { isNew });
  expect("values: 計算・レコード番号は書き込めない", wr("合計")?.includes("書き込めません") && wr("番号")?.includes("書き込めません"), `${wr("合計")}`);
  expect("values: ルックアップのコピー先・自動計算の文字列は書き込めない", wr("顧客名")?.includes("ルックアップのコピー先") && wr("自動")?.includes("自動計算"), `${wr("顧客名")} / ${wr("自動")}`);
  expect("values: 作成者は既存レコードには書けず、新規レコードには書ける", wr("作成者")?.includes("new:") && wr("作成者", true) === null, `${wr("作成者")}`);
  expect("values: 通常の型・添付・テーブルは書き込める", ["取引先名", "資料", "明細", "状態"].every((c) => wr(c) === null), "");

  // set の値
  const set = (code, raw) => values.parseSetValue(f(code), raw);
  expect("values: 数値は 1.5 を受け付け、1,5 は拒否", set("金額", "1.5").value === "1.5" && "error" in set("金額", "1,5"), JSON.stringify(set("金額", "1,5")));
  expect("values: 日付は YYYY-MM-DD だけ", set("開始日", "2026-11-03").value === "2026-11-03" && "error" in set("開始日", "2026/11/03"), "");
  expect("values: ドロップダウンは選択肢だけ（外は選べる値を案内）", set("状態", "完了").value === "完了" && String(set("状態", "不明").error).includes("選べる値"), JSON.stringify(set("状態", "不明")));
  expect("values: チェックボックスは改行区切りで全部が選択肢内", JSON.stringify(set("タグ", "x\ny").value) === '["x","y"]' && "error" in set("タグ", "x\nq"), "");
  expect("values: ユーザー選択は改行区切りのコード", JSON.stringify(set("担当", "a\nb").value) === '[{"code":"a"},{"code":"b"}]', "");
  expect("values: 文字列（1行）は改行を拒否、複数行は許す", "error" in set("取引先名", "a\nb") && set("メモ", "a\nb").value === "a\nb", "");
  expect("values: テーブル全体への set は拒否してセル指定を案内", String(set("明細", "x").error).includes("セル"), JSON.stringify(set("明細", "x")));

  // 添付ファイルのパス
  expect("values: 添付のパスは改行区切りの相対パス", values.parseLocalFilePaths("files/a.pdf\nfiles/b.pdf").paths?.length === 2, "");
  const bsPath = "files" + String.fromCharCode(92) + ".." + String.fromCharCode(92) + "x";
  expect(
    "values: 添付のパスに絶対パス・.. は使えない",
    ["../x", "/etc/x", "C:/x", "files/../x", String.fromCharCode(92) + "x", bsPath].every((p) => "error" in values.parseLocalFilePaths(p)),
    ""
  );

  // clear の値
  const clr = (code) => values.clearValue(f(code));
  expect(
    "values: clear の値（配列系は []・日付は null・文字列は 空文字）",
    JSON.stringify(clr("資料").value) === "[]" && JSON.stringify(clr("タグ").value) === "[]" && clr("開始日").value === null && clr("メモ").value === "" && clr("状態").value === "",
    ""
  );
  expect("values: ラジオボタン・必須・計算は clear できない", "error" in clr("区分") && String(clr("取引先名").error).includes("必須") && "error" in clr("合計"), "");
}

// ---- 1s3. コピーの型変換・表示・一括処理の分割（オフライン・純関数） --------
async function recordCopyTests() {
  console.log("[offline] レコード操作: コピーの型変換・表示・一括処理（bulkRequest）の分割");

  const modUrl = (...p) => pathToFileURL(path.join(ROOT, "dist", ...p)).href;
  const values = await import(modUrl("kintone", "recordValues.js"));
  const { bulkify } = await import(modUrl("kintone", "recordPlan.js"));
  const schema = (type, code, extra = {}) => ({ type, code, label: code, required: false, defaultValue: "", options: [], lookupCopyTarget: false, autoCalc: false, ...extra });
  const conv = (src, dst, value) => values.convertCopyValue(src, dst, value);
  const ok = (r) => !("error" in r);

  // 同じ型
  expect("copy: 文字列から文字列は値のまま", conv(schema("SINGLE_LINE_TEXT", "a"), schema("SINGLE_LINE_TEXT", "b"), "あ").value === "あ", "");
  expect(
    "copy: ユーザー選択は code だけにして書き込む",
    JSON.stringify(conv(schema("USER_SELECT", "a"), schema("USER_SELECT", "b"), [{ code: "a", name: "A" }]).value) === JSON.stringify([{ code: "a" }]),
    ""
  );
  expect("copy: 日付が空（null）なら null のまま", conv(schema("DATE", "a"), schema("DATE", "b"), null).value === null, "");

  // 選択肢
  const checkbox = schema("CHECK_BOX", "c", { options: ["x", "y"] });
  const multi = schema("MULTI_SELECT", "m", { options: ["x", "z"] });
  expect("copy: チェックボックスから複数選択へ（選択肢が全部あれば可）", ok(conv(checkbox, multi, ["x"])), "");
  expect("copy: コピー先に無い選択肢はエラー（どの値かを示す）", String(conv(checkbox, multi, ["x", "y"]).error).includes("「y」"), JSON.stringify(conv(checkbox, multi, ["x", "y"])));
  const drop = schema("DROP_DOWN", "d", { options: ["A", "B"] });
  const radio = schema("RADIO_BUTTON", "r", { options: ["A", "B"] });
  expect("copy: ドロップダウンからラジオボタンへ（空はラジオボタンに入れられない）", conv(drop, radio, "A").value === "A" && "error" in conv(drop, radio, null), "");
  expect("copy: 空のドロップダウンは null のまま", conv(drop, drop, null).value === null, "");

  // 文字列への変換
  const recordNumber = schema("RECORD_NUMBER", "n");
  const single = schema("SINGLE_LINE_TEXT", "s");
  const multiline = schema("MULTI_LINE_TEXT", "ml");
  const number = schema("NUMBER", "num");
  expect("copy: レコード番号は文字列へコピーできる", conv(recordNumber, single, "APP-12").value === "APP-12", "");
  expect("copy: レコード番号は数値へ（数字だけなら可、APP-12 は不可）", conv(recordNumber, number, "12").value === "12" && String(conv(recordNumber, number, "APP-12").error).includes("数値として扱えない"), "");
  expect("copy: 複数行の値は 1 行文字列へコピーできない", String(conv(multiline, single, "a\nb").error).includes("複数行"), "");
  const people = [{ code: "a", name: "Aさん" }, { code: "b", name: "Bさん" }];
  expect(
    "copy: ユーザー選択は表示名を連結して文字列へ（1 行は カンマ区切り、複数行は改行）",
    conv(schema("USER_SELECT", "u"), single, people).value === "Aさん, Bさん" && conv(schema("USER_SELECT", "u"), multiline, people).value === "Aさん\nBさん",
    ""
  );

  // コピーできない組み合わせ
  expect("copy: 日付から数値へはコピーできない", String(values.copyTypeError(schema("DATE", "d"), number)).includes("コピーできません"), "");
  expect("copy: 文字列から添付・テーブルへはコピーできない", values.copyTypeError(single, schema("FILE", "f")) !== null && values.copyTypeError(single, schema("SUBTABLE", "t")) !== null, "");
  expect("copy: 添付どうし・テーブルどうしは型としてはコピーできる", values.copyTypeError(schema("FILE", "a"), schema("FILE", "b")) === null && values.copyTypeError(schema("SUBTABLE", "a"), schema("SUBTABLE", "b")) === null, "");
  expect("copy: 添付とテーブルの値は convertCopyValue では扱わない（専用の処理）", "error" in conv(schema("FILE", "a"), schema("FILE", "b"), []) && "error" in conv(schema("SUBTABLE", "a"), schema("SUBTABLE", "b"), []), "");

  // 表示・出力
  const labelField = schema("CHECK_BOX", "c");
  expect("display: 配列は順序に依存しない", values.displayValue(labelField, ["b", "a"]) === values.displayValue(labelField, ["a", "b"]) && values.displayValue(labelField, ["b", "a"]) === "a\nb", "");
  expect("display: ユーザーは code・添付は名前・null は空・テーブルは行数", values.displayValue(schema("USER_SELECT", "u"), people) === "a\nb" && values.displayValue(schema("FILE", "f"), [{ name: "x.pdf", fileKey: "k" }]) === "x.pdf" && values.displayValue(undefined, null) === "" && values.displayValue(schema("SUBTABLE", "t"), [{}, {}]) === "(2 行)", "");
  const shownFile = values.normalizeForShow(schema("FILE", "f"), [{ name: "a.pdf", size: "10", contentType: "application/pdf", fileKey: "SECRET" }]);
  expect("show: 添付は名前・サイズ・型だけで fileKey を出さない", JSON.stringify(shownFile).includes("a.pdf") && !JSON.stringify(shownFile).includes("SECRET"), JSON.stringify(shownFile));
  const table = schema("SUBTABLE", "t", { fields: new Map([["金額", schema("NUMBER", "金額")]]) });
  const shownTable = values.normalizeForShow(table, [{ id: "5039", value: { 金額: { type: "NUMBER", value: "100" } } }]);
  expect("show: テーブルは行 ID 付きで内側の値を並べる", JSON.stringify(shownTable) === JSON.stringify([{ id: "5039", 金額: "100" }]), JSON.stringify(shownTable));
  expect("values: 既定値の有無（空文字・空配列・null は無し）", !values.hasDefaultValue(schema("SINGLE_LINE_TEXT", "a")) && !values.hasDefaultValue(schema("CHECK_BOX", "b", { defaultValue: [] })) && values.hasDefaultValue(schema("RADIO_BUTTON", "c", { defaultValue: "A" })), "");

  // 一括処理の分割
  const upd = (app, id, guest = "") => ({ app, guestSpaceId: guest, kind: "update", id: String(id), revision: "3", firstLine: 2, record: { f: { value: "x" } }, touched: ["f"], expected: [] });
  const cre = (app, key, line, guest = "") => ({ app, guestSpaceId: guest, kind: "create", newKey: key, firstLine: line, record: { f: { value: key } }, touched: ["f"], expected: [] });

  const mixed = bulkify([...Array.from({ length: 150 }, (_, i) => upd("450", i + 1)), ...Array.from({ length: 30 }, (_, i) => cre("450", "n" + i, i + 2))]);
  expect(
    "bulk: 更新 150 件と追加 30 件は 1 回の一括処理（PUT 100・PUT 50・POST 30）",
    mixed.length === 1 && mixed[0].requests.map((r) => r.method).join(",") === "PUT,PUT,POST" &&
      mixed[0].requests[0].payload.records.length === 100 && mixed[0].requests[1].payload.records.length === 50 && mixed[0].requests[2].payload.records.length === 30,
    JSON.stringify(mixed.map((g) => g.requests.map((r) => r.method + r.payload.records.length)))
  );
  expect(
    "bulk: 更新は id と revision（確認時の値）を送り、追加は record だけ",
    mixed[0].requests[0].payload.records[0].revision === "3" && mixed[0].requests[0].payload.records[0].id === "1" && !("id" in mixed[0].requests[2].payload.records[0]),
    JSON.stringify(mixed[0].requests[0].payload.records[0])
  );
  expect("bulk: meta に ID・キーを持つ", mixed[0].requests[2].meta.keys.length === 30 && mixed[0].requests[0].meta.ids[0] === "1" && mixed[0].requests[0].meta.kind === "update", "");
  const big = bulkify(Array.from({ length: 2100 }, (_, i) => upd("450", i + 1)));
  expect("bulk: 21 リクエストは 20 + 1 の 2 回に分かれ、通し番号が 1, 2", big.length === 2 && big[0].requests.length === 20 && big[1].requests.length === 1 && big.map((g) => g.index).join(",") === "1,2", JSON.stringify(big.map((g) => g.requests.length)));
  const guests = bulkify([upd("460", 1, "5"), upd("450", 2), cre("450", "a", 3)]);
  expect(
    "bulk: ゲストスペースは別の一括処理に分け、通常が先・api はゲストのパス",
    guests.length === 2 && guests[0].guestSpaceId === "" && guests[0].requests[0].api === "/k/v1/records.json" && guests[1].guestSpaceId === "5" && guests[1].requests[0].api === "/k/guest/5/v1/records.json",
    JSON.stringify(guests.map((g) => [g.guestSpaceId, g.requests.map((r) => r.api)]))
  );
  const ordered = bulkify([upd("460", 1), upd("450", 10), upd("450", 9)]);
  expect(
    "bulk: アプリ ID の昇順、更新はレコード ID の数値の昇順",
    ordered[0].requests.map((r) => r.payload.app).join(",") === "450,460" && ordered[0].requests[0].payload.records.map((r) => r.id).join(",") === "9,10",
    JSON.stringify(ordered[0].requests.map((r) => [r.payload.app, r.payload.records.map((x) => x.id)]))
  );
  expect("bulk: 対象が無ければ空", bulkify([]).length === 0, "");

  // 失敗時の案内: タイムアウトは反映されたかどうか不明（「何も変更していません」と言わない）
  const exec = await import(modUrl("kintone", "recordExec.js"));
  const timeout = Object.assign(new Error("POST /k/v1/bulkRequest.json がタイムアウト（300s）しました。ネットワークと CYBOZU_BASE_URL を確認してください。"), { uncertain: true });
  const plain = new Error("一括処理の 1 件目で失敗しました");
  const uncertainNote = exec.failureNote({ bulks: [{ status: "failed" }], error: timeout }, "戻す場合: X");
  expect(
    "failure: タイムアウトは反映の有無が不明と伝え、show records で確認を促す（何も変更していないとは言わない）",
    exec.isUncertain(timeout) && !exec.isUncertain(plain) && uncertainNote.includes("反映されたかどうか分かりません") && uncertainNote.includes("show records") && !uncertainNote.includes("何も変更していません"),
    uncertainNote
  );
  expect(
    "failure: 1 回目の失敗は何も変更していない・2 回目以降の失敗は前の回が反映済みで戻し方を示す",
    exec.failureNote({ bulks: [{ status: "failed" }], error: plain }, "h").includes("何も変更していません") &&
      exec.failureNote({ bulks: [{ status: "ok" }, { status: "failed" }], error: plain }, "戻す場合: X").includes("1 回目までは反映済み") &&
      exec.failureNote({ bulks: [{ status: "ok" }, { status: "failed" }], error: timeout }, "戻す場合: X").includes("戻す場合: X"),
    ""
  );
}

// ---- 1t. レコード操作の E2E 用 mock kintone（レコード・添付・一括処理を再現する） ----
// フォーム定義・レコード・添付を持ち、bulkRequest は全件を検証してから適用する（1 件でも失敗すれば何も変えない）。
const RECORDS_MOCK_PROP = (type, code, extra = {}) => ({ type, code, label: code, ...extra });
const RECORDS_MOCK_FORMS = {
  "303": {
    添付資料: RECORDS_MOCK_PROP("FILE", "添付資料"),
    顧客名: RECORDS_MOCK_PROP("SINGLE_LINE_TEXT", "顧客名"),
    明細: RECORDS_MOCK_PROP("SUBTABLE", "明細", { fields: { 金額: RECORDS_MOCK_PROP("NUMBER", "金額"), 備考: RECORDS_MOCK_PROP("SINGLE_LINE_TEXT", "備考") } })
  },
  "450": {
    資料: RECORDS_MOCK_PROP("FILE", "資料"),
    取引先名: RECORDS_MOCK_PROP("SINGLE_LINE_TEXT", "取引先名", { required: true, defaultValue: "" }),
    移行状況: RECORDS_MOCK_PROP("DROP_DOWN", "移行状況", { options: { 未着手: { label: "未着手", index: "0" }, 移行済: { label: "移行済", index: "1" } } }),
    明細: RECORDS_MOCK_PROP("SUBTABLE", "明細", { fields: { 金額: RECORDS_MOCK_PROP("NUMBER", "金額"), 備考: RECORDS_MOCK_PROP("SINGLE_LINE_TEXT", "備考") } }),
    合計: RECORDS_MOCK_PROP("CALC", "合計", { expression: "金額+1" })
  },
  "460": { 取引先名: RECORDS_MOCK_PROP("SINGLE_LINE_TEXT", "取引先名") }
};
// アプリ 460 はゲストスペース 7 のアプリ（通常の URL では GAIA_IL23 になる）。
const RECORDS_MOCK_GUEST_APPS = { "460": "7" };

function recordsMockRecord(id, revision, fields) {
  return { $id: { type: "__ID__", value: String(id) }, $revision: { type: "__REVISION__", value: String(revision) }, ...fields };
}
const recordsMockFile = (key, name, size) => ({ fileKey: key, name, size: String(size), contentType: "application/pdf" });
const recordsMockRow = (id, amount, memo) => ({ id: String(id), value: { 金額: { type: "NUMBER", value: amount }, 備考: { type: "SINGLE_LINE_TEXT", value: memo } } });

function createRecordsMockState() {
  const mk = recordsMockRecord;
  return {
    records: {
      "303": new Map([
        ["12", mk(12, 3, { 添付資料: { type: "FILE", value: [recordsMockFile("srcA1", "a.pdf", 1234), recordsMockFile("srcA2", "b.pdf", 10)] }, 顧客名: { type: "SINGLE_LINE_TEXT", value: "山田商事" }, 明細: { type: "SUBTABLE", value: [recordsMockRow(5039, "30000", "x"), recordsMockRow(5040, "10", "y")] } })],
        ["15", mk(15, 1, { 添付資料: { type: "FILE", value: [recordsMockFile("srcB1", "c.pdf", 5)] }, 顧客名: { type: "SINGLE_LINE_TEXT", value: "佐藤" }, 明細: { type: "SUBTABLE", value: [] } })]
      ]),
      "450": new Map([
        ["7", mk(7, 12, { 資料: { type: "FILE", value: [recordsMockFile("dstA1", "old.pdf", 7)] }, 取引先名: { type: "SINGLE_LINE_TEXT", value: "旧" }, 移行状況: { type: "DROP_DOWN", value: "未着手" }, 明細: { type: "SUBTABLE", value: [recordsMockRow(6001, "1", "a"), recordsMockRow(6002, "2", "b")] }, 合計: { type: "CALC", value: "3" } })],
        ["8", mk(8, 4, { 資料: { type: "FILE", value: [recordsMockFile("dstB1", "z.pdf", 3)] }, 取引先名: { type: "SINGLE_LINE_TEXT", value: "八" }, 移行状況: { type: "DROP_DOWN", value: null }, 明細: { type: "SUBTABLE", value: [] }, 合計: { type: "CALC", value: "" } })]
      ]),
      "460": new Map([["1", mk(1, 1, { 取引先名: { type: "SINGLE_LINE_TEXT", value: "ゲスト側" } })]])
    },
    nextId: { "303": 100, "450": 500, "460": 50 },
    nextRowId: 9000,
    uploads: new Map(), // fileKey → { name, size }
    uploadSeq: 0,
    bulkBodies: [], // 受け取った bulkRequest の本体（検証用）
    brokenFiles: new Set(), // ダウンロードに失敗させる fileKey
    clearOmittedCells: false, // true なら、行 ID つきの行で送らなかったセルを消す（想定外の挙動の再現。検証が検出できるか確かめる）
    failNextBulk: null, // 次の bulkRequest を失敗させる（{ code, message }）
    committedBulks: 0
  };
}

// 値の型（トップレベル・テーブルの内側）をフォーム定義から引く。
function recordsMockTypeOf(app, code) {
  const form = RECORDS_MOCK_FORMS[app] ?? {};
  if (form[code]) return form[code].type;
  for (const prop of Object.values(form)) if (prop.fields?.[code]) return prop.fields[code].type;
  return "SINGLE_LINE_TEXT";
}

// 添付の値を反映する。既存の添付はそのまま、アップロード済みの fileKey は保存済みの添付に変える。
function recordsMockFiles(state, current, incoming) {
  const before = new Map((current ?? []).map((file) => [file.fileKey, file]));
  return (incoming ?? []).map((file) => {
    if (before.has(file.fileKey)) return before.get(file.fileKey);
    const uploaded = state.uploads.get(file.fileKey);
    if (!uploaded) throw Object.assign(new Error("アップロードされていない fileKey です: " + file.fileKey), { mockCode: "GAIA_FI01" });
    return recordsMockFile("stored-" + file.fileKey, uploaded.name, uploaded.size);
  });
}

// 送信されたフィールドを、レコードへ反映する。テーブルは仕様どおり: id 付きの行は送ったセルだけ更新（他は保持）、id 無しは新規行、送らなかった行は削除。
function recordsMockApplyFields(state, app, target, incoming) {
  for (const [code, field] of Object.entries(incoming)) {
    const type = recordsMockTypeOf(app, code);
    if (type === "FILE") {
      target[code] = { type, value: recordsMockFiles(state, target[code]?.value, field.value) };
    } else if (type === "SUBTABLE") {
      const beforeRows = new Map((target[code]?.value ?? []).map((row) => [String(row.id), row]));
      const rows = (field.value ?? []).map((row) => {
        const base = row.id != null && beforeRows.has(String(row.id)) ? beforeRows.get(String(row.id)) : null;
        const cells = base && !state.clearOmittedCells ? { ...base.value } : {};
        for (const [innerCode, innerField] of Object.entries(row.value ?? {})) {
          const innerType = recordsMockTypeOf(app, innerCode);
          cells[innerCode] = { type: innerType, value: innerType === "FILE" ? recordsMockFiles(state, cells[innerCode]?.value, innerField.value) : innerField.value };
        }
        return { id: base ? String(base.id) : String((state.nextRowId += 1)), value: cells };
      });
      target[code] = { type, value: rows };
    } else {
      target[code] = { type, value: field.value };
    }
  }
}

// bulkRequest: 全リクエストを下書きに適用し、すべて成功したときだけ反映する（kintone の原子性）。
function recordsMockBulk(state, body) {
  state.bulkBodies.push(JSON.parse(JSON.stringify(body)));
  const requests = body.requests ?? [];
  const results = requests.map(() => ({}));
  const fail = (index, code, message) => {
    results[index] = { code, message, id: "mock-error" };
    return [400, { results }];
  };
  if (state.failNextBulk) {
    const failure = state.failNextBulk;
    if (failure.skip > 0) {
      failure.skip -= 1; // skip 回ぶんの一括処理は正常に通し、その次を失敗させる
    } else {
      state.failNextBulk = null;
      return fail(0, failure.code, failure.message);
    }
  }
  const draft = {};
  for (const [app, map] of Object.entries(state.records)) draft[app] = new Map([...map].map(([id, record]) => [id, JSON.parse(JSON.stringify(record))]));
  const nextId = { ...state.nextId };
  for (let i = 0; i < requests.length; i += 1) {
    const { method, api, payload } = requests[i];
    const route = /^\/k\/(?:guest\/(\d+)\/)?v1\/records?\.json$/.exec(api);
    if (!route) return fail(i, "GAIA_AP01", "不明な API です: " + api);
    const app = String(payload.app);
    if ((RECORDS_MOCK_GUEST_APPS[app] ?? "") !== (route[1] ?? "")) return fail(i, "GAIA_IL23", "ゲストスペースの URL が一致しません。");
    const map = draft[app];
    try {
      if (method === "PUT") {
        const done = [];
        for (const item of payload.records) {
          const record = map.get(String(item.id));
          if (!record) return fail(i, "GAIA_RE01", `指定したレコード（id: ${item.id}）が見つかりません。`);
          const stale = item.revision != null && String(item.revision) !== "-1" && String(item.revision) !== record.$revision.value;
          if (stale) return fail(i, "GAIA_CO02", "更新しようとしたレコードは他のユーザーによって更新されています。");
          recordsMockApplyFields(state, app, record, item.record ?? {});
          record.$revision.value = String(Number(record.$revision.value) + 1);
          done.push({ id: String(item.id), revision: record.$revision.value });
        }
        results[i] = { records: done };
      } else if (method === "POST") {
        const ids = [];
        for (const incoming of payload.records) {
          const id = String((nextId[app] += 1));
          const record = recordsMockRecord(id, 1, {});
          recordsMockApplyFields(state, app, record, incoming);
          map.set(id, record);
          ids.push(id);
        }
        results[i] = { ids, revisions: ids.map(() => "1") };
      } else if (method === "DELETE") {
        payload.ids.forEach((id, k) => {
          const record = map.get(String(id));
          const revision = payload.revisions?.[k];
          if (!record) throw Object.assign(new Error(`指定したレコード（id: ${id}）が見つかりません。`), { mockCode: "GAIA_RE01" });
          if (revision != null && String(revision) !== "-1" && String(revision) !== record.$revision.value) {
            throw Object.assign(new Error("削除しようとしたレコードは他のユーザーによって更新されています。"), { mockCode: "GAIA_CO02" });
          }
          map.delete(String(id));
        });
        results[i] = {};
      }
    } catch (error) {
      if (error.mockCode) return fail(i, error.mockCode, error.message);
      throw error;
    }
  }
  for (const [app, map] of Object.entries(draft)) state.records[app] = map;
  state.nextId = nextId;
  state.committedBulks += 1;
  return [200, { results }];
}

function recordsMockHandle(state, method, url, body, raw) {
  const route = /^\/k\/(?:guest\/(\d+)\/)?v1\/(.+)$/.exec(url.pathname);
  if (!route) return null;
  const guest = route[1] ?? "";
  const endpoint = "/" + route[2];
  if (method === "GET" && endpoint === "/app/form/fields.json") {
    const app = url.searchParams.get("app");
    if (!RECORDS_MOCK_FORMS[app]) return [404, { code: "GAIA_AP01", message: "アプリが見つかりません。" }];
    if ((RECORDS_MOCK_GUEST_APPS[app] ?? "") !== guest) return [400, { code: "GAIA_IL23", message: "ゲストスペースのアプリです。" }];
    return [200, { properties: RECORDS_MOCK_FORMS[app], revision: "1" }];
  }
  if (method === "GET" && endpoint === "/records.json") {
    const app = url.searchParams.get("app");
    const query = url.searchParams.get("query") ?? "";
    const fields = [...url.searchParams.entries()].filter(([key]) => key.startsWith("fields[")).map(([, value]) => value);
    let list = [...(state.records[app] ?? new Map()).values()];
    const inIds = /\$id in \(([^)]*)\)/.exec(query);
    if (inIds) list = list.filter((record) => inIds[1].split(",").map((id) => id.trim()).includes(record.$id.value));
    const seek = /\$id > (\d+)/.exec(query);
    if (seek) list = list.filter((record) => Number(record.$id.value) > Number(seek[1]));
    list.sort((a, b) => Number(a.$id.value) - Number(b.$id.value));
    const offset = /offset (\d+)/.exec(query);
    if (offset) list = list.slice(Number(offset[1]));
    const limit = /limit (\d+)/.exec(query);
    if (limit) list = list.slice(0, Number(limit[1]));
    if (fields.length > 0) list = list.map((record) => Object.fromEntries(Object.entries(record).filter(([code]) => fields.includes(code))));
    return [200, { records: JSON.parse(JSON.stringify(list)) }];
  }
  if (method === "GET" && endpoint === "/file.json") {
    const fileKey = url.searchParams.get("fileKey");
    if (state.brokenFiles.has(fileKey)) return [404, { code: "GAIA_FI01", message: "ファイルが見つかりません。" }];
    return [200, Buffer.from("content-of-" + fileKey)];
  }
  if (method === "POST" && endpoint === "/file.json") {
    const name = /filename="([^"]*)"/.exec(raw.toString("utf8"))?.[1] ?? "unknown";
    const fileKey = "up-" + (state.uploadSeq += 1);
    state.uploads.set(fileKey, { name, size: raw.length });
    return [200, { fileKey }];
  }
  if (method === "POST" && endpoint === "/bulkRequest.json") return recordsMockBulk(state, body);
  return null;
}

async function startRecordsMock() {
  const state = createRecordsMockState();
  const mock = await startStatefulMock((method, url, body, raw) => recordsMockHandle(state, method, url, body, raw));
  return { ...mock, state };
}


// ---- 1u. show records / diff records（mock kintone。書き込みが一切起きないことも確認） ----
const RECORDS_JOB_HEADER = "op,from_app,from_record,from_field,to_app,to_record,to_field,mode,value,note";
const RECORDS_JOB_BASIC = [
  "copy,303,12,添付資料,450,7,資料,append,,",
  "copy,303,12,顧客名,450,7,取引先名,,,",
  "set,,,,450,7,移行状況,,移行済,",
  "clear,,,,450,8,資料,,,",
  "copy,303,15,添付資料,450,new:a,資料,,,",
  "set,,,,450,new:a,取引先名,,株式会社サンプル,",
  "copy,303,12,明細[5039].金額,450,7,明細[new:r1].金額,,,",
  "set,,,,450,7,明細[6001].備考,,確認済,"
];

// mock と一時ドメインを用意する。.env は mock の URL とレコードの許可（読み取りと書き込み）を持つ。
async function setupRecordsDomain() {
  const mock = await startRecordsMock();
  const env = mockEnv(mock.baseUrl);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-records-"));
  fs.writeFileSync(
    path.join(tmp, ".env"),
    Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\nKINT_ORIGIN_ALLOW_PULL_RECORDS=true\nKINT_ORIGIN_ALLOW_PUSH_RECORDS=true\n",
    "utf8"
  );
  const entry = (appId, guestSpaceId = "") => ({ appId, code: "", name: "app" + appId, spaceId: "", guestSpaceId, modifiedAt: "2026-01-01T00:00:00Z" });
  writeJsonFile(path.join(tmp, "data", "kintone", "index", "apps.json"), [entry("303"), entry("450"), entry("460", "7")]);
  const run = (args) => runCliAsync(args, tmp, env);
  const writeJob = (name, lines) => {
    const dir = path.join(tmp, "push", "records", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "job.csv"), [RECORDS_JOB_HEADER, ...lines].join("\n") + "\n", "utf8");
    return dir;
  };
  const nonGet = () => mock.requests.filter((request) => !request.startsWith("GET "));
  const close = () => {
    mock.server.closeAllConnections();
    mock.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { mock, tmp, env, run, writeJob, nonGet, close };
}

async function recordsReadE2ETests() {
  console.log("[offline] show records / diff records（mock kintone・書き込みなし）");
  const d = await setupRecordsDomain();
  const json = (r) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return {};
    }
  };
  try {
    // show records
    const show = await d.run(["show", "records", "--id", "303", "--records", "15,12", "--fields", "添付資料,明細"]);
    const shown = json(show);
    expect("show: 指定レコードを ID 昇順で返し、exit 0", show.status === 0 && shown.count === 2 && shown.records[0].$id === "12" && shown.records[1].$id === "15", show.stderr + show.stdout);
    expect(
      "show: 添付はファイル名とサイズだけで fileKey を出さない・テーブルは行 ID 付き",
      shown.records?.[0]?.添付資料?.[0]?.name === "a.pdf" && !show.stdout.includes("srcA1") && shown.records?.[0]?.明細?.[0]?.id === "5039" && shown.records?.[0]?.明細?.[0]?.金額 === "30000",
      show.stdout
    );
    expect("show: --fields の順に fields を返し、レコードは $id と $revision を持つ", shown.fields?.map((f) => f.code).join(",") === "添付資料,明細" && shown.records?.[0]?.$revision === "3" && !("顧客名" in shown.records[0]), show.stdout);
    const showAll = json(await d.run(["show", "records", "--id", "303"]));
    expect("show: --fields 省略時は全フィールドをコード順で返す", showAll.fields?.map((f) => f.code).join(",") === [...["添付資料", "顧客名", "明細"]].sort((a, b) => a.localeCompare(b, "ja")).join(","), JSON.stringify(showAll.fields));
    const showLimit = json(await d.run(["show", "records", "--id", "303", "--limit", "1"]));
    expect("show: --limit で打ち切ると truncated が true", showLimit.count === 1 && showLimit.truncated === true, JSON.stringify(showLimit.count));
    const noField = await d.run(["show", "records", "--id", "303", "--fields", "無い"]);
    expect("show: 存在しないフィールドは exit 1", noField.status === 1 && noField.stderr.includes("がありません"), noField.stderr);
    const innerField = await d.run(["show", "records", "--id", "303", "--fields", "金額"]);
    expect("show: テーブル内のフィールドはテーブルのコードを案内", innerField.status === 1 && innerField.stderr.includes("明細"), innerField.stderr);
    const guest = json(await d.run(["show", "records", "--id", "460"]));
    expect("show: ゲストアプリは索引から自動判定", guest.guestSpaceId === "7" && guest.count === 1, JSON.stringify(guest));
    expect("show と diff は読み取りだけ（GET 以外を送らない）", d.nonGet().length === 0, JSON.stringify(d.nonGet()));

    // diff records（正常）
    d.writeJob("t1", RECORDS_JOB_BASIC);
    const diff = await d.run(["diff", "records", "--name", "t1"]);
    const summary = json(diff);
    expect("diff: 正常なジョブは exit 0", diff.status === 0 && summary.job === "t1" && summary.rows === 8, diff.stderr + diff.stdout);
    expect("diff: 更新 2 件（7・8）・新規 1 件・フィールド一覧", summary.targets?.[0]?.update === 2 && summary.targets?.[0]?.create === 1 && summary.targets?.[0]?.fields?.join(",") === ["資料", "取引先名", "移行状況", "明細"].sort((a, b) => a.localeCompare(b, "ja")).join(","), JSON.stringify(summary.targets));
    expect("diff: アップロード 3 ファイル・一括処理 1 回で原子的・コピー元 303 の 2 件", summary.uploads?.files === 3 && summary.bulks === 1 && summary.atomic === true && summary.sources?.[0]?.app === "303" && summary.sources?.[0]?.records === 2, JSON.stringify(summary));
    const previewFile = path.join(d.tmp, summary.preview ?? "none");
    const previewText = fs.existsSync(previewFile) ? fs.readFileSync(previewFile, "utf8") : "";
    expect(
      "diff: プレビュー CSV は BOM 付きで変更前後を含み、runs/.gitignore を作る",
      previewText.startsWith("\ufeff") && previewText.includes("山田商事") && previewText.includes("移行済") && previewText.includes("old.pdf") && fs.existsSync(path.join(d.tmp, "push", "records", "t1", "runs", ".gitignore")),
      previewText
    );
    expect("diff: 書き込みの API は呼ばない", d.nonGet().length === 0, JSON.stringify(d.nonGet()));

    const indexPath = path.join(d.tmp, "data", "kintone", "index", "apps.json");
    const guestOverride = ["--id", "460", "--guestspace", "7"];
    writeJsonFile(indexPath, [{ appId: "460", guestSpaceId: "8" }]);
    const override = await d.run(["show", "records", ...guestOverride]);
    expect(
      "show: 明示指定したゲストスペースは索引より優先",
      override.status === 0 && json(override).guestSpaceId === "7",
      override.stderr + override.stdout
    );

    fs.writeFileSync(indexPath, "{\n", "utf8");
    const beforePull = d.mock.requests.length;
    const pullWithBrokenIndex = await d.run(["pull", "records", ...guestOverride]);
    expect(
      "pull records: 明示指定があっても壊れた索引を API 呼び出し前に報告",
      pullWithBrokenIndex.status === 1 &&
        pullWithBrokenIndex.stderr.includes("JSON の読み込みに失敗しました") &&
        pullWithBrokenIndex.stderr.includes("apps.json") &&
        d.mock.requests.length === beforePull,
      pullWithBrokenIndex.stderr + pullWithBrokenIndex.stdout
    );
    const showWithBrokenIndex = await d.run(["show", "records", ...guestOverride]);
    expect(
      "show: 明示指定があれば壊れた索引を読まずに取得",
      showWithBrokenIndex.status === 0 && json(showWithBrokenIndex).guestSpaceId === "7",
      showWithBrokenIndex.stderr + showWithBrokenIndex.stdout
    );
  } finally {
    d.close();
  }
}

async function recordsDiffErrorE2ETests() {
  console.log("[offline] diff records の検証エラー・ゲストスペース・操作制限（何も書き込まない）");
  const d = await setupRecordsDomain();
  const json = (r) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return {};
    }
  };
  try {
    const failing = async (label, lines, keyword) => {
      d.writeJob("bad", lines);
      const r = await d.run(["diff", "records", "--name", "bad"]);
      expect(label, r.status === 1 && r.stderr.includes("何も変更していません") && r.stderr.includes(keyword) && r.stderr.includes("行 2") && d.nonGet().length === 0, r.stderr);
    };
    await failing("diff: 存在しないコピー先レコードは存在しないと報告（新規作成しない）", ["copy,303,12,顧客名,450,999,取引先名,,,"], "レコード 999 が存在しません");
    await failing("diff: 存在しないコピー元レコード", ["copy,303,99,顧客名,450,7,取引先名,,,"], "レコード 99 が存在しません");
    await failing("diff: 新規レコードの必須フィールドが無い", ["copy,303,15,添付資料,450,new:b,資料,,,"], "必須フィールド「取引先名」");
    await failing("diff: 計算フィールドは書き込めない", ["set,,,,450,7,合計,,5,"], "書き込めません");
    await failing("diff: 同じセルへの重複", ["set,,,,450,7,移行状況,,移行済,", "set,,,,450,7,移行状況,,未着手,"], "重複");
    await failing("diff: 型が違うコピー（文字列から添付）", ["copy,303,12,顧客名,450,7,資料,,,"], "コピーできません");
    await failing("diff: 存在しないテーブルの行 ID", ["set,,,,450,7,明細[9999].備考,,x,"], "行 ID 9999 がありません");
    await failing("diff: コピー元のテーブルに無い行 ID", ["copy,303,12,明細[1234].金額,450,7,明細[new:r].金額,,,"], "行 ID 1234 がありません");
    await failing("diff: 存在しないフィールド", ["set,,,,450,7,無い,,x,"], "フィールド「無い」がありません");
    await failing("diff: ドロップダウンの選択肢外", ["set,,,,450,7,移行状況,,不明,"], "選択肢");
    await failing("diff: 必須フィールドは clear できない", ["clear,,,,450,7,取引先名,,,"], "必須");
    await failing("diff: 添付ファイルがジョブフォルダに無い", ["set,,,,450,7,資料,,files/none.pdf,"], "見つかりません");
    await failing("diff: テーブル全体の clear と他の操作は併用できない", ["clear,,,,450,7,明細,,,", "set,,,,450,7,明細[6001].備考,,x,"], "併用できません");
    await failing("diff: mode は添付とテーブル全体にだけ", ["set,,,,450,7,取引先名,replace,x,"], "mode は");

    // 同じ段階の問題はまとめて報告する
    d.writeJob("many", ["set,,,,450,7,合計,,5,", "set,,,,450,7,無い,,x,"]);
    const many = await d.run(["diff", "records", "--name", "many"]);
    expect("diff: 同じ段階の問題は 2 件まとめて行番号つきで報告", many.status === 1 && many.stderr.includes("2 件の問題") && many.stderr.includes("行 2") && many.stderr.includes("行 3"), many.stderr);

    // ジョブの指定
    const missingJob = await d.run(["diff", "records", "--name", "nosuch"]);
    expect("diff: 無いジョブは存在するジョブを案内", missingJob.status === 1 && missingJob.stderr.includes("ジョブが見つかりません") && missingJob.stderr.includes("bad"), missingJob.stderr);
    const badName = await d.run(["diff", "records", "--name", "../x"]);
    expect("diff: 不正なジョブ名は exit 1", badName.status === 1 && badName.stderr.includes("ジョブ名が不正"), badName.stderr);
    const noName = await d.run(["diff", "records"]);
    expect("diff: --name 無しは Missing required argument", noName.status === 1 && noName.stderr.includes("Missing required argument: --name"), noName.stderr);

    // ゲストスペース: 一括処理が分かれ、フォーム・レコードはゲストの URL で取る
    d.writeJob("g1", ["copy,303,12,顧客名,450,7,取引先名,,,", "copy,303,12,顧客名,460,1,取引先名,,,"]);
    const guest = await d.run(["diff", "records", "--name", "g1"]);
    const guestSummary = json(guest);
    expect(
      "diff: ゲストのアプリを含むと一括処理が 2 回に分かれ、原子的でない旨を警告",
      guest.status === 0 && guestSummary.bulks === 2 && guestSummary.atomic === false && (guestSummary.warnings ?? []).some((w) => w.includes("分かれます")),
      guest.stderr + guest.stdout
    );
    expect(
      "diff: ゲストアプリのフォームとレコードはゲストの URL で取得",
      d.mock.requests.includes("GET /k/guest/7/v1/app/form/fields.json") && d.mock.requests.includes("GET /k/guest/7/v1/records.json"),
      JSON.stringify(d.mock.requests.slice(-8))
    );
    fs.rmSync(path.join(d.tmp, "data", "kintone", "index", "apps.json"));
    const unindexed = await d.run(["diff", "records", "--name", "g1"]);
    expect("diff: 索引に無いゲストアプリは pull index を案内", unindexed.status === 1 && unindexed.stderr.includes("pull index"), unindexed.stderr);

    // 操作制限: レコードの許可が無いと API を 1 回も呼ばない
    d.mock.requests.length = 0;
    fs.writeFileSync(path.join(d.tmp, ".env"), Object.entries(d.env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", "utf8");
    const denied = await d.run(["diff", "records", "--name", "g1"]);
    const deniedShow = await d.run(["show", "records", "--id", "303"]);
    expect(
      "diff / show: PULL_RECORDS が無ければ「操作制限:」で拒否し API を呼ばない",
      denied.status === 1 && deniedShow.status === 1 && denied.stderr.includes("操作制限:") && deniedShow.stderr.includes("操作制限:") && d.mock.requests.length === 0,
      denied.stderr + deniedShow.stderr
    );
  } finally {
    d.close();
  }
}


// ---- 1v. push records / --restore（mock kintone。反映・競合・復旧・ゲスト・途中失敗） ----
async function recordsPushE2ETests() {
  console.log("[offline] push records / --restore（mock kintone）");
  const d = await setupRecordsDomain();
  const state = d.mock.state;
  const json = (r) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return {};
    }
  };
  const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const runPath = (job, runId, ...rest) => path.join(d.tmp, "push", "records", job, "runs", runId, ...rest);
  const rec = (app, id) => state.records[app].get(id);
  const names = (record, code) => (record[code]?.value ?? []).map((f) => f.name).sort().join(",");
  const rows = (record) => record.明細.value.map((r) => `${r.id}:${r.value.金額?.value ?? "-"}/${r.value.備考?.value ?? "-"}`);
  try {
    d.writeJob("t1", RECORDS_JOB_BASIC);
    // 非対話で -y が無ければ、API を呼ぶ前に中断する
    const noYes = await d.run(["push", "records", "--name", "t1"]);
    expect("push: 非対話で -y 無しは API を呼ぶ前に exit 1（diff の確認と -y を案内）", noYes.status === 1 && noYes.stderr.includes("kint-origin diff") && noYes.stderr.includes("-y を付けて") && d.mock.requests.length === 0, noYes.stderr);

    // 反映
    const push = await d.run(["push", "records", "--name", "t1", "-y"]);
    const result = json(push);
    const runId = result.runId;
    expect("push: -y で exit 0・applied・一括処理 1 回（原子的）", push.status === 0 && result.applied === true && result.atomic === true && result.bulks?.length === 1 && result.bulks[0].status === "ok", push.stderr + push.stdout);
    expect(
      "push: 更新 7・8 と新規 a の ID・リビジョンを返す",
      result.updated?.map((u) => `${u.id}:${u.revisionBefore}>${u.revisionAfter}`).join(",") === "7:12>13,8:4>5" && result.created?.[0]?.key === "a" && result.created[0].id === "501",
      JSON.stringify([result.updated, result.created])
    );
    const r7 = rec("450", "7");
    expect(
      "push: 添付は追記（既存 + コピー 2 件）・値の転記・固定値",
      names(r7, "資料") === "a.pdf,b.pdf,old.pdf" && r7.取引先名.value === "山田商事" && r7.移行状況.value === "移行済" && r7.$revision.value === "13",
      JSON.stringify(r7)
    );
    expect(
      "push: テーブルは既存行を保持し、指定した行のセルだけ更新・新しい行を追加",
      rows(r7).length === 3 && rows(r7)[0] === "6001:1/確認済" && rows(r7)[1] === "6002:2/b" && rows(r7)[2].endsWith(":30000/-"),
      JSON.stringify(rows(r7))
    );
    expect("push: clear した添付は空・新規レコードに値と添付", rec("450", "8").資料.value.length === 0 && names(rec("450", "501"), "資料") === "c.pdf" && rec("450", "501").取引先名.value === "株式会社サンプル", "");
    const body = state.bulkBodies[0];
    const put = body.requests[0];
    expect(
      "push: PUT はレコード ID 順で確認時の revision を送り、@upload: は fileKey に置換済み",
      put.method === "PUT" && put.api === "/k/v1/records.json" && put.payload.records.map((r) => `${r.id}:${r.revision}`).join(",") === "7:12,8:4" && !JSON.stringify(body).includes("@upload:") && state.uploads.size === 3,
      JSON.stringify(put.payload.records.map((r) => [r.id, r.revision]))
    );
    const backup = readJson(runPath("t1", runId, "backup", "records.json"));
    expect(
      "push: 書き込み前のバックアップ（raw 値・リビジョン・添付の実体）を実行記録に保存",
      backup.records.map((r) => r.id).join(",") === "7,8" && backup.records[0].revision === "12" &&
        fs.readFileSync(runPath("t1", runId, "backup", "files", "app-450", "7", "資料", "1-old.pdf"), "utf8") === "content-of-dstA1",
      JSON.stringify(backup.records[0])
    );
    expect("push: 転送用の一時フォルダ（work）は削除され、プレビューと計画が残る", !fs.existsSync(runPath("t1", runId, "work")) && fs.existsSync(runPath("t1", runId, "preview.csv")) && fs.existsSync(runPath("t1", runId, "plan.json")), "");
    expect("push: 反映後の検証で食い違い 0 件", result.verify?.mismatches?.length === 0 && result.verify.checked > 0, JSON.stringify(result.verify));
    expect("push: 復旧プラン（--restore のコマンド）を表示", push.stderr.includes("【復旧プラン】") && push.stderr.includes("--restore " + runId), push.stderr);

    // 復旧
    const restore = await d.run(["push", "records", "--name", "t1", "--restore", runId, "-y"]);
    const restored = json(restore);
    const b7 = rec("450", "7");
    expect(
      "restore: 更新を元の値に戻す（添付はバックアップから再アップロード・転記と固定値・追加した行は削除）",
      restore.status === 0 && restored.applied === true && names(b7, "資料") === "old.pdf" && b7.取引先名.value === "旧" && b7.移行状況.value === "未着手" && rows(b7).join(",") === "6001:1/a,6002:2/b",
      restore.stderr + JSON.stringify(rows(b7))
    );
    expect("restore: 空にした添付を戻し、作成したレコードを削除", names(rec("450", "8"), "資料") === "z.pdf" && !state.records["450"].has("501") && restored.deleted === 1, JSON.stringify(restored));
    expect(
      "restore: 復旧済みの印と、復旧前の状態（削除したレコードを含む）を別の実行記録に保存",
      fs.existsSync(runPath("t1", runId, "restored.json")) && readJson(runPath("t1", restored.runId, "result.json")).kind === "restore" &&
        readJson(runPath("t1", restored.runId, "backup", "records.json")).records.some((r) => r.id === "501"),
      ""
    );
    const again = await d.run(["push", "records", "--name", "t1", "--restore", runId, "-y"]);
    expect("restore: 復旧済みの実行は再度戻せない", again.status === 1 && again.stderr.includes("復旧済み"), again.stderr);
  } finally {
    d.close();
  }
}

async function recordsPushFailureE2ETests() {
  console.log("[offline] push records の競合・復旧の競合・ゲストスペース・途中失敗（mock kintone）");
  const d = await setupRecordsDomain();
  const state = d.mock.state;
  const json = (r) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return {};
    }
  };
  const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const runPath = (job, runId, ...rest) => path.join(d.tmp, "push", "records", job, "runs", runId, ...rest);
  const latestRun = (job) => {
    const dir = path.join(d.tmp, "push", "records", job, "runs");
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().at(-1);
  };
  const rec = (app, id) => state.records[app].get(id);
  try {
    // 確認のあとに他の人が更新した（revision の不一致）: 何も変えず、原因を案内する
    d.writeJob("c1", ["set,,,,450,7,移行状況,,移行済,"]);
    state.failNextBulk = { code: "GAIA_CO02", message: "更新しようとしたレコードは他のユーザーによって更新されています。", skip: 0 };
    const conflict = await d.run(["push", "records", "--name", "c1", "-y"]);
    const conflictResult = readJson(runPath("c1", latestRun("c1"), "result.json"));
    expect(
      "push: revision の不一致は exit 1・何も変更せず、diff からのやり直しを案内",
      conflict.status === 1 && conflict.stderr.includes("他の人が") && conflict.stderr.includes("何も変更していません") && rec("450", "7").移行状況.value === "未着手" && state.committedBulks === 0,
      conflict.stderr
    );
    expect("push: 失敗した実行も result.json に残す（applied false・失敗した一括処理）", conflictResult.applied === false && conflictResult.bulks?.[0]?.status === "failed" && fs.existsSync(runPath("c1", latestRun("c1"), "backup", "records.json")), JSON.stringify(conflictResult));

    // 復旧の競合: 実行後に他の人が編集したレコードは中断して一覧を出す
    d.writeJob("c2", ["set,,,,450,8,取引先名,,八改,"]);
    const pushed = json(await d.run(["push", "records", "--name", "c2", "-y"]));
    rec("450", "8").$revision.value = "99";
    const blocked = await d.run(["push", "records", "--name", "c2", "--restore", pushed.runId, "-y"]);
    expect(
      "restore: 実行後に編集されたレコードがあれば一覧を出して中断（変更しない）",
      blocked.status === 1 && blocked.stderr.includes("レコード 8") && blocked.stderr.includes("--overwrite-remote") && rec("450", "8").取引先名.value === "八改",
      blocked.stderr
    );
    const forced = await d.run(["push", "records", "--name", "c2", "--restore", pushed.runId, "--overwrite-remote", "-y"]);
    expect("restore: --overwrite-remote なら上書きして戻す", forced.status === 0 && rec("450", "8").取引先名.value === "八", forced.stderr);

    // ゲストスペース: 一括処理は別々・復旧もゲストの URL
    d.writeJob("g2", ["copy,303,12,顧客名,450,7,取引先名,,,", "copy,303,12,顧客名,460,1,取引先名,,,"]);
    d.mock.requests.length = 0;
    const guestPush = await d.run(["push", "records", "--name", "g2", "-y"]);
    const guestResult = json(guestPush);
    expect(
      "push: 通常アプリとゲストアプリは別の一括処理（原子的でない旨を表示）",
      guestPush.status === 0 && guestResult.atomic === false && guestResult.bulks?.length === 2 && d.mock.requests.includes("POST /k/v1/bulkRequest.json") && d.mock.requests.includes("POST /k/guest/7/v1/bulkRequest.json") && rec("460", "1").取引先名.value === "山田商事",
      guestPush.stderr + guestPush.stdout
    );
    const guestRestore = await d.run(["push", "records", "--name", "g2", "--restore", guestResult.runId, "-y"]);
    expect("restore: ゲストアプリもゲストの URL で元に戻す", guestRestore.status === 0 && rec("460", "1").取引先名.value === "ゲスト側" && rec("450", "7").取引先名.value === "旧", guestRestore.stderr);

    // 途中失敗: 2 回目の一括処理で失敗 → 1 回目は反映済み、--restore で戻せる
    d.writeJob("p1", ["set,,,,450,7,取引先名,,途中,", "set,,,,460,1,取引先名,,途中,"]);
    state.failNextBulk = { code: "GAIA_CO02", message: "更新しようとしたレコードは他のユーザーによって更新されています。", skip: 1 };
    const partial = await d.run(["push", "records", "--name", "p1", "-y"]);
    const partialRun = latestRun("p1");
    const partialResult = readJson(runPath("p1", partialRun, "result.json"));
    expect(
      "push: 途中で失敗したら前の回は反映済みと報告し、復旧コマンドを示す",
      partial.status === 1 && partial.stderr.includes("1 回目までは反映済み") && partial.stderr.includes("--restore " + partialRun) && rec("450", "7").取引先名.value === "途中" && rec("460", "1").取引先名.value === "ゲスト側",
      partial.stderr
    );
    expect("push: 途中失敗の result.json は partial と、反映済み・失敗・未実行の状態を持つ", partialResult.partial === true && partialResult.bulks.map((b) => b.status).join(",") === "ok,failed" && partialResult.updated?.length === 1, JSON.stringify(partialResult));
    const partialRestore = await d.run(["push", "records", "--name", "p1", "--restore", partialRun, "-y"]);
    expect("restore: 途中失敗の実行も、反映済みの分を元に戻せる", partialRestore.status === 0 && rec("450", "7").取引先名.value === "旧", partialRestore.stderr);

    // 反映後の検証: kintone が「送らなかったセル」を消す挙動だった場合に、保持の確認で検出できる
    d.writeJob("m1", ["set,,,,450,7,明細[6001].備考,,変更,"]);
    state.clearOmittedCells = true;
    const lossy = await d.run(["push", "records", "--name", "m1", "-y"]);
    state.clearOmittedCells = false;
    const lossyResult = json(lossy);
    expect(
      "push: 送らなかったテーブルのセルが消えたら、反映後の検証が食い違いとして報告する（警告つき）",
      lossy.status === 1 && lossyResult.verify?.mismatches?.some((m) => m.field === "明細[6001].金額" && m.expected === "1" && m.actual === "") && lossy.stderr.includes("反映後の値が計画と異なります"),
      lossy.stderr + JSON.stringify(lossyResult.verify)
    );

    // 書き込み前の中断: バックアップ（添付のダウンロード）に失敗したら何も書き込まない
    d.writeJob("b1", ["clear,,,,450,7,資料,,,"]);
    for (const file of rec("450", "7").資料.value) state.brokenFiles.add(file.fileKey);
    const bulksBefore = state.committedBulks;
    const failedBackup = await d.run(["push", "records", "--name", "b1", "-y"]);
    const failedRun = readJson(runPath("b1", latestRun("b1"), "result.json"));
    expect(
      "push: バックアップに失敗したら書き込み前に中断（何も変更しない）",
      failedBackup.status === 1 && failedBackup.stderr.includes("バックアップに失敗したため中断しました") && state.committedBulks === bulksBefore && rec("450", "7").資料.value.length === 1 && failedRun.applied === false,
      failedBackup.stderr
    );
  } finally {
    d.close();
  }
}


// ---- 1w. レコード操作コマンドの引数検証・操作制限（オフライン。API は呼ばない） ----
function recordsCliTests() {
  console.log("[offline] show / diff / push records の引数検証・操作制限");
  const makeDomain = (envLines) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-records-cli-"));
    fs.writeFileSync(path.join(tmp, ".env"), envLines.join("\n") + "\n", "utf8");
    return tmp;
  };
  const allowed = makeDomain(["KINT_ORIGIN_ALLOW_PULL_RECORDS=true", "KINT_ORIGIN_ALLOW_PUSH_RECORDS=true"]);
  const readOnly = makeDomain(["KINT_ORIGIN_ALLOW_PULL_RECORDS=true"]);
  const none = makeDomain([]);
  const run = (cwd, args) => runCli(args, cwd, NO_SHELL_CREDS);
  try {
    const fails = (label, result, keyword) => expect(label, result.status === 1 && result.stderr.includes(keyword), `status=${result.status}\n${result.stderr}`);
    fails("show records: --id 無しは Missing required argument", run(allowed, ["show", "records"]), "Missing required argument: --id");
    fails("show records: --id が数字でない", run(allowed, ["show", "records", "--id", "abc"]), "アプリ ID（数字）");
    fails("show records: --records は数字の ID のカンマ区切り", run(allowed, ["show", "records", "--id", "3", "--records", "1,x"]), "--records は数字の ID");
    fails("show records: --records と --order-by は同時に指定できない", run(allowed, ["show", "records", "--id", "3", "--records", "1", "--order-by", "x asc"]), "同時に指定できません");
    fails("show records: --limit は 1〜10000", run(allowed, ["show", "records", "--id", "3", "--limit", "0"]), "--limit は 1〜10000");
    fails("show records: 不明なオプションは使えるオプションを案内", run(allowed, ["show", "records", "--id", "3", "--foo"]), "不明なオプションです: --foo");
    fails("diff records: --name 無しは Missing required argument", run(allowed, ["diff", "records"]), "Missing required argument: --name");
    fails("diff records: 不正なジョブ名は認証値の前に拒否", run(allowed, ["diff", "records", "--name", "../x"]), "ジョブ名が不正");
    fails("diff records: ジョブが無ければ案内（認証値の前に確認）", run(allowed, ["diff", "records", "--name", "nosuch"]), "ジョブが見つかりません");
    fails("push records: --name 無しは Missing required argument", run(allowed, ["push", "records"]), "Missing required argument: --name");
    fails("push records: --restore の値が実行時刻の形式でない", run(allowed, ["push", "records", "--name", "x", "--restore", "abc", "-y"]), "--restore には runs/ のフォルダ名");
    fails("push records: --restore に値が無い", run(allowed, ["push", "records", "--name", "x", "--restore", "-y"]), "--restore には runs/ のフォルダ名");
    fails("push records: --overwrite-remote は --restore と一緒に", run(allowed, ["push", "records", "--name", "x", "--overwrite-remote", "-y"]), "--overwrite-remote は --restore と一緒に");
    fails("push records: 非対話で -y 無しは diff の確認と -y を案内", run(allowed, ["push", "records", "--name", "x"]), "-y を付けて");
    fails("push records: 使えないオプション（--only）は不明なオプション", run(allowed, ["push", "records", "--name", "x", "--only", "a"]), "不明なオプションです: --only");

    // 操作制限
    const readOnlyPush = run(readOnly, ["push", "records", "--name", "x", "-y"]);
    expect(
      "操作制限: PUSH_RECORDS が無ければ push records は拒否し、必要な設定行と diff records を案内",
      readOnlyPush.status === 1 && readOnlyPush.stderr.includes("操作制限:") && readOnlyPush.stderr.includes("KINT_ORIGIN_ALLOW_PUSH_RECORDS=true") && readOnlyPush.stderr.includes("kint-origin diff records") && !readOnlyPush.stderr.includes("KINT_ORIGIN_ALLOW_PULL_RECORDS=true（"),
      readOnlyPush.stderr
    );
    for (const args of [["show", "records", "--id", "3"], ["diff", "records", "--name", "x"], ["push", "records", "--name", "x", "-y"]]) {
      const denied = run(none, args);
      expect(`操作制限: 許可が無ければ ${args.slice(0, 2).join(" ")} は拒否（認証値の前）`, denied.status === 1 && denied.stderr.includes("操作制限:") && !denied.stderr.includes("Missing required environment variable"), denied.stderr);
    }
    const readOnlyDiff = run(readOnly, ["diff", "records", "--name", "nosuch"]);
    expect("操作制限: diff records は PULL_RECORDS だけで判定を通る（push の許可は不要）", !readOnlyDiff.stderr.includes("操作制限:"), readOnlyDiff.stderr);
  } finally {
    for (const dir of [allowed, readOnly, none]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 1r2. スペースの設定・本文の diff space / push space（純関数・CLI検証・mock E2E） ----
async function spacePushTests() {
  console.log("[offline] スペースの設定・本文（diff space・push space・サニタイズ取り直し）");

  const dist = (...parts) => pathToFileURL(path.join(ROOT, "dist", ...parts)).href;
  const { normalizeSpaceBody, formatSpaceBodyFile, serializeSpaceSettings } = await import(dist("kintone", "serializers.js"));
  const { formatSpaceHtml, collapseSpaceHtml } = await import(dist("kintone", "htmlFormat.js"));
  const { validateSpaceOnlyKeys, validateAndBuildSpaceSettingsPayload } = await import(dist("kintone", "spacePush.js"));
  const { buildRecoveryPlanText } = await import(dist("kintone", "push.js"));

  // A. 純関数（正規化・HTMLインデント整形・settings 抽出・検証・復旧プラン）
  expect("space pure: normalizeSpaceBody は CRLF を LF に揃え末尾改行を除く", normalizeSpaceBody("<div>\r\na\r\n</div>\r\n") === "<div>\na\n</div>", normalizeSpaceBody("<div>\r\na\r\n</div>\r\n"));
  expect("space pure: formatSpaceBodyFile は空でない本文に末尾 LF を 1 つ付ける", formatSpaceBodyFile("<p>x</p>\r\n") === "<p>x</p>\n" && formatSpaceBodyFile("") === "", JSON.stringify(formatSpaceBodyFile("<p>x</p>\r\n")));

  // 以下の HTML fixture に対する整形・1 行化の再現性と冪等性（任意の HTML の可逆性は保証しない）
  const sampleTableOneLine = '<table><tbody><tr><td><a href="https://example.com">リンク1</a></td><td><span style="color:#ffffff;">文字</span></td></tr></tbody></table>';
  const sampleTableFormatted = [
    "<table>",
    "  <tbody>",
    "    <tr>",
    '      <td><a href="https://example.com">リンク1</a></td>',
    '      <td><span style="color:#ffffff;">文字</span></td>',
    "    </tr>",
    "  </tbody>",
    "</table>\n"
  ].join("\n");
  expect("space pure: formatSpaceHtml はブロック要素を階層インデントしインライン要素を壊さない", formatSpaceHtml(sampleTableOneLine) === sampleTableFormatted, formatSpaceHtml(sampleTableOneLine));
  expect("space pure: collapseSpaceHtml は表の fixture を元の1行HTMLへ復元する", collapseSpaceHtml(sampleTableFormatted) === sampleTableOneLine, collapseSpaceHtml(sampleTableFormatted));
  expect("space pure: formatSpaceHtml(collapseSpaceHtml(formatted)) === formatted（冪等性）", formatSpaceHtml(collapseSpaceHtml(sampleTableFormatted)) === sampleTableFormatted, "");
  expect("space pure: collapseSpaceHtml(formatSpaceHtml(oneLine)) === oneLine（1行再現性）", collapseSpaceHtml(formatSpaceHtml(sampleTableOneLine)) === sampleTableOneLine, "");

  const complexOneLine = '<div><p>段落1: <b>太字</b>と<a href="https://example.com">リンク</a></p><table border="0"><tr><td bgcolor="#003366"><img src="/test.png" alt="画像" /></td></tr></table><pre>  line 1\n    line 2\n</pre></div>';
  expect("space pure: 段落・テーブル・画像・pre の fixture は整形後も同じ1行HTMLへ戻る", collapseSpaceHtml(formatSpaceHtml(complexOneLine)) === complexOneLine, collapseSpaceHtml(formatSpaceHtml(complexOneLine)));
  expect("space pure: normalizeSpaceBody はインデント済みHTMLと1行HTMLで同一の正規形（1行）を返す", normalizeSpaceBody(sampleTableFormatted) === normalizeSpaceBody(sampleTableOneLine), `${normalizeSpaceBody(sampleTableFormatted)} !== ${normalizeSpaceBody(sampleTableOneLine)}`);

  const sampleRemote = {
    id: "2",
    name: "営業スペース",
    defaultThread: "15",
    isPrivate: false,
    creator: { code: "u", name: "u" },
    modifier: { code: "u", name: "u" },
    memberCount: 3,
    coverType: "PRESET",
    coverKey: "SPACE_1",
    coverUrl: "https://example.invalid/cover.png",
    body: "<p>初期本文</p>",
    useMultiThread: true,
    isGuest: false,
    AttachedApps: [{ appId: "5", code: "", name: "案件" }],
    fixedMember: false,
    showAnnouncement: true,
    showThreadList: true,
    showAppList: true,
    showMemberList: true,
    showRelatedLinkList: true,
    permissions: { createApp: "EVERYONE" }
  };
  const extracted = serializeSpaceSettings(sampleRemote);
  expect(
    "space pure: serializeSpaceSettings は PUT /k/v1/space.json の 10 キーだけを抽出し、id・body・AttachedApps を含まない",
    Object.keys(extracted).join(",") === "name,isPrivate,fixedMember,useMultiThread,showAnnouncement,showThreadList,showAppList,showMemberList,showRelatedLinkList,permissions" &&
      !("id" in extracted) &&
      !("body" in extracted) &&
      !("AttachedApps" in extracted),
    JSON.stringify(extracted)
  );

  // validateSpaceOnlyKeys
  let okOnlyMsg = "";
  try {
    validateSpaceOnlyKeys(["settings", "body"]);
  } catch (e) {
    okOnlyMsg = e.message;
  }
  expect("space pure: validateSpaceOnlyKeys は settings,body を通す", okOnlyMsg === "", okOnlyMsg);
  let badOnlyMsg = "";
  try {
    validateSpaceOnlyKeys(["views"]);
  } catch (e) {
    badOnlyMsg = e.message;
  }
  expect("space pure: validateSpaceOnlyKeys は不明なキーを拒否し settings, body を案内", badOnlyMsg.includes("views") && badOnlyMsg.includes("settings, body"), badOnlyMsg);

  // validateAndBuildSpaceSettingsPayload の制約検査
  const errOf = (local, remote, isGuest = false) => {
    try {
      validateAndBuildSpaceSettingsPayload(local, remote, { spaceId: "2", isGuest });
      return "";
    } catch (e) {
      return e.message;
    }
  };
  expect("space pure: Multi -> Single（useMultiThread: true -> false）は送信前に拒否", errOf({ ...extracted, useMultiThread: false }, sampleRemote).includes("マルチスレッド）から false（シングルスレッド）へ戻せません"), errOf({ ...extracted, useMultiThread: false }, sampleRemote));
  const singleRemote = { ...sampleRemote, useMultiThread: false };
  const singleLocal = serializeSpaceSettings(singleRemote);
  expect("space pure: シングルスレッドで showThreadList を変更すると拒否", errOf({ ...singleLocal, showThreadList: false }, singleRemote).includes("シングルスレッドのスペース（useMultiThread: false）ではポータル表示項目"), errOf({ ...singleLocal, showThreadList: false }, singleRemote));
  const singlePayload = validateAndBuildSpaceSettingsPayload({ ...singleLocal, name: "新名称" }, singleRemote, { spaceId: "2", isGuest: false });
  expect(
    "space pure: シングルスレッドの payload は show* と useMultiThread を除外して組み立てる",
    singlePayload.id === "2" && singlePayload.name === "新名称" && !("showAnnouncement" in singlePayload) && !("useMultiThread" in singlePayload),
    JSON.stringify(singlePayload)
  );
  const guestRemote = { ...sampleRemote, isGuest: true, isPrivate: true };
  const guestLocal = serializeSpaceSettings(guestRemote);
  expect("space pure: ゲストスペースで isPrivate: false は拒否", errOf({ ...guestLocal, isPrivate: false }, guestRemote, true).includes("ゲストスペースは公開（isPrivate: false）に変更できません"), errOf({ ...guestLocal, isPrivate: false }, guestRemote, true));
  expect("space pure: ゲストスペースで useMultiThread の変更は拒否", errOf({ ...guestLocal, useMultiThread: true }, { ...guestRemote, useMultiThread: false }, true).includes("ゲストスペースでは useMultiThread を変更できません"), errOf({ ...guestLocal, useMultiThread: true }, { ...guestRemote, useMultiThread: false }, true));
  expect("space pure: 不明なキーは拒否", errOf({ ...extracted, unknownKey: 1 }, sampleRemote).includes("不明なキーがあります: unknownKey"), "");
  expect("space pure: name が空や 128 文字超は拒否", errOf({ ...extracted, name: "" }, sampleRemote).includes("1〜128 文字") && errOf({ ...extracted, name: "あ".repeat(129) }, sampleRemote).includes("1〜128 文字"), "");
  const recovery = buildRecoveryPlanText({ mode: "space" });
  expect("space pure: 復旧プランに即時反映と push space の戻し手順を含む", recovery.includes("運用環境へ即時に反映") && recovery.includes("再度 push space"), recovery);

  // B. CLI の引数・ガード（API の前に止まる）
  const tmpCli = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-space-cli-"));
  try {
    fs.writeFileSync(path.join(tmpCli, ".env"), "CYBOZU_BASE_URL=http://127.0.0.1:9\nCYBOZU_USERNAME=u\nCYBOZU_PASSWORD=p\nKINT_ORIGIN_ALLOW_PUSH_SPACE=true\n", "utf8");
    const noIdDiff = runCli(["diff", "space"], tmpCli);
    expect("space CLI: diff space で --id 無しは Missing required argument", noIdDiff.status === 1 && noIdDiff.stderr.includes("Missing required argument: --id"), noIdDiff.stderr);
    const noIdPush = runCli(["push", "space", "-y"], tmpCli);
    expect("space CLI: push space で --id 無しは Missing required argument", noIdPush.status === 1 && noIdPush.stderr.includes("Missing required argument: --id"), noIdPush.stderr);
    const badOnly = runCli(["push", "space", "--id", "2", "--only", "fields", "-y"], tmpCli);
    expect("space CLI: push space --only fields は API の前に拒否", badOnly.status === 1 && badOnly.stderr.includes("settings, body"), badOnly.stderr);
    const noTty = runCli(["push", "space", "--id", "2"], tmpCli);
    expect("space CLI: 非対話で -y 無しは diff と -y を案内して中断", noTty.status === 1 && noTty.stderr.includes("kint-origin diff") && noTty.stderr.includes("-y を付けて"), noTty.stderr);
    const unpulled = runCli(["diff", "space", "--id", "2"], tmpCli);
    expect("space CLI: 未取得のスペースは pull spaces --id 2 を案内して中断", unpulled.status === 1 && unpulled.stderr.includes("pull spaces --id 2"), unpulled.stderr);
  } finally {
    fs.rmSync(tmpCli, { recursive: true, force: true });
  }

  // C. E2E（mock HTTP サーバー: マルチスレッド・サニタイズ取り直し・シングルスレッド・ゲストスペース・ローカル編集の保持と破棄）
  const spaces = {
    "2": { ...sampleRemote, body: "<p>初期本文</p>" },
    "3": { ...sampleRemote, id: "3", name: "単一スレッド", useMultiThread: false, defaultThread: "99", body: "<p>スレッド初期</p>" },
    "4": { ...sampleRemote, id: "4", name: "整形検証スペース", body: "<div><p>段落1</p><p>段落2</p></div>" }
  };
  const guestSpaces = {
    "14": { ...sampleRemote, id: "14", name: "ゲストスペース14", isGuest: true, isPrivate: true, body: "<p>ゲスト初期</p>" }
  };
  const writes = [];
  // kintone の保存時サニタイズを模倣: <svg>...</svg> を削除し、target="_blank" に rel="nofollow noopener noreferrer" を付与する
  const sanitizeHtml = (html) =>
    String(html ?? "")
      .replace(/<svg[\s\S]*?<\/svg>/gi, "")
      .replace(/target="_blank"(?!\s+rel=)/g, 'target="_blank" rel="nofollow noopener noreferrer"');

  const handle = (method, url, body) => {
    const m = /^\/k(?:\/guest\/(\d+))?\/v1(\/.+)$/.exec(url.pathname);
    if (!m) return null;
    const gid = m[1] || "";
    const ep = m[2];
    if (method === "GET") {
      if (ep === "/apps.json") return [200, { apps: [] }];
      if (ep === "/space.json") {
        const id = url.searchParams.get("id") || "";
        const target = gid ? (gid === id ? guestSpaces[id] : null) : spaces[id];
        return target ? [200, target] : [404, { code: "GAIA_SI01", message: "スペースが見つかりません。" }];
      }
      return null;
    }
    writes.push({ method, path: url.pathname, body });
    if (method === "PUT" && ep === "/space.json") {
      const target = gid ? guestSpaces[ String(body.id) ] : spaces[ String(body.id) ];
      if (!target) return [404, { code: "GAIA_SI01", message: "not found" }];
      for (const [k, v] of Object.entries(body)) {
        if (k !== "id" && v !== undefined) target[k] = v;
      }
      return [200, {}];
    }
    if (method === "PUT" && ep === "/space/body.json") {
      const target = gid ? guestSpaces[ String(body.id) ] : spaces[ String(body.id) ];
      if (!target) return [404, { code: "GAIA_SI01", message: "not found" }];
      target.body = sanitizeHtml(body.body);
      return [200, {}];
    }
    if (method === "PUT" && ep === "/space/thread.json") {
      const target = Object.values(gid ? guestSpaces : spaces).find((s) => s.defaultThread === String(body.id));
      if (!target) return [404, { code: "GAIA_SI01", message: "thread not found" }];
      if (body.body !== undefined) target.body = sanitizeHtml(body.body);
      if (body.name !== undefined) target.name = body.name;
      return [200, {}];
    }
    return null;
  };

  const { server, baseUrl } = await startStatefulMock(handle);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-space-e2e-"));
  fs.writeFileSync(
    path.join(tmp, ".env"),
    Object.entries(mockEnv(baseUrl)).map(([k, v]) => `${k}=${v}`).join("\n") + "\nKINT_ORIGIN_ALLOW_PUSH_SPACE=true\n",
    "utf8"
  );
  const run = (args) => runCliAsync(args, tmp, mockEnv(baseUrl));
  const parse = (r) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return {};
    }
  };
  const spaceDir = (dirName) => path.join(tmp, "data", "kintone", "spaces", dirName);
  const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
  const readText = (p) => fs.readFileSync(p, "utf8");

  try {
    // 1. pull spaces で space.json・settings.json・body.html・.kint-origin-pull.json が生成される
    const pull1 = await run(["pull", "spaces", "--id", "2"]);
    const pull1b = await run(["pull", "spaces", "--id", "3"]);
    const pull1c = await run(["pull", "spaces", "--id", "4"]);
    expect(
      "space E2E: pull spaces は space.json（domain 付き）・settings.json・body.html・.kint-origin-pull.json を書く",
      pull1.status === 0 &&
        pull1b.status === 0 &&
        pull1c.status === 0 &&
        readJson(path.join(spaceDir("space-2"), "space.json")).domain === new URL(baseUrl).host &&
        readJson(path.join(spaceDir("space-2"), "settings.json")).name === "営業スペース" &&
        readText(path.join(spaceDir("space-2"), "body.html")) === "<p>初期本文</p>\n" &&
        readText(path.join(spaceDir("space-4"), "body.html")) === "<div>\n  <p>段落1</p>\n  <p>段落2</p>\n</div>\n" &&
        Object.keys(readJson(path.join(spaceDir("space-2"), ".kint-origin-pull.json")).files || {}).join(",") === "body.html,settings.json",
      `status=${pull1.status}/${pull1b.status}/${pull1c.status}\n${pull1.stderr}\n${pull1b.stderr}\n${pull1c.stderr}`
    );

    // 2. 編集前の diff space は両方 same（インデント済み body.html とリモート1行 HTML でも同一ハッシュ判定）
    const diff1 = await run(["diff", "space", "--id", "2"]);
    const diff4 = await run(["diff", "space", "--id", "4"]);
    const d1 = parse(diff1);
    const d4 = parse(diff4);
    expect(
      "space E2E: 編集前の diff space は settings・body ともに same（整形済み body.html も same 判定）",
      diff1.status === 0 &&
        diff4.status === 0 &&
        d1.pullState === true &&
        d1.resources?.every((r) => r.state === "same") &&
        d4.resources?.every((r) => r.state === "same") &&
        diff1.stderr.includes("差分はありません") &&
        diff4.stderr.includes("差分はありません"),
      `${diff1.stdout}\n${diff4.stdout}\n${diff1.stderr}\n${diff4.stderr}`
    );

    // 3. マルチスレッド（space-2）の settings.json と body.html（<svg> と target="_blank" を含む）を編集して diff -> push
    const s2Settings = readJson(path.join(spaceDir("space-2"), "settings.json"));
    s2Settings.name = "営業スペース（改）";
    fs.writeFileSync(path.join(spaceDir("space-2"), "settings.json"), JSON.stringify(s2Settings, null, 2) + "\n", "utf8");
    fs.writeFileSync(
      path.join(spaceDir("space-2"), "body.html"),
      '<div><a href="https://example.com" target="_blank">リンク</a><svg><rect width="10" height="10"/></svg></div>\n',
      "utf8"
    );

    const diff2 = await run(["diff", "space", "--id", "2"]);
    const d2 = parse(diff2);
    expect(
      "space E2E: 編集後の diff space は settings（changedKeys: [name]）と body が local",
      diff2.status === 0 &&
        d2.resources?.find((r) => r.key === "settings")?.state === "local" &&
        JSON.stringify(d2.resources?.find((r) => r.key === "settings")?.changedKeys) === '["name"]' &&
        d2.resources?.find((r) => r.key === "body")?.state === "local",
      JSON.stringify(d2)
    );

    writes.length = 0;
    const push2 = await run(["push", "space", "--id", "2", "-y"]);
    const p2 = parse(push2);
    expect(
      "space E2E: マルチスレッドの push space は PUT /k/v1/space.json と PUT /k/v1/space/body.json を送り、サニタイズ差分を sanitized: true で通知してローカルへ取り直す",
      push2.status === 0 &&
        p2.applied === true &&
        p2.sanitized === true &&
        push2.stderr.includes("許可されていないタグや属性が削除・整形されました") &&
        writes.length === 2 &&
        writes[0].path === "/k/v1/space.json" &&
        writes[1].path === "/k/v1/space/body.json" &&
        Boolean(p2.backupDir) &&
        fs.existsSync(path.join(p2.backupDir, "body.html")) &&
        readText(path.join(spaceDir("space-2"), "body.html")) === '<div><a href="https://example.com" target="_blank" rel="nofollow noopener noreferrer">リンク</a></div>\n',
      `status=${push2.status}\n${push2.stdout}\n${push2.stderr}\nwrites=${JSON.stringify(writes)}`
    );

    // サニタイズ取り直し後の diff space は conflict にならず same になる
    const diffAfterSanitize = parse(await run(["diff", "space", "--id", "2"]));
    expect(
      "space E2E: サニタイズされた保存結果を取り直した直後の diff space はすべて same",
      diffAfterSanitize.resources?.every((r) => r.state === "same"),
      JSON.stringify(diffAfterSanitize)
    );

    // 4. シングルスレッド（space-3）の body.html 編集は PUT /k/v1/space/thread.json（defaultThread: "99"）へ送る
    fs.writeFileSync(path.join(spaceDir("space-3"), "body.html"), "<p>スレッド更新</p>\n", "utf8");
    writes.length = 0;
    const push3 = await run(["push", "space", "--id", "3", "-y"]);
    const p3 = parse(push3);
    expect(
      "space E2E: シングルスレッドの本文は PUT /k/v1/space/thread.json（id=defaultThread）へ送り、サニタイズが無ければ sanitized: false",
      push3.status === 0 &&
        p3.applied === true &&
        p3.sanitized === false &&
        writes.length === 1 &&
        writes[0].path === "/k/v1/space/thread.json" &&
        writes[0].body.id === "99" &&
        writes[0].body.body === "<p>スレッド更新</p>",
      `status=${push3.status}\n${push3.stdout}\nwrites=${JSON.stringify(writes)}`
    );

    // 5. ゲストスペース（guestspace-14）の自動判定と push space
    const pullGuest = await run(["pull", "guestspaces", "--id", "14"]);
    expect("space E2E: pull guestspaces --id 14 が成功", pullGuest.status === 0, pullGuest.stderr);
    fs.writeFileSync(path.join(spaceDir("guestspace-14"), "body.html"), "<p>ゲスト更新</p>\n", "utf8");
    const diffGuest = parse(await run(["diff", "space", "--id", "14"]));
    expect("space E2E: diff space --id 14 は --guestspace 無しでも guestspace-14 を自動判定", diffGuest.guestSpaceId === "14" && diffGuest.resources?.find((r) => r.key === "body")?.state === "local", JSON.stringify(diffGuest));
    writes.length = 0;
    const pushGuest = await run(["push", "space", "--id", "14", "-y"]);
    expect(
      "space E2E: ゲストスペースの push space は /k/guest/14/v1/space/body.json へ送る",
      pushGuest.status === 0 && writes.length === 1 && writes[0].path === "/k/guest/14/v1/space/body.json",
      `status=${pushGuest.status}\nwrites=${JSON.stringify(writes)}`
    );

    // 6. pull spaces のローカル編集保持と --discard-local
    fs.writeFileSync(path.join(spaceDir("space-2"), "body.html"), "<p>ローカル下書き</p>\n", "utf8");
    const pullKeep = await run(["pull", "spaces", "--id", "2", "-f"]);
    const pk = parse(pullKeep);
    expect(
      "space E2E: pull spaces は body.html のローカル編集を保持し spaceLocalEdits に出す",
      pullKeep.status === 0 &&
        readText(path.join(spaceDir("space-2"), "body.html")) === "<p>ローカル下書き</p>\n" &&
        JSON.stringify(pk.spaceLocalEdits) === JSON.stringify([{ file: "body.html", conflict: false }]),
      `${pullKeep.stdout}\n${pullKeep.stderr}`
    );
    const pullDiscard = await run(["pull", "spaces", "--id", "2", "--discard-local"]);
    expect(
      "space E2E: pull spaces --discard-local はローカル編集を破棄して環境の本文に戻す",
      pullDiscard.status === 0 &&
        !("spaceLocalEdits" in parse(pullDiscard)) &&
        readText(path.join(spaceDir("space-2"), "body.html")).includes("rel=\"nofollow noopener noreferrer\""),
      `${pullDiscard.stdout}\n${pullDiscard.stderr}`
    );
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 1 グループの例外で後続グループと最終サマリが止まらないよう、例外を失敗として記録して続行する。
// 例外で途中終了したグループのグラントが後続へ漏れないよう、毎回グラントを空に戻す。
async function runGroup(name, fn) {
  // SMOKE_ONLY=safety,favorite のように指定すると、そのグループだけ実行する（改修中の素早い確認用。最終確認は全件）。
  if (ONLY_GROUPS.size > 0 && !ONLY_GROUPS.has(name)) return;
  try {
    await fn();
  } catch (error) {
    ng(`${name}: 例外で中断`, error?.stack || error);
  } finally {
    resetGrants();
  }
}

// ---- 実行 ---------------------------------------------------------------
console.log("=== kint-origin smoke test ===");
console.log("[dev-agents] 開発設定の同期・保護検証");
try {
  syncDevAgents({ root: ROOT, check: true });
  checkRepositoryKnowledge(ROOT);
  ok("開発設定の同期検査");
  const shared = spawnSync("git", ["check-ignore", "--no-index", "--", ".agents/dev-config.json", ".agents/generated.json", ".agents/skills/kint-origin-development/SKILL.md", ".agents/skills/kint-origin-validation/SKILL.md", ".agents/skills/kint-origin-agent-config/SKILL.md", ".claude/settings.json"], { cwd: ROOT, encoding: "utf8" });
  expect("開発用の正本と共有設定が一括ignoreされていない", shared.status === 1, shared.stdout || shared.stderr);
} catch (error) {
  ng("開発設定の同期検査", error.message);
}
const devAgents = spawnSync(process.execPath, ["--test", path.join(ROOT, "scripts/dev-agents.test.mjs"), path.join(ROOT, "scripts/agent-knowledge.test.mjs")], { cwd: ROOT, encoding: "utf8" });
expect("開発設定の同期・独自変更保護・新規配置テスト", devAgents.status === 0, `${devAgents.stdout || ""}\n${devAgents.stderr || ""}`);
build();
const policyModule = await import(pathToFileURL(path.join(ROOT, "dist", "policy.js")).href);
const resetGrants = () => policyModule.activateGrants([]);
await runGroup("offline", offlineTests);
await runGroup("version", versionTests);
await runGroup("http", httpPolicyTests);
await runGroup("limit", limitTests);
await runGroup("recordCsv", recordCsvTests);
await runGroup("attachment", attachmentTests);
await runGroup("fileDownloadAtomic", fileDownloadAtomicTests);
await runGroup("pluginConfig", pluginConfigTests);
await runGroup("pluginSources", () => pluginSourceTests({ expect, runCli }));
await runGroup("indexPlugins", () => pullIndexPluginTests({ expect, runCliAsync, startMockKintone, mockEnv, writeJsonFile, noShellCreds: NO_SHELL_CREDS }));
await runGroup("commonComments", () => commonCommentsTests({ expect, runCliAsync, startMockKintone, mockEnv, noShellCreds: NO_SHELL_CREDS }));
await runGroup("bulkPull", () => bulkPullTests({ expect, runCliAsync, startMockKintone, mockEnv, noShellCreds: NO_SHELL_CREDS }));
await runGroup("addon", () => addonTests({ ROOT, expect }));
await runGroup("usersPii", usersPiiWarningTests);
await runGroup("pushItems", pushItemsTests);
await runGroup("appDraft", appDraftTests);
await runGroup("pushCli", pushCliTests);
await runGroup("pushCreatePreflight", pushCreatePreflightTests);
await runGroup("appCreate", () => appCreateTests({ ROOT, expect, runCli, runCliAsync, startMockKintone, mockEnv }));
await runGroup("pushDeploy", pushDeployTests);
await runGroup("policy", policyTests);
await runGroup("kintoneClientPolicy", kintoneClientPolicyTests);
await runGroup("guestSpace", guestSpaceTests);
await runGroup("pullKintoneGuestE2E", pullKintoneGuestE2ETests);
await runGroup("permissionDeny", permissionDenyTests);
await runGroup("favorite", favoriteTests);
await runGroup("appDiffPure", appDiffPureTests);
await runGroup("appDiff", appDiffTests);
await runGroup("appDiffGuest", appDiffGuestTests);
await runGroup("spacePush", spacePushTests);
await runGroup("recordJob", recordJobTests);
await runGroup("recordValues", recordValuesTests);
await runGroup("recordCopy", recordCopyTests);
await runGroup("recordsReadE2E", recordsReadE2ETests);
await runGroup("rehearsal", () => rehearsalTests({ expect, runCli, runCliAsync, startMockKintone, mockEnv, noShellCreds: NO_SHELL_CREDS }));
await runGroup("recordsDiffErrorE2E", recordsDiffErrorE2ETests);
await runGroup("recordsPushE2E", recordsPushE2ETests);
await runGroup("recordsPushFailureE2E", recordsPushFailureE2ETests);
await runGroup("recordsCli", recordsCliTests);
await runGroup("import", () => importTests({ ROOT, expect, runCli, runCliAsync, startStatefulMock, mockEnv, writeJsonFile }));
await runGroup("customizeE2E", customizeE2ETests);
await runGroup("safety", () => safetyTests({ ROOT, expect, runCli, runCliAsync, startMockKintone, startStatefulMock, mockEnv }));
await runGroup("agents", agentsTests);
await runGroup("docsMcp", docsMcpTests);
await runGroup("html", htmlTests);
await runGroup("live", liveTests);
await runGroup("pushLive", pushLiveTests);

console.log(`\n結果: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("失敗:");
  for (const f of failures) console.log(`  - ${f.name}`);
  process.exit(1);
}
