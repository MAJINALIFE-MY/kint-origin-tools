// smoke: app create / app templates（オフライン）と、zip リーダー・テンプレート変換。
// 確認すること: zip なしで空欄ドラフトが書ける・API を呼ばない・--template だけが zip を変換する・範囲外と未知の名前は拒否する・
// 同名 zip があっても既定は空欄のまま・既存フォルダと不正な名前は拒否する・パッケージ内の正本を使う（cwd の古いスキルのコピーではない）。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

const NO_SHELL_CREDS = { CYBOZU_BASE_URL: "", CYBOZU_USERNAME: "", CYBOZU_PASSWORD: "" };
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// 検証用の zip を作る。kintone の zip と同じく、既定ではデータ記述子（フラグ bit 3）を使い、ローカルヘッダーのサイズを 0 にする。
function buildZip(entries, { descriptor = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const stored = entry.deflate === false;
    const body = stored ? entry.data : zlib.deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const flags = 0x800 | (descriptor ? 0x8 : 0);
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(descriptor ? 0 : crc, 14);
    local.writeUInt32LE(descriptor ? 0 : body.length, 18);
    local.writeUInt32LE(descriptor ? 0 : entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const parts = [local, name, body];
    if (descriptor) {
      const tail = Buffer.alloc(16);
      tail.writeUInt32LE(0x08074b50, 0);
      tail.writeUInt32LE(crc, 4);
      tail.writeUInt32LE(body.length, 8);
      tail.writeUInt32LE(entry.data.length, 12);
      parts.push(tail);
    }
    const localBlock = Buffer.concat(parts);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    locals.push(localBlock);
    offset += localBlock.length;
  }
  const centralBlock = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBlock.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBlock, end]);
}

export async function appCreateTests({ ROOT, expect, runCli, runCliAsync, startMockKintone, mockEnv }) {
  console.log("[offline] app create / app templates（空欄ドラフト・--template の変換・zip リーダー）");

  const BLANK_DIR = path.join(ROOT, "template", "agents", "common", "skills", "kint-origin-push", "references", "app-blank");
  const BLANK_FILES = ["form/fields.json", "form/layout.json", "views/views.json", "README.md"];
  const read = (file) => fs.readFileSync(file, "utf8");
  const fixture = JSON.parse(read(path.join(ROOT, "scripts", "fixtures", "blankapp-template.json")));
  const newDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `kint-origin-appcreate-${label}-`));
  const run = (args, cwd) => runCli(args, cwd, NO_SHELL_CREDS);
  const draftOf = (domain, name) => path.join(domain, "push", "new-apps", name);
  const templateZip = (template, extra = []) =>
    buildZip([
      { name: "01/", data: Buffer.alloc(0), deflate: false },
      { name: "01/template.json", data: Buffer.from(JSON.stringify(template), "utf8") },
      { name: "01/signature", data: Buffer.from("signature") },
      ...extra
    ]);
  const putZip = (domain, name, bytes, sub = ["push", "app-templates"]) => {
    const dir = path.join(domain, ...sub);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.zip`), bytes);
  };
  const jsonOf = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const treeOf = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((x) => String(x).replaceAll("\\", "/")).sort() : []);
  const allDraftText = (dir) =>
    treeOf(dir)
      .filter((rel) => fs.statSync(path.join(dir, rel)).isFile())
      .map((rel) => read(path.join(dir, rel)))
      .join("\n");

  // ---- 1. zip なしの空欄ドラフト（API を呼ばない） ----
  const mock = await startMockKintone(() => null);
  const blankDomain = newDir("blank");
  try {
    const r = await runCliAsync(["app", "create", "--name", "顧客管理"], blankDomain, mockEnv(mock.baseUrl));
    expect("app create: zip なしで空欄ドラフトを書く（exit 0）", r.status === 0, `status=${r.status}\n${r.stderr}`);
    expect("app create: API を 1 回も呼ばない（認証値があっても）", mock.requests.length === 0, mock.requests.join("\n"));
    expect("app create: 接続しないので、接続先（ホスト・ログイン名）を表示しない", !r.stderr.includes("接続先") && !r.stderr.includes("ユーザー:"), r.stderr);
    const dir = draftOf(blankDomain, "顧客管理");
    const meta = jsonOf(read(path.join(dir, "app.json")));
    expect("app create: app.json は --name のアプリ名（space / thread / guestSpaceId は空）", meta?.name === "顧客管理" && meta.space === "" && meta.thread === "" && meta.guestSpaceId === "", JSON.stringify(meta));
    expect(
      "app create: 空欄ドラフトの 4 ファイルは、スキル参照の正本（app-blank）と同じ内容",
      BLANK_FILES.every((rel) => read(path.join(dir, ...rel.split("/"))) === read(path.join(BLANK_DIR, ...rel.split("/")))),
      treeOf(dir).join(",")
    );
    expect("app create: ドラフトのファイルは app.json と正本の 4 つだけ（zip・created.json は無い）", treeOf(dir).filter((x) => !x.endsWith("/") && /\.[a-z]+$/.test(x)).join(",") === "README.md,app.json,form/fields.json,form/layout.json,views/views.json", treeOf(dir).join(","));
    const fields = jsonOf(read(path.join(dir, "form", "fields.json")));
    const views = jsonOf(read(path.join(dir, "views", "views.json")));
    const layout = jsonOf(read(path.join(dir, "form", "layout.json")));
    // 組み込みフィールドは kintone が自動で作る（追加 API では追加できない）。コードは API ユーザーの表示言語で決まるので、ドラフトに書かない。
    expect("app create: fields.json は空（組み込みフィールドを書かない）", fields && typeof fields.properties === "object" && Object.keys(fields.properties).length === 0, JSON.stringify(fields));
    expect("app create: views.json は空（組み込みの「（すべて）」は書けない・組み込みコードを前提にしない）", views && typeof views.views === "object" && Object.keys(views.views).length === 0, JSON.stringify(views));
    const draftText = allDraftText(dir);
    expect("app create: ドラフトに、組み込みフィールドのコードの前提（Record_number・レコード番号の参照）を入れない", !draftText.includes('"Record_number') && !draftText.includes('"レコード番号"') && !draftText.includes("Created_by"), draftText.slice(0, 200));
    expect("app create: レイアウトは空", Array.isArray(layout?.layout) && layout.layout.length === 0, JSON.stringify(layout));
    expect("app create: ファイルは LF・末尾改行・BOM なし", ["app.json", ...BLANK_FILES].every((rel) => { const t = read(path.join(dir, ...rel.split("/"))); return t.endsWith("\n") && !t.includes("\r") && t.charCodeAt(0) !== 0xfeff; }), "newline/BOM");
    const summary = jsonOf(r.stdout);
    expect("app create: 結果 JSON（draftName・name・template: null・dir・files）", summary?.draftName === "顧客管理" && summary.template === null && summary.dir === "push/new-apps/顧客管理" && summary.files.includes("form/fields.json"), r.stdout);
    expect("app create: created.json（アプリ ID）は作らない", !fs.existsSync(path.join(dir, "created.json")), "created.json exists");
    const diff = run(["diff", "create", "--name", "顧客管理"], blankDomain);
    expect("app create: 書いたドラフトは diff create で読める（形式が push create の入力と一致）", diff.status === 0 && diff.stdout.includes('"form/fields.json"') && diff.stdout.includes('"views/views.json"'), `${diff.stdout}\n${diff.stderr}`);

    // 作成先の指定は app.json へ書く。
    const placed = run(["app", "create", "--name", "案件", "--space", "12", "--thread", "5", "--guestspace", "7"], blankDomain);
    const placedMeta = jsonOf(read(path.join(draftOf(blankDomain, "案件"), "app.json")));
    expect("app create: --space / --thread / --guestspace を app.json へ書く", placed.status === 0 && placedMeta?.space === "12" && placedMeta.thread === "5" && placedMeta.guestSpaceId === "7", `${placed.stderr}\n${JSON.stringify(placedMeta)}`);

    // 既存フォルダは上書きしない。
    fs.writeFileSync(path.join(dir, "form", "layout.json"), '{"layout": "edited"}\n', "utf8");
    const again = run(["app", "create", "--name", "顧客管理"], blankDomain);
    expect("app create: 既存のドラフトは拒否（exit 1）し、中身を変えない", again.status === 1 && again.stderr.includes("既にあります") && read(path.join(dir, "form", "layout.json")) === '{"layout": "edited"}\n', `${again.status}\n${again.stderr}`);
    fs.mkdirSync(path.join(blankDomain, "push", "new-apps", "_example"), { recursive: true });
    const example = run(["app", "create", "--name", "_example"], blankDomain);
    expect("app create: 雛形（_example）は拒否", example.status === 1 && example.stderr.includes("_"), example.stderr);

    // 別のドラフトの app.json の name と同じ名前は拒否する（push create --name は、フォルダ名と app.json の name のどちらでも指定できるため、別のドラフトが選ばれる）。
    const sales = run(["app", "create", "--name", "売上"], blankDomain);
    fs.writeFileSync(path.join(draftOf(blankDomain, "売上"), "app.json"), JSON.stringify({ name: "売上管理" }), "utf8");
    const clash = run(["app", "create", "--name", "売上管理"], blankDomain);
    expect("app create: 既存ドラフトの app.json の name と同じ名前は拒否（別のドラフトが選ばれるのを防ぐ）", sales.status === 0 && clash.status === 1 && clash.stderr.includes("name が同じです") && !fs.existsSync(draftOf(blankDomain, "売上管理")), `${clash.status}\n${clash.stderr}`);
    const caseClash = run(["app", "create", "--name", "ABC-draft"], blankDomain);
    const caseClash2 = run(["app", "create", "--name", "abc-draft"], blankDomain);
    expect("app create: フォルダ名は大文字小文字を区別せず、既存と同じなら拒否", caseClash.status === 0 && caseClash2.status === 1 && caseClash2.stderr.includes("既にあります"), `${caseClash2.status}\n${caseClash2.stderr}`);

    // push create / diff create --name は、フォルダ名の完全一致を優先し、app.json の name だけで一致するドラフトが複数あるときは拒否する。
    fs.mkdirSync(draftOf(blankDomain, "売上管理"), { recursive: true });
    fs.writeFileSync(path.join(draftOf(blankDomain, "売上管理"), "app.json"), JSON.stringify({ name: "別の名前" }), "utf8");
    const byFolder = run(["diff", "create", "--name", "売上管理"], blankDomain);
    expect("diff create --name: フォルダ名の完全一致を優先する（app.json の name が同じ別ドラフトより先）", byFolder.status === 0 && jsonOf(byFolder.stdout)?.order?.[0]?.draftName === "売上管理", `${byFolder.status}\n${byFolder.stderr}`);
    fs.rmSync(draftOf(blankDomain, "売上管理"), { recursive: true, force: true });
    fs.mkdirSync(draftOf(blankDomain, "売上2"), { recursive: true });
    fs.writeFileSync(path.join(draftOf(blankDomain, "売上2"), "app.json"), JSON.stringify({ name: "売上管理" }), "utf8");
    const ambiguous = run(["diff", "create", "--name", "売上管理"], blankDomain);
    expect("diff create --name: app.json の name だけで一致するドラフトが複数あるときは拒否（フォルダ名を案内）", ambiguous.status === 1 && ambiguous.stderr.includes("複数あります") && ambiguous.stderr.includes("フォルダ名"), `${ambiguous.status}\n${ambiguous.stderr}`);
  } finally {
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(blankDomain, { recursive: true, force: true });
  }

  // ---- 2. 名前・オプションの拒否（何も作らない） ----
  const rejectDomain = newDir("reject");
  try {
    const cases = [
      { args: ["app", "create"], want: "Missing required argument: --name" },
      { args: ["app", "create", "--name"], want: "Missing required argument: --name" },
      { args: ["app", "create", "--name", ".hidden"], want: "先頭に" },
      { args: ["app", "create", "--name", "_private"], want: "先頭に" },
      { args: ["app", "create", "--name", ".."], want: "先頭に" },
      { args: ["app", "create", "--name", "a/b"], want: "使えない文字" },
      { args: ["app", "create", "--name", "a\\b"], want: "使えない文字" },
      { args: ["app", "create", "--name", "a:b"], want: "使えない文字" },
      { args: ["app", "create", "--name", "con"], want: "Windows" },
      { args: ["app", "create", "--name", "name."], want: "Windows" },
      { args: ["app", "create", "--name", " pad"], want: "空白" },
      { args: ["app", "create", "--name", "あ".repeat(65)], want: "64 文字以内" },
      { args: ["app", "create", "--name", "ok", "--thread", "3"], want: "--space" },
      { args: ["app", "create", "--name", "ok", "--space", "abc"], want: "正の整数" },
      { args: ["app", "create", "--name", "ok", "--guestspace", "0"], want: "正の整数" },
      { args: ["app", "create", "--name", "ok", "--space"], want: "正の整数" },
      { args: ["app", "create", "--name", "ok", "--template"], want: "テンプレート名" },
      { args: ["app", "create", "--name", "ok", "--bogus"], want: "不明なオプション" },
      { args: ["app", "create", "extra"], want: "不明な引数" },
      { args: ["app", "templates", "--name", "x"], want: "不明なオプション" }
    ];
    for (const { args, want } of cases) {
      const r = run(args, rejectDomain);
      expect(`app: 拒否 ${args.slice(1).join(" ")}`, r.status === 1 && r.stderr.includes(want), `status=${r.status}\n${r.stderr}`);
    }
    expect("app: 拒否したときは push/new-apps を作らない", !fs.existsSync(path.join(rejectDomain, "push")), treeOf(rejectDomain).join(","));
    expect("app: 64 文字のアプリ名は作れる", run(["app", "create", "--name", "あ".repeat(64)], rejectDomain).status === 0, "64 chars");
  } finally {
    fs.rmSync(rejectDomain, { recursive: true, force: true });
  }

  // ---- 3. app templates と --template ----
  const zipDomain = newDir("zip");
  try {
    const none = run(["app", "templates"], zipDomain);
    expect("app templates: zip が無いときは空の一覧（exit 0・任意と案内）", none.status === 0 && jsonOf(none.stdout)?.templates?.length === 0 && none.stderr.includes("任意"), `${none.stdout}\n${none.stderr}`);

    putZip(zipDomain, "blankapp", templateZip(fixture));
    putZip(zipDomain, "_hidden", templateZip(fixture));
    putZip(zipDomain, ".dot", templateZip(fixture));
    putZip(zipDomain, "broken", Buffer.from("これは zip ではありません"));
    fs.writeFileSync(path.join(zipDomain, "push", "app-templates", "notes.txt"), "zip ではない\n", "utf8");
    fs.mkdirSync(path.join(zipDomain, "push", "app-templates", "folder.zip"));
    const listed = jsonOf(run(["app", "templates"], zipDomain).stdout)?.templates ?? [];
    expect(
      "app templates: 名前・出所・zip 内のアプリ名を出す（先頭が _ や . の zip・zip でないもの・フォルダは数えない）",
      listed.map((t) => t.name).join(",") === "blankapp,broken" && listed[0].source === "domain" && listed[0].appName === "blankapp",
      JSON.stringify(listed)
    );
    expect("app templates: 読めない zip は一覧に残し、appName は null・error を付ける", listed[1].appName === null && typeof listed[1].error === "string", JSON.stringify(listed[1]));

    // 既定（--template なし）は zip を見ない。同名の zip（blankapp.zip）があっても、壊れた zip（broken.zip）があっても、空欄のまま。
    const plain = run(["app", "create", "--name", "blankapp"], zipDomain);
    const plainDir = draftOf(zipDomain, "blankapp");
    expect(
      "app create: 同名の zip があっても、--template なしは空欄ドラフト（zip を読まない）",
      plain.status === 0 && jsonOf(plain.stdout)?.template === null && read(path.join(plainDir, "views", "views.json")) === read(path.join(BLANK_DIR, "views", "views.json")) && jsonOf(read(path.join(plainDir, "app.json")))?.name === "blankapp",
      `${plain.status}\n${plain.stderr}`
    );

    // --template: 対応範囲の zip だけ変換する。
    const conv = run(["app", "create", "--name", "fromzip", "--template", "blankapp"], zipDomain);
    const convDir = draftOf(zipDomain, "fromzip");
    expect("app create --template: 対応範囲の zip を変換して書く（exit 0・template を結果に含む）", conv.status === 0 && jsonOf(conv.stdout)?.template === "blankapp", `${conv.status}\n${conv.stderr}`);
    expect(
      "app create --template: 範囲内のテンプレートの結果は、空欄ドラフトと同じ内容（空のアプリそのもの）",
      BLANK_FILES.every((rel) => read(path.join(convDir, ...rel.split("/"))) === read(path.join(BLANK_DIR, ...rel.split("/")))),
      treeOf(convDir).join(",")
    );
    expect("app create --template: app.json のアプリ名は --name（zip のアプリ名で上書きされない）", jsonOf(read(path.join(convDir, "app.json")))?.name === "fromzip", read(path.join(convDir, "app.json")));
    const convText = allDraftText(convDir);
    expect("app create --template: 通知の内部 ID・uuid は捨てる（zip もコピーしない）", !convText.includes("00000000-0000-4000") && !convText.includes("2010") && !convText.includes("FIELD_ENTITY") && treeOf(convDir).every((x) => !x.endsWith(".zip")), treeOf(convDir).join(","));

    const unknown = run(["app", "create", "--name", "nofallback", "--template", "nope"], zipDomain);
    expect("app create --template: 未知の名前は、使える名前を添えて拒否し、空欄へ切り替えない", unknown.status === 1 && unknown.stderr.includes("使える名前: blankapp, broken") && !fs.existsSync(draftOf(zipDomain, "nofallback")), `${unknown.status}\n${unknown.stderr}`);
    const noneAvailable = newDir("nozip");
    try {
      const r = run(["app", "create", "--name", "x", "--template", "blankapp"], noneAvailable);
      expect("app create --template: zip が無いときも拒否（空欄へ切り替えない）", r.status === 1 && r.stderr.includes("使えるテンプレート zip がありません") && !fs.existsSync(path.join(noneAvailable, "push")), `${r.status}\n${r.stderr}`);
    } finally {
      fs.rmSync(noneAvailable, { recursive: true, force: true });
    }
    for (const bad of ["../x", "_hidden", ".dot", "a/b", "a\\b"]) {
      const r = run(["app", "create", "--name", "bad", "--template", bad], zipDomain);
      expect(`app create --template: 不正なテンプレート名は拒否（${bad}）`, r.status === 1 && !fs.existsSync(draftOf(zipDomain, "bad")), `${r.status}\n${r.stderr}`);
    }
    const brokenRun = run(["app", "create", "--name", "frombroken", "--template", "broken"], zipDomain);
    expect("app create --template: 壊れた zip は拒否し、何も作らない", brokenRun.status === 1 && brokenRun.stderr.includes("zip") && !fs.existsSync(draftOf(zipDomain, "frombroken")), `${brokenRun.status}\n${brokenRun.stderr}`);
  } finally {
    fs.rmSync(zipDomain, { recursive: true, force: true });
  }

  // ---- 4. 範囲外の zip は、未対応の箇所を示してドラフトを作らない ----
  const mutations = [
    { name: "custom-field", want: ["カスタムフィールドがあります", "文字列__1行_"], change: (t, app) => (app.schema.table.fieldList["3000"] = { id: "3000", label: "文字列", properties: {}, type: "SINGLE_LINE_TEXT", var: "文字列__1行_" }) },
    { name: "layout", want: ["レイアウトが空ではありません"], change: (t, app) => (app.form.layout = JSON.stringify([{ type: "ROW", fields: [] }])) },
    { name: "process", want: ["プロセス管理があります"], change: (t, app) => (app.status.useStatus = "true") },
    { name: "plugin", want: ["プラグインがあります"], change: (t, app) => (app.plugins = [{ id: "plugin-1" }]) },
    { name: "js", want: ["JavaScript / CSS のカスタマイズがあります"], change: (t, app) => (app.jsFiles = [{ type: "URL", url: "https://example.com/a.js" }]) },
    { name: "lookup", want: ["ルックアップがあります"], change: (t) => (t.lookups = [{ fieldId: "1" }]) },
    { name: "reference", want: ["関連レコード一覧（参照）があります"], change: (t) => (t.references = [{ fieldId: "1" }]) },
    { name: "report", want: ["グラフがあります"], change: (t, app) => (app.reports = [{ name: "g" }]) },
    { name: "acl", want: ["アクセス権の設定があります"], change: (t, app) => (app.acl.app = [{ entity: "x" }]) },
    { name: "action", want: ["アプリアクションがあります"], change: (t) => (t.actions = [{ name: "a" }]) },
    { name: "custom-view", want: ["組み込みの一覧（すべて）ではありません"], change: (t, app) => (app.views[0].builtinType = null) },
    { name: "view-filter", want: ["組み込みの一覧「（すべて）」に設定があります", "filter.q"], change: (t, app) => (app.views[0].filter.q = "a = 1") },
    { name: "view-status-field", want: ["表示項目が、既定（レコード番号だけ）と違います"], change: (t, app) => app.views[0].fields[0].row.push({ columnWidth: null, id: "2014" }) },
    { name: "view-creator-field", want: ["表示項目が、既定（レコード番号だけ）と違います"], change: (t, app) => app.views[0].fields[0].row.push({ columnWidth: null, id: "2011" }) },
    { name: "view-no-field", want: ["表示項目が、既定（レコード番号だけ）と違います"], change: (t, app) => (app.views[0].fields = []) },
    // 一般設定（info）は既定のまま。黙って捨てない。
    { name: "info-theme", want: ["一般設定「theme」が既定（PLAIN）と違います", "RED"], change: (t, app) => (app.info.theme = "RED") },
    { name: "info-description", want: ["一般設定「description」"], change: (t, app) => (app.info.description = "説明") },
    { name: "info-code", want: ["一般設定「code」"], change: (t, app) => (app.info.code = "APPCODE") },
    { name: "info-icon", want: ["一般設定「iconKey」"], change: (t, app) => (app.info.iconKey = "APP10") },
    { name: "info-comment", want: ["一般設定「useComment」"], change: (t, app) => (app.info.useComment = "false") },
    { name: "info-bulk-deletion", want: ["一般設定「enableBulkDeletion」"], change: (t, app) => (app.info.enableBulkDeletion = "true") },
    { name: "info-rounding", want: ["一般設定「roundingMode」"], change: (t, app) => (app.info.roundingMode = "UP") },
    { name: "settings-notes", want: ["設定のメモ"], change: (t, app) => (app.settingsNotesForm.content = "メモ") },
    { name: "images", want: ["画像"], change: (t) => (t.imagesMeta = [{ key: "x" }]) },
    { name: "root-description", want: ["アプリの説明があります"], change: (t) => (t.description = "説明") },
    // 知らない項目・想定外の形は、未対応として報告する。
    { name: "unknown-root-key", want: ["未対応の項目があります: futureFeature"], change: (t) => (t.futureFeature = { x: 1 }) },
    { name: "unknown-app-key", want: ["未対応の項目があります: apps[0].customizations"], change: (t, app) => (app.customizations = { x: 1 }) },
    { name: "unknown-info-key", want: ["未対応の項目があります: apps[0].info.newSetting"], change: (t, app) => (app.info.newSetting = "x") },
    { name: "empty-app", want: ["想定した項目がありません: apps[0].info", "想定した項目がありません: apps[0].schema", "想定した項目がありません: apps[0].views"], change: (t) => (t.apps = [{}]) },
    { name: "views-object", want: ["形式が想定と違います（配列ではありません）: apps[0].views"], change: (t, app) => (app.views = { a: { builtinType: "CALENDAR" } }) },
    { name: "fieldlist-array", want: ["形式が想定と違います（オブジェクトではありません）: apps[0].schema.table.fieldList"], change: (t, app) => (app.schema.table.fieldList = []) },
    { name: "no-view", want: ["1 つだけではありません"], change: (t, app) => (app.views = []) },
    { name: "two-views", want: ["1 つだけではありません"], change: (t, app) => app.views.push(structuredClone(app.views[0])) },
    // 組み込みフィールドの設定の変更（改名・必須・表示）。
    { name: "builtin-rename", want: ["組み込みフィールドの設定が既定と違います", "案件番号"], change: (t, app) => (app.schema.table.fieldList["2009"].var = "案件番号") },
    { name: "builtin-required", want: ["組み込みフィールドの設定が既定と違います"], change: (t, app) => (app.schema.table.fieldList["2009"].properties.required = "false") },
    { name: "builtin-no-label", want: ["組み込みフィールドの設定が既定と違います"], change: (t, app) => (app.schema.table.fieldList["2012"].properties.noLabel = "true") },
    // 組み込みの一覧の設定、プロセス管理の細部、真偽値の表記ゆれ。
    { name: "view-pager", want: ["組み込みの一覧「（すべて）」に設定があります", "pager"], change: (t, app) => (app.views[0].pager = true) },
    { name: "view-device", want: ["device"], change: (t, app) => (app.views[0].device = "ANY") },
    { name: "view-filter-size", want: ["filter.size"], change: (t, app) => (app.views[0].filter.size = "100") },
    { name: "status-filters", want: ["プロセス管理があります"], change: (t, app) => (app.status.filters = [{ id: "f" }]) },
    { name: "status-upper-true", want: ["プロセス管理があります"], change: (t, app) => (app.status.useStatus = "TRUE") },
    { name: "category-upper-true", want: ["カテゴリーがあります"], change: (t, app) => (app.category.useCategory = "True") },
    { name: "notification-comment-off", want: ["コメントの通知の設定が既定（有効）と違います"], change: (t, app) => (app.notification.useComment = "false") },
    { name: "notification", want: ["既定以外の通知"], change: (t, app) => (app.notification.recordNotifications = [{ id: "n" }]) },
    { name: "two-apps", want: ["アプリが 1 つのテンプレートだけ扱えます"], change: (t, app) => t.apps.push(structuredClone(app)) },
    {
      name: "all-at-once",
      want: ["カスタムフィールドがあります", "レイアウトが空ではありません", "プラグインがあります"],
      change: (t, app) => {
        app.schema.table.fieldList["3000"] = { id: "3000", label: "数値", properties: {}, type: "NUMBER", var: "数値" };
        app.form.layout = JSON.stringify([{ type: "ROW", fields: [] }]);
        app.plugins = [{ id: "plugin-1" }];
      }
    }
  ];
  const rangeDomain = newDir("range");
  try {
    for (const mutation of mutations) {
      const template = structuredClone(fixture);
      mutation.change(template, template.apps[0]);
      putZip(rangeDomain, mutation.name, templateZip(template));
      const draft = `d-${mutation.name}`;
      const r = run(["app", "create", "--name", draft, "--template", mutation.name], rangeDomain);
      expect(
        `app create --template: 範囲外（${mutation.name}）は未対応の箇所を示して拒否し、ドラフトを作らない`,
        r.status === 1 && mutation.want.every((text) => r.stderr.includes(text)) && r.stderr.includes("扱える") && !fs.existsSync(draftOf(rangeDomain, draft)),
        `status=${r.status}\n${r.stderr}`
      );
    }
    putZip(rangeDomain, "no-template-json", buildZip([{ name: "01/signature", data: Buffer.from("x") }]));
    const missing = run(["app", "create", "--name", "d-missing", "--template", "no-template-json"], rangeDomain);
    expect("app create --template: 01/template.json が無い zip は拒否", missing.status === 1 && missing.stderr.includes("01/template.json") && !fs.existsSync(draftOf(rangeDomain, "d-missing")), missing.stderr);
    // 範囲内（既定の通知・組み込みの「（すべて）」だけ。通知の内部 ID が別でも、既定の対象なら良い）は受け付ける。
    const accepted = structuredClone(fixture);
    accepted.apps[0].notification.appNotifications[0].target.entityId = "2011";
    accepted.apps[0].views[0].viewType = "LIST";
    putZip(rangeDomain, "in-range", templateZip(accepted));
    const inRange = run(["app", "create", "--name", "d-in-range", "--template", "in-range"], rangeDomain);
    expect("app create --template: 範囲内（既定の通知の対象が作成者だけ等）は受け付ける", inRange.status === 0 && fs.existsSync(draftOf(rangeDomain, "d-in-range")), `${inRange.status}\n${inRange.stderr}`);
  } finally {
    fs.rmSync(rangeDomain, { recursive: true, force: true });
  }

  // ---- 5. パッケージ内の正本を使う・配布物の zip・同名エラー（パッケージを一時フォルダへ複製して実行する） ----
  const staleDomain = newDir("stale");
  const pkg = newDir("pkg");
  const pkgDomain = newDir("pkgdomain");
  try {
    // cwd に届いた古いスキルのコピーは使わない。
    const stale = path.join(staleDomain, ".claude", "skills", "kint-origin-push", "references", "app-blank", "views", "views.json");
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, '{"views": "STALE"}\n', "utf8");
    const fresh = run(["app", "create", "--name", "fresh"], staleDomain);
    expect("app create: cwd の古いスキルのコピーではなく、パッケージ内の正本を使う", fresh.status === 0 && !read(path.join(draftOf(staleDomain, "fresh"), "views", "views.json")).includes("STALE"), fresh.stderr);

    fs.cpSync(path.join(ROOT, "dist"), path.join(pkg, "dist"), { recursive: true });
    fs.cpSync(path.join(ROOT, "template"), path.join(pkg, "template"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "package.json"), path.join(pkg, "package.json"));
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(pkg, "node_modules"), "junction");
    const runPkg = (args) => {
      const r = spawnSync(process.execPath, [path.join(pkg, "dist", "cli.js"), ...args], { cwd: pkgDomain, encoding: "utf8", env: { ...process.env, ...NO_SHELL_CREDS } });
      return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
    };
    putZip(pkg, "shared", templateZip(fixture), ["template", "app-templates"]);
    putZip(pkg, "dup", templateZip(fixture), ["template", "app-templates"]);
    putZip(pkgDomain, "dup", templateZip(fixture));
    putZip(pkgDomain, "domain-only", templateZip(fixture));

    const dup = runPkg(["app", "templates"]);
    expect("app templates: 配布物と push/app-templates に同じ名前があるとエラー（名前を示す）", dup.status === 1 && dup.stderr.includes("同じ名前") && dup.stderr.includes("dup"), `${dup.status}\n${dup.stderr}`);
    const dupCreate = runPkg(["app", "create", "--name", "x-dup", "--template", "dup"]);
    expect("app create --template: 同名のテンプレートがあるとエラー（作らない）", dupCreate.status === 1 && dupCreate.stderr.includes("同じ名前") && !fs.existsSync(draftOf(pkgDomain, "x-dup")), dupCreate.stderr);
    const blankWithDup = runPkg(["app", "create", "--name", "dup"]);
    expect("app create: 同名のテンプレートがあっても、--template なしは空欄ドラフト（エラーにならない）", blankWithDup.status === 0 && read(path.join(draftOf(pkgDomain, "dup"), "views", "views.json")) === read(path.join(BLANK_DIR, "views", "views.json")), blankWithDup.stderr);

    fs.rmSync(path.join(pkgDomain, "push", "app-templates", "dup.zip"));
    fs.rmSync(path.join(pkg, "template", "app-templates", "dup.zip"));
    const listed = jsonOf(runPkg(["app", "templates"]).stdout)?.templates ?? [];
    expect("app templates: 配布物（distributed）とドメイン（domain）の両方を出す", listed.map((t) => `${t.name}:${t.source}`).join(",") === "domain-only:domain,shared:distributed", JSON.stringify(listed));
    const fromDist = runPkg(["app", "create", "--name", "fromdist", "--template", "shared"]);
    expect("app create --template: 配布物（template/app-templates）の zip も使える", fromDist.status === 0 && read(path.join(draftOf(pkgDomain, "fromdist"), "views", "views.json")) === read(path.join(BLANK_DIR, "views", "views.json")), fromDist.stderr);

    // init は、配布用の zip（template/app-templates/）を UTF-8 のテキストとしてドメインへコピーしない（バイナリが壊れる）。zip はパッケージ内から読む。
    const initDomain = newDir("initdomain");
    try {
      const init = spawnSync(process.execPath, [path.join(pkg, "dist", "cli.js"), "init"], { cwd: initDomain, encoding: "utf8", env: { ...process.env, ...NO_SHELL_CREDS } });
      expect("init: 配布用のアプリテンプレート zip（template/app-templates/）をドメインへコピーしない（バイナリを壊さない）", init.status === 0 && !fs.existsSync(path.join(initDomain, "app-templates")) && fs.existsSync(path.join(initDomain, "push", "new-apps", "_example")), `${init.status}\n${init.stderr}\n${treeOf(initDomain).slice(0, 20).join(",")}`);
    } finally {
      fs.rmSync(initDomain, { recursive: true, force: true });
    }
  } finally {
    try {
      fs.rmdirSync(path.join(pkg, "node_modules")); // junction だけを消す（中身は消さない）
    } catch {
      // 無ければよい
    }
    for (const dir of [staleDomain, pkg, pkgDomain]) fs.rmSync(dir, { recursive: true, force: true });
  }
  expect("smoke 後始末: node_modules（junction の先）が残っている", fs.existsSync(path.join(ROOT, "node_modules", "typescript")), "node_modules removed?");

  // ---- 6. 操作制限・ヘルプ ----
  const policy = await import(pathToFileURL(path.join(ROOT, "dist", "policy.js")).href);
  const req = (sub) => policy.requiredPermissions("app", sub, {}).join(",");
  expect("policy: app create / app templates は許可不要（API を呼ばない）", req("create") === "" && req("templates") === "", `${req("create")} / ${req("templates")}`);
  let unregistered = "";
  try {
    policy.requiredPermissions("app", "bogus", {});
  } catch (error) {
    unregistered = String(error.message);
  }
  expect("policy: 未登録の app サブコマンドはエラー", unregistered.includes("未登録"), unregistered);
  const helpCreate = run(["app", "create", "--help"], os.tmpdir());
  expect(
    "help: app create --help（書式・使えるオプション・必要な許可なし）",
    helpCreate.status === 0 && helpCreate.stdout.includes("app create --name <アプリ名>") && helpCreate.stdout.includes("使えるオプション: --name, --template, --space, --thread, --guestspace") && helpCreate.stdout.includes("必要な許可（.env）: なし"),
    helpCreate.stdout
  );
  const helpGroup = run(["app", "--help"], os.tmpdir());
  expect("help: app --help は templates と create を並べる", helpGroup.status === 0 && helpGroup.stdout.includes("app templates") && helpGroup.stdout.includes("app create"), helpGroup.stdout);
  const helpAll = run(["help"], os.tmpdir());
  expect("help: 全体の一覧に app templates / app create / diff rehearsal と許可不要の記載を含む", helpAll.stdout.includes("app templates") && helpAll.stdout.includes("app create") && helpAll.stdout.includes("diff rehearsal") && helpAll.stdout.includes("は許可不要"), helpAll.stdout);

  // ---- 7. テンプレート変換（純関数）----
  const convert = await import(pathToFileURL(path.join(ROOT, "dist", "kintone", "appTemplateConvert.js")).href);
  const analysis = convert.analyzeAppTemplate(fixture);
  expect("変換: blankapp の形は扱える（未対応なし・アプリ名 blankapp）", analysis.issues.length === 0 && analysis.appName === "blankapp" && convert.templateAppName(fixture) === "blankapp", JSON.stringify(analysis.issues));
  expect("変換: 空欄の正本（fields / views）は組み込みフィールド・一覧を持たない", Object.keys(jsonOf(read(path.join(BLANK_DIR, "form", "fields.json")))?.properties ?? { x: 1 }).length === 0 && Object.keys(jsonOf(read(path.join(BLANK_DIR, "views", "views.json")))?.views ?? { x: 1 }).length === 0, "blank source");
  expect("変換: オブジェクトでないテンプレートは未対応として返す（throw しない）", convert.analyzeAppTemplate(null).issues.length === 1 && convert.analyzeAppTemplate([]).issues.length === 1, "non-object");

  // ---- 8. zip リーダー（純関数） ----
  const zipRead = await import(pathToFileURL(path.join(ROOT, "dist", "zipRead.js")).href);
  const text = Buffer.from("日本語のテキスト\n".repeat(200), "utf8");
  for (const descriptor of [true, false]) {
    const zip = buildZip([{ name: "a/deflated.txt", data: text }, { name: "stored.txt", data: Buffer.from("raw"), deflate: false }], { descriptor });
    const label = descriptor ? "データ記述子あり" : "データ記述子なし";
    expect(`zipRead: deflate と無圧縮を読む（${label}）`, zipRead.readZipFile(zip, "a/deflated.txt")?.equals(text) && zipRead.readZipFile(zip, "stored.txt")?.toString() === "raw", label);
    expect(`zipRead: 無いエントリは undefined（${label}）`, zipRead.readZipFile(zip, "missing.txt") === undefined, label);
  }
  const sample = buildZip([{ name: "x.txt", data: Buffer.from("hello world"), deflate: false }]);
  const throwsWith = (fn, want) => {
    try {
      fn();
      return false;
    } catch (error) {
      return String(error.message).includes(want);
    }
  };
  const centralAt = sample.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const patched = (change) => {
    const copy = Buffer.from(sample);
    change(copy);
    return copy;
  };
  expect("zipRead: zip でないデータは拒否", throwsWith(() => zipRead.listZipEntries(Buffer.from("not a zip file at all, really")), "zip"), "not zip");
  expect("zipRead: 小さすぎるデータは拒否", throwsWith(() => zipRead.listZipEntries(Buffer.alloc(5)), "小さすぎ"), "tiny");
  expect("zipRead: 本文の破損（CRC 不一致）を検出", throwsWith(() => zipRead.readZipFile(patched((b) => { b[b.indexOf(Buffer.from("hello"))] ^= 0xff; }), "x.txt"), "CRC"), "crc");
  expect("zipRead: 暗号化されたエントリは拒否", throwsWith(() => zipRead.readZipFile(patched((b) => b.writeUInt16LE(b.readUInt16LE(centralAt + 8) | 1, centralAt + 8)), "x.txt"), "暗号化"), "encrypted");
  expect("zipRead: 展開サイズの上限を超えるエントリは拒否", throwsWith(() => zipRead.readZipFile(patched((b) => b.writeUInt32LE(zipRead.ZIP_MAX_ENTRY_BYTES + 1, centralAt + 24)), "x.txt"), "大きすぎ"), "too large");
  expect("zipRead: zip64 の印（0xFFFFFFFF）は拒否", throwsWith(() => zipRead.readZipFile(patched((b) => b.writeUInt32LE(0xffffffff, centralAt + 24)), "x.txt"), "zip64"), "zip64");
  expect("zipRead: 未対応の圧縮方式は拒否", throwsWith(() => zipRead.readZipFile(patched((b) => b.writeUInt16LE(12, centralAt + 10)), "x.txt"), "未対応の圧縮方式"), "method");
  expect("zipRead: 途中で切れたデータは拒否", throwsWith(() => zipRead.readZipFile(patched((b) => b.writeUInt32LE(b.length, centralAt + 20)), "x.txt"), "切れて"), "truncated");
  // 分割 zip（EOCD のディスク番号）の拒否・自前の CRC-32（Node 22.0〜22.1 には zlib.crc32 が無い）・`\` 区切りの名前。
  const endAt = sample.length - 22;
  expect("zipRead: 分割 zip（ディスク番号が 0 でない）は拒否", throwsWith(() => zipRead.readZipFile(patched((b) => b.writeUInt16LE(3, endAt + 4)), "x.txt"), "分割"), "split");
  expect("zipRead: 分割 zip（中央ディレクトリの開始ディスクが 0 でない）は拒否", throwsWith(() => zipRead.readZipFile(patched((b) => b.writeUInt16LE(1, endAt + 6)), "x.txt"), "分割"), "split2");
  expect("zipRead: 分割 zip（このディスクのエントリ数が全体と違う）は拒否", throwsWith(() => zipRead.readZipFile(patched((b) => b.writeUInt16LE(0, endAt + 8)), "x.txt"), "分割"), "split3");
  const crcSamples = [Buffer.alloc(0), Buffer.from("hello world"), Buffer.from("日本語のテキスト\n".repeat(300)), Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff))];
  const referenceCrc32 = typeof zlib.crc32 === "function" ? zlib.crc32 : crc32;
  expect("zipRead: CRC-32 が標準値・参照実装と一致する（Node 22.0〜22.1 では同梱の参照実装を使う）", crcSamples.every((data) => zipRead.crc32(data) === referenceCrc32(data)) && crc32(Buffer.from("123456789")) === 0xcbf43926 && zipRead.crc32(Buffer.from("123456789")) === 0xcbf43926, "crc32");
  const backslash = buildZip([{ name: "01\\template.json", data: Buffer.from("{}") }]);
  expect("zipRead: 名前の区切りが `\\` の zip（PowerShell 5.1 の Compress-Archive）も、`/` の名前で探せる", zipRead.readZipFile(backslash, "01/template.json")?.toString() === "{}", "backslash");
  const bomb = zlib.deflateRawSync(Buffer.alloc(zipRead.ZIP_MAX_ENTRY_BYTES + 1024));
  expect("zipRead: 申告より大きく展開されるデータ（zip 爆弾）は、上限で止めて拒否", throwsWith(() => {
    const entry = { name: "b", method: 8, flags: 0, crc32: 0, compressedSize: bomb.length, size: 10, localOffset: 0 };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    zipRead.readZipEntry(Buffer.concat([local, bomb]), entry);
  }, "展開できません"), "bomb");
}
