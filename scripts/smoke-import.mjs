// smoke: 更新キー付き CSV の一括取込（diff import / push import / push import --restore）。
// 確認すること:
//  - 純関数: import.json・更新キーの可否・レコード番号（CODE-数字）・クエリのエスケープと 100 件の分割・列の検証・行の値（空セルは clear）・CSV の読み込み
//  - CLI: --name 無し・許可が無いときの拒否と diff import の案内・非対話で -y 無しは API の前に中断・PUSH_RECORDS で records/import を共通許可
//  - mock kintone: 文字列の更新キーで更新と追加、空セルが消え、CSV に無い列は残る、値が同じなら送らない、バックアップ・検証・再実行ガード、
//    --restore で更新が戻り追加したレコードが消える、実行後の別更新は復旧が中断し --overwrite-remote で上書き、
//    検証エラーはすべて API を書き込まずに行番号つきで報告、レコード番号キー・Shift_JIS・ゲストスペース

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const NO_SHELL_CREDS = { CYBOZU_BASE_URL: "", CYBOZU_USERNAME: "", CYBOZU_PASSWORD: "" };

// ---- フォーム定義 ----
const P = (type, code, extra = {}) => ({ type, code, label: code, ...extra });
const opts = (...names) => Object.fromEntries(names.map((name, index) => [name, { label: name, index: String(index) }]));
const FORMS = {
  "303": {
    レコード番号: P("RECORD_NUMBER", "レコード番号"),
    社員番号: P("SINGLE_LINE_TEXT", "社員番号", { required: true, unique: true, expression: "" }),
    氏名: P("SINGLE_LINE_TEXT", "氏名", { required: true, unique: false }),
    部署: P("DROP_DOWN", "部署", { options: opts("営業部", "開発部") }),
    備考: P("MULTI_LINE_TEXT", "備考"),
    数量: P("NUMBER", "数量", { unique: false }),
    タグ: P("CHECK_BOX", "タグ", { options: opts("A", "B", "C") }),
    担当: P("USER_SELECT", "担当"),
    区分: P("RADIO_BUTTON", "区分", { required: true, defaultValue: "甲", options: opts("甲", "乙") }),
    入社日: P("DATE", "入社日"),
    合計: P("CALC", "合計", { expression: "数量*2" }),
    自動: P("SINGLE_LINE_TEXT", "自動", { expression: "氏名" }),
    作成者: P("CREATOR", "作成者"),
    添付: P("FILE", "添付"),
    名簿: P("SUBTABLE", "名簿", { fields: { 内訳: P("SINGLE_LINE_TEXT", "内訳") } })
  },
  "450": {
    レコード番号: P("RECORD_NUMBER", "レコード番号"),
    氏名: P("SINGLE_LINE_TEXT", "氏名"),
    取引先: P("SINGLE_LINE_TEXT", "取引先")
  },
  "460": { 社員番号: P("SINGLE_LINE_TEXT", "社員番号", { unique: true }), 氏名: P("SINGLE_LINE_TEXT", "氏名") },
  "470": { code: P("SINGLE_LINE_TEXT", "code", { unique: true }), name: P("SINGLE_LINE_TEXT", "name") },
  "480": { 番号: P("NUMBER", "番号", { unique: true }), 氏名: P("SINGLE_LINE_TEXT", "氏名") },
  "490": { 社員番号: P("SINGLE_LINE_TEXT", "社員番号", { unique: true }), 氏名: P("SINGLE_LINE_TEXT", "氏名", { required: true, defaultValue: "" }) }
};
const GUEST_APPS = { "460": "7" };
const APP_CODES = { "450": "EMP" };
const UNIQUE_FIELDS = { "303": ["社員番号"], "460": ["社員番号"], "470": ["code"], "480": ["番号"] };

const rec = (id, revision, fields) => ({ $id: { type: "__ID__", value: String(id) }, $revision: { type: "__REVISION__", value: String(revision) }, ...fields });
const f = (type, value) => ({ type, value });

function createState() {
  return {
    records: {
      "303": new Map([
        ["1", rec(1, 3, { レコード番号: f("RECORD_NUMBER", "1"), 社員番号: f("SINGLE_LINE_TEXT", "E0001"), 氏名: f("SINGLE_LINE_TEXT", "山田"), 部署: f("DROP_DOWN", "営業部"), 備考: f("MULTI_LINE_TEXT", "メモ"), 数量: f("NUMBER", "10"), タグ: f("CHECK_BOX", ["A", "B"]), 担当: f("USER_SELECT", [{ code: "u1", name: "U1" }]), 区分: f("RADIO_BUTTON", "甲"), 入社日: f("DATE", "2020-04-01") })],
        ["2", rec(2, 1, { レコード番号: f("RECORD_NUMBER", "2"), 社員番号: f("SINGLE_LINE_TEXT", "E0002"), 氏名: f("SINGLE_LINE_TEXT", "佐藤"), 部署: f("DROP_DOWN", "開発部"), 備考: f("MULTI_LINE_TEXT", ""), 数量: f("NUMBER", "5"), タグ: f("CHECK_BOX", []), 担当: f("USER_SELECT", []), 区分: f("RADIO_BUTTON", "乙"), 入社日: f("DATE", null) })]
      ]),
      "450": new Map([
        ["7", rec(7, 2, { レコード番号: f("RECORD_NUMBER", "EMP-7"), 氏名: f("SINGLE_LINE_TEXT", "旧"), 取引先: f("SINGLE_LINE_TEXT", "A社") })],
        ["8", rec(8, 1, { レコード番号: f("RECORD_NUMBER", "EMP-8"), 氏名: f("SINGLE_LINE_TEXT", "八"), 取引先: f("SINGLE_LINE_TEXT", "B社") })]
      ]),
      "460": new Map([["1", rec(1, 1, { 社員番号: f("SINGLE_LINE_TEXT", "G1"), 氏名: f("SINGLE_LINE_TEXT", "ゲスト") })]]),
      "470": new Map([["1", rec(1, 1, { code: f("SINGLE_LINE_TEXT", "S1"), name: f("SINGLE_LINE_TEXT", "x") })]]),
      "480": new Map([["1", rec(1, 1, { 番号: f("NUMBER", "10.5"), 氏名: f("SINGLE_LINE_TEXT", "数値キー") })]]),
      "490": new Map()
    },
    nextId: { "303": 100, "450": 500, "460": 50, "470": 10, "480": 20, "490": 0 },
    bulkBodies: [],
    queries: [],
    failNextBulk: null,
    caseInsensitive: false, // true なら、文字列の検索が大文字小文字を区別しない（kintone の検索が同じ値として扱う場合の再現）
    committedBulks: 0
  };
}

function typeOf(app, code) {
  const form = FORMS[app] ?? {};
  if (form[code]) return form[code].type;
  for (const prop of Object.values(form)) if (prop.fields?.[code]) return prop.fields[code].type;
  return "SINGLE_LINE_TEXT";
}

function applyFields(app, target, incoming) {
  for (const [code, field] of Object.entries(incoming)) {
    const type = typeOf(app, code);
    let value = field.value;
    if (type === "USER_SELECT") value = (value ?? []).map((item) => ({ code: item.code, name: item.code }));
    target[code] = { type, value };
  }
}

// "a", "b" や 1, 2 のような in の値の並びを解釈する（\" と \\ のエスケープを戻す）。
function parseInList(text) {
  const items = [];
  let i = 0;
  while (i < text.length) {
    while (text[i] === " " || text[i] === ",") i += 1;
    if (i >= text.length) break;
    if (text[i] === '"') {
      let value = "";
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i += 1;
        value += text[i];
        i += 1;
      }
      i += 1;
      items.push(value);
    } else {
      let j = i;
      while (j < text.length && text[j] !== ",") j += 1;
      items.push(text.slice(i, j).trim());
      i = j;
    }
  }
  return items;
}

function bulk(state, body) {
  state.bulkBodies.push(JSON.parse(JSON.stringify(body)));
  const requests = body.requests ?? [];
  const results = requests.map(() => ({}));
  const fail = (index, code, message) => {
    results[index] = { code, message, id: "mock-error" };
    return [400, { results }];
  };
  if (state.failNextBulk) {
    const failure = state.failNextBulk;
    state.failNextBulk = null;
    return fail(0, failure.code, failure.message);
  }
  const draft = {};
  for (const [app, map] of Object.entries(state.records)) draft[app] = new Map([...map].map(([id, record]) => [id, JSON.parse(JSON.stringify(record))]));
  const nextId = { ...state.nextId };
  const checkUnique = (app, i) => {
    for (const code of UNIQUE_FIELDS[app] ?? []) {
      const seen = new Set();
      for (const record of draft[app].values()) {
        const value = String(record[code]?.value ?? "");
        if (value === "") continue;
        if (seen.has(value)) return fail(i, "GAIA_UN03", `「${code}」の値が重複しています: ${value}`);
        seen.add(value);
      }
    }
    return null;
  };
  for (let i = 0; i < requests.length; i += 1) {
    const { method, api, payload } = requests[i];
    const route = /^\/k\/(?:guest\/(\d+)\/)?v1\/records?\.json$/.exec(api);
    if (!route) return fail(i, "GAIA_AP01", "不明な API です: " + api);
    const app = String(payload.app);
    if ((GUEST_APPS[app] ?? "") !== (route[1] ?? "")) return fail(i, "GAIA_IL23", "ゲストスペースの URL が一致しません。");
    const map = draft[app];
    if (method === "PUT") {
      const done = [];
      for (const item of payload.records) {
        const record = map.get(String(item.id));
        if (!record) return fail(i, "GAIA_RE01", `指定したレコード（id: ${item.id}）が見つかりません。`);
        if (item.revision != null && String(item.revision) !== "-1" && String(item.revision) !== record.$revision.value) {
          return fail(i, "GAIA_CO02", "更新しようとしたレコードは他のユーザーによって更新されています。");
        }
        applyFields(app, record, item.record ?? {});
        record.$revision.value = String(Number(record.$revision.value) + 1);
        done.push({ id: String(item.id), revision: record.$revision.value });
      }
      results[i] = { records: done };
    } else if (method === "POST") {
      const ids = [];
      for (const incoming of payload.records) {
        const id = String((nextId[app] += 1));
        const record = rec(id, 1, {});
        applyFields(app, record, incoming);
        if (typeOf(app, "レコード番号") === "RECORD_NUMBER" && FORMS[app]?.レコード番号) record.レコード番号 = f("RECORD_NUMBER", (APP_CODES[app] ? APP_CODES[app] + "-" : "") + id);
        map.set(id, record);
        ids.push(id);
      }
      results[i] = { ids, revisions: ids.map(() => "1") };
    } else if (method === "DELETE") {
      for (const [k, id] of payload.ids.entries()) {
        const record = map.get(String(id));
        const revision = payload.revisions?.[k];
        if (!record) return fail(i, "GAIA_RE01", `指定したレコード（id: ${id}）が見つかりません。`);
        if (revision != null && String(revision) !== "-1" && String(revision) !== record.$revision.value) return fail(i, "GAIA_CO02", "削除しようとしたレコードは他のユーザーによって更新されています。");
        map.delete(String(id));
      }
    }
    const dup = checkUnique(app, i);
    if (dup) return dup;
  }
  for (const [app, map] of Object.entries(draft)) state.records[app] = map;
  state.nextId = nextId;
  state.committedBulks += 1;
  return [200, { results }];
}

function handle(state, method, url, body) {
  const route = /^\/k\/(?:guest\/(\d+)\/)?v1\/(.+)$/.exec(url.pathname);
  if (!route) return null;
  const guest = route[1] ?? "";
  const endpoint = "/" + route[2];
  const app = url.searchParams.get("app");
  if (method === "GET" && endpoint === "/app.json") {
    const id = url.searchParams.get("id");
    return [200, { appId: id, code: APP_CODES[id] ?? "", name: "app" + id }];
  }
  if (method === "GET" && endpoint === "/app/form/fields.json") {
    if (!FORMS[app]) return [404, { code: "GAIA_AP01", message: "アプリが見つかりません。" }];
    if ((GUEST_APPS[app] ?? "") !== guest) return [400, { code: "GAIA_IL23", message: "ゲストスペースのアプリです。" }];
    return [200, { properties: FORMS[app], revision: "1" }];
  }
  if (method === "GET" && endpoint === "/records.json") {
    const query = url.searchParams.get("query") ?? "";
    state.queries.push(query);
    const fields = [...url.searchParams.entries()].filter(([key]) => key.startsWith("fields[")).map(([, value]) => value);
    let list = [...(state.records[app] ?? new Map()).values()];
    const hit = /^(\S+) in \((.*)\) limit (\d+)$/s.exec(query);
    if (hit) {
      const [, code, listText, limit] = hit;
      const items = parseInList(listText);
      const norm = (value) => (state.caseInsensitive ? String(value).toLowerCase() : String(value));
      list = list.filter((record) => (code === "$id" ? items.includes(record.$id.value) : items.some((item) => norm(item) === norm(record[code]?.value ?? ""))));
      list = list.slice(0, Number(limit));
    }
    if (fields.length > 0) list = list.map((record) => Object.fromEntries(Object.entries(record).filter(([code]) => fields.includes(code))));
    return [200, { records: JSON.parse(JSON.stringify(list)) }];
  }
  if (method === "POST" && endpoint === "/bulkRequest.json") return bulk(state, body);
  return null;
}

const json = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return {};
  }
};

export async function importTests(ctx) {
  await importPureTests(ctx);
  importCliTests(ctx);
  await importE2ETests(ctx);
  await importValidationE2ETests(ctx);
  await importKeyKindE2ETests(ctx);
}

// ---- 純関数 ----
async function importPureTests({ ROOT, expect }) {
  console.log("[offline] 更新キー付き CSV 取込の純関数（import.json・更新キー・クエリ・列と値の検証・CSV の読み込み）");
  const dist = (name) => import(pathToFileURL(path.join(ROOT, "dist", "kintone", name)).href);
  const imp = await dist("recordImport.js");
  const vals = await dist("recordValues.js");
  const schema = vals.buildSchemaIndex(FORMS["303"]);
  const field = (code) => schema.top.get(code);

  // import.json
  const okCfg = imp.parseImportConfig('{"app":123,"updateKey":"異動編號"}');
  expect("import.json: app と updateKey だけなら utf8 が既定（guestSpaceId は無し）", okCfg.config?.app === "123" && okCfg.config.updateKey === "異動編號" && okCfg.config.encoding === "utf8" && !("guestSpaceId" in okCfg.config), JSON.stringify(okCfg));
  const fullCfg = imp.parseImportConfig('﻿{"app":"45","updateKey":" k ","encoding":"sjis","guestSpaceId":7}');
  expect("import.json: BOM・文字列の app・encoding・guestSpaceId を解釈する", fullCfg.config?.app === "45" && fullCfg.config.updateKey === "k" && fullCfg.config.encoding === "sjis" && fullCfg.config.guestSpaceId === "7", JSON.stringify(fullCfg));
  const cfgError = (label, text, keyword) => {
    const r = imp.parseImportConfig(text);
    expect(label, Array.isArray(r.errors) && r.errors.some((e) => e.includes(keyword)), JSON.stringify(r));
  };
  cfgError("import.json: JSON として読めない", "{", "JSON として読めません");
  cfgError("import.json: オブジェクトでない", "[]", "オブジェクト");
  cfgError("import.json: app が正の整数でない", '{"app":0,"updateKey":"k"}', "アプリ ID");
  cfgError("import.json: updateKey が無い", '{"app":1}', "updateKey");
  cfgError("import.json: encoding は utf8 / sjis だけ", '{"app":1,"updateKey":"k","encoding":"utf-8"}', "encoding");
  cfgError("import.json: 不明なキー（打ち間違い）は拒否", '{"app":1,"updateKey":"k","encodng":"sjis"}', "encodng");
  cfgError("import.json: guestSpaceId が数字でない", '{"app":1,"updateKey":"k","guestSpaceId":"x"}', "guestSpaceId");
  expect("import.json: 問題はまとめて返す", imp.parseImportConfig('{"app":"a","updateKey":""}').errors?.length === 2, "");

  // 更新キーの可否
  const numberSchema = vals.buildSchemaIndex(FORMS["480"]);
  expect("更新キー: 文字列（1行）は「重複を禁止」のときだけ", imp.keyKindOf(field("社員番号")) === "text" && imp.keyKindOf(field("氏名")) === null, "");
  expect("更新キー: 数値は「重複を禁止」のときだけ・レコード番号は可", imp.keyKindOf(numberSchema.top.get("番号")) === "number" && imp.keyKindOf(field("数量")) === null && imp.keyKindOf(field("レコード番号")) === "recordNumber", "");
  expect("更新キー: 日付・ドロップダウン・テーブル内のフィールドは不可", imp.keyKindOf(field("入社日")) === null && imp.keyKindOf(field("部署")) === null && imp.keyKindOf(schema.inner.get("内訳")) === null, "");

  // レコード番号の値
  const rn = imp.parseRecordNumber;
  expect("レコード番号: 数字・アプリコード付き（ハイフンを含むコードも）を解釈する", rn("12")?.id === "12" && rn("EMP-12")?.appCode === "EMP" && rn("A-B-12")?.appCode === "A-B" && rn(" 7 ")?.id === "7", JSON.stringify([rn("12"), rn("EMP-12"), rn("A-B-12")]));
  expect("レコード番号: 0・数字でない値・小数・先頭 0 は不可", rn("0") === null && rn("abc") === null && rn("12.5") === null && rn("EMP-") === null && rn("012") === null && rn("EMP-x") === null, "");
  expect("更新キーの値: 空はエラー・数値は正規形に・文字列は改行不可", "error" in imp.parseKeyValue("text", field("社員番号"), "  ") && imp.parseKeyValue("number", numberSchema.top.get("番号"), "010.50").key === "10.5" && "error" in imp.parseKeyValue("text", field("社員番号"), "a\nb") && imp.parseKeyValue("recordNumber", field("レコード番号"), "EMP-3").key === "3", "");
  expect("数値の正規形", ["010.50:10.5", "-0:0", "0.0:0", "-1.20:-1.2", "100:100", "1,5:1,5", "007:7"].every((pair) => {
    const [input, want] = pair.split(":");
    return vals.canonicalNumber(input) === want;
  }), "");

  // クエリ
  expect("クエリ: ダブルクォートとバックスラッシュをエスケープして囲む", imp.quoteQueryString('a"b\\c') === '"a\\"b\\\\c"', imp.quoteQueryString('a"b\\c'));
  expect("クエリ: 文字列はクォート・数値とレコード番号はそのまま", imp.keyLiteral("text", "E1") === '"E1"' && imp.keyLiteral("number", "10.5") === "10.5" && imp.keyLiteral("recordNumber", "7") === "7", "");
  expect("クエリ: レコード番号は $id、それ以外はフィールドコードで引く（limit 500）", imp.keyQuery("recordNumber", "x", ["1", "2"]) === "$id in (1,2) limit 500" && imp.keyQuery("text", "社員番号", ['"E1"']) === '社員番号 in ("E1") limit 500', "");
  const literals = Array.from({ length: 250 }, (_, i) => String(i + 1));
  expect("クエリ: in は 100 件ずつに分ける", imp.chunkLiterals(literals).map((c) => c.length).join(",") === "100,100,50", imp.chunkLiterals(literals).map((c) => c.length).join(","));
  const longLiterals = Array.from({ length: 5 }, (_, i) => '"' + String(i).repeat(400) + '"');
  expect("クエリ: URL が長くなりすぎないよう、値の長さでも分ける（1 つが長すぎても単独で送る）", imp.chunkLiterals(longLiterals, 100, 1000).map((c) => c.length).join(",") === "2,2,1" && imp.chunkLiterals(['"' + "x".repeat(5000) + '"'], 100, 1000).length === 1, imp.chunkLiterals(longLiterals, 100, 1000).map((c) => c.length).join(","));

  // 列の検証
  const colError = (code) => imp.importColumnError(field(code));
  expect("列: テーブル・添付は取込できない（push records を案内）", colError("名簿")?.includes("push records") && colError("添付")?.includes("取込できません"), `${colError("名簿")} / ${colError("添付")}`);
  expect("列: 計算・自動計算・作成者・レコード番号は取込できない（列を外すよう案内）", colError("合計")?.includes("書き込めません") && colError("自動")?.includes("自動計算") && colError("作成者")?.includes("作成者・更新者") && colError("レコード番号")?.includes("書き込めません") && colError("合計")?.includes("外してください"), "");
  expect("列: 文字列・ドロップダウン・チェックボックス・ユーザー選択・日付・数値は取り込める", ["氏名", "部署", "タグ", "担当", "入社日", "数量", "備考", "区分"].every((code) => colError(code) === null), ["氏名", "部署", "タグ", "担当", "入社日", "数量", "備考", "区分"].map((c) => colError(c)).join("/"));
  const lookupSchema = vals.buildSchemaIndex({ 顧客コード: P("SINGLE_LINE_TEXT", "顧客コード", { lookup: { fieldMappings: [{ field: "顧客名", relatedField: "名" }] } }), 顧客名: P("SINGLE_LINE_TEXT", "顧客名") });
  expect("列: ルックアップのコピー先は取込できない", imp.importColumnError(lookupSchema.top.get("顧客名"))?.includes("ルックアップのコピー先"), "");

  const resolve = (header, updateKey = "社員番号") => imp.resolveImportColumns({ header, schema, updateKey, app: "303" });
  const messages = (r) => r.issues.map((issue) => issue.message).join(" | ");
  const good = resolve(["社員番号", "氏名", "部署"]);
  expect("列の検証: 問題が無ければ列を返し、更新キーの列を示す", good.issues.length === 0 && good.kind === "text" && good.columns.length === 3 && good.columns[0].isKey && !good.columns[1].isKey, JSON.stringify(good.issues));
  expect("列の検証: 更新キーの列が CSV に無い", messages(resolve(["氏名"])).includes("列が records.csv にありません"), messages(resolve(["氏名"])));
  expect("列の検証: 存在しない列・テーブル内の列", messages(resolve(["社員番号", "無い"])).includes("列「無い」") && messages(resolve(["社員番号", "内訳"])).includes("テーブル内のフィールド"), "");
  expect("列の検証: 更新キーがトップレベルの重複禁止でない（文字列・テーブル内・存在しない）", messages(resolve(["氏名"], "氏名")).includes("使えません") && messages(resolve(["内訳"], "内訳")).includes("テーブル内のフィールド") && messages(resolve(["氏名"], "nope")).includes("app 303 にありません"), "");
  expect("列の検証: ヘッダーの問題は行 1 として複数まとめて返す", resolve(["社員番号", "無い", "名簿", "合計"]).issues.filter((issue) => issue.lines[0] === 1).length === 3, messages(resolve(["社員番号", "無い", "名簿", "合計"])));

  // 行の値
  const columns = good.columns;
  const row = (cells, line = 2) => ({ line, cells });
  const parsed = imp.parseImportRow(columns, "text", row(["E9", "名前", ""]));
  expect("行: 空のセルは空にする値になる（ドロップダウンは空文字）", parsed.parsed?.values.get("部署")?.value === "" && parsed.parsed.values.get("氏名")?.value === "名前" && parsed.parsed.values.get("社員番号")?.value === "E9" && parsed.parsed.key === "E9", JSON.stringify(parsed));
  const allCols = (codes) => imp.resolveImportColumns({ header: codes, schema, updateKey: "社員番号", app: "303" }).columns;
  const multi = imp.parseImportRow(allCols(["社員番号", "タグ", "担当", "入社日", "数量"]), "text", row(["E9", "A\nC", "u1\nu2", "", "1.5"]));
  expect("行: 複数の値は改行区切り・ユーザーは code・空の日付は null", JSON.stringify(multi.parsed?.values.get("タグ")?.value) === '["A","C"]' && JSON.stringify(multi.parsed.values.get("担当")?.value) === '[{"code":"u1"},{"code":"u2"}]' && multi.parsed.values.get("入社日")?.value === null, JSON.stringify(multi));
  const cleared = imp.parseImportRow(allCols(["社員番号", "タグ"]), "text", row(["E9", ""]));
  expect("行: 空のチェックボックスは空の配列", JSON.stringify(cleared.parsed?.values.get("タグ")?.value) === "[]", JSON.stringify(cleared));
  const bad = imp.parseImportRow(allCols(["社員番号", "氏名", "区分", "数量", "部署"]), "text", row(["E9", "", "", "1,000", "不明"], 7));
  expect(
    "行: 必須とラジオボタンを空にできない・数値・選択肢の誤りは、行番号つきで全部返す",
    bad.parsed === undefined && bad.issues.length === 4 && bad.issues.every((issue) => issue.lines[0] === 7) && bad.issues.some((i) => i.message.includes("必須フィールドは空にできません")) && bad.issues.some((i) => i.message.includes("ラジオボタンは空にできません")) && bad.issues.some((i) => i.message.includes("数値で指定")) && bad.issues.some((i) => i.message.includes("選択肢")),
    JSON.stringify(bad.issues)
  );
  const emptyKey = imp.parseImportRow(columns, "text", row(["", "名前", ""]));
  expect("行: 更新キーが空の行はエラー", emptyKey.parsed === undefined && emptyKey.issues[0]?.message.includes("空です"), JSON.stringify(emptyKey));
  const rnColumns = imp.resolveImportColumns({ header: ["レコード番号", "氏名"], schema, updateKey: "レコード番号", app: "303" }).columns;
  const rnRow = imp.parseImportRow(rnColumns, "recordNumber", row(["EMP-7", "七"]));
  expect("行: レコード番号の更新キーは書き込む値に含めない（アプリコードを控える）", rnRow.parsed?.key === "7" && rnRow.parsed.appCode === "EMP" && !rnRow.parsed.values.has("レコード番号") && rnRow.parsed.values.has("氏名"), JSON.stringify(rnRow));

  // 値の比較
  const same = (code, a, b) => imp.sameValue(field(code), a, b);
  expect("比較: 数値は桁の表記を無視・チェックボックスは順序を無視・ユーザーは code で比べる", same("数量", "1.0", "1") && !same("数量", "1", "2") && same("タグ", ["B", "A"], ["A", "B"]) && same("担当", [{ code: "u1", name: "U1" }], [{ code: "u1" }]) && same("入社日", null, "") && same("部署", null, ""), "");
  const dt = vals.buildSchemaIndex({ 日時: P("DATETIME", "日時") }).top.get("日時");
  expect("比較: 日時はタイムゾーンの表記が違っても同じ時刻なら同じ値", imp.sameValue(dt, "2026-11-03T01:15:00Z", "2026-11-03T10:15:00+09:00") && !imp.sameValue(dt, "2026-11-03T01:15:00Z", "2026-11-03T10:15:00Z"), "");

  // CSV
  const csv = imp.parseImportCsv("﻿社員番号,氏名\r\nE1,\"a\r\nb\"\r\nE2,c\r\n");
  expect("CSV: BOM を除き、セル内の CRLF は LF にする・行番号はヘッダーを 1 とする", csv.issues.length === 0 && csv.header[0] === "社員番号" && csv.rows[0].cells[1] === "a\nb" && csv.rows[0].line === 2 && csv.rows[1].line === 3, JSON.stringify(csv));
  const badCsv = imp.parseImportCsv("a,,a\n1,2\n");
  expect("CSV: 空の列名・重複した列名・列数の不一致を行番号つきで報告", badCsv.issues.some((i) => i.message.includes("空の列名")) && badCsv.issues.some((i) => i.message.includes("重複")) && badCsv.issues.some((i) => i.lines[0] === 2 && i.message.includes("列数")), JSON.stringify(badCsv.issues));
  expect("CSV: 空・ヘッダーだけはエラー", imp.parseImportCsv("").issues.length === 1 && imp.parseImportCsv("a,b\n").issues[0]?.message.includes("データの行がありません"), "");

  // 文字コード
  const sjis = Buffer.from([0x8e, 0x52, 0x93, 0x63]); // 山田（Shift_JIS）
  expect("文字コード: Shift_JIS を読める", imp.decodeCsvBytes(sjis, "sjis") === "山田", "");
  let utf8Error = "";
  try {
    imp.decodeCsvBytes(sjis, "utf8");
  } catch (error) {
    utf8Error = error.message;
  }
  expect("文字コード: UTF-8 として読めなければ encoding: sjis を案内", utf8Error.includes("UTF-8 として読めません") && utf8Error.includes('"encoding": "sjis"'), utf8Error);
  expect("文字コード: UTF-8 の BOM は除く", imp.decodeCsvBytes(Buffer.from("﻿a,b"), "utf8") === "a,b", "");

  // ハッシュ
  const h = imp.hashImportJob;
  expect("ハッシュ: 改行コードと BOM の違いは無視・内容が変われば別", h('{"a":1}\r\n', "a,b\r\n1,2\r\n") === h('{"a":1}\n', "﻿a,b\n1,2\n") && h('{"a":1}\n', "a,b\n1,2\n") !== h('{"a":1}\n', "a,b\n1,3\n") && h("x", "y") !== h("xy", ""), "");
}

// ---- CLI（オフライン。API は呼ばない） ----
function importCliTests({ expect, runCli }) {
  console.log("[offline] diff / push import の引数検証・操作制限");
  const makeDomain = (envLines) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-import-cli-"));
    fs.writeFileSync(path.join(tmp, ".env"), envLines.join("\n") + "\n", "utf8");
    return tmp;
  };
  const allowed = makeDomain(["KINT_ORIGIN_ALLOW_PULL_RECORDS=true", "KINT_ORIGIN_ALLOW_PUSH_RECORDS=true"]);
  const readOnly = makeDomain(["KINT_ORIGIN_ALLOW_PULL_RECORDS=true"]);
  const none = makeDomain([]);
  const run = (cwd, args) => runCli(args, cwd, NO_SHELL_CREDS);
  try {
    fs.mkdirSync(path.join(allowed, "push", "import", "exists"), { recursive: true });
    fs.writeFileSync(path.join(allowed, "push", "import", "exists", "import.json"), '{"app":1,"updateKey":"k"}\n', "utf8");
    const fails = (label, result, keyword) => expect(label, result.status === 1 && result.stderr.includes(keyword), `status=${result.status}\n${result.stderr}`);
    fails("diff import: --name 無しは Missing required argument", run(allowed, ["diff", "import"]), "Missing required argument: --name");
    fails("diff import: 不正なジョブ名は認証値の前に拒否（push/import を案内）", run(allowed, ["diff", "import", "--name", "../x"]), "push/import/ の下のフォルダ名");
    fails("diff import: ジョブが無ければ存在するジョブを案内（認証値の前に確認）", run(allowed, ["diff", "import", "--name", "nosuch"]), "存在するジョブ: exists");
    fails("diff import: records.csv が無ければ案内", run(allowed, ["diff", "import", "--name", "exists"]), "records.csv がありません");
    fails("diff import: 使えないオプション（--restore）は不明なオプション", run(allowed, ["diff", "import", "--name", "x", "--restore", "20261103-101530"]), "不明なオプションです: --restore");
    fails("push import: --name 無しは Missing required argument", run(allowed, ["push", "import"]), "Missing required argument: --name");
    fails("push import: --restore の値が実行時刻の形式でない", run(allowed, ["push", "import", "--name", "x", "--restore", "abc", "-y"]), "--restore には runs/ のフォルダ名");
    fails("push import: --restore に値が無い", run(allowed, ["push", "import", "--name", "x", "--restore", "-y"]), "--restore には runs/ のフォルダ名");
    fails("push import: --overwrite-remote は --restore と一緒に", run(allowed, ["push", "import", "--name", "x", "--overwrite-remote", "-y"]), "--overwrite-remote は --restore と一緒に");
    fails("push import: 非対話で -y 無しは API の前に中断（diff の確認と -y を案内）", run(allowed, ["push", "import", "--name", "x"]), "-y を付けて");
    fails("push import: 使えないオプション（--only）は不明なオプション", run(allowed, ["push", "import", "--name", "x", "--only", "a"]), "不明なオプションです: --only");
    const missing = run(allowed, ["push", "import", "--name", "nosuch", "-y"]);
    expect("push import: ジョブが無ければ API を呼ばずに案内", missing.status === 1 && missing.stderr.includes("ジョブが見つかりません") && !missing.stderr.includes("Missing required environment variable"), missing.stderr);
    const restoreMissing = run(allowed, ["push", "import", "--name", "exists", "--restore", "20261103-101530", "-y"]);
    expect("push import --restore: ジョブの入力が揃っていなければ案内", restoreMissing.status === 1 && restoreMissing.stderr.includes("records.csv がありません"), restoreMissing.stderr);

    // 操作制限
    const allowedPush = run(allowed, ["push", "import", "--name", "x", "-y"]);
    expect(
      "操作制限: PULL_RECORDS と PUSH_RECORDS なら push import を許可する",
      !allowedPush.stderr.includes("操作制限:"),
      allowedPush.stderr
    );
    const readOnlyPush = run(readOnly, ["push", "import", "--name", "x", "-y"]);
    expect(
      "操作制限: PULL_RECORDS だけでは push import は拒否（PUSH_RECORDS を案内）",
      readOnlyPush.status === 1 && readOnlyPush.stderr.includes("操作制限:") && readOnlyPush.stderr.includes("KINT_ORIGIN_ALLOW_PUSH_RECORDS=true"),
      readOnlyPush.stderr
    );
    for (const args of [["diff", "import", "--name", "x"], ["push", "import", "--name", "x", "-y"]]) {
      const denied = run(none, args);
      expect(`操作制限: 許可が無ければ ${args.slice(0, 2).join(" ")} は拒否（認証値の前）`, denied.status === 1 && denied.stderr.includes("操作制限:") && !denied.stderr.includes("Missing required environment variable"), denied.stderr);
    }
    const readOnlyDiff = run(readOnly, ["diff", "import", "--name", "nosuch"]);
    expect("操作制限: diff import は PULL_KINTONE（既定）と PULL_RECORDS だけで判定を通る（push の許可は不要）", !readOnlyDiff.stderr.includes("操作制限:") && readOnlyDiff.stderr.includes("ジョブが見つかりません"), readOnlyDiff.stderr);

    // ヘルプ
    const help = run(allowed, ["push", "import", "--help"]);
    expect(
      "help: push import -h は通常の実行と --restore の両方の形式と、必要な許可（PULL_RECORDS と PUSH_RECORDS）を示す",
      help.status === 0 && help.stdout.includes("--restore <実行時刻>") && help.stdout.includes("KINT_ORIGIN_ALLOW_PULL_RECORDS と KINT_ORIGIN_ALLOW_PUSH_RECORDS") && help.stdout.includes("使えるオプション: --name, --restore, --overwrite-remote, -y/--yes"),
      help.stdout + help.stderr
    );
    const diffHelp = run(allowed, ["diff", "import", "-h"]);
    expect("help: diff import -h は必要な許可（PULL_KINTONE と PULL_RECORDS）を示す", diffHelp.status === 0 && diffHelp.stdout.includes("KINT_ORIGIN_ALLOW_PULL_KINTONE と KINT_ORIGIN_ALLOW_PULL_RECORDS") && diffHelp.stdout.includes("使えるオプション: --name"), diffHelp.stdout);
  } finally {
    for (const dir of [allowed, readOnly, none]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- mock kintone を使う E2E ----
async function setupDomain({ startStatefulMock, mockEnv, runCliAsync, writeJsonFile }) {
  const state = createState();
  const mock = await startStatefulMock((method, url, body) => handle(state, method, url, body));
  const env = mockEnv(mock.baseUrl);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kint-origin-import-"));
  fs.writeFileSync(
    path.join(tmp, ".env"),
    Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + `\nKINT_ORIGIN_ALLOW_PULL_RECORDS=true\nKINT_ORIGIN_ALLOW_PUSH_RECORDS=true\n`,
    "utf8"
  );
  const entry = (appId, guestSpaceId = "") => ({ appId, code: "", name: "app" + appId, spaceId: "", guestSpaceId, modifiedAt: "2026-01-01T00:00:00Z" });
  writeJsonFile(path.join(tmp, "data", "kintone", "index", "apps.json"), [entry("303"), entry("450"), entry("460", "7"), entry("470"), entry("480"), entry("490")]);
  const run = (args) => runCliAsync(args, tmp, env);
  const jobDir = (name) => path.join(tmp, "push", "import", name);
  // 取込ジョブを作る。csv は文字列（UTF-8）か Buffer（そのまま書く）。
  const writeJob = (name, config, csv) => {
    fs.mkdirSync(jobDir(name), { recursive: true });
    fs.writeFileSync(path.join(jobDir(name), "import.json"), JSON.stringify(config) + "\n", "utf8");
    fs.writeFileSync(path.join(jobDir(name), "records.csv"), csv);
  };
  const nonGet = () => mock.requests.filter((request) => !request.startsWith("GET "));
  const runPath = (job, runId, ...rest) => path.join(jobDir(job), "runs", runId, ...rest);
  const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const close = () => {
    mock.server.closeAllConnections();
    mock.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { mock, state, tmp, env, run, writeJob, nonGet, jobDir, runPath, readJson, close };
}

const T1_CSV = ["社員番号,氏名,部署,備考,数量,タグ", 'E0001,山田太郎,営業部,,10,"A\nC"', "E0002,佐藤,開発部,,5,", "E0003,新人,営業部,新規メモ,7,B"].join("\n") + "\n";

async function importE2ETests(ctx) {
  const { expect } = ctx;
  console.log("[offline] diff import / push import / --restore（mock kintone）");
  const d = await setupDomain(ctx);
  const { state } = d;
  const getRecord = (app, id) => state.records[app].get(id);
  try {
    d.writeJob("t1", { app: 303, updateKey: "社員番号" }, T1_CSV);

    // diff import
    const diff = await d.run(["diff", "import", "--name", "t1"]);
    const summary = json(diff);
    expect("diff import: exit 0・更新 1 件・追加 1 件・変更なし 1 件", diff.status === 0 && summary.job === "t1" && summary.rows === 3 && summary.update === 1 && summary.create === 1 && summary.unchanged === 1 && summary.updateKey === "社員番号", diff.stderr + diff.stdout);
    expect("diff import: 変わるフィールドの一覧・一括処理 1 回で原子的・推定 API 回数は GET だけ", summary.fields?.includes("氏名") && summary.fields.includes("備考") && summary.fields.includes("タグ") && summary.bulks === 1 && summary.atomic === true && summary.estimatedApiCalls === 2, JSON.stringify(summary));
    expect("diff import: 更新キーを in で 1 回に照合する（文字列はクォート・limit 500）", state.queries.length === 1 && state.queries[0] === '社員番号 in ("E0001","E0002","E0003") limit 500', JSON.stringify(state.queries));
    const preview = fs.readFileSync(path.join(d.tmp, summary.preview), "utf8");
    expect(
      "diff import: プレビューは BOM 付きで変更前後を含み、変更なしの行は含まない・runs/.gitignore を作る",
      preview.startsWith("﻿") && preview.includes("山田太郎") && preview.includes("メモ") && preview.includes("create") && preview.includes("新規メモ") && !preview.includes("E0002") && fs.existsSync(path.join(d.jobDir("t1"), "runs", ".gitignore")),
      preview
    );
    expect("diff import: 書き込みの API は呼ばない", d.nonGet().length === 0, JSON.stringify(d.nonGet()));

    // push import: 非対話で -y 無しは API の前に中断
    d.mock.requests.length = 0;
    const noYes = await d.run(["push", "import", "--name", "t1"]);
    expect("push import: 非対話で -y 無しは API を呼ぶ前に exit 1（diff の確認と -y を案内）", noYes.status === 1 && noYes.stderr.includes("kint-origin diff") && noYes.stderr.includes("-y を付けて") && d.mock.requests.length === 0, noYes.stderr);

    // push import -y
    const push = await d.run(["push", "import", "--name", "t1", "-y"]);
    const result = json(push);
    const runId = result.runId;
    expect("push import: -y で exit 0・applied・一括処理 1 回（原子的）", push.status === 0 && result.applied === true && result.atomic === true && result.bulks?.length === 1 && result.bulks[0].status === "ok", push.stderr + push.stdout);
    expect("push import: 更新したレコードの ID・リビジョンと追加したレコードの更新キー → ID を返す", result.updated?.length === 1 && result.updated[0].id === "1" && result.updated[0].revisionBefore === "3" && result.updated[0].revisionAfter === "4" && result.created?.[0]?.key === "E0003" && result.created[0].id === "101", JSON.stringify([result.updated, result.created]));
    const r1 = getRecord("303", "1");
    expect(
      "push import: 更新は変えたフィールドだけ（氏名・空のセルは空に・チェックボックス）で、CSV に無い列と同じ値の列は残る",
      r1.氏名.value === "山田太郎" && r1.備考.value === "" && JSON.stringify(r1.タグ.value) === '["A","C"]' && r1.部署.value === "営業部" && r1.数量.value === "10" && r1.担当.value[0].code === "u1" && r1.区分.value === "甲" && r1.入社日.value === "2020-04-01" && r1.$revision.value === "4",
      JSON.stringify(r1)
    );
    const r101 = getRecord("303", "101");
    expect("push import: 一致しない更新キーは新規追加（全列を書く）", r101?.社員番号.value === "E0003" && r101.氏名.value === "新人" && r101.備考.value === "新規メモ" && r101.数量.value === "7" && JSON.stringify(r101.タグ.value) === '["B"]', JSON.stringify(r101));
    expect("push import: 変更なしのレコード（E0002）は触らない", getRecord("303", "2").$revision.value === "1", JSON.stringify(getRecord("303", "2")));
    const body = state.bulkBodies[0];
    const put = body.requests[0];
    const post = body.requests[1];
    expect(
      "push import: PUT は確認時の revision と変えたフィールドだけを送る",
      put.method === "PUT" && put.api === "/k/v1/records.json" && put.payload.records.length === 1 && put.payload.records[0].id === "1" && put.payload.records[0].revision === "3" && Object.keys(put.payload.records[0].record).sort().join(",") === ["タグ", "備考", "氏名"].sort().join(","),
      JSON.stringify(put)
    );
    expect(
      "push import: POST は更新キーを含む CSV の全列を送る（空にしない列は送らない）",
      post.method === "POST" && post.payload.records.length === 1 && Object.keys(post.payload.records[0]).sort().join(",") === ["タグ", "備考", "数量", "氏名", "社員番号", "部署"].sort().join(",") && !("区分" in post.payload.records[0]),
      JSON.stringify(post)
    );
    expect("push import: 書き込みは bulkRequest だけ（push:records の許可で通る）", d.nonGet().every((request) => request === "POST /k/v1/bulkRequest.json") && d.nonGet().length === 1, JSON.stringify(d.nonGet()));
    const backup = d.readJson(d.runPath("t1", runId, "backup", "records.json"));
    expect(
      "push import: 書き込み前のバックアップは変えるフィールドだけ（値とリビジョン）",
      backup.records.length === 1 && backup.records[0].id === "1" && backup.records[0].revision === "3" && Object.keys(backup.records[0].fields).sort().join(",") === ["タグ", "備考", "氏名"].sort().join(",") && backup.records[0].fields.氏名.value === "山田",
      JSON.stringify(backup)
    );
    const saved = d.readJson(d.runPath("t1", runId, "result.json"));
    expect("push import: result.json は kind import・入力のハッシュ・復旧コマンドを持つ", saved.kind === "import" && /^[0-9a-f]{64}$/.test(saved.jobHash) && saved.restoreCommand === `kint-origin push import --name t1 --restore ${runId}` && saved.applied === true, JSON.stringify(saved));
    expect("push import: 実行記録にプレビューと計画を保存し、転送用の一時フォルダは残さない", fs.existsSync(d.runPath("t1", runId, "preview.csv")) && fs.existsSync(d.runPath("t1", runId, "plan.json")) && !fs.existsSync(d.runPath("t1", runId, "work")), "");
    expect("push import: 反映後の検証で食い違い 0 件", result.verify?.mismatches?.length === 0 && result.verify.checked > 0, JSON.stringify(result.verify));
    expect("push import: 復旧プラン（push import --restore のコマンド）を表示", push.stderr.includes("【復旧プラン】") && push.stderr.includes("push import --name t1 --restore " + runId), push.stderr);

    // 同じ入力の再実行は API の前に止まる
    d.mock.requests.length = 0;
    const again = await d.run(["push", "import", "--name", "t1", "-y"]);
    expect("push import: 同じ入力の再実行は反映済みの記録があると API を呼ぶ前に止まる", again.status === 1 && again.stderr.includes("すでに実行しています") && again.stderr.includes(runId) && again.stderr.includes("反映済み") && d.mock.requests.length === 0, again.stderr);
    // CRLF に変えても同じ入力とみなす
    fs.writeFileSync(path.join(d.jobDir("t1"), "records.csv"), T1_CSV.replace(/\n/g, "\r\n"), "utf8");
    const crlf = await d.run(["push", "import", "--name", "t1", "-y"]);
    expect("push import: 改行コードだけが違う再実行も同じ入力として止まる", crlf.status === 1 && crlf.stderr.includes("すでに実行しています") && d.mock.requests.length === 0, crlf.stderr);

    // 変更も追加も無ければ何も送らない
    d.writeJob("t2", { app: 303, updateKey: "社員番号" }, "社員番号,氏名\nE0001,山田太郎\nE0002,佐藤\n");
    d.mock.requests.length = 0;
    const noop = await d.run(["push", "import", "--name", "t2", "-y"]);
    const noopResult = json(noop);
    expect(
      "push import: すべて環境と同じなら何も送らずに exit 0（nothingToDo）・実行記録は作らない",
      noop.status === 0 && noopResult.applied === false && noopResult.nothingToDo === true && noopResult.unchanged === 2 && d.nonGet().length === 0 && noop.stderr.includes("何も送らずに終了") && !fs.existsSync(path.join(d.jobDir("t2"), "runs")),
      noop.stderr + noop.stdout
    );

    // 復旧
    const restore = await d.run(["push", "import", "--name", "t1", "--restore", runId, "-y"]);
    const restored = json(restore);
    const b1 = getRecord("303", "1");
    expect(
      "restore: 更新を元の値に戻す（氏名・空にした備考・チェックボックス）",
      restore.status === 0 && restored.applied === true && b1.氏名.value === "山田" && b1.備考.value === "メモ" && JSON.stringify(b1.タグ.value) === '["A","B"]' && b1.部署.value === "営業部",
      restore.stderr + JSON.stringify(b1)
    );
    expect("restore: この実行で追加したレコードを削除", !state.records["303"].has("101") && restored.deleted === 1 && restored.restored === 1, JSON.stringify(restored));
    expect(
      "restore: 復旧済みの印と、復旧前の状態（削除したレコードを含む）を別の実行記録に保存",
      fs.existsSync(d.runPath("t1", runId, "restored.json")) && d.readJson(d.runPath("t1", restored.runId, "result.json")).kind === "restore" && d.readJson(d.runPath("t1", restored.runId, "backup", "records.json")).records.some((r) => r.id === "101"),
      ""
    );
    const restoredAgain = await d.run(["push", "import", "--name", "t1", "--restore", runId, "-y"]);
    expect("restore: 復旧済みの実行は再度戻せない", restoredAgain.status === 1 && restoredAgain.stderr.includes("復旧済み"), restoredAgain.stderr);
    const noRun = await d.run(["push", "import", "--name", "t1", "--restore", "20990101-000000", "-y"]);
    expect("restore: 実行記録が無ければ push/import/<ジョブ>/runs/ のフォルダ名を案内", noRun.status === 1 && noRun.stderr.includes("実行記録が見つかりません") && noRun.stderr.includes("push/import/t1/runs/"), noRun.stderr);
    // 復旧済み（restored.json あり）の実行は、同じ入力を再実行してよい
    fs.writeFileSync(path.join(d.jobDir("t1"), "records.csv"), T1_CSV, "utf8");
    const rerunAfterRestore = await d.run(["push", "import", "--name", "t1", "-y"]);
    expect("push import: 復旧済みの実行の後は、同じ入力を再実行できる", rerunAfterRestore.status === 0 && json(rerunAfterRestore).applied === true, rerunAfterRestore.stderr);

    // 実行記録の取り違え: import の実行記録は push records では戻せない（逆も同じ）
    const importRunId = json(rerunAfterRestore).runId;
    fs.mkdirSync(path.join(d.tmp, "push", "records", "t1"), { recursive: true });
    fs.writeFileSync(path.join(d.tmp, "push", "records", "t1", "job.csv"), "op,from_app,from_record,from_field,to_app,to_record,to_field,mode,value\n", "utf8");
    fs.cpSync(d.runPath("t1", importRunId), path.join(d.tmp, "push", "records", "t1", "runs", importRunId), { recursive: true });
    const crossRecords = await d.run(["push", "records", "--name", "t1", "--restore", importRunId, "-y"]);
    expect("取り違え: import の実行記録は push records --restore では戻せない", crossRecords.status === 1 && crossRecords.stderr.includes("push records の実行ではありません"), crossRecords.stderr);
    const fakeId = "20990101-000001";
    fs.mkdirSync(d.runPath("t1", fakeId), { recursive: true });
    fs.writeFileSync(d.runPath("t1", fakeId, "result.json"), JSON.stringify({ kind: "push", applied: true }), "utf8");
    const crossImport = await d.run(["push", "import", "--name", "t1", "--restore", fakeId, "-y"]);
    expect("取り違え: push records の実行記録は push import --restore では戻せない", crossImport.status === 1 && crossImport.stderr.includes("push import の実行ではありません"), crossImport.stderr);
  } finally {
    d.close();
  }

  // 復旧の競合・途中失敗
  console.log("[offline] push import の revision 競合・復旧の競合・失敗後の再実行（mock kintone）");
  const c = await setupDomain(ctx);
  const cstate = c.state;
  const crec = (app, id) => cstate.records[app].get(id);
  try {
    c.writeJob("c1", { app: 303, updateKey: "社員番号" }, "社員番号,氏名\nE0002,佐藤改\n");
    cstate.failNextBulk = { code: "GAIA_CO02", message: "更新しようとしたレコードは他のユーザーによって更新されています。" };
    const conflict = await c.run(["push", "import", "--name", "c1", "-y"]);
    const runs = fs.readdirSync(path.join(c.jobDir("c1"), "runs"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    const failed = c.readJson(c.runPath("c1", runs[0], "result.json"));
    expect(
      "push import: revision の不一致は exit 1・何も変更せず、diff からのやり直しを案内し、失敗した実行も result.json に残す",
      conflict.status === 1 && conflict.stderr.includes("他の人が") && conflict.stderr.includes("何も変更していません") && crec("303", "2").氏名.value === "佐藤" && cstate.committedBulks === 0 && failed.applied === false && failed.bulks?.[0]?.status === "failed" && failed.kind === "import",
      conflict.stderr + JSON.stringify(failed)
    );
    const retry = await c.run(["push", "import", "--name", "c1", "-y"]);
    expect("push import: 確定で未反映の失敗の後は、同じ入力を再実行できる（反映済みの記録ではない）", retry.status === 0 && json(retry).applied === true && crec("303", "2").氏名.value === "佐藤改", retry.stderr);

    // 復旧の競合
    const pushed = json(retry);
    crec("303", "2").$revision.value = "99";
    const blocked = await c.run(["push", "import", "--name", "c1", "--restore", pushed.runId, "-y"]);
    expect(
      "restore: 実行後に編集されたレコードがあれば一覧を出して中断（変更しない）",
      blocked.status === 1 && blocked.stderr.includes("レコード 2") && blocked.stderr.includes("--overwrite-remote") && crec("303", "2").氏名.value === "佐藤改",
      blocked.stderr
    );
    const forced = await c.run(["push", "import", "--name", "c1", "--restore", pushed.runId, "--overwrite-remote", "-y"]);
    expect("restore: --overwrite-remote なら上書きして戻す", forced.status === 0 && crec("303", "2").氏名.value === "佐藤", forced.stderr);

    // 更新キーでの照合は、実行のたびに環境の今の状態で行う（他の人が同じ更新キーのレコードを作った後は、追加ではなく更新になる）
    c.writeJob("c2", { app: 303, updateKey: "社員番号" }, "社員番号,氏名\nE0100,新規A\n");
    const beforeCreated = await c.run(["diff", "import", "--name", "c2"]);
    expect("diff import: 環境に無い更新キーは create", json(beforeCreated).create === 1 && json(beforeCreated).update === 0, beforeCreated.stderr);
    cstate.records["303"].set("55", rec(55, 1, { 社員番号: f("SINGLE_LINE_TEXT", "E0100"), 氏名: f("SINGLE_LINE_TEXT", "他の人が作成"), 区分: f("RADIO_BUTTON", "甲") }));
    const afterCreated = await c.run(["diff", "import", "--name", "c2"]);
    expect("diff import: 他の人が作成した後は、同じ更新キーが update になる（重複して追加しない）", json(afterCreated).update === 1 && json(afterCreated).create === 0, afterCreated.stderr);
  } finally {
    c.close();
  }
}

// ---- 検証エラー（何も書き込まず、行番号つきで報告する） ----
async function importValidationE2ETests(ctx) {
  const { expect } = ctx;
  console.log("[offline] diff import の検証エラー（何も書き込まない）");
  const d = await setupDomain(ctx);
  const { state } = d;
  try {
    const failing = async (label, csv, keyword, { config = { app: 303, updateKey: "社員番号" }, line } = {}) => {
      d.writeJob("bad", config, csv);
      const r = await d.run(["diff", "import", "--name", "bad"]);
      const lineOk = line === undefined || r.stderr.includes("行 " + line);
      expect(label, r.status === 1 && r.stderr.includes("何も変更していません") && r.stderr.includes(keyword) && lineOk && d.nonGet().length === 0, r.stderr);
    };
    await failing("diff import: 更新キーが「重複を禁止」でない文字列", "氏名\n山田\n", "使えません", { config: { app: 303, updateKey: "氏名" } });
    await failing("diff import: 更新キーのフィールドが無い", "社員番号\nE1\n", "app 303 にありません", { config: { app: 303, updateKey: "nope" } });
    await failing("diff import: 更新キーがテーブル内のフィールド", "内訳\nx\n", "テーブル内のフィールド", { config: { app: 303, updateKey: "内訳" } });
    await failing("diff import: 更新キーの列が CSV に無い", "氏名\n山田\n", "列が records.csv にありません");
    await failing("diff import: 存在しない列", "社員番号,存在しない\nE1,x\n", "列「存在しない」");
    await failing("diff import: テーブルの列は黙って飛ばさずエラー", "社員番号,名簿\nE1,x\n", "テーブル・添付ファイルは対象外");
    await failing("diff import: 添付ファイルの列はエラー", "社員番号,添付\nE1,x\n", "取込できません");
    await failing("diff import: 計算フィールドの列はエラー", "社員番号,合計\nE1,5\n", "書き込めません");
    await failing("diff import: 自動計算の列はエラー", "社員番号,自動\nE1,x\n", "自動計算");
    await failing("diff import: 作成者の列はエラー", "社員番号,作成者\nE1,x\n", "作成者・更新者");
    await failing("diff import: 更新キーでないレコード番号の列はエラー", "社員番号,レコード番号\nE1,3\n", "書き込めません");
    await failing("diff import: CSV 内で更新キーが重複", "社員番号,氏名\nE1,a\nE2,b\nE1,c\n", "重複", { line: "2, 4" });
    await failing("diff import: 更新キーが空の行", "社員番号,氏名\n,新人\n", "空です", { line: 2 });
    await failing("diff import: 選択肢にない値", "社員番号,部署\nE0001,不明\n", "選択肢", { line: 2 });
    await failing("diff import: 必須フィールドを空にできない", "社員番号,氏名\nE0001,\n", "必須フィールドは空にできません", { line: 2 });
    await failing("diff import: ラジオボタンを空にできない", "社員番号,区分\nE0001,\n", "ラジオボタンは空にできません", { line: 2 });
    await failing("diff import: 列数がヘッダーより多い行（カンマを含む値は引用符で囲む）", "社員番号,数量\nE0001,1,000\n", "列数がヘッダー", { line: 2 });
    await failing("diff import: 数値の書式エラー", '社員番号,数量\nE0001,"1,000"\n', "数値で指定", { line: 2 });
    await failing("diff import: 列数がヘッダーと違う行", "社員番号,氏名\nE0001\n", "列数がヘッダー（2 列）と一致しません（1 列）", { line: 2 });
    await failing("diff import: 新規追加の行に必須フィールドの列が無い", "社員番号\nE1\n", "必須フィールド「氏名」の列がありません", { config: { app: 490, updateKey: "社員番号" }, line: 2 });

    // 同じ段階の問題はまとめて報告する
    d.writeJob("many", { app: 303, updateKey: "社員番号" }, "社員番号,部署,区分\nE0001,不明,\nE0002,開発部,乙\nE0003,営業部,\n");
    const many = await d.run(["diff", "import", "--name", "many"]);
    expect("diff import: 同じ段階の問題は行番号つきでまとめて報告（3 件）", many.status === 1 && many.stderr.includes("3 件の問題") && many.stderr.includes("行 2") && many.stderr.includes("行 4"), many.stderr);

    // 環境側の問題
    state.records["303"].set("9", rec(9, 1, { 社員番号: f("SINGLE_LINE_TEXT", "E0001"), 氏名: f("SINGLE_LINE_TEXT", "重複"), 区分: f("RADIO_BUTTON", "甲") }));
    d.writeJob("dup", { app: 303, updateKey: "社員番号" }, "社員番号,氏名\nE0001,x\n");
    const dup = await d.run(["diff", "import", "--name", "dup"]);
    expect("diff import: 環境側で更新キーが 2 件以上一致したらエラー（レコード ID を示す）", dup.status === 1 && dup.stderr.includes("環境に 2 件") && dup.stderr.includes("1, 9") && dup.stderr.includes("行 2") && d.nonGet().length === 0, dup.stderr);
    state.records["303"].delete("9");
    state.caseInsensitive = true;
    d.writeJob("ci", { app: 303, updateKey: "社員番号" }, "社員番号,氏名\ne0002,x\n");
    const ci = await d.run(["diff", "import", "--name", "ci"]);
    expect("diff import: 検索が大文字小文字を同じ値として扱った環境のレコードは、完全一致しなければエラー（別のレコードとして追加しない）", ci.status === 1 && ci.stderr.includes("完全一致しません") && ci.stderr.includes("E0002") && d.nonGet().length === 0, ci.stderr);
    state.caseInsensitive = false;

    // 入力ファイルの問題
    fs.writeFileSync(path.join(d.jobDir("bad"), "import.json"), '{"app":303}\n', "utf8");
    const noKey = await d.run(["diff", "import", "--name", "bad"]);
    expect("diff import: import.json の問題は API の前に報告", noKey.status === 1 && noKey.stderr.includes("updateKey") && noKey.stderr.includes("何も変更していません"), noKey.stderr);
    d.writeJob("sjisbad", { app: 470, updateKey: "code" }, Buffer.concat([Buffer.from("code,name\nS1,"), Buffer.from([0x8e, 0x52, 0x93, 0x63]), Buffer.from("\n")]));
    const wrongEncoding = await d.run(["diff", "import", "--name", "sjisbad"]);
    expect("diff import: UTF-8 として読めない CSV は encoding: sjis を案内", wrongEncoding.status === 1 && wrongEncoding.stderr.includes("UTF-8 として読めません") && wrongEncoding.stderr.includes('"encoding": "sjis"'), wrongEncoding.stderr);

    // 操作制限: 許可が無いと API を 1 回も呼ばない
    d.mock.requests.length = 0;
    fs.writeFileSync(path.join(d.tmp, ".env"), Object.entries(d.env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", "utf8");
    const denied = await d.run(["diff", "import", "--name", "many"]);
    expect("diff import: PULL_RECORDS が無ければ「操作制限:」で拒否し API を呼ばない", denied.status === 1 && denied.stderr.includes("操作制限:") && d.mock.requests.length === 0, denied.stderr);
  } finally {
    d.close();
  }
}

// ---- 更新キーの種類（レコード番号・数値・Shift_JIS）とゲストスペース ----
async function importKeyKindE2ETests(ctx) {
  const { expect } = ctx;
  console.log("[offline] push import: レコード番号・数値の更新キー・Shift_JIS・BOM と CRLF・ゲストスペース（mock kintone）");
  const d = await setupDomain(ctx);
  const { state } = d;
  const rec2 = (app, id) => state.records[app].get(id);
  try {
    // レコード番号: 数字・CODE-数字・一致しない行は新規
    d.writeJob("rn", { app: 450, updateKey: "レコード番号" }, "レコード番号,氏名\nEMP-7,七\n8,八\n999,新規\n");
    const diff = await d.run(["diff", "import", "--name", "rn"]);
    const summary = json(diff);
    expect("diff import（レコード番号）: 更新 1・追加 1・変更なし 1・照合は $id（レコード番号の列は書かない）", diff.status === 0 && summary.update === 1 && summary.create === 1 && summary.unchanged === 1 && state.queries.at(-1) === "$id in (7,8,999) limit 500" && !summary.fields.includes("レコード番号"), diff.stderr + JSON.stringify(summary) + JSON.stringify(state.queries));
    expect("diff import（レコード番号）: 環境に無い番号は新規追加でサーバーが採番する警告", (summary.warnings ?? []).some((w) => w.includes("環境に無いレコード番号 1 件") && w.includes("999")), JSON.stringify(summary.warnings));
    expect("diff import（レコード番号）: アプリコード付きの番号があるときだけアプリ情報を取得する", d.mock.requests.includes("GET /k/v1/app.json"), JSON.stringify(d.mock.requests));
    const push = await d.run(["push", "import", "--name", "rn", "-y"]);
    const result = json(push);
    expect(
      "push import（レコード番号）: 7 を更新・999 の行は新規追加（POST にレコード番号を含めない・番号は採番）",
      push.status === 0 && rec2("450", "7").氏名.value === "七" && rec2("450", "8").$revision.value === "1" && result.created?.[0]?.key === "999" && result.created[0].id === "501" && !("レコード番号" in state.bulkBodies[0].requests.at(-1).payload.records[0]) && rec2("450", "501").氏名.value === "新規",
      push.stderr + JSON.stringify(result)
    );
    const restore = await d.run(["push", "import", "--name", "rn", "--restore", result.runId, "-y"]);
    expect("restore（レコード番号）: 更新を戻し、追加したレコードを削除", restore.status === 0 && rec2("450", "7").氏名.value === "旧" && !state.records["450"].has("501"), restore.stderr);
    d.writeJob("rn-other", { app: 450, updateKey: "レコード番号" }, "レコード番号,氏名\nOTHER-7,x\n");
    const other = await d.run(["diff", "import", "--name", "rn-other"]);
    expect("diff import（レコード番号）: 別のアプリのアプリコードはエラー（別アプリの CSV の取り違え）", other.status === 1 && other.stderr.includes("アプリコードが、このアプリ（コード: EMP）と一致しません") && other.stderr.includes("行 2"), other.stderr);
    d.writeJob("rn-bad", { app: 450, updateKey: "レコード番号" }, "レコード番号,氏名\n12abc,x\n");
    const badNumber = await d.run(["diff", "import", "--name", "rn-bad"]);
    expect("diff import（レコード番号）: 数字でない番号はエラー", badNumber.status === 1 && badNumber.stderr.includes("レコード番号は数字") && badNumber.stderr.includes("行 2"), badNumber.stderr);

    // 数値の更新キー: 表記の違い（10.50 と 10.5）は同じキー
    d.writeJob("num", { app: 480, updateKey: "番号" }, "番号,氏名\n010.50,数値キー改\n3,新規\n");
    const num = await d.run(["push", "import", "--name", "num", "-y"]);
    expect(
      "push import（数値）: 表記の違う数値の更新キー（010.50 = 10.5）で更新し、無ければ追加・クエリの値は正規形",
      num.status === 0 && rec2("480", "1").氏名.value === "数値キー改" && state.queries.some((q) => q === "番号 in (10.5,3) limit 500") && json(num).created?.[0]?.key === "3",
      num.stderr + JSON.stringify(state.queries.slice(-2))
    );

    // Shift_JIS・BOM と CRLF
    d.writeJob("sjis", { app: 470, updateKey: "code", encoding: "sjis" }, Buffer.concat([Buffer.from("code,name\r\nS1,"), Buffer.from([0x8e, 0x52, 0x93, 0x63]), Buffer.from("\r\n")]));
    const sjis = await d.run(["push", "import", "--name", "sjis", "-y"]);
    expect("push import（Shift_JIS）: encoding: sjis の CSV を読んで更新する", sjis.status === 0 && rec2("470", "1").name.value === "山田", sjis.stderr);
    d.writeJob("bom", { app: 303, updateKey: "社員番号" }, "\uFEFF社員番号,備考\r\nE0001,\"改\r\n行\"\r\nE0002,単行\r\n");
    const bom = await d.run(["push", "import", "--name", "bom", "-y"]);
    expect("push import（BOM・CRLF）: BOM 付き UTF-8 と CRLF を読む（複数行のセルの改行は LF で書く）", bom.status === 0 && rec2("303", "1").備考.value === "改\n行" && rec2("303", "2").備考.value === "単行", bom.stderr);
    d.writeJob("multi", { app: 470, updateKey: "code" }, 'code,name\nS1,"改\n行"\n');
    const multi = await d.run(["diff", "import", "--name", "multi"]);
    expect("diff import: 文字列（1行）のセルに改行があればエラー（行番号つき）", multi.status === 1 && multi.stderr.includes("改行は設定できません") && multi.stderr.includes("行 2"), multi.stderr);

    // ゲストスペース: 索引から判定・import.json の guestSpaceId・どちらも無ければ案内
    d.writeJob("guest", { app: 460, updateKey: "社員番号" }, "社員番号,氏名\nG1,ゲスト改\nG2,新規ゲスト\n");
    d.mock.requests.length = 0;
    const guest = await d.run(["push", "import", "--name", "guest", "-y"]);
    expect(
      "push import（ゲスト）: 索引からゲストスペースを判定し、フォーム・照合・一括処理はゲストの URL",
      guest.status === 0 && d.mock.requests.includes("GET /k/guest/7/v1/app/form/fields.json") && d.mock.requests.includes("GET /k/guest/7/v1/records.json") && d.mock.requests.includes("POST /k/guest/7/v1/bulkRequest.json") && rec2("460", "1").氏名.value === "ゲスト改" && json(guest).updated?.[0]?.guestSpaceId === "7",
      guest.stderr + JSON.stringify(d.mock.requests)
    );
    const guestRestore = await d.run(["push", "import", "--name", "guest", "--restore", json(guest).runId, "-y"]);
    expect("restore（ゲスト）: ゲストの URL で元に戻す", guestRestore.status === 0 && rec2("460", "1").氏名.value === "ゲスト" && !state.records["460"].has("51"), guestRestore.stderr);
    fs.rmSync(path.join(d.tmp, "data", "kintone", "index", "apps.json"));
    d.writeJob("guest2", { app: 460, updateKey: "社員番号", guestSpaceId: 7 }, "社員番号,氏名\nG1,ゲスト改2\n");
    const explicit = await d.run(["diff", "import", "--name", "guest2"]);
    expect("diff import（ゲスト）: 索引が無くても import.json の guestSpaceId で判定できる", explicit.status === 0 && json(explicit).guestSpaceId === "7" && json(explicit).update === 1, explicit.stderr);
    d.writeJob("guest3", { app: 460, updateKey: "社員番号" }, "社員番号,氏名\nG1,x\n");
    const unindexed = await d.run(["diff", "import", "--name", "guest3"]);
    expect("diff import（ゲスト）: 索引にも import.json にも無ければ guestSpaceId と pull index を案内", unindexed.status === 1 && unindexed.stderr.includes("guestSpaceId") && unindexed.stderr.includes("pull index"), unindexed.stderr);
  } finally {
    d.close();
  }
}
