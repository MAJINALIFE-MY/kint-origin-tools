import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const MAX_LINES = 10_000;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PART_BYTES = 64 * 1024;

const SECRET_NAME = /password|passwd|token|secret|encrypted|authorization|cookie|api.?key|private.?key|file.?key/i;
const SECRET_ASSIGNMENT = /((?:--?[\w-]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION|COOKIE)[\w-]*\s*=|[A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|PRIVATE_KEY|AUTHORIZATION|COOKIE)[A-Z0-9_]*\s*[=:])\s*)([^\s,;]+)/gi;
const AUTH_HEADER = /((?:Basic|Bearer)\s+)[A-Za-z0-9._~+\/-]+=*/gi;
const ENCRYPTED_PASSWORD = /enc:v1:[A-Za-z0-9+/=.-]+/g;
const sensitiveValues = new Set<string>();

class RunLogUnavailableError extends Error {
  constructor(message = "ログを保存できないため、後続の変更操作を中断しました。") {
    super(message);
    this.name = "RunLogUnavailableError";
  }
}

function localTimestamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  const three = (value: number) => String(value).padStart(3, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}-${three(date.getMilliseconds())}`;
}

function redactString(value: string): string {
  if (/^[\s]*[\[{]/.test(value)) {
    try {
      return JSON.stringify(redact(JSON.parse(value)));
    } catch {
      // Treat text that only resembles JSON as plain text.
    }
  }
  let output = value
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(AUTH_HEADER, "$1[REDACTED]")
    .replace(ENCRYPTED_PASSWORD, "[REDACTED]");
  for (const secret of sensitiveValues) {
    if (secret) output = output.replaceAll(secret, "[REDACTED]");
  }
  return output;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 40) return "[MAX_DEPTH]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const previous = index > 0 ? String(value[index - 1]) : "";
      return /^--?[\w-]*(?:password|passwd|token|secret|api[_-]?key|private[_-]?key|authorization|cookie)$/i.test(previous)
        ? "[REDACTED]"
        : redact(item, depth + 1);
    });
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SECRET_NAME.test(key) ? "[REDACTED]" : redact(item, depth + 1);
    }
    return output;
  }
  return value;
}

function splitUtf8(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes && part) {
      parts.push(part);
      part = "";
      bytes = 0;
    }
    part += character;
    bytes += size;
  }
  if (part || parts.length === 0) parts.push(part);
  return parts;
}

export class RunLog {
  readonly runId = randomUUID();
  readonly directory: string;
  private readonly startedAt = new Date();
  private readonly startedAtMs = performance.now();
  private sequence = 0;
  private part = 0;
  private lineCount = 0;
  private byteCount = 0;
  private fd = -1;
  private closed = false;
  private failure: Error | undefined;

  constructor(cwd: string) {
    const root = path.resolve(cwd, "log");
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const rootStat = fs.lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("log はシンボリックリンクではない通常のディレクトリである必要があります。");
      const rootIgnore = path.join(root, ".gitignore");
      const rootIgnoreStat = fs.lstatSync(rootIgnore, { throwIfNoEntry: false });
      if (rootIgnoreStat?.isSymbolicLink() || (rootIgnoreStat && !rootIgnoreStat.isFile())) throw new Error("log/.gitignore は通常ファイルである必要があります。");
      if (!rootIgnoreStat) {
        try {
          fs.writeFileSync(rootIgnore, "*\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      this.directory = path.join(root, `run-${localTimestamp(this.startedAt)}-${this.runId}`);
      fs.mkdirSync(this.directory, { mode: 0o700 });
      fs.writeFileSync(path.join(this.directory, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      this.openNextFile();
    } catch (error) {
      this.directory = path.join(root, `run-${localTimestamp(this.startedAt)}-${this.runId}`);
      throw new Error(`実行ログを初期化できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  write(type: string, fields: Record<string, unknown> = {}): void {
    if (this.closed) return;
    if (this.failure) return;
    try {
      const redacted = redact(fields) as Record<string, unknown>;
      const rawText = typeof redacted.text === "string" ? redacted.text : undefined;
      const base = { ...redacted };
      delete base.text;
      const chunks = rawText === undefined ? [undefined] : splitUtf8(rawText, MAX_PART_BYTES);
      const eventId = chunks.length > 1 ? randomUUID() : undefined;
      for (let index = 0; index < chunks.length; index += 1) {
        this.sequence += 1;
        const entry = {
          schemaVersion: 1,
          runId: this.runId,
          seq: this.sequence,
          ts: new Date().toISOString(),
          elapsedMs: Math.max(0, Math.round(performance.now() - this.startedAtMs)),
          type,
          ...base,
          ...(chunks[index] !== undefined ? { text: chunks[index] } : {}),
          ...(eventId ? { eventId, part: index + 1, parts: chunks.length } : {})
        };
        const line = `${JSON.stringify(entry)}\n`;
        const bytes = Buffer.byteLength(line, "utf8");
        if (this.lineCount > 0 && (this.lineCount + 1 > MAX_LINES || this.byteCount + bytes > MAX_BYTES)) {
          this.closePart();
          this.openNextFile();
        }
        const written = fs.writeSync(this.fd, line, undefined, "utf8");
        if (written !== bytes) throw new Error("ログファイルへ全バイトを書き込めませんでした。");
        this.lineCount += 1;
        this.byteCount += bytes;
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      process.stderr.write(`実行ログを保存できません。以後の変更操作を中断します: ${this.failure.message}\n`);
    }
  }

  assertWritable(): void {
    if (this.failure) throw new RunLogUnavailableError();
  }

  get unavailable(): boolean {
    return Boolean(this.failure);
  }

  finish(exitCode: number): number {
    this.write("run_end", { exitCode: this.failure && exitCode === 0 ? 1 : exitCode });
    this.closed = true;
    try {
      this.closePart();
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      process.stderr.write(`実行ログを閉じられませんでした: ${this.failure.message}\n`);
    }
    return this.failure && exitCode === 0 ? 1 : exitCode;
  }

  private openNextFile(): void {
    this.part += 1;
    const name = `log-${localTimestamp(new Date())}-${String(this.part).padStart(4, "0")}.log`;
    this.fd = fs.openSync(path.join(this.directory, name), "wx", 0o600);
    this.lineCount = 0;
    this.byteCount = 0;
  }

  private closePart(): void {
    if (this.fd < 0) return;
    try {
      fs.fsyncSync(this.fd);
    } finally {
      fs.closeSync(this.fd);
      this.fd = -1;
    }
  }
}

let activeRunLog: RunLog | undefined;

export function startRunLog(cwd: string): RunLog {
  const runLog = new RunLog(cwd);
  activeRunLog = runLog;
  return runLog;
}

export function currentRunLog(): RunLog | undefined {
  return activeRunLog;
}

export function recordRunEvent(type: string, fields: Record<string, unknown> = {}): void {
  activeRunLog?.write(type, fields);
}

export function recordLocalAction(action: string, targetPath: string, fields: Record<string, unknown> = {}): void {
  recordRunEvent("local_action", { action, path: targetPath, ...fields });
  assertRunLogWritable();
}

export function assertRunLogWritable(): void {
  activeRunLog?.assertWritable();
}

export function runLogUnavailable(): boolean {
  return activeRunLog?.unavailable ?? false;
}

export function registerSensitiveValue(value: string): void {
  if (value) sensitiveValues.add(value);
}
