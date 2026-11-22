// .env による操作制限（ハーネス）。cwd の .env の KINT_ORIGIN_ALLOW_* で許可した pull / push だけを実行する。
// - 判定元は .env ファイルだけ。プロセス環境変数の KINT_ORIGIN_ALLOW_* は無視する（AI が環境変数で回避できないように）。
// - コマンド層（authorizeCommand）で拒否し、通過した許可を実行時グラントとして記録する。
// - HTTP 層（assertRequestAllowed）と cli-kintone 層（assertCliKintoneAllowed）はグラントだけを見て多重に遮断する。

import fs from "node:fs";

import { ENV_PATH, parseEnvFile } from "./env.js";
import { log } from "./log.js";

export type Permission =
  | "pull:kintone"
  | "pull:records"
  | "pull:bulk-records"
  | "pull:records-all-once"
  | "pull:comments-all-once"
  | "pull:users"
  | "push:app"
  | "push:space"
  | "push:records";

export interface PermissionDef {
  permission: Permission;
  envKey: string;
  defaultAllowed: boolean;
  label: string;
}

export const PERMISSION_DEFS: readonly PermissionDef[] = [
  { permission: "pull:kintone", envKey: "KINT_ORIGIN_ALLOW_PULL_KINTONE", defaultAllowed: true, label: "アプリ設定・スペースの取得" },
  { permission: "pull:records", envKey: "KINT_ORIGIN_ALLOW_PULL_RECORDS", defaultAllowed: false, label: "レコード・添付ファイルの取得" },
  { permission: "pull:bulk-records", envKey: "KINT_ORIGIN_ALLOW_BULK_RECORDS", defaultAllowed: false, label: "複数アプリのレコード・コメント一括取得" },
  { permission: "pull:records-all-once", envKey: "KINT_ORIGIN_ALLOW_PULL_RECORDS_ALL_ONCE", defaultAllowed: false, label: "全アプリのレコード取得（1回限り）" },
  { permission: "pull:comments-all-once", envKey: "KINT_ORIGIN_ALLOW_PULL_COMMENTS_ALL_ONCE", defaultAllowed: false, label: "全アプリのコメント取得（1回限り）" },
  { permission: "pull:users", envKey: "KINT_ORIGIN_ALLOW_PULL_USERS", defaultAllowed: false, label: "共通管理ユーザーの取得（個人情報）" },
  { permission: "push:app", envKey: "KINT_ORIGIN_ALLOW_PUSH_APP", defaultAllowed: false, label: "アプリ設定・customize・新規アプリ作成の反映" },
  { permission: "push:space", envKey: "KINT_ORIGIN_ALLOW_PUSH_SPACE", defaultAllowed: false, label: "スペース設定・本文の反映" },
  { permission: "push:records", envKey: "KINT_ORIGIN_ALLOW_PUSH_RECORDS", defaultAllowed: false, label: "レコードの更新・追加・添付コピー・CSV一括取込" }
];

const ENV_KEY_PREFIX = "KINT_ORIGIN_ALLOW_";
const AI_NOTE = "AI エージェントは .env を変更せず、ユーザーに判断を依頼してください。";

function permissionDef(permission: Permission): PermissionDef {
  const def = PERMISSION_DEFS.find((item) => item.permission === permission);
  if (!def) throw new Error(`操作制限: 未定義の許可です: ${permission}`);
  return def;
}

export interface PolicySetting {
  key: string;
  permission: Permission;
  allowed: boolean;
  source: ".env" | "default";
}

export interface Policy {
  envPath: string;
  envFile: boolean;
  allowed: ReadonlySet<Permission>;
  settings: PolicySetting[];
  warnings: string[];
  errors: string[];
}

// 純関数: .env の値と、警告用のプロセス環境変数から実効ポリシーを作る（テスト用に export）。
export function parsePolicy(
  fileValues: Record<string, string>,
  processEnv: Record<string, string | undefined> = {}
): Pick<Policy, "allowed" | "settings" | "warnings" | "errors"> {
  const allowed = new Set<Permission>();
  const settings: PolicySetting[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const def of PERMISSION_DEFS) {
    const raw = fileValues[def.envKey];
    let value = def.defaultAllowed;
    let source: PolicySetting["source"] = "default";
    if (raw != null && raw.trim() !== "") {
      const normalized = raw.trim().toLowerCase();
      source = ".env";
      if (normalized === "true" || normalized === "false") {
        value = normalized === "true";
      } else {
        // 不正値は fail-closed（許可しない）。呼び出し側は errors があれば全体を中断する。
        value = false;
        errors.push(`${def.envKey} の値「${raw}」は不正です（true / false のみ）。`);
      }
    }
    if (value) allowed.add(def.permission);
    settings.push({ key: def.envKey, permission: def.permission, allowed: value, source });
    const fromProcess = processEnv[def.envKey];
    if (fromProcess != null && fromProcess !== "" && fromProcess !== raw) {
      warnings.push(`環境変数 ${def.envKey} は無視します（操作制限は .env ファイルの値だけを使います）。`);
    }
  }
  const knownKeys = PERMISSION_DEFS.map((def) => def.envKey);
  for (const key of Object.keys(fileValues)) {
    if (key.startsWith(ENV_KEY_PREFIX) && !knownKeys.includes(key)) {
      warnings.push(`.env の ${key} は不明なキーのため無視します（有効: ${knownKeys.join(", ")}）。`);
    }
  }
  return { allowed, settings, warnings, errors };
}

export function readPolicy(envPath: string = ENV_PATH): Policy {
  const envFile = fs.existsSync(envPath);
  const fileValues = envFile ? parseEnvFile(fs.readFileSync(envPath, "utf8")) : {};
  return { envPath, envFile, ...parsePolicy(fileValues, process.env) };
}

function allowedNames(allowed: ReadonlySet<Permission>, kind: "pull" | "push"): string[] {
  return PERMISSION_DEFS.filter((def) => def.permission.startsWith(`${kind}:`) && allowed.has(def.permission)).map((def) =>
    def.permission.slice(kind.length + 1)
  );
}

function describeAllowed(allowed: ReadonlySet<Permission>): string {
  const pull = allowedNames(allowed, "pull");
  const push = allowedNames(allowed, "push");
  return `pull=${pull.length ? pull.join(",") : "なし"} / push=${push.length ? push.join(",") : "なし"}`;
}

function sourceText(policy: Policy): string {
  return policy.envFile ? `.env: ${policy.envPath}` : ".env なし・既定値";
}

// ---- コマンド → 必要な許可 ------------------------------------------------

export type PolicyArgs = Record<string, string | boolean>;
type Requirement = (args: PolicyArgs) => Permission[];

export type PullSub = "index" | "plugins" | "common" | "kintone" | "all" | "app" | "records" | "comments" | "spaces" | "guestspaces" | "tracked-spaces" | "favorite" | "users";
export type PushSub = "app" | "create" | "space" | "records" | "import";
export type DiffSub = "app" | "create" | "space" | "records" | "import" | "rehearsal";
export type ShowSub = "records" | "plugin-source";
export type AppSub = "templates" | "create";
export type CommandGroup = "pull" | "push" | "diff" | "show" | "app";

// サブコマンドの一覧の正本。cli.ts の PULL_COMMANDS / PUSH_COMMANDS はこのキーから導出する
// （サブコマンドを足すときは、ここで必要な許可を必ず割り当てる）。
export const PULL_REQUIREMENTS: Record<PullSub, Requirement> = {
  index: () => ["pull:kintone"],
  plugins: () => ["pull:kintone"],
  common: (args) => (args.from ? [] : ["pull:kintone"]),
  kintone: () => ["pull:kintone"],
  all: () => ["pull:kintone", "pull:users"],
  app: (args) => (args.a ? ["pull:kintone", "pull:records"] : ["pull:kintone"]),
  records: (args) => args["all-indexed"]
    ? ["pull:records", "pull:bulk-records", ...(args["dry-run"] ? [] : (["pull:records-all-once"] as Permission[]))]
    : ["pull:records"],
  comments: (args) => args["all-indexed"]
    ? ["pull:records", "pull:bulk-records", ...(args["dry-run"] ? [] : (["pull:comments-all-once"] as Permission[]))]
    : ["pull:records"],
  spaces: () => ["pull:kintone"],
  guestspaces: () => ["pull:kintone"],
  "tracked-spaces": () => ["pull:kintone"],
  favorite: (args) => args["with-records"] || args["with-comments"]
    ? ["pull:kintone", "pull:records", "pull:bulk-records"]
    : ["pull:kintone"],
  users: () => ["pull:users"]
};

export const PUSH_REQUIREMENTS: Record<PushSub, Requirement> = {
  app: () => ["push:app"],
  create: () => ["push:app"],
  space: () => ["push:space"],
  // レコードの書き込みは、バックアップ用の取得（pull:records）と書き込み（push:records）の両方が要る。
  records: () => ["pull:records", "push:records"],
  // 更新キー付き CSV の取込も push:records に含め、バックアップ用の pull:records も必須にする。
  import: () => ["pull:records", "push:records"]
};

// diff は書き込みなし。app/create/rehearsal はローカルのみ、space/records/import は環境から GET する。
export const DIFF_REQUIREMENTS: Record<DiffSub, Requirement> = {
  app: () => [],
  create: () => [],
  space: () => ["pull:kintone"],
  // ジョブの検証はフォーム定義（kintone）とレコード（records）の GET だけ。
  records: () => ["pull:kintone", "pull:records"],
  import: () => ["pull:kintone", "pull:records"],
  rehearsal: () => []
};

// show は読み取りだけ。プラグインのソース照会はローカル台帳を読むだけで許可は要らない。
export const SHOW_REQUIREMENTS: Record<ShowSub, Requirement> = {
  records: () => ["pull:records"],
  "plugin-source": () => []
};

// app は push/new-apps/ へのローカルのドラフト作成だけ（API・認証値を使わない）。許可は要らない。
// kintone への作成は push:app の許可で行う。
export const APP_REQUIREMENTS: Record<AppSub, Requirement> = {
  templates: () => [],
  create: () => []
};

const REQUIREMENT_TABLES: Record<CommandGroup, Record<string, Requirement>> = {
  pull: PULL_REQUIREMENTS,
  push: PUSH_REQUIREMENTS,
  diff: DIFF_REQUIREMENTS,
  show: SHOW_REQUIREMENTS,
  app: APP_REQUIREMENTS
};

export function requiredPermissions(command: CommandGroup, sub: string, args: PolicyArgs): Permission[] {
  const table = REQUIREMENT_TABLES[command];
  if (!Object.hasOwn(table, sub)) throw new Error(`操作制限: 未登録のサブコマンドです: ${command} ${sub}`);
  return table[sub](args);
}

function commandLabel(command: CommandGroup, sub: string, args: PolicyArgs): string {
  return `${command} ${sub}${command === "pull" && sub === "app" && args.a ? " --a" : ""}`;
}

function denialHint(command: CommandGroup, sub: string, args: PolicyArgs): string {
  if (command === "pull" && sub === "all") return "kintone 部分だけ取得する場合は kint-origin pull kintone を使ってください。";
  if (command === "pull" && sub === "app" && args.a) return "アプリ設定だけ取得する場合は --a を外してください。";
  if (command === "push" && sub === "records") {
    return "反映内容の確認だけなら kint-origin diff records --name <ジョブ名> で行えます（KINT_ORIGIN_ALLOW_PULL_RECORDS の許可で動きます）。";
  }
  if (command === "push" && sub === "import") {
    return "反映内容の確認だけなら kint-origin diff import --name <ジョブ名> で行えます（KINT_ORIGIN_ALLOW_PULL_RECORDS の許可で動きます）。";
  }
  if (command === "push" && sub === "space") {
    return "反映内容の確認だけなら kint-origin diff space --id <spaceId> で行えます（push の許可は不要）。";
  }
  if (command === "push") {
    return `反映内容の確認だけなら ${sub === "create" ? "kint-origin diff create" : "kint-origin diff app --id <appId>"} で行えます（push の許可は不要）。`;
  }
  return "";
}

function buildDenialMessage(
  command: CommandGroup,
  sub: string,
  args: PolicyArgs,
  missing: Permission[],
  policy: Policy
): string {
  const lines = [
    `操作制限: ${commandLabel(command, sub, args)} は .env で許可されていません。`,
    ...missing.map((permission) => {
      const def = permissionDef(permission);
      return `  必要な設定: ${def.envKey}=true（${def.label}）`;
    }),
    `  現在の許可: ${describeAllowed(policy.allowed)}（${sourceText(policy)}）`
  ];
  const hint = denialHint(command, sub, args);
  if (hint) lines.push(hint);
  lines.push(`許可する場合は、ユーザーが .env に上記の設定を追記してください。${AI_NOTE}`);
  return lines.join("\n");
}

function buildInvalidPolicyMessage(policy: Policy): string {
  return [
    "操作制限: .env の設定が不正なため中断しました。",
    ...policy.errors.map((error) => `  - ${error}`),
    `.env を修正してください（${sourceText(policy)}）。${AI_NOTE}`
  ].join("\n");
}

// ---- 実行時グラント ----------------------------------------------------------

let activeGrants: ReadonlySet<Permission> = new Set();

// テストからも使う。CLI では authorizeCommand だけが呼ぶ。
export function activateGrants(permissions: Iterable<Permission>): void {
  activeGrants = new Set(permissions);
}

// pull / push / diff の実行前に呼ぶ。不足があれば throw し、通過したら必要な許可だけをグラントする。
export function authorizeCommand(
  command: CommandGroup,
  sub: string,
  args: PolicyArgs,
  policy: Policy = readPolicy()
): Permission[] {
  for (const warning of policy.warnings) log(`警告: ${warning}`);
  if (policy.errors.length > 0) throw new Error(buildInvalidPolicyMessage(policy));
  const required = requiredPermissions(command, sub, args);
  const missing = required.filter((permission) => !policy.allowed.has(permission));
  if (missing.length > 0) throw new Error(buildDenialMessage(command, sub, args, missing, policy));
  activateGrants(required);
  return required;
}

// ---- HTTP 層 ------------------------------------------------------------------

// レコード本体・添付の API（guest パス・preview 接頭辞を含む。guest ID の形式は問わず fail-closed）。
// レコードのアクセス権設定 /k/v1/record/acl.json はアプリ設定 API なので除く（records/acl/evaluate.json は対象のまま）。
const RECORD_API_RE = /^\/k\/(?:guest\/[^/]+\/)?v1\/(?:preview\/)?(?!record\/acl\.json$)(?:records?|file)(?:\/[\w/]+)?\.json$/;

export interface RequestRule {
  anyOf: Permission[];
  label: string;
}

// 一括処理 API（bulkRequest）。レコードの書き込みを束ねるため、レコード API と同じ扱いにする。
const BULK_API_RE = /^\/k\/(?:guest\/[^/]+\/)?v1\/bulkRequest\.json$/;

// スペースの設定・本文・スレッドの書き込み API（guest パスを含む）。
const SPACE_WRITE_API_RE = /^\/k\/(?:guest\/[^/]+\/)?v1\/space(?:\/(?:body|thread))?\.json$/;

export function classifyRequest(method: string, pathname: string): RequestRule | null {
  if (method.toUpperCase() !== "GET") {
    // レコード・添付・一括処理への書き込みは push:records だけ。push app の許可ではレコードに書けない。
    // アプリ設定の書き込み（下の分岐）は push:records では通さない。
    if (RECORD_API_RE.test(pathname) || BULK_API_RE.test(pathname)) return { anyOf: ["push:records"], label: "レコードの書き込み" };
    if (SPACE_WRITE_API_RE.test(pathname)) return { anyOf: ["push:space"], label: "スペースの書き込み" };
    return { anyOf: ["push:app"], label: "書き込み（GET 以外）" };
  }
  if (pathname.startsWith("/v1/")) return { anyOf: ["pull:users"], label: "共通管理（User API）" };
  if (RECORD_API_RE.test(pathname)) return { anyOf: ["pull:records"], label: "レコード・添付" };
  if (/^\/k\/v1\/plugins(?:\/required)?\.json$/.test(pathname)) return { anyOf: ["pull:kintone"], label: "プラグイン一覧の取得" };
  return null;
}

export function assertRequestAllowed(method: string, pathname: string, requiredPermission?: Permission): void {
  if (requiredPermission) {
    if (!activeGrants.has(requiredPermission)) {
      throw new Error(
        `操作制限: この実行で許可されていない API 呼び出しを遮断しました（${method.toUpperCase()} ${pathname}・${requiredPermission}）。`
      );
    }
    return;
  }
  const rule = classifyRequest(method, pathname);
  if (!rule || rule.anyOf.some((permission) => activeGrants.has(permission))) return;
  throw new Error(
    `操作制限: この実行で許可されていない API 呼び出しを遮断しました（${method.toUpperCase()} ${pathname}・${rule.label}）。` +
      "コマンドの許可判定と実際の API が食い違っています（ツールの不具合の可能性があります）。"
  );
}

// ---- cli-kintone 層 -------------------------------------------------------------

// 子プロセスで許可する cli-kintone 操作（未登録は fail-closed で拒否）。null は追加の許可不要。
const CLI_KINTONE_RULES: Record<string, Permission | null> = {
  "customize init": null,
  "customize export": null,
  "record export": "pull:records"
};

export function assertCliKintoneAllowed(args: string[]): void {
  const operation = args.slice(0, 2).join(" ");
  if (!Object.hasOwn(CLI_KINTONE_RULES, operation)) {
    throw new Error(`操作制限: 未登録の cli-kintone 操作のため実行しません（${operation}）。`);
  }
  const permission = CLI_KINTONE_RULES[operation];
  if (permission && !activeGrants.has(permission)) {
    throw new Error(
      `操作制限: この実行で許可されていない cli-kintone 操作を遮断しました（${operation}）。コマンドの許可判定と実際の操作が食い違っています（ツールの不具合の可能性があります）。`
    );
  }
}

// ---- policy コマンド ------------------------------------------------------------

export function policySummary(policy: Policy) {
  return {
    envPath: policy.envPath,
    envFile: policy.envFile,
    allowed: { pull: allowedNames(policy.allowed, "pull"), push: allowedNames(policy.allowed, "push") },
    settings: policy.settings.map(({ key, allowed, source }) => ({ key, value: allowed, source })),
    warnings: policy.warnings,
    errors: policy.errors
  };
}
