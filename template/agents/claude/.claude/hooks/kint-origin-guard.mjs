#!/usr/bin/env node
// Claude PreToolUse adapter: shared policy -> ask/deny JSON; pass -> no output.
// Generated from the kint-origin template. Update with kint-origin update.

let input = {};
let inputBroken = false;
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  inputBroken = true;
}

function decide(decision, reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason
      }
    })
  );
  process.exit(0);
}

if (inputBroken) {
  decide("ask", "kint-origin のガード（hook）が入力を解釈できませんでした。保護が働かないため、この操作はユーザーが内容を確認して許可してください。");
}

try {
  const { evaluateCommand, evaluateWritePath } = await import("../../.agents/hooks/kint-origin-guard-core.mjs");
  const toolName = String(input.tool_name || "");
  const toolInput = input.tool_input || {};
  let result = null;
  if (toolName === "Bash" || toolName === "PowerShell") {
    result = evaluateCommand(String(toolInput.command || ""), {
      pushDecision: "ask",
      updateYesDecision: "ask",
      protectEnv: true,
      denyChainedPush: true
    });
  } else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) {
    result = evaluateWritePath(String(toolInput.file_path || toolInput.notebook_path || ""), input.cwd || process.cwd());
  }
  if (result) decide(result.decision, result.reason);
} catch (error) {
  decide("ask", "kint-origin のガード（hook）の判定中にエラーが起きました（" + (error && error.message ? error.message : String(error)) + "）。この操作はユーザーが内容を確認して許可してください。");
}

// No output: normal host permission evaluation.
process.exit(0);
