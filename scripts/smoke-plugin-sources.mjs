import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const INSTALLED = "data/kintone/plugin/installed.json";
const SHARED = "data/kintone/plugin/sources.json";
const LOCAL = "data/kintone/plugin/sources.local.json";
const IGNORE = "data/kintone/plugin/.gitignore";

export function pluginSourceTests({ expect, runCli }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-plugin-sources-"));
  const domain = fs.realpathSync(tmp);
  const git = (...args) => spawnSync("git", args, { cwd: domain, encoding: "utf8" });
  const run = (...args) => runCli(args, domain, { CYBOZU_BASE_URL: "", CYBOZU_USERNAME: "", CYBOZU_PASSWORD: "" });
  const find = (id, ...args) => run("show", "plugin-source", "--id", id, ...args);
  const byName = (name) => run("show", "plugin-source", "--name", name);
  const write = (file, data) => fs.writeFileSync(path.join(domain, file), data, "utf8");
  const writeJson = (file, data) => write(file, `${JSON.stringify(data, null, 2)}\n`);
  const read = (file) => fs.readFileSync(path.join(domain, file), "utf8");
  const exists = (file) => fs.existsSync(path.join(domain, file));
  const parse = (result) => JSON.parse(result.stdout || "null");
  const checkIgnore = (file) => git("check-ignore", "--quiet", "--no-index", "--", file).status;
  const ids = {
    gantt: "a".repeat(32),
    external: "b".repeat(32),
    script: "c".repeat(32),
    missing: "d".repeat(32),
    installed: "e".repeat(32)
  };

  try {
    const help = run("show", "plugin-source", "--help");
    expect("plugin-source: help documents ID and alias lookup", help.status === 0 && help.stdout.includes("--id <pluginId>") && help.stdout.includes("--name <alias>"), help.stdout || help.stderr);
    const empty = find(ids.gantt);
    expect("plugin-source: lookup without a plugins directory is unregistered", empty.status === 0 && parse(empty)?.status === "unregistered" && !exists("data/kintone/plugin"), empty.stdout || empty.stderr);
    const gitInit = git("init", "-q");
    if (gitInit.status !== 0) throw new Error(gitInit.stderr);
    const init = run("init");
    expect(
      "plugin-source: init creates an empty source array and ignore rule",
      init.status === 0 && parse(init)?.copied.includes(SHARED)
        && read(SHARED) === "[]\n" && read(IGNORE) === "/sources.local.json\n" && !exists("plugins")
        && !exists(INSTALLED),
      init.stdout || init.stderr
    );
    expect("plugin-source: Git ignores the private catalog and tracks the shared catalog", checkIgnore(LOCAL) === 0 && checkIgnore(SHARED) === 1 && !exists(LOCAL), IGNORE);

    const githubUrl = "https://github.com/example-org/example-plugin";
    const program = "ganttchart/提供済み code.js";
    fs.mkdirSync(path.join(domain, "data/kintone/plugin/ganttchart"));
    write(`data/kintone/plugin/${program}`, "// fixture\n");
    const sources = [
      { alias: "ganttchart", pluginId: ids.gantt, path: "ganttchart" },
      { alias: "external", pluginId: ids.external, githubUrl },
      { pluginId: ids.script, path: program },
      { alias: "missing", pluginId: ids.missing, path: "ganttchart/old.js" }
    ];
    writeJson(SHARED, sources);
    write(".env", "KINT_ORIGIN_ALLOW_PULL_KINTONE=smoke-invalid\nCYBOZU_USERNAME=smoke-credential\n");
    const sharedFolder = byName("ganttchart");
    const sharedGitHub = find(ids.external);
    const sharedFile = find(ids.script);
    expect(
      "plugin-source: resolves folder, GitHub repository and JS file without loading .env",
      [sharedFolder, sharedGitHub, sharedFile].every((result) => result.status === 0 && !result.stderr)
        && parse(sharedFolder)?.path === path.join(domain, "data/kintone/plugin/ganttchart")
        && parse(sharedFolder)?.pluginId === ids.gantt
        && parse(sharedGitHub)?.githubUrl === githubUrl && parse(sharedGitHub)?.alias === "external"
        && parse(sharedGitHub)?.sourceFile === SHARED
        && parse(sharedFile)?.path === path.join(domain, "data/kintone/plugin", program),
      [sharedFolder, sharedGitHub, sharedFile].map((result) => result.stdout || result.stderr).join("\n")
    );

    const personal = path.join(domain, "checkout");
    fs.mkdirSync(personal);
    const personalSources = [
      { alias: "local-only", path: program },
      { pluginId: ids.external, path: personal }
    ];
    writeJson(LOCAL, personalSources);
    const fromLocal = find(ids.external);
    const localByInheritedAlias = byName("external");
    const localOnly = byName("local-only");
    const personalResult = parse(fromLocal);
    expect(
      "plugin-source: personal source overrides by ID and inherits the shared alias",
      fromLocal.status === 0 && personalResult?.path === personal && personalResult.sourceFile === LOCAL
        && localByInheritedAlias.status === 0 && parse(localByInheritedAlias)?.path === personal
        && parse(localOnly)?.path === path.join(domain, "data/kintone/plugin", program)
        && parse(localOnly)?.pluginId === null,
      fromLocal.stdout || fromLocal.stderr
    );
    const missing = find(ids.missing);
    expect("plugin-source: a missing path is distinguishable from an unregistered ID", missing.status === 0
      && parse(missing)?.status === "missing-path"
      && parse(missing)?.path === path.join(domain, "data/kintone/plugin/ganttchart/old.js")
      && parse(find("f".repeat(32)))?.status === "unregistered", missing.stdout || missing.stderr);

    writeJson(INSTALLED, { plugins: [{
      id: ids.installed, name: "未登録プラグイン", description: "説明", isMarketPlugin: false, version: "3.2.1"
    }] });
    const noSource = find(ids.installed);
    expect("plugin-source: installed.jsonにあり参照台帳にないIDはno-source", noSource.status === 0
      && parse(noSource)?.status === "no-source" && parse(noSource)?.sourceFile === INSTALLED
      && parse(noSource)?.displayName === "未登録プラグイン" && parse(noSource)?.version === "3.2.1", noSource.stdout || noSource.stderr);

    writeJson(SHARED, [{ alias: "duplicate", path: program }, { alias: "duplicate", path: program }]);
    const duplicateAlias = byName("duplicate");
    expect("plugin-source: rejects duplicate aliases in one catalog", duplicateAlias.status === 1 && duplicateAlias.stderr.includes("重複"), duplicateAlias.stderr);
    writeJson(SHARED, [{ alias: "external", pluginId: ids.external, path: "ganttchart" }]);
    writeJson(LOCAL, [{ alias: "external", pluginId: ids.gantt, path: personal }]);
    const conflictingOverride = byName("external");
    expect("plugin-source: rejects an alias override with a conflicting ID", conflictingOverride.status === 1
      && conflictingOverride.stderr.includes("pluginId") && conflictingOverride.stderr.includes(LOCAL), conflictingOverride.stderr);
    writeJson(LOCAL, personalSources);

    const invalidArgs = [find("../bad"), byName("../bad"), find(ids.gantt, "--open"), find(ids.gantt, "--name", "ganttchart"), run("show", "plugin-source")];
    expect("plugin-source: rejects invalid IDs, unknown options and missing required arguments", invalidArgs.every((result) => result.status === 1 && result.stdout === ""), invalidArgs.map((result) => result.stderr).join("\n"));
    for (const invalid of [
      { alias: "../bad", pluginId: ids.gantt, path: "ganttchart" },
      { alias: "missing-source" },
      { pluginId: "x".repeat(32), githubUrl },
      { alias: "bad", path: "../checkout" }, { alias: "bad", path: personal },
      { alias: "bad", githubUrl: "https://fixture-secret@github.com/org/repo" },
      { alias: "bad", path: program, githubUrl }, { alias: "bad", githubUrl, githubPath: "../outside" },
      { alias: "bad", path: program, githubPath: "examples/ganttchart" }, { alias: "bad", path: program, unknown: true }
    ]) {
      writeJson(SHARED, [invalid]);
      const result = byName("bad");
      expect("plugin-source: rejects invalid source rows", result.status === 1 && result.stderr.includes(`PLUGIN_SOURCES_INVALID: ${SHARED}`) && !result.stderr.includes("fixture-secret"), result.stderr);
    }
    write(SHARED, '{"bad-id": fixture-secret}\n');
    const malformed = byName("bad-id");
    expect("plugin-source: rejects the previous object format and does not echo contents", malformed.status === 1 && malformed.stderr.includes(SHARED) && !malformed.stderr.includes("fixture-secret"), malformed.stderr);

    // Windows uses a junction so the regression also runs without developer-mode symlinks.
    fs.symlinkSync(personal, path.join(domain, "data/kintone/plugin/linked"), process.platform === "win32" ? "junction" : "dir");
    writeJson(SHARED, [{ alias: "linked", path: "linked" }]);
    const linked = byName("linked");
    expect("plugin-source: a relative link cannot point outside plugins", linked.status === 1 && linked.stderr.includes(SHARED), linked.stdout || linked.stderr);

    writeJson(SHARED, sources);
    const sharedBefore = read(SHARED);
    const localBefore = read(LOCAL);
    const customIgnore = "# existing rule\n/dist/\n!/sources.local.json";
    write(IGNORE, customIgnore);
    const rootIgnore = read(".gitignore");
    const add = git("add", "-f", "--", LOCAL);
    if (add.status !== 0) throw new Error(add.stderr);
    const update = run("update", "-y");
    expect(
      "plugin-source: update appends ignore rule and preserves catalogs and user files",
      update.status === 0 && parse(update)?.updated.includes(IGNORE)
        && read(IGNORE) === `${customIgnore}\n/sources.local.json\n` && read(".gitignore") === rootIgnore
        && read(SHARED) === sharedBefore && read(LOCAL) === localBefore && read(`data/kintone/plugin/${program}`) === "// fixture\n",
      update.stdout || update.stderr
    );
    expect(
      "plugin-source: update warns about an already tracked private catalog",
      update.stderr.includes(`${LOCAL} は既にGitで追跡されています`)
        && git("ls-files", "--error-unmatch", "--", LOCAL).status === 0 && checkIgnore(LOCAL) === 0,
      update.stderr
    );
    const again = run("update", "-y");
    expect("plugin-source: repeated update is idempotent", again.status === 0 && parse(again)?.updated.length === 0, again.stdout || again.stderr);
    fs.unlinkSync(path.join(domain, SHARED));
    fs.unlinkSync(path.join(domain, IGNORE));
    const recreate = run("update", "-y");
    const updatedFiles = parse(recreate)?.updated;
    expect(
      "plugin-source: update creates a missing empty array template",
      recreate.status === 0 && updatedFiles?.includes(SHARED) && updatedFiles.includes(IGNORE)
        && read(SHARED) === "[]\n" && read(LOCAL) === localBefore && checkIgnore(LOCAL) === 0,
      recreate.stdout || recreate.stderr
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
