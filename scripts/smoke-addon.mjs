import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export async function addonTests({ ROOT, expect }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-addon-smoke-"));
  const cli = path.join(ROOT, "dist", "cli.js");
  const domain = path.join(temp, "domain");
  const source = path.join(temp, "private-addons");
  const trackedDomain = path.join(temp, "tracked-domain");
  fs.mkdirSync(domain);
  fs.mkdirSync(source);
  fs.mkdirSync(trackedDomain);

  const run = (cwd, args, extraEnv = {}) => spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      KINT_ORIGIN_ADDON_DIR: source,
      CYBOZU_PASSWORD: "smoke-secret-sentinel",
      ...extraEnv
    }
  });
  const parse = (result) => {
    if (result.status !== 0) throw new Error(`command failed (${result.status}): ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const git = (cwd, args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  const skill = (name) => {
    const root = path.join(source, "pj-management", "skills", name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "SKILL.md"), `---\nname: ${name}\ndescription: A project management smoke-test skill.\n---\n\n# ${name}\n`, "utf8");
  };
  const writeManifest = (version) => {
    const manifestPath = path.join(source, "pj-management", "addon.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.version = version;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  };

  try {
    parse(run(domain, ["addon", "create", "pj-management"]));
    const addonRoot = path.join(source, "pj-management");
    const commandPath = path.join(addonRoot, "commands", "echo.mjs");
    fs.writeFileSync(commandPath, [
      "console.log(JSON.stringify({ args: process.argv.slice(2), password: process.env.CYBOZU_PASSWORD ?? null, domain: process.env.KINT_ORIGIN_DOMAIN_ROOT }));",
      "if (process.argv.includes('exit-seven')) process.exitCode = 7;",
      ""
    ].join("\n"), "utf8");
    const manifestPath = path.join(addonRoot, "addon.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.description = "Project management helpers";
    manifest.commands = { echo: "commands/echo.mjs" };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    skill("kint-origin-addon-pj-management");
    fs.writeFileSync(path.join(addonRoot, "rules", "workflow.md"), "# Workflow\n\nReview project context before preparing an estimate.\n", "utf8");

    git(domain, ["init", "-q"]);
    const available = parse(run(domain, ["addon", "list"]));
    expect("addon list finds an external candidate", available.addons.some((item) => item.name === "pj-management" && item.status === "available"), JSON.stringify(available));

    const installedResult = parse(run(domain, ["addon", "install", "pj-management", "-y"]));
    expect("addon install records the source outside the domain", installedResult.operation === "install" && fs.realpathSync(path.join(domain, ".kint-origin", "addons", "linked", "pj-management")) === fs.realpathSync(addonRoot), JSON.stringify(installedResult));
    const statePath = path.join(domain, ".kint-origin", "addons", "installed.json");
    let state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect("addon state records version and rule files", state.addons["pj-management"]?.version === "0.1.0" && state.addons["pj-management"]?.rules?.includes("rules/workflow.md"), JSON.stringify(state));
    expect("addon index lists its Markdown rule", fs.readFileSync(path.join(domain, ".kint-origin", "addons", "INDEX.md"), "utf8").includes("linked/pj-management/rules/workflow.md"), "rule path missing from generated index");

    const ignored = [".kint-origin/addons/installed.json", ".agents/skills/kint-origin-addon-pj-management/SKILL.md", ".claude/skills/kint-origin-addon-pj-management/SKILL.md", ".cursor/rules/kint-origin-addon-index.mdc"]
      .map((item) => git(domain, ["check-ignore", "-q", "--no-index", "--", item]).status === 0);
    expect("addon-managed files are Git-ignored", ignored.every(Boolean), JSON.stringify(ignored));
    const listed = parse(run(domain, ["addon", "list"]));
    expect("addon list reports installed state", listed.addons.some((item) => item.name === "pj-management" && item.status === "installed"), JSON.stringify(listed));

    const command = run(domain, ["addon", "run", "pj-management", "echo", "--help", "two words", "$(literal)"]);
    const commandResult = JSON.parse(command.stdout);
    expect("addon run forwards child arguments and does not expose credentials", command.status === 0 && JSON.stringify(commandResult.args) === JSON.stringify(["--help", "two words", "$(literal)"]) && commandResult.password === null && commandResult.domain === domain, command.stdout || command.stderr);
    const failedCommand = run(domain, ["addon", "run", "pj-management", "echo", "exit-seven"]);
    expect("addon run returns the child exit code", failedCommand.status === 7, `status=${failedCommand.status}`);

    skill("kint-origin-addon-pj-management-quotes");
    writeManifest("0.2.0");
    const updateResult = parse(run(domain, ["addon", "update", "pj-management", "-y"]));
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect("addon update synchronizes new skills and version", updateResult.operation === "update" && state.addons["pj-management"].version === "0.2.0" && fs.existsSync(path.join(domain, ".agents", "skills", "kint-origin-addon-pj-management-quotes")), JSON.stringify({ updateResult, state }));

    writeManifest("0.3.0");
    const domainUpdate = parse(run(domain, ["update", "-y"]));
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect("domain update synchronizes installed addons", domainUpdate.addons.includes("pj-management") && state.addons["pj-management"].version === "0.3.0", JSON.stringify({ addons: domainUpdate.addons, version: state.addons["pj-management"].version }));

    const removed = parse(run(domain, ["addon", "remove", "pj-management", "-y"]));
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect("addon remove removes only domain links and registration", removed.operation === "remove" && Object.keys(state.addons).length === 0 && !fs.existsSync(path.join(domain, ".agents", "skills", "kint-origin-addon-pj-management")) && fs.existsSync(addonRoot), JSON.stringify({ removed, state }));

    git(trackedDomain, ["init", "-q"]);
    const trackedSkill = path.join(trackedDomain, ".agents", "skills", "kint-origin-addon-pj-management", "SKILL.md");
    fs.mkdirSync(path.dirname(trackedSkill), { recursive: true });
    fs.writeFileSync(trackedSkill, "user-owned\n", "utf8");
    git(trackedDomain, ["add", "-f", ".agents/skills/kint-origin-addon-pj-management/SKILL.md"]);
    const trackedInstall = run(trackedDomain, ["addon", "install", "pj-management", "-y"]);
    expect("addon install refuses Git-tracked addon paths", trackedInstall.status === 1 && trackedInstall.stderr.includes("ADDON_TRACKED"), trackedInstall.stderr);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
