import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oneShotUrl = pathToFileURL(path.join(ROOT, "dist", "oneShot.js")).href;
const RECORDS_ONCE = "KINT_ORIGIN_ALLOW_PULL_RECORDS_ALL_ONCE";

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function callOneShot(cwd, body) {
  const script = `const { consumeOneShotSetting } = await import(${JSON.stringify(oneShotUrl)});\n${body}`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd, encoding: "utf8", windowsHide: true });
}

function oneShotFileTests({ expect }) {
  console.log("[offline] 全件取得の一度限り .env 許可");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-one-shot-"));
  try {
    const content = Buffer.from(`\uFEFFCYBOZU_PASSWORD=dummy-secret\r\n# keep this comment\r\nexport ${RECORDS_ONCE} = 'true'\r\nKINT_ORIGIN_ALLOW_PULL_COMMENTS_ALL_ONCE=false\r\n`, "utf8");
    fs.writeFileSync(path.join(tmp, ".env"), content);
    const result = callOneShot(tmp, `const fs = await import('node:fs');\nconst snapshot = fs.readFileSync('.env');\nconsumeOneShotSetting(${JSON.stringify(RECORDS_ONCE)}, snapshot);`);
    const expected = Buffer.from(content.toString("utf8").replace("'true'", "'false'"), "utf8");
    expect("一度限り許可は BOM・CRLF・コメント・引用符を保って false にする", result.status === 0 && fs.readFileSync(path.join(tmp, ".env")).equals(expected), `${result.stderr}\n${fs.readFileSync(path.join(tmp, ".env"), "utf8")}`);
    expect("一度限り許可の成功後にロック・一時ファイルが残らない", !fs.existsSync(path.join(tmp, ".env.kint-origin-all.lock")) && fs.readdirSync(tmp).every((name) => !name.endsWith(".tmp")), fs.readdirSync(tmp).join(","));

    writeText(path.join(tmp, ".env"), `${RECORDS_ONCE}=true\n`);
    writeText(path.join(tmp, ".env.kint-origin-all.lock"), "held\n");
    const stale = callOneShot(tmp, `const fs = await import('node:fs');\nconsumeOneShotSetting(${JSON.stringify(RECORDS_ONCE)}, fs.readFileSync('.env'));`);
    expect("既存ロックがある場合は停止し、他プロセスのロックを削除しない", stale.status !== 0 && fs.existsSync(path.join(tmp, ".env.kint-origin-all.lock")) && fs.readFileSync(path.join(tmp, ".env"), "utf8") === `${RECORDS_ONCE}=true\n`, stale.stderr);
    fs.unlinkSync(path.join(tmp, ".env.kint-origin-all.lock"));

    writeText(path.join(tmp, ".env"), `${RECORDS_ONCE}=true\n`);
    const changed = callOneShot(tmp, `const fs = await import('node:fs');\nconst snapshot = fs.readFileSync('.env');\nfs.appendFileSync('.env', '# concurrent edit\\n');\nconsumeOneShotSetting(${JSON.stringify(RECORDS_ONCE)}, snapshot);`);
    expect("確認後に .env が変わった場合は停止し、変更を上書きしない", changed.status !== 0 && fs.readFileSync(path.join(tmp, ".env"), "utf8") === `${RECORDS_ONCE}=true\n# concurrent edit\n`, changed.stderr);
    expect("競合中断後も自分のロックだけを片付ける", !fs.existsSync(path.join(tmp, ".env.kint-origin-all.lock")), fs.readdirSync(tmp).join(","));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function bulkPullTests({ expect, runCliAsync, startMockKintone, mockEnv, noShellCreds }) {
  oneShotFileTests({ expect });
  console.log("[offline] 全件取得の対象・完全索引・ホスト・dry-run");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-bulk-pull-"));
  const apps = [
    { appId: "30", code: "domain-app", name: "Domain app", spaceId: null, modifiedAt: "2026-01-01T00:00:00Z" },
    { appId: "40", code: "space-app", name: "Space app", spaceId: "7", modifiedAt: "2026-01-01T00:00:00Z" },
    { appId: "50", code: "guest-app", name: "Guest app", spaceId: "62", modifiedAt: "2026-01-01T00:00:00Z" }
  ];
  const mock = await startMockKintone((url) => {
    if (url.pathname === "/k/v1/apps.json") return [200, { apps }];
    if (url.pathname === "/k/v1/plugins.json") return [200, { plugins: [] }];
    if (url.pathname === "/k/v1/space.json" && url.searchParams.get("id") === "62") return [400, { code: "GAIA_IL25", message: "Guest space" }];
    if (url.pathname === "/k/guest/62/v1/app.json") return [200, { appId: "50", spaceId: "62", name: "Guest app" }];
    if (url.pathname === "/k/v1/app.json") {
      const appId = url.searchParams.get("id");
      const app = apps.find((item) => item.appId === appId);
      return app ? [200, { appId: app.appId, spaceId: app.spaceId, name: app.name }] : [404, { code: "GAIA_AP01", message: "not found" }];
    }
    if (url.pathname === "/k/guest/62/v1/space.json") return [200, { id: "62", isGuest: true }];
    if (url.pathname === "/k/v1/space.json") return [200, { id: url.searchParams.get("id"), isGuest: false }];
    return null;
  });
  const env = mockEnv(mock.baseUrl);
  const envText = `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n")}\nKINT_ORIGIN_ALLOW_PULL_RECORDS=true\nKINT_ORIGIN_ALLOW_BULK_RECORDS=true\n${RECORDS_ONCE}=true\n`;
  try {
    writeText(path.join(tmp, ".env"), envText);
    const indexed = await runCliAsync(["pull", "index"], tmp, { ...noShellCreds, ...env });
    const markerPath = path.join(tmp, "data", "kintone", "index", ".bulk-source.json");
    const marker = fs.existsSync(markerPath) ? readJson(markerPath) : null;
    expect("pull index はホストと apps fingerprint を持つ完全索引記録を作る", indexed.status === 0 && marker?.version === 1 && marker.origin === new URL(mock.baseUrl).host && /^[a-f0-9]{64}$/.test(marker.appsSha256), `${indexed.stderr}\n${JSON.stringify(marker)}`);

    const requestsBeforeDryRun = mock.requests.length;
    const dryRun = await runCliAsync(["pull", "records", "--all-indexed", "--expect-host", new URL(mock.baseUrl).host, "--dry-run"], tmp, { ...noShellCreds, ...env });
    const preview = JSON.parse(dryRun.stdout || "null");
    expect("all-indexed dry-run は ID 順の全対象と取得先を示し、初回索引でもゲストアプリを判定する", dryRun.status === 0 && preview?.status === "dry-run" && preview.targets.map((target) => target.appId).join(",") === "30,40,50" && preview.targets.every((target) => target.path.includes("app-")) && preview.targets.find((target) => target.appId === "50")?.guestSpaceId === "62" && preview.targets.find((target) => target.appId === "50")?.path.includes("guestspace-62") && preview.oneShotConsumed === false, `${dryRun.stdout}\n${dryRun.stderr}`);
    expect("all-indexed dry-run はレコード API・保存先・.env を変更しない", !mock.requests.slice(requestsBeforeDryRun).some((request) => /\/records\.json|\/record\/comments\.json|\/file\.json/.test(request)) && fs.readFileSync(path.join(tmp, ".env"), "utf8") === envText && !fs.existsSync(path.join(tmp, "data", "kintone", "apps", "app-30", "records", "records.csv")), mock.requests.slice(requestsBeforeDryRun).join("\n"));

    const spaceAppDir = path.join(tmp, "data", "kintone", "spaces", "space-7", "apps", "app-40");
    fs.mkdirSync(spaceAppDir, { recursive: true });
    fs.writeFileSync(path.join(spaceAppDir, "records"), "sentinel", "utf8");
    const requestsBeforePathConflict = mock.requests.length;
    const pathConflict = await runCliAsync(["pull", "records", "--all-indexed", "--expect-host", new URL(mock.baseUrl).host, "--dry-run"], tmp, { ...noShellCreds, ...env });
    expect("all-indexed dry-run は records/ が通常ファイルなら拒否し、レコード API 前に停止する", pathConflict.status === 1
      && pathConflict.stderr.includes("records") && pathConflict.stderr.includes("通常ディレクトリ")
      && !mock.requests.slice(requestsBeforePathConflict).some((request) => /\/records\.json|\/record\/comments\.json|\/file\.json/.test(request))
      && fs.readFileSync(path.join(spaceAppDir, "records"), "utf8") === "sentinel", pathConflict.stderr);
    fs.unlinkSync(path.join(spaceAppDir, "records"));
    fs.rmSync(spaceAppDir, { recursive: true, force: true });

    const requestsBeforeWrongHost = mock.requests.length;
    const wrongHost = await runCliAsync(["pull", "records", "--all-indexed", "--expect-host", "other.example", "--dry-run"], tmp, { ...noShellCreds, ...env });
    expect("expect-host と .env が異なる場合は API 前に停止", wrongHost.status === 1 && wrongHost.stderr.includes("接続先確認に失敗") && mock.requests.length === requestsBeforeWrongHost, wrongHost.stderr);

    const requestsBeforeNonTty = mock.requests.length;
    const nonTty = await runCliAsync(["pull", "records", "--all-indexed", "--expect-host", new URL(mock.baseUrl).host], tmp, { ...noShellCreds, ...env });
    expect("全件の実取得は非対話実行で停止し、一度限り許可を消費しない", nonTty.status === 1 && nonTty.stderr.includes("対話確認が必要") && mock.requests.length === requestsBeforeNonTty && fs.readFileSync(path.join(tmp, ".env"), "utf8") === envText, nonTty.stderr);

    writeText(path.join(tmp, "favorites", "sample.json"), JSON.stringify({ apps: [30], spaces: [7] }, null, 2) + "\n");
    const requestsBeforeFavorite = mock.requests.length;
    const favorite = await runCliAsync(["pull", "favorite", "--name", "sample", "--with-records", "--expect-host", new URL(mock.baseUrl).host, "--dry-run"], tmp, { ...noShellCreds, ...env });
    const favoritePreview = JSON.parse(favorite.stdout || "null");
    expect("favorite dry-run は apps のデータ対象と spaces の設定対象を区別して表示", favorite.status === 0 && favoritePreview?.status === "dry-run" && favoritePreview.targets.map((target) => target.appId).join(",") === "30" && favoritePreview.settingsTargets?.apps.join(",") === "30" && favoritePreview.settingsTargets?.spaces.join(",") === "7", `${favorite.stdout}\n${favorite.stderr}`);
    expect("favorite dry-run は設定・レコードを書き込まずレコード API を呼ばない", !mock.requests.slice(requestsBeforeFavorite).some((request) => /\/records\.json|\/record\/comments\.json|\/file\.json/.test(request)) && !fs.existsSync(path.join(tmp, "data", "kintone", "apps", "app-30", "records", "records.csv")), mock.requests.slice(requestsBeforeFavorite).join("\n"));

    const requestsBeforeInvalid = mock.requests.length;
    const badFlags = await runCliAsync(["pull", "favorite", "--name", "sample", "--with-attachments", "--expect-host", new URL(mock.baseUrl).host], tmp, { ...noShellCreds, ...env });
    expect("favorite は --with-attachments 単独を API 前に拒否", badFlags.status === 1 && badFlags.stderr.includes("--with-records と一緒") && mock.requests.length === requestsBeforeInvalid, badFlags.stderr);

    writeText(path.join(tmp, "data", "kintone", "index", "apps.json"), JSON.stringify([...apps, { appId: "60", code: "new", name: "new", spaceId: "", guestSpaceId: "", modifiedAt: "" }], null, 2) + "\n");
    const requestsBeforeStale = mock.requests.length;
    const staleIndex = await runCliAsync(["pull", "comments", "--all-indexed", "--expect-host", new URL(mock.baseUrl).host, "--dry-run"], tmp, { ...noShellCreds, ...env });
    expect("完全索引 fingerprint が古い場合は pull index の再実行を案内し API 前に止める", staleIndex.status === 1 && staleIndex.stderr.includes("pull index を実行し直してください") && mock.requests.length === requestsBeforeStale, staleIndex.stderr);
  } finally {
    mock.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
