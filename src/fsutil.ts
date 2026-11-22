import fs from "node:fs";
import path from "node:path";
import { assertRunLogWritable, recordLocalAction, recordRunEvent } from "./runLog.js";

function relativePath(filePath: string): string {
  return path.relative(process.cwd(), path.resolve(filePath)).replaceAll(path.sep, "/");
}

export function ensureDir(dirPath: string, { allowWhenLogUnavailable = false }: { allowWhenLogUnavailable?: boolean } = {}): void {
  if (allowWhenLogUnavailable) recordRunEvent("local_action", { action: "ensure-directory", path: relativePath(dirPath), logFailureRecovery: true });
  else recordLocalAction("ensure-directory", relativePath(dirPath));
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeJson(filePath: string, value: unknown, { allowWhenLogUnavailable = false }: { allowWhenLogUnavailable?: boolean } = {}): void {
  if (!allowWhenLogUnavailable) assertRunLogWritable();
  ensureDir(path.dirname(filePath), { allowWhenLogUnavailable });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const fields = { action: "write-json", path: relativePath(filePath), bytes: Buffer.byteLength(serialized, "utf8"), ...(allowWhenLogUnavailable ? { logFailureRecovery: true } : {}) };
  if (allowWhenLogUnavailable) recordRunEvent("local_action", fields);
  else recordLocalAction(fields.action, fields.path, { bytes: fields.bytes });
  fs.writeFileSync(filePath, serialized, "utf8");
}

export function writeText(filePath: string, text: string): void {
  assertRunLogWritable();
  ensureDir(path.dirname(filePath));
  const value = String(text);
  recordLocalAction("write-text", relativePath(filePath), { bytes: Buffer.byteLength(value, "utf8") });
  fs.writeFileSync(filePath, value, "utf8");
}

// Windows のエディターや PowerShell 5.1 で保存された UTF-8 BOM 付きの JSON も読む。
export function parseJsonText(text: string, label: string): unknown {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`JSON の読み込みに失敗しました: ${label} (${message})`);
  }
}

export function readJsonIfExists(filePath: string): unknown | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return parseJsonText(fs.readFileSync(filePath, "utf8"), filePath);
}

// ディレクトリを除き、basePath からの相対パスを返す。
export function listFilesRecursive(dirPath: string, basePath = dirPath): string[] {
  if (!fs.existsSync(dirPath)) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(entryPath, basePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(path.relative(basePath, entryPath));
    }
  }
  return files;
}
