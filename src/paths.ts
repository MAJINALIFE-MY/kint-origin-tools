import path from "node:path";

// data/ は cwd（対象ドメインのフォルダ）基準。
const DATA_ROOT = path.resolve(process.cwd(), "data");
export const KINTONE_DATA_ROOT = path.join(DATA_ROOT, "kintone");
export const CYBOZU_COMMON_DATA_ROOT = path.join(DATA_ROOT, "cybozu-common");

// ディレクトリ名に使う ID は数字だけ。`..` や区切り文字を含む値で data/ の外へ書き出さないための最後の砦
// （入力の検証は cli.ts の parseKnownArgs が先に行う）。
function assertDirId(label: string, value: string | number): string {
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new Error(`${label} は数字だけで指定してください: ${JSON.stringify(text)}`);
  }
  return text;
}

export function getSpaceDirName({ guestSpaceId, spaceId }: { guestSpaceId?: string; spaceId?: string }): string {
  if (guestSpaceId) return `guestspace-${assertDirId("ゲストスペース ID", guestSpaceId)}`;
  if (spaceId) return `space-${assertDirId("スペース ID", spaceId)}`;
  throw new Error("Space id is required");
}

export function getAppDirName(appId: string | number): string {
  return `app-${assertDirId("アプリ ID", appId)}`;
}

export function kintoneAppsRootPath(): string {
  return path.join(KINTONE_DATA_ROOT, "apps");
}

export function kintoneSpacesRootPath(): string {
  return path.join(KINTONE_DATA_ROOT, "spaces");
}

function kintoneDeletedRootPath(): string {
  return path.join(KINTONE_DATA_ROOT, "deleted");
}

export function kintoneDeletedAppsRootPath(): string {
  return path.join(kintoneDeletedRootPath(), "apps");
}

export function kintoneDeletedSpacesRootPath(): string {
  return path.join(kintoneDeletedRootPath(), "spaces");
}

export function kintoneCommonRootPath(): string {
  return path.join(KINTONE_DATA_ROOT, "common");
}

export function kintoneSpaceRootPath(args: { guestSpaceId?: string; spaceId?: string }): string {
  return path.join(kintoneSpacesRootPath(), getSpaceDirName(args));
}

export function kintoneAppRootPath({
  guestSpaceId = "",
  spaceId = "",
  appId
}: {
  guestSpaceId?: string;
  spaceId?: string;
  appId: string | number;
}): string {
  if (guestSpaceId || spaceId) {
    return path.join(kintoneSpaceRootPath({ guestSpaceId, spaceId }), "apps", getAppDirName(appId));
  }
  return path.join(kintoneAppsRootPath(), getAppDirName(appId));
}

export function cybozuCommonRootPath(): string {
  return CYBOZU_COMMON_DATA_ROOT;
}

// _agentdata はアプリ・スペースディレクトリ内の AI 作業領域。pull は一切書き込まない（保護対象）。
export const AGENT_DATA_DIR = "_agentdata";

function agentDataPath(targetDir: string): string {
  return path.join(targetDir, AGENT_DATA_DIR);
}

// push space 等の実行前バックアップ先（_agentdata/backup/）。
export function pushBackupRootPath(targetDir: string): string {
  return path.join(agentDataPath(targetDir), "backup");
}

// 新規アプリドラフトの置き場（cwd 基準。data/ の「取得物のみ」原則を守るため data/ 外）。
export function pushNewAppsRootPath(): string {
  return path.resolve(process.cwd(), "push", "new-apps");
}

// ドメイン独自の kintone アプリテンプレート zip の置き場（cwd 基準。`app create --template` の入力。update は上書きしない）。
export function pushAppTemplatesRootPath(): string {
  return path.resolve(process.cwd(), "push", "app-templates");
}

// レコード操作ジョブの置き場（cwd 基準。data/ の「取得物のみ」原則を守るため data/ 外）。
export function pushRecordsRootPath(): string {
  return path.resolve(process.cwd(), "push", "records");
}

// 更新キー付き CSV 取込ジョブの置き場（cwd 基準。data/ の「取得物のみ」原則を守るため data/ 外）。
export function pushImportRootPath(): string {
  return path.resolve(process.cwd(), "push", "import");
}

// お気に入り（監視グループ）定義の置き場（cwd 基準。data/ の「取得物のみ」原則を守るため data/ 外。ユーザー/AI が編集する）。
export function favoritesRootPath(): string {
  return path.resolve(process.cwd(), "favorites");
}

// kint-origin html の出力先（cwd 基準。data/ の兄弟。ツール専有＝実行のたび全再生成）。
export function htmlRootPath(): string {
  return path.resolve(process.cwd(), "html");
}
