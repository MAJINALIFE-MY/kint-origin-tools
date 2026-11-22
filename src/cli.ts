#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pullApp, pullSpace, pullTrackedSpaces } from "./kintone/pull.js";
import { mergeFavoriteGroups, pullFavorites, selectFavoriteGroups } from "./kintone/favorites.js";
import { pullRecords } from "./kintone/records.js";
import { pullUsers } from "./cybozu-user/pullUsers.js";
import { diffApp } from "./kintone/appDiff.js";
import { createAppDraft, listAppTemplates } from "./kintone/appTemplate.js";
import { diffCreate, pushApp, pushCreate } from "./kintone/push.js";
import { diffSpace, pushSpace } from "./kintone/spacePush.js";
import { pullApps, refreshAppIndexForPulledApp } from "./kintone/apps.js";
import { lookupIndexedApp } from "./kintone/appIndex.js";
import { pullIndex } from "./kintone/index.js";
import { pullInstalledPlugins } from "./kintone/installedPlugins.js";
import { importCommonCapture, pullCommon } from "./kintone/common.js";
import { pullRecordComments } from "./kintone/comments.js";
import { runBulkPull, verifyCurrentAppTarget } from "./kintone/bulkPull.js";
import { diffRecords, pushRecords, restoreRecords, showRecords } from "./kintone/recordPush.js";
import { diffImport, pushImport, restoreImport } from "./kintone/recordImportPush.js";
import { diffRehearsal } from "./kintone/recordRehearsal.js";
import { initProject } from "./init.js";
import { updateProject } from "./update.js";
import { warnIfDocsMcpMissing } from "./docsMcp.js";
import { runSecretCommand } from "./crypto.js";
import { conflictingConnectionKeys, getAddonDirectory } from "./env.js";
import { describeConnection } from "./kintone/tenant.js";
import { generateHtml } from "./html/generate.js";
import { findPluginSource } from "./pluginSources.js";
import { log } from "./log.js";
import { listAddons, makeEmptyAddon, manageAddon, prepareAddonRun } from "./addon/operations.js";
import { runAddon } from "./addon/runtime.js";
import { recordRunEvent, startRunLog } from "./runLog.js";
import {
  APP_REQUIREMENTS,
  authorizeCommand,
  DIFF_REQUIREMENTS,
  PERMISSION_DEFS,
  policySummary,
  PULL_REQUIREMENTS,
  PUSH_REQUIREMENTS,
  readPolicy,
  requiredPermissions,
  SHOW_REQUIREMENTS,
  type CommandGroup
} from "./policy.js";

// サブコマンドは policy.ts で必要な許可と一緒に定義する。
const PULL_COMMANDS = new Set(Object.keys(PULL_REQUIREMENTS));
const PUSH_COMMANDS = new Set(Object.keys(PUSH_REQUIREMENTS));
const DIFF_COMMANDS = new Set(Object.keys(DIFF_REQUIREMENTS));
const SHOW_COMMANDS = new Set(Object.keys(SHOW_REQUIREMENTS));
const APP_COMMANDS = new Set(Object.keys(APP_REQUIREMENTS));
const COMMAND_GROUPS: Record<CommandGroup, Set<string>> = {
  pull: PULL_COMMANDS,
  push: PUSH_COMMANDS,
  diff: DIFF_COMMANDS,
  show: SHOW_COMMANDS,
  app: APP_COMMANDS
};

type Args = Record<string, string | boolean>;

const BOOLEAN_FLAGS = new Set([
  "force",
  "yes",
  "attachments",
  "all-indexed",
  "dry-run",
  "with-records",
  "with-comments",
  "with-attachments",
  "plugin",
  "a",
  "no-deploy",
  "all",
  "open",
  "discard-local",
  "overwrite-remote"
]);

// サブコマンドごとに使えるオプション。ここに無いオプションや余分な引数は実行前にエラーにする
// （打ち間違いが黙って無視され、意図と違う操作になるのを防ぐ）。
const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  init: [],
  update: ["yes"],
  policy: [],
  secret: [],
  html: ["open"],
  "pull index": [],
  "pull plugins": [],
  "pull common": ["from"],
  "pull kintone": ["force"],
  "pull all": ["force"],
  "pull app": ["id", "guestspace", "plugin", "a", "force", "discard-local"],
  "pull records": ["id", "guestspace", "condition", "order-by", "attachments", "yes", "all-indexed", "expect-host", "dry-run"],
  "pull comments": ["id", "guestspace", "all-indexed", "expect-host", "dry-run"],
  "pull spaces": ["id", "force", "discard-local"],
  "pull guestspaces": ["id", "force", "discard-local"],
  "pull tracked-spaces": ["force"],
  "pull favorite": ["name", "all", "force", "with-records", "with-comments", "with-attachments", "expect-host", "dry-run"],
  "pull users": [],
  "diff app": ["id", "guestspace", "base", "only"],
  "diff create": ["name", "all"],
  "diff space": ["id", "guestspace"],
  "diff records": ["name"],
  "diff import": ["name"],
  "diff rehearsal": ["id", "import"],
  "show records": ["id", "guestspace", "records", "fields", "condition", "order-by", "limit"],
  "show plugin-source": ["id", "name"],
  "app templates": [],
  "app create": ["name", "template", "space", "thread", "guestspace"],
  "push app": ["id", "guestspace", "only", "base", "no-deploy", "yes"],
  "push create": ["name", "all", "no-deploy", "yes"],
  "push space": ["id", "guestspace", "only", "overwrite-remote", "yes"],
  "push records": ["name", "restore", "overwrite-remote", "yes"],
  "push import": ["name", "restore", "overwrite-remote", "yes"]
};

const SHORT_FLAGS: Record<string, string> = { "-f": "force", "-y": "yes", "-a": "a" };

interface ParsedArgs {
  args: Args;
  /** 指定されたオプション（token は入力のまま、name は正式名） */
  given: Array<{ token: string; name: string }>;
  /** オプションではない余分な引数 */
  extras: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: Args = {};
  const given: ParsedArgs["given"] = [];
  const extras: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const short = SHORT_FLAGS[token];
    if (short) {
      args[short] = true;
      given.push({ token, name: short });
      continue;
    }
    if (!token.startsWith("--")) {
      extras.push(token);
      continue;
    }
    const key = token.slice(2);
    given.push({ token, name: key });
    if (BOOLEAN_FLAGS.has(key)) {
      args[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("-")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return { args, given, extras };
}

function optionLabel(name: string): string {
  if (name === "yes") return "-y/--yes";
  if (name === "force") return "-f/--force";
  return `--${name}`;
}

// --id を正の整数とする通常の検証とは別に、複合IDやプラグインIDを検証するコマンド。
const OWN_ID_FORMAT_COMMANDS = new Set(["pull records", "pull comments", "show records", "show plugin-source"]);

// kintone の ID は正の整数。データのフォルダ名（app-<id> など）に使うため、`..` や区切り文字を含む値を実行前に拒否する。
function validateIdOptions(commandKey: string, args: Args, allowed: readonly string[]): void {
  for (const name of ["id", "guestspace", "space", "thread"]) {
    if (!allowed.includes(name)) continue;
    if (name === "id" && OWN_ID_FORMAT_COMMANDS.has(commandKey)) continue;
    const value = args[name];
    // --id が値なしの場合は、各コマンドの requireArg が「Missing required argument」で案内する。
    if (value === undefined || (name === "id" && value === true)) continue;
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
      throw new Error(`--${name} には正の整数（数字のみ）を指定してください: ${typeof value === "string" ? value : "（値なし）"}`);
    }
  }
}

function parseKnownArgs(commandKey: string, argv: string[]): Args {
  const parsed = parseArgs(argv);
  const allowed = COMMAND_OPTIONS[commandKey] ?? [];
  const problems = [
    ...parsed.given.filter(({ name }) => !allowed.includes(name)).map(({ token }) => `不明なオプションです: ${token}`),
    ...parsed.extras.map((extra) => `不明な引数です: ${extra}`)
  ];
  if (problems.length > 0) {
    throw new Error(
      `${problems.join("\n")}\n${commandKey} で使えるオプション: ${allowed.length ? allowed.map(optionLabel).join(", ") : "なし"}`
    );
  }
  validateIdOptions(commandKey, parsed.args, allowed);
  return parsed.args;
}

function requireArg(args: Args, name: string): string {
  const value = args[name];
  if (!value || typeof value !== "string") {
    throw new Error(`Missing required argument: --${name}`);
  }
  return value;
}

function strArg(args: Args, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

function resolveAppLocation(
  appId: string,
  args: Args,
  { readIndexWithOverride = false }: { readIndexWithOverride?: boolean } = {}
): { guestSpaceId: string; spaceId: string } {
  const guestSpaceOverride = strArg(args, "guestspace");
  // pull app / pull records は明示指定時も索引の読み込みエラーを報告する。
  const indexed = !guestSpaceOverride || readIndexWithOverride ? lookupIndexedApp(appId) : undefined;
  const guestSpaceId = guestSpaceOverride || indexed?.guestSpaceId || "";
  return { guestSpaceId, spaceId: guestSpaceId ? "" : indexed?.spaceId || "" };
}

function parseRecordsId(value: string): { appId: string; recordId: string } {
  const parts = value.split(",");
  if (parts.length > 2 || parts.some((part) => !/^\d+$/.test(part) || Number(part) <= 0)) {
    throw new Error("records の --id は <appId> または <appId>,<recordId> の形式で指定してください。");
  }
  return { appId: parts[0], recordId: parts[1] || "" };
}

function printJson(value: unknown): void {
  const text = JSON.stringify(value, null, 2);
  recordRunEvent("stdout", { text });
  console.log(text);
}

function printText(text: string): void {
  recordRunEvent("stdout", { text });
  console.log(text);
}

function printError(text: string): void {
  recordRunEvent("error", { text });
  console.error(text);
}

// ツールのパッケージ root（import.meta.url 基準。dist/cli.js -> ../package.json）から version を読む。
function toolVersion(): string {
  const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  return String(pkg.version || "");
}

// User API 取得物には PII が含まれるため、users 実行前に注意喚起する（表示のみ。all の自動運用は止めない）。
function warnUsersPii(): void {
  log(
    "注意: 取得物（data/cybozu-common/ 配下の users.json・csv/*.csv）には氏名・メールアドレス等の個人情報が含まれます。" +
      "この data/ をコミットするリポジトリの公開範囲・アクセス権を確認してください。"
  );
}

function runSpaces({
  id,
  guest,
  force,
  discardLocal
}: {
  id: string;
  guest: boolean;
  force: boolean;
  discardLocal: boolean;
}) {
  return guest
    ? pullSpace({ guestSpaceId: id, force, discardLocal })
    : pullSpace({ spaceId: id, force, discardLocal });
}

function validateBulkPullArgs(sub: string, args: Args): void {
  if (sub === "records" || sub === "comments") {
    if (args["all-indexed"]) {
      const incompatible = sub === "records"
        ? ["id", "guestspace", "condition", "order-by", "yes"]
        : ["id", "guestspace"];
      const supplied = incompatible.filter((key) => args[key] !== undefined);
      if (supplied.length) throw new Error(`--all-indexed と同時に使えないオプションです: ${supplied.map((key) => `--${key}`).join(", ")}`);
      requireArg(args, "expect-host");
    } else {
      if (args["expect-host"] !== undefined || args["dry-run"] !== undefined) throw new Error("--expect-host / --dry-run は --all-indexed と一緒に指定してください。");
      requireArg(args, "id");
    }
  }
  if (sub === "favorite") {
    const withRecords = Boolean(args["with-records"]);
    const withComments = Boolean(args["with-comments"]);
    const withAttachments = Boolean(args["with-attachments"]);
    const hasData = withRecords || withComments || withAttachments;
    if (withAttachments && !withRecords) throw new Error("--with-attachments は --with-records と一緒に指定してください。");
    if (hasData && args.all) throw new Error("お気に入り全グループ（--all）ではデータ取得できません。--name を指定してください。");
    if (hasData) {
      requireArg(args, "name");
      requireArg(args, "expect-host");
    } else if (args["expect-host"] !== undefined || args["dry-run"] !== undefined) {
      throw new Error("--expect-host / --dry-run は --with-records または --with-comments と一緒に指定してください。");
    }
  }
}

function isBulkPullRequest(sub: string, args: Args): boolean {
  return Boolean(args["all-indexed"]) || (sub === "favorite" && Boolean(args["with-records"] || args["with-comments"] || args["with-attachments"]));
}

const USAGE = `Usage: kint-origin <command> [options]

Commands:
  pull common                                 共通設定を取得し、data/kintone/common/ に保存
  pull common --from <directory>              手動取得した共通設定をオフラインで取り込み
  pull comments --id <appId>[,<recordId>] [--guestspace <id>]  アプリの指定レコード、または全レコードのコメントを取得
  pull comments --all-indexed --expect-host <host> [--dry-run]  完全索引にある全アプリのコメントを確認後に取得（.env の1回限り許可が必要）
  init                                       新ドメイン用テンプレート＋空ディレクトリ＋AIエージェント設定(Claude/Codex/Cursor)作成
                                             既存のファイルは上書きしない。既存の .gitignore には .env などの除外を追記する（既存の行は変えない）
  update [-y]                                スキル/ルール/AGENTS.md/CLAUDE.md/README.md/設定を最新テンプレートへ更新（上書き）
                                             上書きされるファイルを一覧にして y/N で確認する（-y=確認を省略。非対話の実行は -y が必要）
                                             kint-origin-local-* スキルと、配布物に無い独自のファイルは上書きも削除もしない。ツール本体のフォルダでは実行できない
                                             kint-origin-local- で始まらない独自スキルは名前の警告を出す（上書き・削除はしない）
  pull index                                 全アプリ索引とインストール済みプラグイン一覧を更新
                                            プラグイン一覧は installed.json に保存（sources.json の参照は変更しない）
  pull plugins                              インストール済みプラグイン一覧だけを更新
  pull kintone [--force|-f]                  ドメイン全体（スペース＋アプリ）差分取得＋削除判定
  pull all [--force|-f]                      kintone → users をまとめて取得
  pull app --id <appId> [--guestspace <id>] [--plugin] [--a] [-f] [--discard-local]
                                             1アプリ取得。--plugin=APIラボのプラグイン設定、--a=プラグイン設定＋records/添付も確認なしで取得
                                             -f=権限なしと記録した管理系設定（acl・通知・customize 等）も取り直して再判定
                                             通常は data/ のローカル編集（push 対象ファイル・customize）を上書きせず保持する。
                                             --discard-local=ローカル編集を破棄して環境の内容で取り直す
  pull records --id <appId>[,<recordId>] [--guestspace <id>] [--condition "<query>"] [--order-by "<order>"] [--attachments] [-y]
                                             全件取得、または指定レコードだけ既存 CSV を更新。通常は添付DLを確認（Enter=Yes）
                                             --attachments=添付確認省略、-y/--yes=全確認省略（どちらも添付あり）
  pull records --all-indexed --expect-host <host> [--attachments] [--dry-run]
                                             完全索引にある全アプリのレコードを確認後に取得。実行時に .env の1回限り許可を false にする
  pull spaces --id <spaceId> [-f] [--discard-local]
                                             スペース＋配下アプリ差分取得（settings.json / body.html のローカル編集は保持。--discard-local=破棄して取り直す）
  pull guestspaces --id <guestSpaceId> [-f] [--discard-local]
                                             ゲストスペース＋配下アプリ差分取得（--discard-local=ローカル編集を破棄して取り直す）
  pull tracked-spaces [--force|-f]           追跡スペース差分取得＋削除判定
  pull favorite --name <グループ名> | --all [-f] [--with-records] [--with-comments] [--with-attachments] --expect-host <host> [--dry-run]
                                             favorites/<グループ名>.json に定義した設定を取得。--with-* は apps のデータだけ対象にし、毎回対話確認
                                             --with-attachments は --with-records と併用。--all は設定のみで、データ取得は --name 指定時だけ
  pull users                                 cybozu.com 共通管理ユーザー（取得物に個人情報を含む点に注意）
  app templates                              kintone のアプリテンプレート zip の一覧（任意。名前・出所・zip 内のアプリ名を JSON で表示。API は呼ばない）
  app create --name <アプリ名> [--template <名前>] [--space <id>] [--thread <id>] [--guestspace <id>]
                                             push/new-apps/<アプリ名>/ に新規アプリのドラフトをローカルで作る（API は呼ばず、許可も不要。アプリ ID は付かない）
                                             既定は空欄のドラフト（zip は使わない）。--template=app templates の zip が「空のアプリ」の形か検査して作る（扱えない zip や未知の名前は拒否）
                                             kintone への作成は、diff create で確認のうえ push create で行う
  diff app --id <appId> [--guestspace <id>] [--base <ref>] [--only <keys>]
                                             Git 基準と pull 状態から app 設定・customize のローカル差分を表示（API・許可不要）
  diff create [--name <ドラフト名> | --all] push create の事前確認（作成順・ファイル・参照・復旧プラン）。API は呼ばない
  diff space --id <spaceId> [--guestspace <id>]
                                             data/kintone/spaces/ の settings.json・body.html と環境のスペースの差分を表示。読み取りのみ
  diff records --name <ジョブ名>             push/records/<ジョブ名>/job.csv の検証とプレビュー（GET のみ。変更前後の CSV を runs/ に出力）
  diff import --name <ジョブ名>              push/import/<ジョブ名>/ の import.json と records.csv（更新キー付き CSV）の検証とプレビュー（GET のみ。
                                         更新・追加・変更なしの件数と、変更前後の CSV を runs/ に出力）
  diff rehearsal --id <appId> [--import <ジョブ名>]
                                             取得済みレコードとローカルフォームから、画面取込用CSVをローカル生成（API・認証・操作許可不要）
  show records --id <appId> [--records <id,...>] [--fields <code,...>] [--condition "<query>"] [--order-by "<order>"] [--limit <n>] [--guestspace <id>]
                                             レコード・フィールド単位の値を JSON で表示（読み取りのみ。data/ は変更しない。添付はファイル名とサイズだけ）
  show plugin-source --id <pluginId> | --name <alias>
                                             data/kintone/plugin/ の sources.json と sources.local.json からソース参照先を JSON で表示（ローカルのみ）
                                             --name は sources.json に登録した alias を指定する
  push app --id <appId> [--guestspace <id>] [--only <keys>] [--base <ref>] [--no-deploy] [-y]
                                             Git 基準から変更された app 設定・customize だけを反映（動作テスト環境→運用環境 deploy）
                                             --base は pull app の取得結果を含むコミットを指定（既定 HEAD）。環境の同一リソース変更は上書き
  push create [--name <ドラフト名> | --all] [--no-deploy] [-y]
                                             push/new-apps/<名前>/ のドラフトから新規アプリ作成（{{app:名前}} 参照は依存順に自動解決）
  push space --id <spaceId> [--guestspace <id>] [--only <keys>] [--overwrite-remote] [-y]
                                             data/kintone/spaces/ の settings.json・body.html のローカル編集をスペースへ即時反映（--only=settings,body。
                                             実行前にバックアップ、反映直後に再取得して HTML サニタイズ差分も同期）
  push records --name <ジョブ名> [-y]        push/records/<ジョブ名>/job.csv のとおりにレコードを更新・追加（添付のコピー・値の転記・固定値・テーブル行。
                                             実行前にバックアップ。運用環境へ即時反映）
  push records --name <ジョブ名> --restore <実行時刻> [--overwrite-remote] [-y]
                                             push records の実行をバックアップから元に戻す（その実行で作成したレコードは削除）
                                             --overwrite-remote=実行後に他の人が編集したレコードも上書きして戻す
  push import --name <ジョブ名> [-y]         push/import/<ジョブ名>/ の更新キー付き CSV のとおりにレコードを更新・追加（kintone の「ファイルから読み込む」相当。
                                         更新キーが一致すれば更新、無ければ追加。CSV にある列だけを書く。実行前にバックアップ。運用環境へ即時反映）
  push import --name <ジョブ名> --restore <実行時刻> [--overwrite-remote] [-y]
                                         push import の実行をバックアップから元に戻す（その実行で追加したレコードは削除）
                                         --overwrite-remote=実行後に他の人が編集したレコードも上書きして戻す
  html [--open]                              data/ の取得内容をローカル閲覧用の静的HTMLへ変換して html/ に出力（Webサーバー不要。
                                             ブラウザで html/index.html を開く。--open=生成後に既定ブラウザで開く）
  policy                                     .env の操作制限（KINT_ORIGIN_ALLOW_*）の実効値を JSON で表示（API は使わない）
  secret                                     .env の CYBOZU_PASSWORD に書くマシン固有の暗号化パスワード（enc:v1:...）を発行（API は使わない）
                                             対話入力（非表示）または標準入力から 1 行読み取り、マシン識別値とログインユーザー名に結び付けた暗号化値を出力する
                                             stdout の envLine（CYBOZU_PASSWORD=enc:v1:...）を .env に書き写す。.env 自体は書き換えない
  addon list                               外部addonフォルダの一覧とインストール状態を表示
  addon create <name>                      空のaddon雛形を外部addonフォルダに作成
  addon install <name> [-y]                addonのスキル・ルールをこのドメインへリンク
  addon update <name> [-y]                 インストール済みaddonのリンクを同期
  addon remove <name> [-y]                 addonのリンクと登録をこのドメインから削除
  addon run <name> <command> [...args]     インストール済みaddonのコマンドを実行
  version | --version | -v                   バージョン表示

操作制限: cwd の .env の KINT_ORIGIN_ALLOW_* で許可した操作だけを実行する（未設定時は pull kintone 相当のみ）。
  KINT_ORIGIN_ALLOW_PULL_KINTONE（既定 true）/ _PULL_RECORDS / _BULK_RECORDS / _PULL_RECORDS_ALL_ONCE / _PULL_COMMENTS_ALL_ONCE / _PULL_USERS / _PUSH_APP / _PUSH_SPACE / _PUSH_RECORDS（既定 false）
  値は true / false。環境変数では上書きできない。diff app は Git のローカル差分のみ（API・許可不要）。diff space は pull kintone の許可で動く。
  app create / app templates / diff create / diff rehearsal は許可不要（diff rehearsal は API を呼ばない）。
  show records は PULL_RECORDS、diff records / diff import は PULL_KINTONE と PULL_RECORDS、push records / import は PULL_RECORDS と PUSH_RECORDS が要る。
  全アプリ一括取得は PULL_RECORDS と BULK_RECORDS に加え、実行ごとに使い切る PULL_RECORDS_ALL_ONCE または PULL_COMMENTS_ALL_ONCE が要る。
  確認は kint-origin policy。
kintone documentation MCP の設定が見つからないと各コマンドが警告する（.env の KINT_ORIGIN_DOCS_MCP_WARNING=false で止める）。

push は kintone 環境を書き換える危険コマンド。ローカル編集だけを送る。実行前に反映内容と復旧プランを表示して y/N 確認する。
-y は確認を省略する（AI エージェントは、ユーザーが内容を承認したときだけ付ける）。
反映コマンドの一覧は kint-origin push --help。引数・必要な許可は kint-origin push <サブコマンド> --help。

実行は対象ドメインのフォルダ内で（data/ と .env は実行ディレクトリ基準）。`;

// ---- サブコマンド別のヘルプ ----
// USAGE の各コマンドのブロックから生成する（文書とコードを二重管理にしない）。操作制限・認証値・API には一切触れない。

const GROUPS = ["pull", "push", "diff", "show", "app"];
// USAGE のブロックの続きの行は、深いインデント（コマンド名の列の右側）で始まる。
const CONTINUATION_INDENT = " ".repeat(40);

// USAGE の「Commands:」を、コマンドごとのブロック（先頭行 + 説明の続き行）に分ける。キーは "pull app" のようなコマンド名。
function usageBlocks(): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = USAGE.split("\n");
  const start = lines.indexOf("Commands:");
  let currentKey = "";
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    if (line.startsWith(CONTINUATION_INDENT)) {
      if (currentKey) blocks.set(currentKey, `${blocks.get(currentKey)}\n${line}`);
      continue;
    }
    const tokens = line.trim().split(/\s+/);
    currentKey = GROUPS.includes(tokens[0]) ? `${tokens[0]} ${tokens[1]}` : tokens[0];
    blocks.set(currentKey, blocks.has(currentKey) ? `${blocks.get(currentKey)}\n${line}` : line);
  }
  return blocks;
}

function permissionKeys(group: CommandGroup, sub: string, args: Record<string, string | boolean>): string[] {
  return requiredPermissions(group, sub, args).map(
    (permission) => PERMISSION_DEFS.find((def) => def.permission === permission)?.envKey ?? permission
  );
}

// コマンドごとに必要な許可（.env の KINT_ORIGIN_ALLOW_*）。policy.ts が正本。pull app は --a の有無で変わるので両方を示す。
function requiredPermissionsText(group: CommandGroup, sub: string, args: Record<string, string | boolean> = {}): string {
  if (group === "pull" && sub === "common") {
    return "pull common は pull:kintone が必要です。--from を指定したローカル取り込みでは権限・API・認証情報を使いません。";
  }
  try {
    const normal = permissionKeys(group, sub, args);
    const withA = group === "pull" && sub === "app" && !args.a ? permissionKeys(group, sub, { ...args, a: true }) : normal;
    const base = normal.length > 0 ? normal.join(" と ") : "なし";
    const extra = withA.join() !== normal.join() ? `（--a を付けると ${withA.join(" と ")}）` : "";
    return `必要な許可（.env）: ${base}${extra}（確認は kint-origin policy。許可の変更はユーザーが .env に書く）`;
  } catch {
    return "";
  }
}

function optionsText(commandKey: string): string {
  const allowed = COMMAND_OPTIONS[commandKey] ?? [];
  return `使えるオプション: ${allowed.length > 0 ? allowed.map(optionLabel).join(", ") : "なし"}`;
}

// kint-origin <command> --help の出力。該当が無ければ undefined。
function helpFor(tokens: string[]): string | undefined {
  const [first, second] = tokens;
  if (!first) return undefined;
  if (first === "addon") {
    const header = "Usage: kint-origin <command> [options]\n";
    const lines = [
      "addon list",
      "addon create <name>",
      "addon install <name> [-y]",
      "addon update <name> [-y]",
      "addon remove <name> [-y]",
      "addon run <name> <command> [...args]",
      "",
      "addonソースはドメインの .env または環境変数 KINT_ORIGIN_ADDON_DIR で指定します。",
      "addonの正本は外部フォルダに残り、install はスキルをリンクしてGit除外を設定します。",
      "addonコマンドは addon.json に定義した Node.js .mjs ファイルです。引数（--help を含む）は加工せず渡します。"
    ];
    if (!second) return [header, ...lines].join("\n");
    const actions: Record<string, string> = {
      list: "addon list\n  外部ソースのaddonとインストール状態を表示します。kintone API は呼びません。",
      create: "addon create <name>\n  KINT_ORIGIN_ADDON_DIR に空のaddon構成を作成します。",
      install: "addon install <name> [-y]\n  addonを現在のドメインへリンクします。-y は確認を省略します。",
      update: "addon update <name> [-y]\n  現在のaddonソースに合わせてリンクを同期します。-y は確認を省略します。",
      remove: "addon remove <name> [-y]\n  addonが管理するリンクを現在のドメインから削除します。-y は確認を省略します。",
      run: "addon run <name> <command> [...args]\n  インストール済みaddonのコマンドを実行します。引数はそのまま渡します。"
    };
    const action = actions[second];
    return action ? `${header}${action}` : undefined;
  }
  const blocks = usageBlocks();
  const header = "Usage: kint-origin <command> [options]\n";
  // グループ（pull / push / diff / show / app）: そのグループの全サブコマンドを並べる。
  if (GROUPS.includes(first) && !second) {
    const body = [...blocks.entries()].filter(([key]) => key.startsWith(`${first} `)).map(([, value]) => value);
    if (body.length === 0) return undefined;
    return [header, ...body, "", `各サブコマンドの詳細（使えるオプション・必要な許可）: kint-origin ${first} <サブコマンド> --help`].join("\n");
  }
  const key = GROUPS.includes(first) ? `${first} ${second}` : first;
  const block = blocks.get(key);
  if (!block) return undefined;
  const helpArgs = parseArgs(tokens.slice(2)).args;
  const extra = [optionsText(key), GROUPS.includes(first) ? requiredPermissionsText(first as CommandGroup, second, helpArgs) : ""].filter(Boolean);
  return [header, block, "", ...extra].join("\n");
}

async function runPull(sub: string, args: Args): Promise<void> {
  switch (sub) {
    case "index": {
      printJson(await pullIndex());
      break;
    }
    case "plugins": {
      printJson(await pullInstalledPlugins());
      break;
    }
    case "common": {
      printJson(await pullCommon());
      break;
    }
    case "kintone": {
      printJson(await pullApps({ force: Boolean(args.force) }));
      break;
    }
    case "app": {
      const appId = requireArg(args, "id");
      const { guestSpaceId, spaceId } = resolveAppLocation(appId, args, { readIndexWithOverride: true });
      const dataTarget = args.a
        ? await verifyCurrentAppTarget(appId, guestSpaceId, { records: true, attachments: true })
        : undefined;
      const effectiveGuestSpaceId = dataTarget?.guestSpaceId ?? guestSpaceId;
      const effectiveSpaceId = dataTarget?.spaceId ?? spaceId;
      const includePluginConfigs = Boolean(args.plugin || args.a);
      if (includePluginConfigs) {
        log("INFO APIラボ（検討中の新機能）を利用中: アプリに追加されているプラグインの設定情報を取得します");
      }
      // 索引にあるスペースを渡す（app.json を読めない権限でも、スペース配下のアプリを別フォルダへ書かない）。
      const summary = await pullApp({
        appId,
        guestSpaceId: effectiveGuestSpaceId,
        spaceId: effectiveSpaceId,
        pluginConfigs: includePluginConfigs,
        force: Boolean(args.force),
        discardLocal: Boolean(args["discard-local"])
      });
      if (summary.denied) log(`権限がないためスキップ: ${summary.denied.join(", ")}（権限付与後は -f で再判定）`);
      if (summary.localEdits) {
        log(
          `ローカル編集を保持: ${summary.localEdits.map((edit) => `${edit.file}${edit.conflict ? "（環境側も変更）" : ""}`).join(", ")}` +
            `（確認は kint-origin diff app --id ${appId}。破棄して取り直すなら --discard-local）`
        );
      }
      await refreshAppIndexForPulledApp({ appId, guestSpaceId, incomplete: Boolean(summary.resourceFailures?.length) });
      if (args.a) {
        const records = await pullRecords({
          appId,
          guestSpaceId: effectiveGuestSpaceId,
          spaceId: summary.spaceId,
          attachments: true,
          yes: true
        });
        printJson({ ...summary, records });
        if ((records.attachmentFailures ?? 0) > 0) process.exitCode = 1;
      } else {
        printJson(summary);
      }
      break;
    }
    case "records": {
      const { appId, recordId } = parseRecordsId(requireArg(args, "id"));
      const target = await verifyCurrentAppTarget(appId, strArg(args, "guestspace"), { records: true, attachments: Boolean(args.attachments) });
      const result = await pullRecords({
          appId,
          recordId,
          guestSpaceId: target.guestSpaceId,
          spaceId: target.guestSpaceId ? "" : target.spaceId,
          condition: strArg(args, "condition"),
          orderBy: strArg(args, "order-by"),
          attachments: Boolean(args.attachments),
          yes: Boolean(args.yes)
        });
      printJson(result);
      if (result.aborted || (result.attachmentFailures ?? 0) > 0) process.exitCode = 1;
      break;
    }
    case "comments": {
      const { appId, recordId } = parseRecordsId(requireArg(args, "id"));
      const target = await verifyCurrentAppTarget(appId, strArg(args, "guestspace"), { comments: true });
      const result = await pullRecordComments({ appId, recordId, guestSpaceId: target.guestSpaceId, spaceId: target.guestSpaceId ? "" : target.spaceId });
      printJson(result);
      if (result.failures.length > 0) process.exitCode = 1;
      break;
    }
    case "spaces":
    case "guestspaces": {
      const id = requireArg(args, "id");
      printJson(
        await runSpaces({
          id,
          guest: sub === "guestspaces",
          force: Boolean(args.force),
          discardLocal: Boolean(args["discard-local"])
        })
      );
      break;
    }
    case "all": {
      const kintone = await pullApps({ force: Boolean(args.force) });
      warnUsersPii();
      const users = await pullUsers();
      printJson({ kintone, users });
      break;
    }
    case "tracked-spaces": {
      printJson(await pullTrackedSpaces({ force: Boolean(args.force) }));
      break;
    }
    case "favorite": {
      // 定義の読み込み・検証は認証値の読み込みと API 呼び出しより前に行う（不正な定義は API を呼ばずに止める）。
      const groups = selectFavoriteGroups({ name: args.name, all: Boolean(args.all) });
      printJson(await pullFavorites({ targets: mergeFavoriteGroups(groups), force: Boolean(args.force) }));
      break;
    }
    case "users": {
      warnUsersPii();
      printJson(await pullUsers());
      break;
    }
  }
}

// push records / push import の --restore（runs/ のフォルダ名）と --overwrite-remote の組み合わせを検証する。復旧でなければ空文字を返す。
function parseRestoreArg(args: Args): string {
  const restore = strArg(args, "restore");
  if (args.restore && !restore) throw new Error("--restore には runs/ のフォルダ名（例: 20261103-101530）を指定してください。");
  if (restore && !/^\d{8}-\d{6}(-\d+)?$/.test(restore)) {
    throw new Error("--restore には runs/ のフォルダ名（例: 20261103-101530）を指定してください。");
  }
  if (args["overwrite-remote"] && !restore) throw new Error("--overwrite-remote は --restore と一緒に指定してください。");
  return restore;
}

// 結果を stdout に JSON で出し、確認で辞退された（何も反映していない）かを返す。
function printPushResult(result: { aborted?: boolean }): boolean {
  printJson(result);
  return Boolean(result.aborted);
}

// 確認で辞退されたら true を返す。
async function runPush(sub: string, args: Args): Promise<boolean> {
  switch (sub) {
    case "app": {
      const appId = requireArg(args, "id");
      const { guestSpaceId } = resolveAppLocation(appId, args);
      const only = strArg(args, "only")
        ? strArg(args, "only")
            .split(",")
            .map((key) => key.trim())
            .filter(Boolean)
        : undefined;
      return printPushResult(
        await pushApp({
          appId,
          guestSpaceId,
          only,
          baseRef: strArg(args, "base") || "HEAD",
          deploy: !args["no-deploy"],
          yes: Boolean(args.yes)
        })
      );
    }
    case "records": {
      const name = requireArg(args, "name");
      const restore = parseRestoreArg(args);
      return printPushResult(
        restore
          ? await restoreRecords({ name, runId: restore, yes: Boolean(args.yes), overwriteRemote: Boolean(args["overwrite-remote"]) })
          : await pushRecords({ name, yes: Boolean(args.yes) })
      );
    }
    case "import": {
      const name = requireArg(args, "name");
      const restore = parseRestoreArg(args);
      return printPushResult(
        restore
          ? await restoreImport({ name, runId: restore, yes: Boolean(args.yes), overwriteRemote: Boolean(args["overwrite-remote"]) })
          : await pushImport({ name, yes: Boolean(args.yes) })
      );
    }
    case "create": {
      return printPushResult(
        await pushCreate({
          name: strArg(args, "name") || undefined,
          all: Boolean(args.all),
          deploy: !args["no-deploy"],
          yes: Boolean(args.yes)
        })
      );
    }
    case "space": {
      const guestSpaceId = strArg(args, "guestspace");
      const spaceId = args.id !== undefined || !guestSpaceId ? requireArg(args, "id") : guestSpaceId;
      const only = strArg(args, "only")
        ? strArg(args, "only")
            .split(",")
            .map((key) => key.trim())
            .filter(Boolean)
        : undefined;
      return printPushResult(
        await pushSpace({
          spaceId,
          guestSpaceId,
          only,
          yes: Boolean(args.yes),
          overwriteRemote: Boolean(args["overwrite-remote"])
        })
      );
    }
  }
  return false;
}

const ID_PATTERN = /^[1-9]\d*$/;

// 数字の ID をカンマ区切りで受け取る（--records 12,15）。
function parseIdList(value: string, label: string): string[] {
  const ids = value.split(",").map((item) => item.trim());
  if (ids.some((item) => !ID_PATTERN.test(item))) throw new Error(`${label} は数字の ID をカンマ区切りで指定してください（例: 12,15）。`);
  return ids;
}

async function runShow(sub: string, args: Args): Promise<void> {
  switch (sub) {
    case "records": {
      const appId = requireArg(args, "id");
      if (!ID_PATTERN.test(appId)) throw new Error("show records の --id はアプリ ID（数字）で指定してください。");
      const recordIds = strArg(args, "records") ? parseIdList(strArg(args, "records"), "--records") : undefined;
      const orderBy = strArg(args, "order-by");
      if (recordIds && orderBy) throw new Error("--records と --order-by は同時に指定できません（--records の結果はレコード ID 順です）。");
      const limitRaw = strArg(args, "limit") || "100";
      const limit = Number(limitRaw);
      if (!/^\d+$/.test(limitRaw) || limit < 1 || limit > 10000) throw new Error("--limit は 1〜10000 の整数で指定してください。");
      const fields = strArg(args, "fields")
        ? strArg(args, "fields")
            .split(",")
            .map((code) => code.trim())
            .filter(Boolean)
        : undefined;
      const { guestSpaceId } = resolveAppLocation(appId, args);
      printJson(await showRecords({ appId, guestSpaceId, recordIds, fields, condition: strArg(args, "condition"), orderBy, limit }));
      break;
    }
  }
}

async function runDiff(sub: string, args: Args): Promise<void> {
  switch (sub) {
    case "records": {
      printJson(await diffRecords({ name: requireArg(args, "name") }));
      break;
    }
    case "import": {
      printJson(await diffImport({ name: requireArg(args, "name") }));
      break;
    }
    case "rehearsal": {
      const result = diffRehearsal({ appId: requireArg(args, "id"), importName: args.import === undefined ? undefined : requireArg(args, "import") });
      printJson(result);
      if (result.status === "issues") process.exitCode = 1;
      break;
    }
    case "app": {
      const appId = requireArg(args, "id");
      const { guestSpaceId } = resolveAppLocation(appId, args);
      const only = strArg(args, "only")
        ? strArg(args, "only").split(",").map((key) => key.trim()).filter(Boolean)
        : undefined;
      printJson(diffApp({ appId, guestSpaceId, baseRef: strArg(args, "base") || "HEAD", only }));
      break;
    }
    case "create": {
      printJson(diffCreate({ name: strArg(args, "name") || undefined, all: Boolean(args.all) }));
      break;
    }
    case "space": {
      const guestSpaceId = strArg(args, "guestspace");
      const spaceId = args.id !== undefined || !guestSpaceId ? requireArg(args, "id") : guestSpaceId;
      printJson(await diffSpace({ spaceId, guestSpaceId }));
      break;
    }
  }
}

function runApp(sub: string, args: Args): void {
  switch (sub) {
    case "templates": {
      const result = listAppTemplates();
      if (result.templates.length === 0) {
        log(
          "アプリテンプレートの zip はありません（任意です）。使うときは push/app-templates/<名前>.zip に置いてください。" +
            "zip なしでも、kint-origin app create --name <アプリ名> で空欄のドラフトを作れます。"
        );
      }
      printJson(result);
      break;
    }
    case "create": {
      // 値なしの --template（--template だけ）は、空欄へ黙ってフォールバックさせずに拒否する。
      if (args.template === true) throw new Error("--template にはテンプレート名を指定してください（一覧は kint-origin app templates）。");
      const result = createAppDraft({
        name: requireArg(args, "name"),
        template: strArg(args, "template") || undefined,
        space: strArg(args, "space"),
        thread: strArg(args, "thread"),
        guestSpaceId: strArg(args, "guestspace")
      });
      log(
        `ドラフトを作りました: ${result.dir}（${result.template ? `テンプレート「${result.template}」を検査して作成。内容は空欄と同じ` : "空欄"}）。` +
          `次は、ドラフトの form/fields.json・form/layout.json・views/views.json を編集し、kint-origin diff create --name ${result.draftName} で確認してください。` +
          "kintone への作成は、承認を得て push create で行います。"
      );
      printJson(result);
      break;
    }
  }
}

// どのドメインへ接続するかを、API を呼ぶ前に表示する（別ドメインの .env・環境変数での誤実行に気づけるように）。
// 認証値が無い（.env 未作成など）ときは、ここでは何も出さない（必要なコマンドは、その後の認証値の読み込みでエラーになる）。
function logConnection(): void {
  try {
    log(`接続先: ${describeConnection()}`);
  } catch {
    return;
  }
  const conflicts = conflictingConnectionKeys();
  if (conflicts.length > 0) {
    log(
      `警告: 環境変数 ${conflicts.join(", ")} が、このフォルダの .env の値と異なります。環境変数が優先されます。` +
        "別のドメインへ接続していないか確認してください（意図しない場合は、シェルの環境変数を外してください）。"
    );
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  // An addon command owns its argument parser; in particular, forward child --help unchanged.
  if (command === "addon" && rest[0] === "run" && rest.length >= 3 && rest[2] !== "--help" && rest[2] !== "-h") {
    const [, name, childCommand, ...childArgs] = rest;
    const prepared = prepareAddonRun(process.cwd(), name, childCommand);
    process.exitCode = await runAddon(prepared.entry, childArgs, prepared.context);
    return;
  }

  // サブコマンド別のヘルプ: `kint-origin pull --help`・`pull app --help`・`help pull app`。
  // 操作制限・認証値・API には触れず、引数の検証（不明なオプションの拒否）より前に処理する。
  const asksHelp = command === "help" || rest.some((token) => token === "--help" || token === "-h");
  if (asksHelp && command !== undefined && command !== "--help" && command !== "-h") {
    const tokens = (command === "help" ? rest : [command, ...rest]).filter((token) => token !== "--help" && token !== "-h");
    if (tokens.length > 0) {
      const text = helpFor(tokens);
      if (text === undefined) {
        printError(`Unknown command: ${tokens.join(" ")}\n\n${USAGE}`);
        process.exitCode = 1;
        return;
      }
      printText(text);
      return;
    }
  }

  // pull / push / diff / show / app はグループコマンド。次のトークンをサブコマンドとして振り分ける。
  if (command === "pull" || command === "push" || command === "diff" || command === "show" || command === "app") {
    const [sub, ...subRest] = rest;
    if (!sub || !COMMAND_GROUPS[command].has(sub)) {
      printError(`Unknown command: ${[command, sub].filter(Boolean).join(" ")}\n\n${USAGE}`);
      process.exitCode = 1;
      return;
    }
    // 未登録のオプション・余分な引数は、操作制限の判定や API 呼び出しより前に中断する。
    const args = parseKnownArgs(`${command} ${sub}`, subRest);
    if (command === "pull") validateBulkPullArgs(sub, args);
    if (command === "pull" && sub === "common" && args.from !== undefined) {
      printJson(importCommonCapture(requireArg(args, "from")));
      return;
    }
    if (command === "show" && sub === "plugin-source") {
      if ((args.id === undefined) === (args.name === undefined)) {
        throw new Error("--id または --name のどちらか一方を指定してください。");
      }
      const lookup = args.name === undefined ? { id: requireArg(args, "id") } : { name: requireArg(args, "name") };
      printJson(findPluginSource(lookup));
      return;
    }
    log(`▶ kint-origin ${[command, sub, ...subRest].join(" ").trim()}`);
    if (command === "pull" && isBulkPullRequest(sub, args)) {
      warnIfDocsMcpMissing();
      authorizeCommand(command, sub, args);
      const source = sub === "favorite"
        ? (() => {
            const groups = selectFavoriteGroups({ name: args.name, all: Boolean(args.all) });
            return { groups, targets: mergeFavoriteGroups(groups) };
          })()
        : undefined;
      const result = await runBulkPull({
        mode: sub === "favorite" ? "favorite" : sub as "records" | "comments",
        expectedHost: requireArg(args, "expect-host"),
        allIndexed: Boolean(args["all-indexed"]),
        source,
        withRecords: Boolean(args["with-records"]),
        withComments: Boolean(args["with-comments"]),
        attachments: Boolean(args.attachments || args["with-attachments"]),
        dryRun: Boolean(args["dry-run"]),
        force: Boolean(args.force)
      });
      printJson(result);
      if (result.status === "partial" || result.status === "aborted") {
        log(result.status === "aborted" ? "✖ 中断しました（確認で承認されなかったため、取得していません）" : "✖ 一部の取得に失敗しました。JSON の failures を確認してください。");
        process.exitCode = 1;
      } else if (result.status === "dry-run") {
        log("✓ 取得プレビュー完了（データは保存していません）");
      } else {
        log("✓ 取得完了");
      }
      return;
    }
    const offlineLocalDiff = command === "diff" && (sub === "rehearsal" || sub === "app");
    // diff app / rehearsal はローカル処理だけなので、接続先・MCP設定・.envの許可を読まない。
    if (!offlineLocalDiff) {
      if (command !== "app") logConnection();
      warnIfDocsMcpMissing();
      authorizeCommand(command, sub, args);
    }
    let aborted = false;
    if (command === "pull") {
      await runPull(sub, args);
    } else if (command === "push") {
      aborted = await runPush(sub, args);
    } else if (command === "show") {
      await runShow(sub, args);
    } else if (command === "app") {
      runApp(sub, args);
    } else {
      await runDiff(sub, args);
    }
    if (aborted) {
      // 確認で承認されなかった。完了と区別できるよう、終了コードも 0 にしない（自動実行・AI が反映済みと誤解しない）。
      log("✖ 中断しました（確認で承認されなかったため、何も反映していません）");
      process.exitCode = 1;
      return;
    }
    if (process.exitCode && process.exitCode !== 0) {
      log("✖ 一部または全体の処理に失敗しました。JSON の failures を確認してください。");
      return;
    }
    log("✓ 完了");
    return;
  }

  switch (command) {
    case "addon": {
      const [action, ...args] = rest;
      if (action === "list" && args.length === 0) {
        printJson(listAddons());
        break;
      }
      if (action === "create" && args.length === 1) {
        const directory = getAddonDirectory();
        const root = makeEmptyAddon(args[0], directory, process.cwd());
        printJson({ name: args[0], path: root });
        break;
      }
      if (action === "install" || action === "update" || action === "remove") {
        const positional = args.filter((item) => item !== "-y" && item !== "--yes");
        const flags = args.filter((item) => item === "-y" || item === "--yes");
        if (positional.length !== 1 || flags.length > 1 || positional[0].startsWith("-")) {
          throw new Error(`Usage: kint-origin addon ${action} <name> [-y]`);
        }
        const result = await manageAddon(action, positional[0], { yes: flags.length === 1 });
        printJson(result);
        if (result.aborted) process.exitCode = 1;
        break;
      }
      if (action === "run") throw new Error("Usage: kint-origin addon run <name> <command> [...args]");
      printError(`Unknown command: addon${action ? ` ${action}` : ""}\n\n${USAGE}`);
      process.exitCode = 1;
      return;
    }
    case "init": {
      parseKnownArgs("init", rest);
      warnIfDocsMcpMissing();
      printJson(initProject());
      break;
    }
    case "update": {
      const args = parseKnownArgs("update", rest);
      warnIfDocsMcpMissing();
      const result = await updateProject({ yes: Boolean(args.yes) });
      printJson(result);
      if (result.aborted) process.exitCode = 1;
      break;
    }
    case "html": {
      const args = parseKnownArgs("html", rest);
      log(`▶ kint-origin ${["html", ...rest].join(" ").trim()}`);
      warnIfDocsMcpMissing();
      printJson(await generateHtml({ open: Boolean(args.open) }));
      log("✓ 完了");
      break;
    }
    case "policy": {
      parseKnownArgs("policy", rest);
      warnIfDocsMcpMissing();
      const policy = readPolicy();
      printJson(policySummary(policy));
      if (policy.errors.length > 0) process.exitCode = 1;
      break;
    }
    case "secret": {
      parseKnownArgs("secret", rest);
      printJson(await runSecretCommand());
      break;
    }
    case "version":
    case "--version":
    case "-v":
      printText(toolVersion());
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printText(USAGE);
      break;
    default:
      printError(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
      return;
  }
}

async function runCli(): Promise<void> {
  let runLog;
  try {
    runLog = startRunLog(process.cwd());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const args = process.argv.slice(2);
  recordRunEvent("run_start", { command: args[0] ?? "", args, cwd: process.cwd(), pid: process.pid });
  try {
    runLog.assertWritable();
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordRunEvent("error", { text: message });
    console.error(message);
    process.exitCode = 1;
  } finally {
    process.exitCode = runLog.finish(Number(process.exitCode ?? 0));
  }
}

void runCli();
