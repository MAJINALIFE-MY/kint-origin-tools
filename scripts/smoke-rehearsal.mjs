import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readCsv(file) {
  return parse(fs.readFileSync(file, "utf8"), { bom: true, relax_column_count: false, skip_empty_lines: false });
}

function recordForm() {
  return {
    properties: {
      レコード番号: { code: "レコード番号", type: "RECORD_NUMBER", label: "レコード番号" },
      社員番号: { code: "社員番号", type: "SINGLE_LINE_TEXT", label: "社員番号", required: true, unique: true },
      氏名: { code: "氏名", type: "MULTI_LINE_TEXT", label: "氏名" },
      確認: { code: "確認", type: "CHECK_BOX", label: "確認", options: { A: { label: "A" }, C: { label: "C" } } },
      日時: { code: "日時", type: "DATETIME", label: "日時" },
      明細: { code: "明細", type: "SUBTABLE", label: "明細", fields: { 内側: { code: "内側", type: "SINGLE_LINE_TEXT", label: "内側" } } }
    },
    revision: "7"
  };
}

function recordLayout() {
  return {
    layout: [
      { type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "社員番号" }, { type: "MULTI_LINE_TEXT", code: "氏名" }, { type: "CHECK_BOX", code: "確認" }, { type: "DATETIME", code: "日時" }] },
      { type: "SUBTABLE", code: "明細", fields: [{ type: "SINGLE_LINE_TEXT", code: "内側" }] }
    ]
  };
}

function recordValue(type, value) {
  return { type, value };
}

export async function rehearsalTests({ expect, runCli, runCliAsync, startMockKintone, mockEnv, noShellCreds }) {
  console.log("[offline] diff rehearsal: 取得時型・手動取込CSV・再生成保護");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-rehearsal-"));
  const form = recordForm();
  const layout = recordLayout();
  const record = {
    $id: recordValue("__ID__", "1"),
    $revision: recordValue("__REVISION__", "1"),
    レコード番号: recordValue("RECORD_NUMBER", "1"),
    社員番号: recordValue("SINGLE_LINE_TEXT", "0001"),
    氏名: recordValue("MULTI_LINE_TEXT", "旧氏名"),
    確認: recordValue("CHECK_BOX", ["A", "C"]),
    日時: recordValue("DATETIME", "2026-01-10T00:15:30Z"),
    明細: recordValue("SUBTABLE", [{ id: "row-1", value: { 内側: recordValue("SINGLE_LINE_TEXT", "明細1") } }, { id: "row-2", value: { 内側: recordValue("SINGLE_LINE_TEXT", "明細2") } }])
  };
  const mock = await startMockKintone((url) => {
    if (url.pathname === "/k/v1/app.json") return [200, { appId: "70", name: "Rehearsal", spaceId: null }];
    if (url.pathname === "/k/v1/app/form/fields.json") return [200, form];
    if (url.pathname === "/k/v1/app/form/layout.json") return [200, layout];
    if (url.pathname === "/k/v1/records.json") return [200, { records: [record], totalCount: "1" }];
    return null;
  }, { tls: true });
  try {
    const env = mockEnv(mock.baseUrl);
    writeText(path.join(tmp, ".env"), `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n")}\nKINT_ORIGIN_ALLOW_PULL_RECORDS=true\n`);
    const init = runCli(["init"], tmp);
    expect("init: rehearsal 機能を含む新規ドメインを作成", init.status === 0, init.stderr);

    const pull = await runCliAsync(["pull", "records", "--id", "70", "--yes"], tmp, { ...noShellCreds, ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    const recordsDir = path.join(tmp, "data", "kintone", "apps", "app-70", "records");
    const savedSchema = fs.existsSync(path.join(recordsDir, ".kint-origin-records-schema.json"))
      ? JSON.parse(fs.readFileSync(path.join(recordsDir, ".kint-origin-records-schema.json"), "utf8"))
      : null;
    expect("pull records: CSVと公開フォーム型を保存しCSVの生バイトハッシュを記録", pull.status === 0 && savedSchema?.formRevision === "7" && savedSchema?.fields?.氏名 === "MULTI_LINE_TEXT" && savedSchema.csvSha256 === crypto.createHash("sha256").update(fs.readFileSync(path.join(recordsDir, "records.csv"))).digest("hex"), `${pull.stderr}\n${JSON.stringify(savedSchema)}`);

    const appDir = path.join(tmp, "data", "kintone", "apps", "app-70");
    const editedForm = recordForm();
    editedForm.properties.氏名 = { code: "氏名", type: "SINGLE_LINE_TEXT", label: "氏名" };
    editedForm.properties.確認.options = { A: { label: "A" }, B: { label: "B" } };
    editedForm.properties.追加 = { code: "追加", type: "SINGLE_LINE_TEXT", label: "追加" };
    writeJson(path.join(appDir, "form", "fields.json"), editedForm);
    const importDir = path.join(tmp, "push", "import", "update-rows");
    writeJson(path.join(importDir, "import.json"), { app: 70, updateKey: "社員番号" });
    writeText(
      path.join(importDir, "records.csv"),
      stringify([["社員番号", "氏名", "確認", "追加", "日時"], ["0001", "新氏名", "A\nB", "追加値", "2026-01-10T00:15:30Z"]], { record_delimiter: "\n" })
    );
    const baselineRequests = mock.requests.length;
    const result = await runCliAsync(["diff", "rehearsal", "--id", "70", "--import", "update-rows"], tmp, { ...noShellCreds, KINT_ORIGIN_ALLOW_PULL_RECORDS: "invalid" });
    const summary = JSON.parse(result.stdout || "{}");
    const outputDir = path.join(tmp, "push", "rehearsal", "70");
    const baseline = fs.existsSync(path.join(outputDir, "baseline.csv")) ? readCsv(path.join(outputDir, "baseline.csv")) : [];
    const changes = fs.existsSync(path.join(outputDir, "changes.csv")) ? readCsv(path.join(outputDir, "changes.csv")) : [];
    const report = fs.existsSync(path.join(outputDir, "report.json")) ? JSON.parse(fs.readFileSync(path.join(outputDir, "report.json"), "utf8")) : null;
    expect("diff rehearsal: env許可が不正でもローカル生成し、mock APIへのアクセスを増やさない", result.status === 0 && summary.status === "generated" && mock.requests.length === baselineRequests, `${result.stderr}\n${result.stdout}\n${mock.requests.slice(baselineRequests).join("\n")}`);
    expect("baseline: 型変更列は空欄、追加列を出し、複数行のサブテーブルを1レコードにする", baseline.length === 2 && baseline[0].includes("社員番号") && baseline[0].includes("氏名") && baseline[0].includes("追加") && baseline[1][baseline[0].indexOf("氏名")] === "" && baseline[1][baseline[0].indexOf("社員番号")] === "0001", JSON.stringify(baseline));
    expect("baseline: 複数選択を画面取込用の選択肢列にし、削除選択肢と秒をレポート", baseline[0].includes("確認[A]") && baseline[0].includes("確認[B]") && baseline[1][baseline[0].indexOf("確認[A]")] === "1" && baseline[1][baseline[0].indexOf("確認[B]")] === "" && report?.warningDetails?.some((item) => item.code === "removed-choice") && report?.warningDetails?.some((item) => item.code === "truncated-seconds"), `${JSON.stringify(baseline)}\n${JSON.stringify(report?.warningDetails)}`);
    expect("changes: 更新キーの先頭ゼロとチェックボックス選択肢列を保持", changes.length === 2 && changes[0].includes("確認[A]") && changes[1][changes[0].indexOf("社員番号")] === "0001" && changes[1][changes[0].indexOf("確認[A]")] === "1" && changes[1][changes[0].indexOf("確認[B]")] === "1", JSON.stringify(changes));
    expect("init: 型情報・ロック・rehearsal出力をGit除外", (() => {
      const ignore = fs.readFileSync(path.join(tmp, ".gitignore"), "utf8");
      return ignore.includes(".kint-origin-records-schema.json") && ignore.includes(".kint-origin-records.lock") && ignore.includes("/push/rehearsal/");
    })(), fs.readFileSync(path.join(tmp, ".gitignore"), "utf8"));

    const withoutImport = await runCliAsync(["diff", "rehearsal", "--id", "70"], tmp, { ...noShellCreds });
    expect("diff rehearsal: --importを省くと前回生成したchanges.csvを除去", withoutImport.status === 0 && JSON.parse(withoutImport.stdout).changesFile === null && !fs.existsSync(path.join(outputDir, "changes.csv")), `${withoutImport.stderr}\n${withoutImport.stdout}`);

    const baselinePath = path.join(outputDir, "baseline.csv");
    fs.appendFileSync(baselinePath, "tampered\n", "utf8");
    const tampered = await runCliAsync(["diff", "rehearsal", "--id", "70"], tmp, { ...noShellCreds });
    expect("diff rehearsal: 手編集された出力を上書きしない", tampered.status === 1 && tampered.stderr.includes("上書きしません") && fs.readFileSync(baselinePath, "utf8").endsWith("tampered\n"), tampered.stderr);
  } finally {
    mock.server.closeAllConnections();
    mock.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
