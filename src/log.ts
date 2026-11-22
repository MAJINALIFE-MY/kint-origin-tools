// 簡易進捗ログ。結果(JSON)は stdout、進捗は stderr に出す（パイプを汚さない）。

import { recordRunEvent } from "./runLog.js";

const START = Date.now();

function elapsedText(): string {
  const totalSec = Math.round((Date.now() - START) / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

export function log(message: string): void {
  recordRunEvent("progress", { text: message });
  process.stderr.write(`[${elapsedText()}] ${message}\n`);
}

let progressDone = 0;
let progressTotal = 0;

export function setProgressTotal(total: number): void {
  progressDone = 0;
  progressTotal = total;
}

export function progress(label: string): void {
  progressDone += 1;
  const counter = progressTotal ? ` [${progressDone}/${progressTotal}]` : "";
  log(`${label}${counter}`);
}
