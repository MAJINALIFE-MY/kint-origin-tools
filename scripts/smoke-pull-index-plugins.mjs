import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const INSTALLED = "data/kintone/plugin/installed.json";
const SHARED = "data/kintone/plugin/sources.json";
const LOCAL = "data/kintone/plugin/sources.local.json";

export async function pullIndexPluginTests({ expect, runCliAsync, startMockKintone, mockEnv, writeJsonFile, noShellCreds }) {
  console.log("[offline] pull index: プラグイン一覧の取得と保存");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-index-plugins-"));
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-index-fresh-"));
  const pluginOnly = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-pull-plugins-"));
  const installed = path.join(tmp, INSTALLED);
  const shared = path.join(tmp, SHARED);
  const local = path.join(tmp, LOCAL);
  const appIndex = path.join(tmp, "data/kintone/index/apps.json");
  const spaceIndex = path.join(tmp, "data/kintone/index/spaces.json");
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const plugins = Array.from({ length: 101 }, (_, i) => ({
    id: "a".repeat(30) + alphabet[Math.floor(i / 26)] + alphabet[i % 26],
    name: `プラグイン ${i}`,
    description: `説明 ${i}`,
    isMarketPlugin: i % 2 === 0,
    version: "1.0.0"
  }));
  let mode = "normal";
  const mock = await startMockKintone((url) => {
    if (url.pathname === "/k/v1/apps.json") {
      if (mode === "apps-invalid") {
        const offset = Number(url.searchParams.get("offset") || 0);
        if (offset === 100) return [200, { unexpected: [] }];
        return [200, { apps: Array.from({ length: 100 }, (_, index) => ({ appId: String(1000 + index), name: `App ${index}`, spaceId: "" })) }];
      }
      return [200, { apps: [{ appId: "1", name: `テストアプリ ${mode}`, spaceId: "", modifiedAt: "2026-01-01T00:00:00Z" }] }];
    }
    if (url.pathname !== "/k/v1/plugins.json") return null;
    const offset = Number(url.searchParams.get("offset"));
    if (mode === "failure" && offset === 100) return [400, { code: "TEST", message: "fixture failure" }];
    if (mode === "invalid" && offset === 100) return [200, { plugins: "invalid" }];
    if (mode === "duplicate" && offset === 100) return [200, { plugins: [plugins[0]] }];
    if (mode === "bad-fields" && offset === 100) {
      const { description, ...incomplete } = plugins[100];
      return [200, { plugins: [incomplete] }];
    }
    const activePlugins = mode === "updated" ? plugins.slice(0, 100).map((plugin, i) => i === 0
      ? { ...plugin, name: "更新後のプラグイン", description: "更新後の説明", isMarketPlugin: false, version: "2.0.0" }
      : plugin) : mode === "empty" ? [] : plugins;
    return [200, { plugins: activePlugins.slice(offset, offset + Number(url.searchParams.get("limit"))) }];
  });
  const run = (env = noShellCreds, cwd = tmp) => runCliAsync(["pull", "index"], cwd, env);
  const read = (file) => fs.readFileSync(file, "utf8");
  const parse = (file) => JSON.parse(read(file));
  try {
    const help = await runCliAsync(["pull", "index", "--help"], tmp, mockEnv(mock.baseUrl));
    expect("pull index plugins: help は必要な取得許可を表示し API に接続しない", help.status === 0
      && help.stdout.includes("KINT_ORIGIN_ALLOW_PULL_KINTONE") && mock.requests.length === 0, help.stdout || help.stderr);
    const initial = await runCliAsync(["init"], tmp, mockEnv(mock.baseUrl));
    expect("pull index plugins: 接続設定があっても init は API に接続しない", initial.status === 0 && read(shared) === "[]\n" && mock.requests.length === 0, initial.stderr);
    fs.writeFileSync(path.join(tmp, ".env"), Object.entries(mockEnv(mock.baseUrl)).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", "utf8");

    const githubUrl = "https://github.com/example-org/plugin";
    const sharedSources = [{ alias: "named", pluginId: plugins[0].id, githubUrl }];
    const localSources = [{ alias: "personal", pluginId: plugins[1].id, path: "custom" }];
    writeJsonFile(shared, sharedSources);
    writeJsonFile(local, localSources);
    const sharedBefore = read(shared);
    const localBefore = read(local);
    const first = await run();
    const summary = JSON.parse(first.stdout || "null");
    const pluginRequests = mock.requests.filter((request) => request.includes("/k/v1/plugins.json"));
    expect("pull index plugins: 101件を全項目保持してinstalled.jsonへ保存し、参照台帳を変更しない", first.status === 0 && mock.requests.length === 3
      && pluginRequests.length === 2 && pluginRequests[0].includes("limit=100") && pluginRequests[1].includes("offset=100")
      && summary?.apps === 1 && summary.apiCalls === 3 && summary.written.includes(INSTALLED)
      && summary.written.includes(SHARED) === false
      && JSON.stringify(parse(installed).plugins) === JSON.stringify(plugins)
      && JSON.parse(read(appIndex))[0]?.name === "テストアプリ normal"
      && first.stderr.includes("101 件") && read(shared) === sharedBefore && read(local) === localBefore,
    first.stderr || read(installed));

    const source = await runCliAsync(["show", "plugin-source", "--id", plugins[2].id], tmp, noShellCreds);
    const noSource = JSON.parse(source.stdout || "null");
    expect("pull index plugins: installed一覧のAPI項目からno-sourceを返す", source.status === 0 && noSource?.status === "no-source"
      && noSource.sourceFile === INSTALLED && noSource.displayName === plugins[2].name && noSource.version === "1.0.0", source.stdout || source.stderr);
    fs.mkdirSync(path.join(tmp, "data/kintone/plugin/custom"));
    const withSourceRow = [...sharedSources, { alias: "third", pluginId: plugins[2].id, path: "custom" }];
    writeJsonFile(shared, withSourceRow);
    const withSource = await runCliAsync(["show", "plugin-source", "--id", plugins[2].id], tmp, noShellCreds);
    expect("pull index plugins: installed一覧のIDを使って手動登録したソースを照会", withSource.status === 0
      && JSON.parse(withSource.stdout || "null")?.status === "found", withSource.stdout || withSource.stderr);

    const installedBeforeUpdate = read(installed);
    const sourcesBeforeUpdate = read(shared);
    mode = "updated";
    const updated = await run(mockEnv(mock.baseUrl));
    const updatedPlugins = parse(installed).plugins;
    expect("pull index plugins: 再取得でAPI項目を更新し、削除済みIDを一覧から外す", updated.status === 0
      && updatedPlugins.length === 100 && updatedPlugins[0].name === "更新後のプラグイン"
      && updatedPlugins[0].description === "更新後の説明" && updatedPlugins[0].isMarketPlugin === false
      && updatedPlugins[0].version === "2.0.0" && read(shared) === sourcesBeforeUpdate
      && read(local) === localBefore && read(installed) !== installedBeforeUpdate,
    updated.stderr || read(installed));

    mode = "empty";
    const empty = await run(mockEnv(mock.baseUrl));
    expect("pull index plugins: 0件ならAPI形式の空配列を保存", empty.status === 0 && JSON.stringify(parse(installed)) === '{"plugins":[]}', empty.stderr || read(installed));

    mode = "normal";
    const beforeDisabled = mock.requests.length;
    const beforeDisabledInstalled = read(installed);
    fs.writeFileSync(path.join(tmp, ".env"), "KINT_ORIGIN_ALLOW_PULL_KINTONE=false\n", "utf8");
    const disabled = await run(mockEnv(mock.baseUrl));
    expect("pull index plugins: 取得が無効な場合は API に接続せず取得物を保全", disabled.status === 1
      && mock.requests.length === beforeDisabled && read(installed) === beforeDisabledInstalled, disabled.stderr);
    fs.writeFileSync(path.join(tmp, ".env"), "KINT_ORIGIN_ALLOW_PULL_KINTONE=true\n", "utf8");

    const appIndexBefore = read(appIndex);
    const spaceIndexBefore = read(spaceIndex);
    const bulkSourcePath = path.join(tmp, "data/kintone/index/.bulk-source.json");
    const bulkSourceBefore = read(bulkSourcePath);
    const installedBeforeFailure = read(installed);
    const sharedBeforeFailure = read(shared);
    for (const failureMode of ["failure", "invalid", "duplicate", "bad-fields"]) {
      mode = failureMode;
      const result = await run(mockEnv(mock.baseUrl));
      expect(`pull index plugins: ${failureMode} の途中失敗で索引・一覧・参照台帳を保全`, result.status === 1
        && read(installed) === installedBeforeFailure && read(shared) === sharedBeforeFailure && read(local) === localBefore
        && read(appIndex) === appIndexBefore && read(spaceIndex) === spaceIndexBefore, result.stderr);
    }

    mode = "apps-invalid";
    const requestsBeforeInvalidApps = mock.requests.length;
    const invalidAppsPage = await run(mockEnv(mock.baseUrl));
    expect("pull index: apps の2ページ目に配列が無い場合は完全索引を作らず、前回成果を保つ", invalidAppsPage.status === 1
      && mock.requests.length === requestsBeforeInvalidApps + 2
      && read(appIndex) === appIndexBefore && read(spaceIndex) === spaceIndexBefore
      && read(bulkSourcePath) === bulkSourceBefore && read(installed) === installedBeforeFailure,
    `${invalidAppsPage.stdout}\n${invalidAppsPage.stderr}`);

    mode = "failure";
    const failedFresh = await run(mockEnv(mock.baseUrl), fresh);
    expect("pull index plugins: 初回の一覧取得が失敗したら索引・台帳を作らない", failedFresh.status === 1 && !fs.existsSync(path.join(fresh, "data")), failedFresh.stderr);
    mode = "normal";
    const freshResult = await run(mockEnv(mock.baseUrl), fresh);
    const freshSummary = JSON.parse(freshResult.stdout || "null");
    expect("pull index plugins: init前の環境にもinstalled・参照雛形・Git除外を作る", freshResult.status === 0
      && freshSummary?.written.includes(INSTALLED) && freshSummary?.written.includes(SHARED)
      && freshSummary?.written.includes("data/kintone/plugin/.gitignore")
      && read(path.join(fresh, SHARED)) === "[]\n"
      && read(path.join(fresh, "data/kintone/plugin/.gitignore")) === "/sources.local.json\n"
      && JSON.stringify(JSON.parse(read(path.join(fresh, INSTALLED))).plugins) === JSON.stringify(plugins), freshResult.stderr);

    const pluginOnlyRoot = path.join(pluginOnly, "data/kintone/plugin");
    fs.mkdirSync(pluginOnlyRoot, { recursive: true });
    writeJsonFile(path.join(pluginOnly, SHARED), [{ alias: "known", path: "custom" }]);
    fs.writeFileSync(path.join(pluginOnlyRoot, ".gitignore"), "keep-this-rule\n", "utf8");
    const beforePluginHelpCalls = mock.requests.length;
    const pluginsHelp = await runCliAsync(["pull", "plugins", "--help"], pluginOnly, mockEnv(mock.baseUrl));
    expect("pull plugins: help は専用許可を表示し API に接続しない", pluginsHelp.status === 0
      && pluginsHelp.stdout.includes("KINT_ORIGIN_ALLOW_PULL_KINTONE") && mock.requests.length === beforePluginHelpCalls, pluginsHelp.stdout || pluginsHelp.stderr);
    const sourceBeforePullPlugins = read(path.join(pluginOnly, SHARED));
    const ignoreBeforePullPlugins = read(path.join(pluginOnlyRoot, ".gitignore"));
    let beforePluginOnlyCalls = mock.requests.length;
    const pluginsOnlyResult = await runCliAsync(["pull", "plugins"], pluginOnly, mockEnv(mock.baseUrl));
    const pluginsOnlySummary = JSON.parse(pluginsOnlyResult.stdout || "null");
    const pluginsOnlyRequests = mock.requests.slice(beforePluginOnlyCalls);
    expect("pull plugins: 取得一覧だけを書き、アプリ索引とソース台帳を変更しない", pluginsOnlyResult.status === 0
      && pluginsOnlyRequests.length === 2 && pluginsOnlyRequests.every((request) => request.includes("/k/v1/plugins.json"))
      && pluginsOnlySummary?.plugins === 101 && pluginsOnlySummary.apiCalls === 2
      && JSON.stringify(pluginsOnlySummary.written) === JSON.stringify([INSTALLED])
      && JSON.stringify(JSON.parse(read(path.join(pluginOnly, INSTALLED))).plugins) === JSON.stringify(plugins)
      && read(path.join(pluginOnly, SHARED)) === sourceBeforePullPlugins
      && read(path.join(pluginOnlyRoot, ".gitignore")) === ignoreBeforePullPlugins
      && !fs.existsSync(path.join(pluginOnly, "data/kintone/index/apps.json")), pluginsOnlyResult.stderr);

    const installedBeforePluginOnlyFailure = read(path.join(pluginOnly, INSTALLED));
    mode = "failure";
    beforePluginOnlyCalls = mock.requests.length;
    const failedPluginOnly = await runCliAsync(["pull", "plugins"], pluginOnly, mockEnv(mock.baseUrl));
    expect("pull plugins: 2ページ目の取得失敗で既存一覧を保持", failedPluginOnly.status === 1
      && mock.requests.length === beforePluginOnlyCalls + 2
      && read(path.join(pluginOnly, INSTALLED)) === installedBeforePluginOnlyFailure
      && read(path.join(pluginOnly, SHARED)) === sourceBeforePullPlugins, failedPluginOnly.stderr);
  } finally {
    mock.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
    fs.rmSync(pluginOnly, { recursive: true, force: true });
  }
}
