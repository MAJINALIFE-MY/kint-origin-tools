// スペース（data/kintone/spaces/(space|guestspace)-<id>/）の diff と push。
// - settings.json → PUT /k/(guest/<id>/)?v1/space.json
// - body.html → マルチスレッド（useMultiThread: true）は PUT /k/(guest/<id>/)?v1/space/body.json、
//               シングルスレッド（useMultiThread: false）は PUT /k/(guest/<id>/)?v1/space/thread.json（defaultThread 宛）
// - スペースには動作テスト環境（preview）が無いため、事前バックアップを保存したうえで運用環境へ即時反映し、
//   直後に GET /space.json で取り直して kintone の HTML サニタイズ差分（sanitized）を検出・同期する。

import fs from "node:fs";
import path from "node:path";

import { confirmYes } from "../confirm.js";
import { ensureDir, parseJsonText, writeJson, writeText } from "../fsutil.js";
import { log } from "../log.js";
import { canonicalJson } from "../normalize.js";
import { kintoneSpaceRootPath, pushBackupRootPath } from "../paths.js";
import { isGuestSpaceRequiredError, KintoneClient, type KintoneSpace } from "./client.js";
import { classify, hashJson, hashLocalJson, readPullState, type FileState } from "./pullState.js";
import { isErrorStub } from "./pushItems.js";
import { assertConfirmable, backupTimestamp, buildRecoveryPlanText, type SkippedResource } from "./push.js";
import {
  SPACE_SETTINGS_KEYS,
  formatSpaceBodyFile,
  hashLocalSpaceBody,
  hashSpaceBody,
  normalizeSpaceBody,
  serializeSpaceSettings,
  writeSpaceExport,
  type SpaceSettingKey
} from "./serializers.js";
import { describeConnection, isOtherTenant, otherTenantMessage } from "./tenant.js";

const SPACE_PUSH_KEYS = ["settings", "body"] as const;
export type SpacePushKey = (typeof SPACE_PUSH_KEYS)[number];

export type SpaceResourceState = FileState | "skipped";

export interface SpaceDiffResource {
  key: SpacePushKey;
  file: "settings.json" | "body.html";
  state: SpaceResourceState;
  reason?: string;
  changedKeys?: SpaceSettingKey[];
}

export interface SpaceDiffSummary {
  spaceId: string;
  guestSpaceId: string;
  name: string;
  spaceDir: string;
  useMultiThread: boolean;
  pullState: boolean;
  resources: SpaceDiffResource[];
}

export interface PushSpaceSummary {
  spaceId: string;
  guestSpaceId: string;
  name: string;
  spaceDir: string;
  backupDir?: string;
  applied: boolean;
  pushed: Array<{ key: SpacePushKey; method: "PUT"; endpoint: string }>;
  skipped: SkippedResource[];
  /** body を反映したとき、kintone の保存時サニタイズで送信 HTML から変化したか */
  sanitized?: boolean;
  /** 反映は完了したが、直後の再取得に失敗したときのメッセージ */
  verifyError?: string;
  aborted?: boolean;
}

export function validateSpaceOnlyKeys(only: string[] | undefined): void {
  if (!only) return;
  const unknown = only.filter((key) => !(SPACE_PUSH_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new Error(`--only に不明なキーがあります: ${unknown.join(", ")}（有効: ${SPACE_PUSH_KEYS.join(", ")}）`);
  }
}

function resolveSpaceTarget({
  spaceId = "",
  guestSpaceId = ""
}: {
  spaceId?: string;
  guestSpaceId?: string;
}): { id: string; guestSpaceId: string; spaceDir: string } {
  if (guestSpaceId) {
    if (spaceId && String(spaceId) !== String(guestSpaceId)) {
      throw new Error(
        `--id (${spaceId}) と --guestspace (${guestSpaceId}) が一致しません。ゲストスペースは --id <id> --guestspace <id> または --guestspace <id> で指定してください。`
      );
    }
    const id = String(guestSpaceId);
    return { id, guestSpaceId: id, spaceDir: kintoneSpaceRootPath({ guestSpaceId: id }) };
  }
  const id = String(spaceId);
  const normalDir = kintoneSpaceRootPath({ spaceId: id });
  const guestDir = kintoneSpaceRootPath({ guestSpaceId: id });
  if (!fs.existsSync(normalDir) && fs.existsSync(guestDir)) {
    return { id, guestSpaceId: id, spaceDir: guestDir };
  }
  return { id, guestSpaceId: "", spaceDir: normalDir };
}

function assertSpacePulled(spaceDir: string, id: string, guestSpaceId: string): void {
  if (!fs.existsSync(path.join(spaceDir, "space.json"))) {
    const pullCmd = guestSpaceId ? `kint-origin pull guestspaces --id ${id}` : `kint-origin pull spaces --id ${id}`;
    throw new Error(`スペースが未取得です: ${spaceDir}\n先に ${pullCmd} を実行してください。`);
  }
}

const BOOLEAN_SPACE_KEYS = [
  "isPrivate",
  "fixedMember",
  "useMultiThread",
  "showAnnouncement",
  "showThreadList",
  "showAppList",
  "showMemberList",
  "showRelatedLinkList"
] as const;

const PORTAL_VISIBILITY_KEYS = [
  "showAnnouncement",
  "showThreadList",
  "showAppList",
  "showMemberList",
  "showRelatedLinkList"
] as const;

export function validateAndBuildSpaceSettingsPayload(
  raw: unknown,
  remote: KintoneSpace,
  { spaceId, isGuest = false }: { spaceId: string; isGuest?: boolean }
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || isErrorStub(raw)) {
    throw new Error("settings.json は JSON オブジェクトで指定してください。");
  }
  const obj = raw as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((key) => !(SPACE_SETTINGS_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new Error(`settings.json に不明なキーがあります: ${unknown.join(", ")}（有効: ${SPACE_SETTINGS_KEYS.join(", ")}）`);
  }
  if (typeof obj.name !== "string" || obj.name.trim() === "" || obj.name.length > 128) {
    throw new Error("settings.json の name は 1〜128 文字の文字列を指定してください。");
  }
  for (const key of BOOLEAN_SPACE_KEYS) {
    if (key in obj && typeof obj[key] !== "boolean") {
      throw new Error(`settings.json の ${key} は true / false で指定してください。`);
    }
  }
  if ("permissions" in obj && obj.permissions !== null) {
    const perms = obj.permissions;
    if (
      !perms ||
      typeof perms !== "object" ||
      Array.isArray(perms) ||
      Object.keys(perms).some((k) => k !== "createApp") ||
      !["EVERYONE", "ADMIN"].includes(String((perms as any).createApp))
    ) {
      throw new Error('settings.json の permissions.createApp は "EVERYONE" または "ADMIN" を指定してください。');
    }
  }

  const remoteSettings = serializeSpaceSettings(remote);
  const nextMultiThread = typeof obj.useMultiThread === "boolean" ? obj.useMultiThread : remoteSettings.useMultiThread;

  if (remoteSettings.useMultiThread && nextMultiThread === false) {
    throw new Error("useMultiThread は true（マルチスレッド）から false（シングルスレッド）へ戻せません（kintone の仕様制限）。");
  }
  if (isGuest) {
    if (obj.isPrivate === false && remoteSettings.isPrivate !== false) {
      throw new Error("ゲストスペースは公開（isPrivate: false）に変更できません（kintone の仕様制限）。");
    }
    if (typeof obj.useMultiThread === "boolean" && obj.useMultiThread !== remoteSettings.useMultiThread) {
      throw new Error("ゲストスペースでは useMultiThread を変更できません。");
    }
  }
  if (!nextMultiThread) {
    for (const key of PORTAL_VISIBILITY_KEYS) {
      if (typeof obj[key] === "boolean" && obj[key] !== remoteSettings[key]) {
        throw new Error(`シングルスレッドのスペース（useMultiThread: false）ではポータル表示項目（${key}）を変更できません。`);
      }
    }
  }

  const payload: Record<string, unknown> = {
    id: String(spaceId),
    name: obj.name
  };
  if (typeof obj.isPrivate === "boolean") payload.isPrivate = obj.isPrivate;
  if (typeof obj.fixedMember === "boolean") payload.fixedMember = obj.fixedMember;
  if (!isGuest && nextMultiThread && typeof obj.useMultiThread === "boolean") payload.useMultiThread = obj.useMultiThread;
  if (nextMultiThread) {
    for (const key of PORTAL_VISIBILITY_KEYS) {
      if (typeof obj[key] === "boolean") payload[key] = obj[key];
    }
  }
  if (obj.permissions && typeof obj.permissions === "object") {
    payload.permissions = { createApp: String((obj.permissions as any).createApp) };
  }
  return payload;
}

interface SpaceInspection {
  diff: SpaceDiffSummary;
  remoteSpace: KintoneSpace;
  localSettingsRaw?: unknown;
  localBodyRaw?: string;
}

async function fetchRemoteSpace(client: KintoneClient, id: string, guestSpaceId: string): Promise<KintoneSpace> {
  try {
    return await client.getSpace(id, { guestSpaceId });
  } catch (error) {
    if (!guestSpaceId && isGuestSpaceRequiredError(error)) {
      throw new Error(
        [
          `スペース ${id} はゲストスペースです。--guestspace を指定して再実行してください。`,
          `  例: kint-origin diff space --id ${id} --guestspace ${id}`
        ].join("\n")
      );
    }
    throw error;
  }
}

async function inspectSpace({
  client,
  id,
  guestSpaceId,
  spaceDir
}: {
  client: KintoneClient;
  id: string;
  guestSpaceId: string;
  spaceDir: string;
}): Promise<SpaceInspection> {
  const remoteSpace = await fetchRemoteSpace(client, id, guestSpaceId);
  const state = readPullState(spaceDir);
  const remoteSettings = serializeSpaceSettings(remoteSpace);
  const remoteSettingsHash = hashJson(remoteSettings);
  const remoteBodyHash = hashSpaceBody(remoteSpace.body);

  const resources: SpaceDiffResource[] = [];
  let localSettingsRaw: unknown;
  let localBodyRaw: string | undefined;

  const settingsFile = path.join(spaceDir, "settings.json");
  if (!fs.existsSync(settingsFile)) {
    resources.push({
      key: "settings",
      file: "settings.json",
      state: "skipped",
      reason: "ローカルにファイルがありません（settings.json）"
    });
  } else {
    const text = fs.readFileSync(settingsFile, "utf8");
    try {
      localSettingsRaw = parseJsonText(text, settingsFile);
    } catch (error) {
      throw new Error(`settings.json の JSON パースに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isErrorStub(localSettingsRaw)) {
      resources.push({
        key: "settings",
        file: "settings.json",
        state: "skipped",
        reason: "pull 失敗時のスタブ（_error）のため対象外です"
      });
    } else {
      const localHash = hashLocalJson(settingsFile);
      const fileState = classify({ base: state?.files["settings.json"], local: localHash, remote: remoteSettingsHash });
      const changedKeys: SpaceSettingKey[] = [];
      if (localSettingsRaw && typeof localSettingsRaw === "object" && !Array.isArray(localSettingsRaw)) {
        const localObj = localSettingsRaw as Record<string, unknown>;
        for (const key of SPACE_SETTINGS_KEYS) {
          if (key in localObj && canonicalJson(localObj[key]) !== canonicalJson(remoteSettings[key])) {
            changedKeys.push(key);
          }
        }
      }
      resources.push({
        key: "settings",
        file: "settings.json",
        state: fileState,
        ...(changedKeys.length ? { changedKeys } : {})
      });
    }
  }

  const bodyFile = path.join(spaceDir, "body.html");
  if (!fs.existsSync(bodyFile)) {
    resources.push({
      key: "body",
      file: "body.html",
      state: "skipped",
      reason: "ローカルにファイルがありません（body.html）"
    });
  } else {
    localBodyRaw = fs.readFileSync(bodyFile, "utf8");
    const localHash = hashLocalSpaceBody(bodyFile);
    const fileState = classify({ base: state?.files["body.html"], local: localHash, remote: remoteBodyHash });
    resources.push({
      key: "body",
      file: "body.html",
      state: fileState
    });
  }

  const diff: SpaceDiffSummary = {
    spaceId: id,
    guestSpaceId,
    name: remoteSpace.name || "",
    spaceDir,
    useMultiThread: Boolean(remoteSpace.useMultiThread),
    pullState: Boolean(state),
    resources
  };

  return { diff, remoteSpace, localSettingsRaw, localBodyRaw };
}

function describeSpaceDiff(diff: SpaceDiffSummary): string[] {
  const lines: string[] = [];
  const pullCmd = diff.guestSpaceId
    ? `kint-origin pull guestspaces --id ${diff.spaceId}`
    : `kint-origin pull spaces --id ${diff.spaceId}`;
  if (!diff.pullState) {
    lines.push(
      `pull 状態がありません。${pullCmd} を実行すると、以後ローカル編集と環境側の変更を区別できます（push space は pull 状態が必要です）。`
    );
  }
  const keysOf = (target: FileState): string[] =>
    diff.resources.filter((r) => r.state === target).map((r) => `${r.key} (${r.file})`);
  const local = keysOf("local");
  const remote = keysOf("remote");
  const conflict = keysOf("conflict");
  if (local.length) lines.push(`ローカル編集（push space で反映）: ${local.join(", ")}`);
  if (remote.length) lines.push(`環境側の変更（${pullCmd} で取り込み）: ${remote.join(", ")}`);
  if (conflict.length) lines.push(`競合（ローカルと環境の両方が変更）: ${conflict.join(", ")}`);
  if (!local.length && !remote.length && !conflict.length) {
    lines.push("ローカルと環境に差分はありません。");
  }
  const settingsRes = diff.resources.find((r) => r.key === "settings");
  if (settingsRes?.changedKeys?.length) {
    lines.push(`  settings 変更キー: ${settingsRes.changedKeys.join(", ")}`);
  }
  for (const r of diff.resources) {
    if (r.state === "skipped") lines.push(`  対象外: ${r.key}（${r.reason}）`);
  }
  return lines;
}

function spaceConflictMessage(id: string, guestSpaceId: string, keys: string[]): string {
  const pullCmd = guestSpaceId
    ? `pull guestspaces --id ${id} --discard-local`
    : `pull spaces --id ${id} --discard-local`;
  const diffCmd = `kint-origin diff space --id ${id}${guestSpaceId ? ` --guestspace ${guestSpaceId}` : ""}`;
  return [
    `環境側でも変更されています: ${keys.join(", ")}`,
    `${diffCmd} で内容を確認し、kint-origin ${pullCmd} で環境の内容に取り直して編集し直すか、`,
    "環境側の変更を上書きしてよければ --overwrite-remote を付けて再実行してください。"
  ].join("\n");
}

export async function diffSpace({
  spaceId = "",
  guestSpaceId = ""
}: {
  spaceId?: string;
  guestSpaceId?: string;
}): Promise<SpaceDiffSummary> {
  const { id, guestSpaceId: resolvedGuestId, spaceDir } = resolveSpaceTarget({ spaceId, guestSpaceId });
  assertSpacePulled(spaceDir, id, resolvedGuestId);
  if (isOtherTenant(spaceDir)) throw new Error(otherTenantMessage(spaceDir));
  const client = new KintoneClient();
  const { diff } = await inspectSpace({ client, id, guestSpaceId: resolvedGuestId, spaceDir });
  for (const line of describeSpaceDiff(diff)) log(line);
  return diff;
}

type PreparedSpaceRequest = { method: "PUT" } & (
  | { key: "settings"; endpoint: "/space.json"; payload: Record<string, unknown> }
  | { key: "body"; endpoint: "/space/body.json"; sentBody: string }
  | { key: "body"; endpoint: "/space/thread.json"; sentBody: string; threadId: string }
);

export async function pushSpace({
  spaceId = "",
  guestSpaceId = "",
  only,
  yes = false,
  overwriteRemote = false
}: {
  spaceId?: string;
  guestSpaceId?: string;
  only?: string[];
  yes?: boolean;
  overwriteRemote?: boolean;
}): Promise<PushSpaceSummary> {
  assertConfirmable({ yes });
  validateSpaceOnlyKeys(only);

  const { id, guestSpaceId: resolvedGuestId, spaceDir } = resolveSpaceTarget({ spaceId, guestSpaceId });
  assertSpacePulled(spaceDir, id, resolvedGuestId);
  if (isOtherTenant(spaceDir)) throw new Error(otherTenantMessage(spaceDir));

  const client = new KintoneClient();
  const inspection = await inspectSpace({ client, id, guestSpaceId: resolvedGuestId, spaceDir });
  const { diff, remoteSpace } = inspection;
  const spaceLabel = resolvedGuestId ? `guestspace-${id}` : `space-${id}`;
  log(`対象: ${spaceLabel}${diff.name ? ` ${diff.name}` : ""}（${resolvedGuestId ? `ゲストスペース ${resolvedGuestId}` : "通常"}）`);
  log(`接続先: ${describeConnection()}`);

  if (!diff.pullState) {
    const pullCmd = resolvedGuestId ? `kint-origin pull guestspaces --id ${id}` : `kint-origin pull spaces --id ${id}`;
    throw new Error(`pull 状態がありません: ${spaceDir}\n${pullCmd} を実行してから編集してください。`);
  }

  const conflicts = diff.resources
    .filter((r) => r.state === "conflict" && (!only || only.includes(r.key)))
    .map((r) => r.key);
  if (conflicts.length > 0 && !overwriteRemote) {
    throw new Error(spaceConflictMessage(id, resolvedGuestId, conflicts));
  }

  for (const line of describeSpaceDiff(diff)) log(line);

  const requests: PreparedSpaceRequest[] = [];
  const skipped: SkippedResource[] = [];
  let settingsPayload: Record<string, unknown> | undefined;

  for (const resource of diff.resources) {
    if (only && !only.includes(resource.key)) {
      skipped.push({ key: resource.key, reason: "--only の対象外" });
      continue;
    }
    if (resource.state === "skipped") {
      skipped.push({ key: resource.key, reason: resource.reason ?? "対象外" });
      continue;
    }
    if (resource.state === "same") {
      skipped.push({ key: resource.key, reason: "環境と同じ内容です" });
      continue;
    }
    if (resource.state === "remote") {
      const pullCmd = resolvedGuestId ? "pull guestspaces" : "pull spaces";
      skipped.push({ key: resource.key, reason: `環境側だけが変更されています（${pullCmd} で取り込めます）` });
      continue;
    }

    if (resource.key === "settings") {
      settingsPayload = validateAndBuildSpaceSettingsPayload(inspection.localSettingsRaw, remoteSpace, {
        spaceId: id,
        isGuest: Boolean(resolvedGuestId || remoteSpace.isGuest)
      });
      requests.push({
        key: "settings",
        method: "PUT",
        endpoint: "/space.json",
        payload: settingsPayload
      });
    } else if (resource.key === "body") {
      const effectiveMultiThread =
        settingsPayload && typeof settingsPayload.useMultiThread === "boolean"
          ? settingsPayload.useMultiThread
          : Boolean(remoteSpace.useMultiThread);
      const sentBody = normalizeSpaceBody(inspection.localBodyRaw ?? "");
      if (effectiveMultiThread) {
        requests.push({
          key: "body",
          method: "PUT",
          endpoint: "/space/body.json",
          sentBody
        });
      } else {
        const defaultThread = remoteSpace.defaultThread != null ? String(remoteSpace.defaultThread).trim() : "";
        if (!defaultThread) {
          throw new Error("シングルスレッドスペースの本文更新に必要な defaultThread が取得できません。");
        }
        requests.push({
          key: "body",
          method: "PUT",
          endpoint: "/space/thread.json",
          sentBody,
          threadId: defaultThread
        });
      }
    }
  }

  log(`送信リソース: ${requests.length > 0 ? requests.map((r) => `${r.key} (${r.endpoint})`).join(", ") : "(なし)"}`);
  for (const skip of skipped) {
    log(`  対象外: ${skip.key} — ${skip.reason}`);
  }

  const base: PushSpaceSummary = {
    spaceId: id,
    guestSpaceId: resolvedGuestId,
    name: diff.name,
    spaceDir,
    applied: false,
    pushed: requests.map(({ key, method, endpoint }) => ({ key, method, endpoint })),
    skipped
  };

  if (requests.length === 0) {
    log("送信対象がないため何も反映しません。");
    return { ...base, pushed: [] };
  }

  log(buildRecoveryPlanText({ mode: "space", backupRoot: pushBackupRootPath(spaceDir) + path.sep }));
  log("この操作は動作テスト環境を経由せず、運用環境のスペース設定・本文を即時に書き換えます。");

  if (!yes) {
    const ok = await confirmYes("続行しますか？ [y/N]");
    if (!ok) {
      log("中断しました。");
      return { ...base, aborted: true };
    }
  }

  // 事前バックアップを _agentdata/backup/<時刻>/ へ保存する（失敗したら PUT 前に中断）。
  const backupDir = path.join(pushBackupRootPath(spaceDir), backupTimestamp());
  try {
    ensureDir(backupDir);
    writeJson(path.join(backupDir, "space.json"), remoteSpace);
    writeJson(path.join(backupDir, "settings.json"), serializeSpaceSettings(remoteSpace));
    writeText(path.join(backupDir, "body.html"), formatSpaceBodyFile(remoteSpace.body));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`反映前のバックアップに失敗したため、何も反映せずに中断しました: ${message}`);
  }
  log(`バックアップ: ${backupDir}`);

  // 逐次反映（settings → body の順。useMultiThread を false→true に切り替えた直後でも /space/body.json が使える）。
  const sentKeys = new Set<string>();
  let sentBodyText: string | undefined;
  for (const req of requests) {
    if (req.key === "settings") {
      await client.updateSpace(req.payload, { guestSpaceId: resolvedGuestId });
    } else if (req.endpoint === "/space/body.json") {
      await client.updateSpaceBody({ id, body: req.sentBody }, { guestSpaceId: resolvedGuestId });
      sentBodyText = req.sentBody;
    } else {
      await client.updateThread({ id: req.threadId, body: req.sentBody }, { guestSpaceId: resolvedGuestId });
      sentBodyText = req.sentBody;
    }
    sentKeys.add(req.key);
    log(`反映(運用環境): ${req.key}`);
  }
  log("運用環境への反映が完了しました。");

  // 直後に GET /space.json で保存後の状態を取り直し、kintone 側の HTML サニタイズ差分を検出・同期する。
  let sanitized: boolean | undefined;
  let verifyError: string | undefined;
  let updatedName = diff.name;
  try {
    const updatedSpace = await client.getSpace(id, { guestSpaceId: resolvedGuestId });
    updatedName = updatedSpace.name || updatedName;
    if (sentBodyText !== undefined) {
      sanitized = normalizeSpaceBody(updatedSpace.body) !== sentBodyText;
      if (sanitized) {
        log(
          "警告: kintone の保存処理により、許可されていないタグや属性が削除・整形されました。" +
            "ローカルの body.html を保存後の内容で更新しました（git diff で差分を確認できます）。"
        );
      }
    }
    writeSpaceExport({
      space: updatedSpace,
      guestSpaceId: resolvedGuestId,
      spaceId: resolvedGuestId ? "" : id,
      adoptRemote: sentKeys
    });
    log("検証 pull 完了。git diff で反映内容を確認してください。");
  } catch (error) {
    verifyError = error instanceof Error ? error.message : String(error);
    const pullCmd = resolvedGuestId ? `kint-origin pull guestspaces --id ${id}` : `kint-origin pull spaces --id ${id}`;
    log(
      `運用環境への反映は完了しています。ただし、反映後の再取得に失敗しました (${verifyError})。` +
        `${pullCmd} で data/ を取り直し、git diff で反映内容を確認してください。`
    );
  }

  return {
    ...base,
    name: updatedName,
    backupDir,
    applied: true,
    ...(sanitized !== undefined ? { sanitized } : {}),
    ...(verifyError ? { verifyError } : {})
  };
}
