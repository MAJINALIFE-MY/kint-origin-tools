import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncDevAgents } from "./sync-dev-agents.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = path.join(ROOT, "local-test");
fs.mkdirSync(BASE, { recursive: true });
const skill = "---\nname: demo-skill\ndescription: Validate a demo export.\n---\n\nRead [context](references/context.md).\n";
const role = "---\nname: demo-reviewer\ndescription: Review demo changes.\n---\n\nReview without editing files.\n";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(BASE, "dev-agents-"));
  t.after(() => {
    assert.equal(path.dirname(root), BASE);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (rel, bytes) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  };
  write("AGENTS.md", "# Shared instructions\n");
  write("CLAUDE.md", "@AGENTS.md\n");
  write(".claude/settings.json", "{}\n");
  write(".agents/dev-config.json", JSON.stringify({ schemaVersion: 1, skills: ["demo-skill"], roles: ["demo-reviewer"] }) + "\n");
  write(".agents/skills/demo-skill/SKILL.md", skill);
  write(".agents/skills/demo-skill/references/context.md", "# Context\n");
  write(".agents/roles/demo-reviewer.md", role);
  return { root, write, read: (rel) => fs.readFileSync(path.join(root, rel)), sync: (options = {}) => syncDevAgents({ root, ...options }) };
}

test("fresh checkout: links, native role formats and idempotent sync", (t) => {
  const f = fixture(t);
  assert.throws(() => f.sync({ check: true }), /ありません/);
  const first = f.sync();
  assert.equal(first.linked.length, 1);
  assert.equal(first.written.length, 3);
  assert.equal(fs.realpathSync(path.join(f.root, ".claude/skills/demo-skill")), fs.realpathSync(path.join(f.root, ".agents/skills/demo-skill")));
  assert.deepEqual(f.read(".claude/skills/demo-skill/SKILL.md"), f.read(".agents/skills/demo-skill/SKILL.md"));
  assert.match(f.read(".codex/agents/demo-reviewer.toml").toString(), /developer_instructions = /);
  assert.match(f.read(".claude/agents/demo-reviewer.md").toString(), /^---\nname: demo-reviewer/);
  f.sync({ check: true });
  const state = f.read(".agents/generated.json");
  const stamp = fs.statSync(path.join(f.root, ".agents/generated.json")).mtimeMs;
  assert.deepEqual(f.sync().written, []);
  assert.deepEqual(f.sync().linked, []);
  assert.deepEqual(f.read(".agents/generated.json"), state);
  assert.equal(fs.statSync(path.join(f.root, ".agents/generated.json")).mtimeMs, stamp);
});

test("copy fallback preserves binary assets and updates unchanged generated files", (t) => {
  const f = fixture(t);
  const binary = Buffer.from([0, 255, 1, 128, 13, 10]);
  f.write(".agents/skills/demo-skill/assets/data.bin", binary);
  f.sync({ copy: true });
  assert.deepEqual(f.read(".claude/skills/demo-skill/assets/data.bin"), binary);
  f.write(".agents/skills/demo-skill/references/context.md", "# Updated context\n");
  assert.throws(() => f.sync({ check: true }), /同期/);
  assert.equal(f.sync().mode, "copy");
  assert.deepEqual(f.read(".claude/skills/demo-skill/references/context.md"), f.read(".agents/skills/demo-skill/references/context.md"));
  f.sync({ check: true });
});

test("a clone with a tracked link-mode ledger can choose copy mode before bootstrap", (t) => {
  const f = fixture(t);
  f.sync();
  const source = path.join(f.root, ".claude/skills/demo-skill");
  // unlinkはリンクそのものだけを取り外す。正本のディレクトリは削除しない。
  fs.unlinkSync(source);
  assert.equal(f.sync({ copy: true }).mode, "copy");
  assert.equal(fs.lstatSync(source).isSymbolicLink(), false);
  assert.deepEqual(f.read(".claude/skills/demo-skill/SKILL.md"), f.read(".agents/skills/demo-skill/SKILL.md"));
  f.sync({ check: true });
});

test("check never repairs missing generated files; sync can restore them", (t) => {
  const f = fixture(t);
  f.sync();
  fs.unlinkSync(path.join(f.root, ".cursor/agents/demo-reviewer.md"));
  const state = f.read(".agents/generated.json");
  assert.throws(() => f.sync({ check: true }), /生成物がありません/);
  assert.equal(fs.existsSync(path.join(f.root, ".cursor/agents/demo-reviewer.md")), false);
  assert.deepEqual(f.read(".agents/generated.json"), state);
  f.sync();
  f.sync({ check: true });
});

test("generated custom edits stop the entire update and remain intact", (t) => {
  const f = fixture(t);
  f.sync();
  const state = f.read(".agents/generated.json");
  const other = f.read(".cursor/agents/demo-reviewer.md");
  f.write(".agents/roles/demo-reviewer.md", role + "New canonical instruction.\n");
  f.write(".claude/agents/demo-reviewer.md", "User edits\n");
  assert.throws(() => f.sync(), /独自変更/);
  assert.equal(f.read(".claude/agents/demo-reviewer.md").toString(), "User edits\n");
  assert.deepEqual(f.read(".cursor/agents/demo-reviewer.md"), other);
  assert.deepEqual(f.read(".agents/generated.json"), state);
});

test("unmodified roles update from their canonical source", (t) => {
  const f = fixture(t);
  f.sync();
  f.write(".agents/roles/demo-reviewer.md", role + "Review CSV newlines.\n");
  assert.throws(() => f.sync({ check: true }), /同期/);
  assert.equal(f.sync().written.length, 3);
  assert.match(f.read(".codex/agents/demo-reviewer.toml").toString(), /CSV newlines/);
  f.sync({ check: true });
});

test("empty roles sync without a roles directory and write no agent definitions", (t) => {
  const f = fixture(t);
  f.write(".agents/dev-config.json", JSON.stringify({ schemaVersion: 1, skills: ["demo-skill"], roles: [] }) + "\n");
  fs.rmSync(path.join(f.root, ".agents/roles"), { recursive: true });
  const result = f.sync();
  assert.equal(result.roles, 0);
  assert.equal(result.written.length, 0);
  for (const rel of [".claude/agents", ".cursor/agents", ".codex/agents"]) assert.equal(fs.existsSync(path.join(f.root, rel)), false);
  f.sync({ check: true });
});

test("retiring a role keeps generated files until the ledger entries are removed", (t) => {
  const f = fixture(t);
  f.sync();
  const generated = [".claude/agents/demo-reviewer.md", ".cursor/agents/demo-reviewer.md", ".codex/agents/demo-reviewer.toml"];
  const before = Object.fromEntries(generated.map((rel) => [rel, f.read(rel)]));
  f.write(".agents/dev-config.json", JSON.stringify({ schemaVersion: 1, skills: ["demo-skill"], roles: [] }) + "\n");
  fs.rmSync(path.join(f.root, ".agents/roles"), { recursive: true });
  assert.throws(() => f.sync(), /旧生成物を保護します/);
  for (const rel of generated) assert.deepEqual(f.read(rel), before[rel]);
  const ledger = JSON.parse(f.read(".agents/generated.json").toString());
  for (const rel of generated) delete ledger.files[rel];
  f.write(".agents/generated.json", JSON.stringify(ledger, null, 2) + "\n");
  for (const rel of generated) fs.unlinkSync(path.join(f.root, rel));
  f.sync({ check: true });
});

test("personal configuration files and unknown files are preserved", (t) => {
  const f = fixture(t);
  const personal = [".claude/settings.local.json", ".codex/config.toml", ".cursor/hooks.json", ".claude/agents/personal.md"];
  for (const rel of personal) f.write(rel, "personal\n");
  f.sync();
  for (const rel of personal) assert.equal(f.read(rel).toString(), "personal\n");
});

test("missing sources and unregistered skills fail without writing", (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, ".agents/roles/demo-reviewer.md"));
  assert.throws(() => f.sync(), /ENOENT/);
  assert.equal(fs.existsSync(path.join(f.root, ".claude/agents")), false);
  f.write(".agents/roles/demo-reviewer.md", role);
  f.write(".agents/skills/extra/SKILL.md", skill);
  assert.throws(() => f.sync(), /未登録/);
});

test("BOM, invalid UTF-8, CRLF, name mismatch and broken references fail", (t) => {
  const f = fixture(t);
  for (const content of ["\uFEFF" + skill, Buffer.from([255, 254]), skill.replaceAll("\n", "\r\n"), skill.replace("name: demo-skill", "name: wrong"), skill.replace("description: Validate a demo export.", 'description: ""'), skill.replace("references/context.md", "missing.md")]) {
    f.write(".agents/skills/demo-skill/SKILL.md", content);
    assert.throws(() => f.sync());
    assert.equal(fs.existsSync(path.join(f.root, ".claude/agents")), false);
  }
});

test("traversal names and duplicate names are rejected", (t) => {
  const f = fixture(t);
  for (const names of [["../outside"], ["demo-skill", "demo-skill"], []]) {
    f.write(".agents/dev-config.json", JSON.stringify({ schemaVersion: 1, skills: names, roles: ["demo-reviewer"] }) + "\n");
    assert.throws(() => f.sync());
  }
});

test("missing common instructions, broken imports and invalid native settings are rejected", (t) => {
  const f = fixture(t);
  f.sync();
  fs.unlinkSync(path.join(f.root, "AGENTS.md"));
  assert.throws(() => f.sync({ check: true }), /共通指示/);
  f.write("AGENTS.md", "# Shared instructions\n");
  f.write("CLAUDE.md", "Independent and drifting copy\n");
  assert.throws(() => f.sync({ check: true }), /import/);
  f.write("CLAUDE.md", "@AGENTS.md\n");
  f.write(".claude/settings.json", "invalid json\n");
  assert.throws(() => f.sync({ check: true }), /JSON/);
});

test("source links and foreign destination links are rejected", (t) => {
  const f = fixture(t);
  f.write("outside/SKILL.md", "keep\n");
  const destination = path.join(f.root, ".claude/skills/demo-skill");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(path.join(f.root, "outside"), destination, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.sync(), /異なる配置/);
  assert.equal(f.read("outside/SKILL.md").toString(), "keep\n");
  fs.symlinkSync(path.join(f.root, "outside"), path.join(f.root, ".agents/skills/demo-skill/foreign"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.sync(), /リンク/);
});

test("generated-file symlinks cannot redirect writes", (t) => {
  const f = fixture(t);
  f.write("outside.md", "keep\n");
  fs.mkdirSync(path.join(f.root, ".claude/agents"), { recursive: true });
  // Windowsのファイルsymlink権限は必須にしない。祖先ディレクトリのjunctionで検証する。
  fs.rmdirSync(path.join(f.root, ".claude/agents"));
  f.write("foreign/personal.md", "keep\n");
  fs.symlinkSync(path.join(f.root, "foreign"), path.join(f.root, ".claude/agents"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.sync(), /祖先がリンク/);
  assert.equal(fs.existsSync(path.join(f.root, "foreign/demo-reviewer.md")), false);
});

test("copy-side additions and unexpected mode changes are protected", (t) => {
  const f = fixture(t);
  f.sync({ copy: true });
  f.write(".claude/skills/demo-skill/user.txt", "keep\n");
  assert.throws(() => f.sync(), /追加ファイル/);
  assert.equal(f.read(".claude/skills/demo-skill/user.txt").toString(), "keep\n");
  const linked = fixture(t);
  linked.sync();
  assert.throws(() => linked.sync({ copy: true }), /方式/);
});

