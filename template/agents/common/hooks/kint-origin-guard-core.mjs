// Shared guard policy, distributed to .agents/hooks/. No stdin/stdout or process exit.
// Generated from the kint-origin template. Update with kint-origin update.

import fs from "node:fs";
import path from "node:path";

// .env（認証情報と操作制限 KINT_ORIGIN_ALLOW_*）はユーザー管理。.env.example だけは雛形として除外する。
function isProtectedEnvName(name) {
  const lower = String(name).toLowerCase();
  return lower === ".env" || (lower.startsWith(".env.") && lower !== ".env.example");
}
// コマンド文字列中の .env / .env.xxx の参照（空白・引用符・=・括弧・パス区切りの直後を拾う）。
const ENV_REF_RE = /(?:^|[\s"'`=(\/\\])(\.env(?:\.[\w.-]+)?)(?=$|[\s"'`;|&)>,])/gi;
// .env を書き換え得る操作（リダイレクト、PowerShell の書き込み系とエイリアス、Unix の cp/mv/rm/tee/sed 等）。
const ENV_WRITE_RE =
  /[>]|\b(?:set-content|add-content|out-file|new-item|copy-item|move-item|rename-item|remove-item|clear-content|sc|ac|ni|cpi|mi|ri|rni|del|erase|cp|mv|rm|tee|sed|truncate)\b/i;
const ENV_DENY_REASON =
  ".env（認証情報と操作制限 KINT_ORIGIN_ALLOW_*）はユーザーが管理するファイルです。AI は作成・変更・削除しないでください。許可の変更が必要なら、必要な設定行をユーザーに伝えて追記を依頼してください。";

function referencesProtectedEnv(command) {
  for (const match of command.matchAll(ENV_REF_RE)) {
    if (isProtectedEnvName(match[1])) return true;
  }
  return false;
}

// data/.../app-<id>/ と data/kintone/spaces/(space|guestspace)-<id>/ のうち push の対象になる設定ファイル。
// 通常アプリ・スペース・ゲストスペースのどの配置でも一致させる。Windows のパスは大文字小文字を区別しないため i フラグを付ける。
const APP_DIR = "(?:^|/)data/kintone/(?:apps|spaces/(?:space|guestspace)-[^/]+/apps)/app-[^/]+";
const SPACE_DIR = "(?:^|/)data/kintone/spaces/(?:space|guestspace)-[^/]+";
// プラグインの台帳とソースは利用者が管理する。
const PLUGIN_DIR_RE = /(?:^|\/)data\/kintone\/plugin\/.+/i;
const INSTALLED_PLUGINS_RE = /(?:^|\/)data\/kintone\/plugin\/installed\.json$/i;
const PUSH_TARGET_RE = new RegExp(
  "(?:" +
    APP_DIR +
    "/(?:" +
    [
      "form/(?:fields|layout)\\.json",
      "views/views\\.json",
      "reports/reports\\.json",
      "app_settings/(?:settings|status|app_actions)\\.json",
      "notifications/notifications_(?:general|perRecord|reminder)\\.json",
      "acl/(?:app|record|field)_acl\\.json",
      "customize/customize-manifest\\.json",
      "customize/(?:desktop|mobile)/(?:js|css)/.+"
    ].join("|") +
    ")" +
    "|" +
    SPACE_DIR +
    "/(?:settings\\.json|body\\.html)" +
    ")$",
  "i"
);
// AI 作業領域は、各アプリまたは各スペース直下の _agentdata/ だけ。
const AGENT_DATA_RE = new RegExp("(?:" + APP_DIR + "|" + SPACE_DIR + ")/_agentdata(?:/|$)", "i");
// push/records/<ジョブ名>/runs/ と push/import/<ジョブ名>/runs/ は kint-origin が書く実行記録（プレビュー・バックアップ・結果。顧客データを含む）。AI は編集・作成しない。
const RECORDS_RUNS_RE = /(?:^|\/)push\/(?:records|import)\/[^/]+\/runs(?:\/|$)/i;
// コマンドの連結（; & | 改行 バッククォート $(）。PowerShell の呼び出し演算子（先頭の &）とリダイレクト（2>&1）は連結とみなさない。
const CHAIN_RE = /[;&|\r\n`]|\$\(/;
function isChained(command) {
  return CHAIN_RE.test(command.replace(/^\s*&\s+/, "").replace(/\d*>&\d*/g, ""));
}

// data/ 配下（kint-origin の取得物・作業コピー）か。
// - プロジェクトルートからの相対パスが data/ で始まる
// - ルートを特定できない絶対パスでも、kint-origin の取得物の配置（data/kintone/・data/cybozu-common/）を含む
// パスのどこかに data/ があるだけ（.claude/skills/<名前>/data/…・temp/<案件>/data/… など利用者の独自の置き場）は、data/ とみなさない。
function isInDataDir(normalized) {
  if (/^data\//i.test(normalized)) return true;
  return /\/data\/(?:kintone|cybozu-common)\//i.test(normalized);
}

// ガード自身・権限設定・AI ツールの設定の編集（AI が自分の保護を外せないようにする）。
const PROTECTION_PATH_RE = /(?:^|\/)(?:\.agents\/hooks\/|\.claude\/(?:hooks\/|settings(?:\.local)?\.json$)|\.cursor\/(?:hooks\/|hooks\.json$)|\.codex\/(?:rules\/|hooks\/|hooks\.json$)|\.mcp\.json$)/i;

// ドメイン独自のスキル・ルールの名前（kint-origin-local-）。新しく作るときだけ判定し、
// 既存のフォルダ・ファイル（配布物・addon のリンク・既存の独自スキル）の編集は通す。
const LOCAL_PREFIX = "kint-origin-local-";
const LOCAL_ENTRY_RE = /^\.(?:claude|agents|cursor)\/(?:skills|rules)\/([^/]+)/i;
export function namingViolation(rel, root) {
  const normalized = path.posix.normalize(String(rel).replaceAll("\\", "/"));
  const match = LOCAL_ENTRY_RE.exec(normalized);
  if (!match) return "";
  if (match[1].startsWith(LOCAL_PREFIX)) return "";
  if (root && fs.existsSync(path.join(root, match[0]))) return "";
  return match[0];
}
export function namingReason(target) {
  return (
    "このドメイン独自のスキル・ルールは、名前を kint-origin-local-<名前>（英小文字・数字・ハイフン）にしてください（対象: " + target + "）。" +
    "スキルは .claude/skills/kint-origin-local-<名前>/SKILL.md と .agents/skills/kint-origin-local-<名前>/SKILL.md の両方に置き、SKILL.md の name をフォルダ名と同じにします。" +
    "ルールは .claude/rules/kint-origin-local-<名前>.md（Cursor は .cursor/rules/kint-origin-local-<名前>.mdc）です。" +
    "kint-origin-<名前> は配布物、kint-origin-addon-* は外部addon用の予約です。手順は kint-origin-extend スキルを参照してください。"
  );
}

// push の呼び出し（kint-origin 本体のほか、node <dist>/cli.js push・kint-origin.exe・npx kint-origin も拾う）。
const PUSH_INVOCATION_RE = /(?:kint-origin(?:\.cmd|\.ps1|\.exe)?|(?:^|[\s"'\/\\])cli\.js)["']?\s+["']?push\b/i;

// update -y（確認なしで、CLAUDE.md・AGENTS.md・.claude/settings.json などの保護設定を含む配布ファイルを上書きする）。
const UPDATE_YES_RE = /(?:kint-origin(?:\.cmd|\.ps1|\.exe)?|(?:^|[\s"'\/\\])cli\.js)["']?\s+["']?update\b[^;&|\r\n]*\s(?:-y|--yes)\b/i;

// .env の読み取り（認証情報をモデルの文脈に入れない）。書き込みは別の判定で deny する。
// Read ツールでの読み取りは、この hook ではなく settings.json の permissions.deny（Read(**/.env) など）で止める。
const ENV_READ_RE = /\b(?:cat|type|more|less|head|tail|bat|get-content|gc|select-string|sls|findstr|grep|rg|awk|sed|strings|xxd|od)\b/i;
const ENV_READ_REASON =
  ".env には認証情報（パスワード）が含まれます。AI は内容を読み取らないでください。操作制限の実効値は kint-origin policy で確認できます（認証値は表示されません）。";

// Windows のパス（C:\…・/c:/…）を / 区切りにそろえる。
export function toPosix(p) {
  return String(p ?? "").replaceAll("\\", "/").replace(/^\/([a-zA-Z]:\/)/, "$1");
}
// file が root の中なら root からの相対パスに、外なら元のパスのまま返す。
export function relativeTo(file, root) {
  const f = toPosix(file);
  const r = toPosix(root).replace(/\/+$/, "");
  return r && f.toLowerCase().startsWith(r.toLowerCase() + "/") ? f.slice(r.length + 1) : f;
}

// A null result delegates to the host's normal permission evaluation.
function verdict(decision, kind, reason) {
  return { decision, kind, reason };
}

// Host policy stays explicit: Claude asks and checks env/chaining; Cursor denies.
export function evaluateCommand(command, { pushDecision, updateYesDecision, protectEnv = false, denyChainedPush = false }) {
  if (protectEnv && referencesProtectedEnv(command) && ENV_WRITE_RE.test(command)) return verdict("deny", "env-write", ENV_DENY_REASON);
  if (protectEnv && referencesProtectedEnv(command) && ENV_READ_RE.test(command)) return verdict("deny", "env-read", ENV_READ_REASON);
  // パス付き・引用符付きの呼び出し（"...\kint-origin.cmd" push、kint-origin "push"、node dist/cli.js push 等）も拾う。
  if (UPDATE_YES_RE.test(command)) {
    return verdict(
      updateYesDecision,
      "update",
      "kint-origin update -y は、確認なしで CLAUDE.md・AGENTS.md・.claude/settings.json・hook などの配布ファイルを上書きします（独自の編集は失われます）。" +
        "-y を付けずにユーザーのターミナルで実行すると、上書きされるファイルの一覧を見て y/N で確認できます。内容を承認する場合だけ許可してください。"
    );
  }
  if (PUSH_INVOCATION_RE.test(command)) {
    if (denyChainedPush && isChained(command)) {
      return verdict(
        "deny",
        "chained-push",
        "kint-origin push は他のコマンドと連結せず、単体の 1 行で実行してください（承認ダイアログで実行内容が分かるようにするため）。"
      );
    }
    return verdict(
      pushDecision,
      "push",
      "kintone 環境へ反映する push コマンドです。対象・kint-origin diff の結果・反映の影響・復旧方法・実行コマンドを確認し、その内容で反映してよければ許可してください。-y 付きは CLI の y/N 確認を省略します。"
    );
  }
  return null;
}

// Full file protection is only used by Claude. Cursor/Codex call namingViolation.
export function evaluateWritePath(rawPath, root) {
  if (!rawPath) return null;
  const cwd = String(root).replaceAll("\\", "/").replace(/\/+$/, "");
  let normalized = rawPath.replaceAll("\\", "/");
  // 絶対パスならプロジェクトルート（cwd）からの相対に直してから判定する。
  if (cwd && normalized.toLowerCase().startsWith(`${cwd.toLowerCase()}/`)) {
    normalized = normalized.slice(cwd.length + 1);
  }
  const baseName = normalized.split("/").pop() || "";
  if (isProtectedEnvName(baseName)) return verdict("deny", "env-write", ENV_DENY_REASON);
  if (PROTECTION_PATH_RE.test(normalized)) {
    return verdict(
      "ask",
      "protection",
      "kint-origin の保護（hook・権限設定・AI ツールの設定）に関わるファイルです。AI が自分の保護を変えないよう、ユーザーが内容を確認して許可してください: " + normalized
    );
  }
  if (RECORDS_RUNS_RE.test(normalized)) {
    return verdict(
      "deny",
      "write",
      "push/records/<ジョブ名>/runs/ と push/import/<ジョブ名>/runs/ は kint-origin が書く実行記録（プレビュー・バックアップ・結果。顧客データを含む）です。AI は編集・作成しないでください。" +
        "ジョブの入力は push/records/<ジョブ名>/job.csv（取込は push/import/<ジョブ名>/import.json と records.csv）に書き、復旧は kint-origin push records --restore（取込は push import --restore）で行います。"
    );
  }
  const inData = isInDataDir(normalized);
  const inAgentData = AGENT_DATA_RE.test(normalized);
  if (inData && INSTALLED_PLUGINS_RE.test(normalized)) {
    return verdict("deny", "write", "data/kintone/plugin/installed.json は pull index が取得するプラグイン一覧です。手作業で変更せず、kint-origin pull index で更新してください。");
  }
  // `..` で許可範囲（push 対象・_agentdata）の外へ抜けるパスは許可しない。
  const hasParentSegment = /(^|\/)\.\.(\/|$)/.test(normalized);
  if (inData && (hasParentSegment || (!inAgentData && !PUSH_TARGET_RE.test(normalized) && !PLUGIN_DIR_RE.test(normalized)))) {
    return verdict(
      "deny",
      "write",
      "data/ で編集できるのは push 対象の設定ファイル（form/fields.json・form/layout.json・views/views.json・reports/reports.json・app_settings/・notifications/・acl/・customize/ のマニフェストと JS/CSS、スペースの settings.json・body.html）だけです。" +
        "records/・index/・app.json・space.json・apps.json・form/form.json・plugins.json・customize.json・plugin-configs/・.kint-origin-pull.json などの取得物は書き換えないでください。" +
        "プラグインのソース参照台帳とソースは data/kintone/plugin/ に置けます。installed.json は pull index が取得するため編集しないでください。その他の作業ファイルは data/.../app-<id>/_agentdata/（スペースは spaces/<space>/_agentdata/）または %TEMP% に置いてください。"
    );
  }
  const namingTarget = namingViolation(normalized, cwd);
  if (namingTarget) return verdict("deny", "naming", namingReason(namingTarget));
  return null;
}
