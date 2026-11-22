// pull 状態（アプリディレクトリの .kint-origin-pull.json）。
// push 対象ファイルについて「前回 pull で書いた内容のハッシュ（base）」を記録し、
// ローカル（local）・環境（remote）との三方比較で、ローカル編集と環境側の変更を区別する。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseJsonText, readJsonIfExists, writeJson } from "../fsutil.js";
import { canonicalJson, normalizeDynamicValues } from "../normalize.js";
import { isErrorStub } from "./pushItems.js";

const PULL_STATE_FILE = ".kint-origin-pull.json";

export interface PullState {
  schemaVersion: 1;
  /** `folder/file`（push 対象）→ 前回 pull で書いた内容のハッシュ */
  files: Record<string, string>;
  /** customize（マニフェストと JS/CSS 一式）のハッシュ */
  customize?: string;
}

// same: ローカルと環境が同じ / local: ローカルだけ変更 / remote: 環境だけ変更 / conflict: 両方変更
export type FileState = "same" | "local" | "remote" | "conflict";

export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// 改行コードの違い（git の autocrlf 等）で別内容と判定しないよう、テキストは LF に揃えてからハッシュする。
export function hashBytes(bytes: Buffer): string {
  if (bytes.includes(0)) return sha256(bytes);
  return sha256(bytes.toString("utf8").replace(/\r\n/g, "\n"));
}

// revision / fileKey を正規化し、キー順に依存しないハッシュにする（pull の出力と同じ正規化）。
export function hashJson(value: unknown): string {
  return sha256(canonicalJson(normalizeDynamicValues(value)));
}

// ローカルの JSON ファイルのハッシュ。無い・取得失敗スタブ（_error）は undefined。JSON として読めなければ生テキストで比較する。
export function hashLocalJson(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, "utf8");
  let value: unknown;
  try {
    value = parseJsonText(text, file);
  } catch {
    return `raw:${hashBytes(Buffer.from(text, "utf8"))}`;
  }
  return isErrorStub(value) ? undefined : hashJson(value);
}

export function classify({ base, local, remote }: { base?: string; local?: string; remote?: string }): FileState {
  if (local === remote) return "same";
  // ローカルに無いファイルは編集ではないので、環境から取り直す側（remote）として扱う。
  if (local === undefined) return "remote";
  if (base === undefined) return remote === undefined ? "local" : "conflict";
  if (local === base) return "remote";
  if (remote === base) return "local";
  return "conflict";
}

function pullStatePath(appDir: string): string {
  return path.join(appDir, PULL_STATE_FILE);
}

export function readPullState(appDir: string): PullState | undefined {
  const value = readJsonIfExists(pullStatePath(appDir)) as Partial<PullState> | undefined;
  if (!value || value.schemaVersion !== 1 || typeof value.files !== "object" || value.files === null) return undefined;
  return { schemaVersion: 1, files: value.files, ...(typeof value.customize === "string" ? { customize: value.customize } : {}) };
}

export function writePullState(appDir: string, state: PullState): void {
  const files = Object.fromEntries(Object.entries(state.files).sort(([a], [b]) => a.localeCompare(b, "en")));
  writeJson(pullStatePath(appDir), { schemaVersion: 1, files, ...(state.customize ? { customize: state.customize } : {}) });
}
