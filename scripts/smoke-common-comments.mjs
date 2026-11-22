import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.text, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export async function commonCommentsTests({ expect, runCliAsync, startMockKintone, mockEnv, noShellCreds }) {
  console.log("[offline] 共通設定の手動取り込み・API取得、コメントのページングと保存");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-common-comments-"));
  try {
    const capture = path.join(tmp, "captures", "kintone-common");
    writeText(path.join(capture, "customize", "customize-manifest.json"), JSON.stringify({
      scope: "ALL",
      desktop: { js: ["desktop/js/example.js"], css: [] },
      mobile: { js: [], css: [] }
    }));
    writeText(path.join(capture, "customize", "desktop", "js", "example.js"), "console.log('common');\r\n");
    writeText(path.join(capture, "settings", "user-management.json"), JSON.stringify({ z: 2, a: 1 }));
    writeText(path.join(capture, "templates", "apps", "index.json"), JSON.stringify({ archives: ["sample.zip"] }));
    writeText(path.join(capture, "templates", "spaces", "index.json"), JSON.stringify({ archives: ["space.sptpl"] }));
    fs.writeFileSync(path.join(capture, "templates", "apps", "sample.zip"), storedZip([
      { name: "app.json", text: JSON.stringify({ app: { name: "Sample" } }) },
      { name: "views/view.json", text: JSON.stringify({ title: "List" }) }
    ]));
    fs.writeFileSync(path.join(capture, "templates", "spaces", "space.sptpl"), storedZip([
      { name: "space.json", text: JSON.stringify({ name: "Sample space" }) }
    ]));

    const localImport = await runCliAsync(["pull", "common", "--from", "captures/kintone-common"], tmp, noShellCreds);
    const localSummary = JSON.parse(localImport.stdout || "null");
    const common = path.join(tmp, "data", "kintone", "common");
    expect("pull common --from は認証情報なしで手動データを取り込む", localImport.status === 0
      && localSummary?.written.includes("customize/customize-manifest.json")
      && fs.readFileSync(path.join(common, "customize", "desktop", "js", "example.js"), "utf8") === "console.log('common');\n"
      && JSON.stringify(readJson(path.join(common, "settings", "user-management.json"))) === '{"a":1,"z":2}'
      && readJson(path.join(common, "templates", "apps", "index.json")).archives[0].file === "sample.zip"
      && JSON.stringify(readJson(path.join(common, "templates", "apps", "sample", "views", "view.json"))) === '{"title":"List"}'
      && readJson(path.join(common, "templates", "spaces", "index.json")).archives[0].file === "space.sptpl"
      && fs.readFileSync(path.join(common, "templates", "spaces", "space.sptpl")).equals(fs.readFileSync(path.join(capture, "templates", "spaces", "space.sptpl")))
      && JSON.stringify(readJson(path.join(common, "templates", "spaces", "space", "space.json"))) === '{"name":"Sample space"}',
    `${localImport.stdout}\n${localImport.stderr}`);

    const unchanged = await runCliAsync(["pull", "common", "--from", "captures/kintone-common"], tmp, noShellCreds);
    expect("共通設定の再取り込みは同じ JSON・ZIP を変更しない", unchanged.status === 0
      && JSON.parse(unchanged.stdout || "null")?.written.length === 0
      && JSON.parse(unchanged.stdout || "null")?.unchanged.length >= 5, unchanged.stdout || unchanged.stderr);

    fs.unlinkSync(path.join(capture, "templates", "spaces", "space.sptpl"));
    fs.writeFileSync(path.join(capture, "templates", "spaces", "Space.sptpl"), storedZip([
      { name: "space.json", text: JSON.stringify({ name: "Case changed" }) }
    ]));
    writeText(path.join(capture, "templates", "spaces", "index.json"), JSON.stringify({ archives: ["Space.sptpl"] }));
    const caseOnlyTemplate = await runCliAsync(["pull", "common", "--from", "captures/kintone-common"], tmp, noShellCreds);
    expect("テンプレートファイル名の大文字・小文字だけを変える同期は安全のため中断し、既存展開結果を保つ", caseOnlyTemplate.status === 1
      && fs.existsSync(path.join(common, "templates", "spaces", "space.sptpl"))
      && fs.existsSync(path.join(common, "templates", "spaces", "space", "space.json"))
      && caseOnlyTemplate.stderr.includes("大文字・小文字だけを変更"), caseOnlyTemplate.stderr);
    fs.unlinkSync(path.join(capture, "templates", "spaces", "Space.sptpl"));
    fs.writeFileSync(path.join(capture, "templates", "spaces", "space.sptpl"), storedZip([
      { name: "space.json", text: JSON.stringify({ name: "Sample space" }) }
    ]));
    writeText(path.join(capture, "templates", "spaces", "index.json"), JSON.stringify({ archives: [] }));
    const deleteSptpl = await runCliAsync(["pull", "common", "--from", "captures/kintone-common"], tmp, noShellCreds);
    expect(".sptpl の削除は ZIP と拡張子除去後の展開 JSON を両方削除する", deleteSptpl.status === 0
      && !fs.existsSync(path.join(common, "templates", "spaces", "space.sptpl"))
      && !fs.existsSync(path.join(common, "templates", "spaces", "space", "space.json"))
      && readJson(path.join(common, "templates", "spaces", "index.json")).archives.length === 0,
    `${deleteSptpl.stdout}\n${deleteSptpl.stderr}`);

    writeText(path.join(capture, "customize", "desktop", "js", "example.js"), "console.log('updated');\n");
    const updatedCustomize = await runCliAsync(["pull", "common", "--from", "captures/kintone-common"], tmp, noShellCreds);
    expect("共通カスタマイズは前回管理した JS を内容変更して再取り込みできる", updatedCustomize.status === 0
      && fs.readFileSync(path.join(common, "customize", "desktop", "js", "example.js"), "utf8") === "console.log('updated');\n",
    `${updatedCustomize.stdout}\n${updatedCustomize.stderr}`);

    const missingCapture = await runCliAsync(["pull", "common", "--from", "captures/missing"], tmp, noShellCreds);
    expect("pull common --from の存在しないパスは失敗する", missingCapture.status === 1 && missingCapture.stderr.includes("取り込み元ディレクトリがありません"), missingCapture.stderr);

    const oldSetting = fs.readFileSync(path.join(common, "settings", "user-management.json"), "utf8");
    fs.unlinkSync(path.join(capture, "settings", "user-management.json"));
    writeText(path.join(capture, "settings", "User-Management.json"), JSON.stringify({ z: 2, a: 1 }));
    const caseOnlySetting = await runCliAsync(["pull", "common", "--from", "captures/kintone-common"], tmp, noShellCreds);
    expect("設定ファイル名の大文字・小文字だけを変える同期は安全のため中断し、既存ファイルを保つ", caseOnlySetting.status === 1
      && fs.readFileSync(path.join(common, "settings", "user-management.json"), "utf8") === oldSetting
      && caseOnlySetting.stderr.includes("大文字・小文字だけを変更"), caseOnlySetting.stderr);
    fs.unlinkSync(path.join(capture, "settings", "User-Management.json"));

    fs.writeFileSync(path.join(capture, "settings", "user-management.json"), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
    const invalidUtf8 = await runCliAsync(["pull", "common", "--from", "captures/kintone-common"], tmp, noShellCreds);
    expect("共通設定 JSON の不正 UTF-8 は文字化けとして保存せず、既存設定を保つ", invalidUtf8.status === 1
      && fs.readFileSync(path.join(common, "settings", "user-management.json"), "utf8") === oldSetting
      && invalidUtf8.stderr.includes("UTF-8 の JSON"), invalidUtf8.stderr);
    writeText(path.join(capture, "settings", "user-management.json"), JSON.stringify({ z: 2, a: 1 }));

    writeText(path.join(capture, "templates", "apps", "index.json"), JSON.stringify({ archives: ["sample.zip", "sample.zip.zip"] }));
    fs.writeFileSync(path.join(capture, "templates", "apps", "sample.zip.zip"), storedZip([
      { name: "nested.json", text: "{}" }
    ]));
    const collision = await runCliAsync(["pull", "common", "--from", "captures/kintone-common"], tmp, noShellCreds);
    expect("テンプレート ZIP と別アーカイブの展開先が衝突する入力は、書き込み前に中断する", collision.status === 1
      && readJson(path.join(common, "templates", "apps", "index.json")).archives[0].file === "sample.zip"
      && !fs.existsSync(path.join(common, "templates", "apps", "sample.zip.zip"))
      && collision.stderr.includes("パスが衝突"), collision.stderr);
    fs.unlinkSync(path.join(capture, "templates", "apps", "sample.zip.zip"));

    writeText(path.join(capture, "settings", "user-management.json"), JSON.stringify({ updated: true }));
    writeText(path.join(capture, "templates", "apps", "index.json"), JSON.stringify({ archives: ["bad.zip"] }));
    fs.writeFileSync(path.join(capture, "templates", "apps", "bad.zip"), storedZip([
      { name: "../outside.json", text: "{}" }
    ]));
    const invalid = await runCliAsync(["pull", "common", "--from", "captures/kintone-common"], tmp, noShellCreds);
    expect("危険な ZIP パスは取り込みを中断し既存の設定を保持する", invalid.status === 1
      && fs.readFileSync(path.join(common, "settings", "user-management.json"), "utf8") === oldSetting
      && invalid.stderr.includes("相対パス"), invalid.stderr);

    const pluginId = "a".repeat(32);
    let failCommentRecord = "";
    const mock = await startMockKintone((url) => {
      if (url.pathname === "/k/v1/apps.json") {
        return [200, { apps: [{ appId: "30", code: "comments", name: "Comments", spaceId: "7", modifiedAt: "2026-01-01T00:00:00Z" }] }];
      }
      if (url.pathname === "/k/v1/app.json") return [200, { appId: "30", spaceId: "7", name: "Comments" }];
      if (url.pathname === "/k/v1/space.json") return [200, { id: "7", isGuest: false }];
      if (url.pathname === "/k/v1/plugins.json") return [200, { plugins: [] }];
      if (url.pathname === "/k/v1/plugins/required.json") return [200, { plugins: [{ id: pluginId, name: "Required" }] }];
      if (url.pathname === "/k/v1/records.json") {
        const query = url.searchParams.get("query") || "";
        if (query.includes("$id > 0")) return [200, { records: [{ $id: { value: "1" } }, { $id: { value: "2" } }] }];
        if (query.includes("$id > 2")) return [200, { records: [] }];
      }
      if (url.pathname.endsWith("/record/comments.json")) {
        const record = url.searchParams.get("record") || "";
        if (record === failCommentRecord) return [400, { code: "TEST", message: "comment fixture failure" }];
        if (record === "2") return [200, { comments: [], older: false, newer: false }];
        const offset = Number(url.searchParams.get("offset") || "0");
        const count = Math.max(0, Math.min(10, 11 - offset));
        const comments = Array.from({ length: count }, (_, index) => {
          const id = offset + index + 1;
          return { id: String(id), text: `comment ${id}`, createdAt: "2026-01-01T00:00:00Z", creator: { code: "user", name: "User" }, mentions: [] };
        });
        return [200, { comments, older: offset > 0, newer: offset + comments.length < 11 }];
      }
      return null;
    });
    try {
      const index = await runCliAsync(["pull", "index"], tmp, mockEnv(mock.baseUrl));
      const threads = path.join(tmp, "data", "kintone", "spaces", "space-7", "threads");
      expect("pull index はスペース直下に手動用 threads/ を作る", index.status === 0 && fs.existsSync(path.join(threads, ".gitkeep")), index.stderr);
      const required = await runCliAsync(["pull", "common"], tmp, mockEnv(mock.baseUrl));
      const requiredSummary = JSON.parse(required.stdout || "null");
      expect("pull common は必須プラグイン設定を取得し既存プラグイン一覧も維持する", required.status === 0
        && requiredSummary?.requiredPlugins === 1 && requiredSummary?.apiCalls === 2
        && readJson(path.join(tmp, "data", "kintone", "common", "plugins", "required.json")).plugins[0]?.id === pluginId
        && readJson(path.join(tmp, "data", "kintone", "plugin", "installed.json")).plugins.length === 0,
      `${required.stdout}\n${required.stderr}`);

      const commentsEnv = mockEnv(mock.baseUrl);
      writeText(path.join(tmp, ".env"), "KINT_ORIGIN_ALLOW_PULL_RECORDS=true\n");
      const comments = await runCliAsync(["pull", "comments", "--id", "30"], tmp, commentsEnv);
      const commentSummary = JSON.parse(comments.stdout || "null");
      const appComments = path.join(tmp, "data", "kintone", "spaces", "space-7", "apps", "app-30", "comments");
      const record1 = path.join(appComments, "record-1.json");
      const record2 = path.join(appComments, "record-2.json");
      expect("pull comments は全レコードを列挙しコメントの複数ページを各アプリに保存する", comments.status === 0
        && commentSummary?.records === 2 && commentSummary?.comments === 11
        && commentSummary?.empty === 1 && readJson(record1).comments.length === 11 && !fs.existsSync(record2),
      `${comments.stdout}\n${comments.stderr}`);

      const record1BeforeFailure = fs.readFileSync(record1, "utf8");
      failCommentRecord = "1";
      const failed = await runCliAsync(["pull", "comments", "--id", "30,1"], tmp, commentsEnv);
      expect("コメント取得の一部失敗は exit 1 で既存 JSON を保持する", failed.status === 1
        && fs.readFileSync(record1, "utf8") === record1BeforeFailure
        && JSON.parse(failed.stdout || "null")?.failures?.[0]?.recordId === "1", `${failed.stdout}\n${failed.stderr}`);

      const appMeta = path.join(tmp, "data", "kintone", "spaces", "space-7", "apps", "app-30", "app.json");
      writeText(appMeta, JSON.stringify({ domain: "other.example", appId: "30", name: "Wrong tenant" }));
      const beforeWrongTenant = mock.requests.length;
      const wrongTenant = await runCliAsync(["pull", "comments", "--id", "30,1"], tmp, commentsEnv);
      expect("コメント取得は既存 app.json が別ドメインならコメント API 前に停止し、既存ファイルを保つ", wrongTenant.status === 1
        && !mock.requests.slice(beforeWrongTenant).some((request) => request.includes("/records.json") || request.includes("/record/comments.json"))
        && wrongTenant.stderr.includes("取得元 other.example")
        && fs.readFileSync(record1, "utf8") === record1BeforeFailure,
      `${wrongTenant.stdout}\n${wrongTenant.stderr}`);
      fs.unlinkSync(appMeta);

      const beforeDenied = mock.requests.length;
      writeText(path.join(tmp, ".env"), "KINT_ORIGIN_ALLOW_PULL_RECORDS=false\n");
      const denied = await runCliAsync(["pull", "comments", "--id", "30,1"], tmp, commentsEnv);
      expect("pull comments は pull:records 許可がなければ API を呼ばない", denied.status === 1
        && mock.requests.length === beforeDenied && denied.stderr.includes("KINT_ORIGIN_ALLOW_PULL_RECORDS"), denied.stderr);

      const helpRequests = mock.requests.length;
      const help = await runCliAsync(["pull", "comments", "--help"], tmp, commentsEnv);
      expect("pull comments の help は必須引数・許可を示し API を呼ばない", help.status === 0
        && help.stdout.includes("--id") && help.stdout.includes("KINT_ORIGIN_ALLOW_PULL_RECORDS")
        && mock.requests.length === helpRequests, help.stdout || help.stderr);

      fs.rmSync(threads, { recursive: true, force: true });
      fs.writeFileSync(threads, "manual sentinel");
      const threadPathConflict = await runCliAsync(["pull", "index"], tmp, mockEnv(mock.baseUrl));
      expect("threads がディレクトリ以外なら pull index は中断し、既存ファイルを維持する", threadPathConflict.status === 1
        && fs.readFileSync(threads, "utf8") === "manual sentinel", threadPathConflict.stderr);
    } finally {
      mock.server.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
