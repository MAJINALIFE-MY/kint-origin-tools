import readline from "node:readline";
import { recordRunEvent } from "./runLog.js";

// stdout の結果をパイプで処理できるよう、確認は stderr に出す。
export function isYesAnswer(answer: string, defaultYes = false): boolean {
  const normalized = answer.trim();
  return normalized === "" ? defaultYes : /^(y|yes)$/i.test(normalized);
}

export function confirmYes(message: string, { defaultYes = false }: { defaultYes?: boolean } = {}): Promise<boolean> {
  if (!process.stdin.isTTY) {
    recordRunEvent("confirmation", { text: message, result: "no_tty" });
    return Promise.resolve(false);
  }
  recordRunEvent("confirmation", { text: message, result: "asked" });
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    // 回答を受け取る前に入力が閉じた（Ctrl-D・Ctrl-C・端末の切断）場合は「承認されなかった」として扱う。
    // これが無いと promise が解決されないままプロセスが終了コード 0 で終わり、何も表示されない。
    rl.once("close", () => {
      if (settled) return;
      settled = true;
      recordRunEvent("confirmation", { text: message, result: "closed" });
      resolve(false);
    });
    rl.question(`${message} `, (answer) => {
      // close イベントの resolve(false) より先に回答を確定させる。
      const approved = isYesAnswer(answer, defaultYes);
      settled = true;
      recordRunEvent("confirmation", { text: message, result: approved ? "approved" : "declined" });
      resolve(approved);
      rl.close();
    });
  });
}
