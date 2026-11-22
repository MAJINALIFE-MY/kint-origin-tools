import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markdownTargets, checkSkillReferences, checkPackagedKnowledge } from "./check-agent-knowledge.mjs";

const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../local-test");
function fixture(t) {
  fs.mkdirSync(BASE, { recursive: true });
  const root = fs.mkdtempSync(path.join(BASE, "knowledge-"));
  t.after(() => { assert.equal(path.dirname(root), BASE); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
  };
  return { root, write };
}

test("links resolve relative to their document; code examples and external links are ignored", (t) => {
  const f = fixture(t);
  f.write("guide.md", '[child](nested/a.md#section) [web](https://example.com)\n```md\n[example](missing.md)\n```\n');
  f.write("nested/a.md", "# Section\n");
  assert.deepEqual(markdownTargets(f.root, "guide.md"), ["nested/a.md"]);
  fs.unlinkSync(path.join(f.root, "nested/a.md"));
  assert.throws(() => markdownTargets(f.root, "guide.md"), /参照先/);
});

test("references must be reachable from SKILL, including transitive references", (t) => {
  const f = fixture(t);
  f.write("s/SKILL.md", "Read [a](references/a.md).\n");
  f.write("s/references/a.md", "Read [b](b.md).\n");
  f.write("s/references/b.md", "Details\n");
  assert.equal(checkSkillReferences(f.root, "s"), 3);
  f.write("s/references/orphan.md", "Unused\n");
  assert.throws(() => checkSkillReferences(f.root, "s"), /辿れない/);
});

test("references reject BOM, unresolved placeholders and paths outside the checkout", (t) => {
  const f = fixture(t);
  for (const text of ["\uFEFFtext\n", "text\r\n", "{{AGENT_DOC}}\n", "[outside](../../package.json)\n"]) {
    f.write("a.md", text);
    assert.throws(() => markdownTargets(f.root, "a.md"));
  }
});

test("package validation catches a source link missing from the tarball", (t) => {
  const f = fixture(t);
  for (const file of ["README.md", "SECURITY.md"]) f.write(file, "Entry\n");
  f.write("README.md", "[security](SECURITY.md)\n");
  const files = ["README.md", "SECURITY.md"];
  assert.doesNotThrow(() => checkPackagedKnowledge(f.root, files));
  f.write("source-only.md", "Only in the source checkout\n");
  f.write("README.md", "[guide](source-only.md)\n");
  assert.throws(() => checkPackagedKnowledge(f.root, files), /パッケージに参照先/);
});
