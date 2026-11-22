#!/usr/bin/env node
// Codex PreToolUse hook（matcher ^apply_patch$）: .claude/.agents/.cursor の skills/・rules/ に、
// kint-origin-local- で始まらない名前で新しく作るパッチ（*** Add File / *** Move to）を deny する。既存のフォルダ・ファイルの編集は通す。
// 入力: stdin に JSON（cwd・tool_name・tool_input.command に apply_patch の本文）。
// 出力: 拒否するときだけ hookSpecificOutput を 1 回出す。通すときは何も出さず exit 0（Codex 公式: 出力なしの exit 0 は続行）。
// 名前の案内であり、データ保護ではないため、判定できない入力・例外のときは止めない。
// Codex は、このフォルダの .codex/ を信頼し、/hooks でこの hook を信頼したときだけ実行する。
// このファイルは kint-origin のテンプレートから生成されています。最新化は `kint-origin update`。

// apply_patch の本文から、新しく作る（Add File）・移動先（Move to）のパスを取り出す。
function patchTargets(command) {
  const text = Array.isArray(command) ? command.join("\n") : String(command ?? "");
  return [...text.matchAll(/^\*\*\* (?:Add File|Move to): (.+?)\s*$/gm)].map((m) => m[1]);
}

let input;
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  process.exit(0);
}
try {
  const { namingViolation, namingReason, relativeTo, toPosix } = await import("../../.agents/hooks/kint-origin-guard-core.mjs");
  const root = toPosix(input?.cwd || process.cwd()).replace(/\/+$/, "");
  for (const file of patchTargets(input?.tool_input?.command)) {
    const target = namingViolation(relativeTo(file, root), root);
    if (target) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: namingReason(target) }
        })
      );
      process.exit(0);
    }
  }
} catch {
  /* 判定に失敗しても作業は止めない */
}
process.exit(0);
