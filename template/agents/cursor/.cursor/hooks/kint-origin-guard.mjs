#!/usr/bin/env node
// Cursor beforeShellExecution hook: kint-origin push をシェル起動前に止める。
// - `kint-origin push ...`（app / create / space / records / import、-y の有無を問わない）は deny にする。
//   push は、Cursor のエージェントからは実行せず、ユーザーが自分のターミナルで実行する運用にしている（確認ではなく拒否で止める）。
//   拒否の理由と対処（kint-origin diff で内容を確認し、ユーザーが自分のターミナルで実行する）は user_message / agent_message で伝える。
// - preToolUse（matcher: Write）: .claude/.agents/.cursor の skills/・rules/ に、kint-origin-local- で始まらない名前で
//   新しく作る書き込みは deny にする（既存のフォルダ・ファイルの編集は通す）。Write の入力のパスの項目名は公式に記載が無いため、
//   file_path / path / target_file / filePath の順に読む。パスが取れないとき・例外のときは通す（名前の案内であり、データ保護ではない）。
// - それ以外は allow を返す。
// 判定はドメイン内の .agents/hooks/kint-origin-guard-core.mjs に集約する。
// 入力: stdin に JSON（command ほか）。出力: { permission, user_message, agent_message } の JSON。
// hooks.json の failClosed: true により、異常終了・タイムアウト・空出力では実行されない。どの経路でも JSON を 1 回出す。
// このファイルは kint-origin のテンプレートから生成されています。最新化は `kint-origin update`。

async function decidePreToolUse(input) {
  try {
    const { namingViolation, namingReason, relativeTo, toPosix } = await import("../../.agents/hooks/kint-origin-guard-core.mjs");
    const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
    const file = toolInput.file_path ?? toolInput.path ?? toolInput.target_file ?? toolInput.filePath ?? "";
    if (!file) return { permission: "allow" };
    const roots = Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0 ? input.workspace_roots : [input.cwd || process.cwd()];
    const root = roots.find((r) => relativeTo(file, r) !== toPosix(file)) ?? roots[0];
    const target = namingViolation(relativeTo(file, root), toPosix(root));
    if (!target) return { permission: "allow" };
    return {
      permission: "deny",
      user_message: namingReason(target),
      agent_message:
        "hook が、kint-origin-local- で始まらない名前のスキル・ルールの新規作成を拒否しました。名前を kint-origin-local-<名前> に変えて作り直してください（手順は kint-origin-extend スキル）。"
    };
  } catch {
    return { permission: "allow" };
  }
}

async function decide(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return {
      permission: "deny",
      user_message:
        "kint-origin の hook が入力を解釈できなかったため、コマンドを実行しませんでした。Cursor を更新した直後なら、ドメインフォルダのターミナルで kint-origin update を実行して hook を最新化してください。",
      agent_message: "hook が入力を解釈できず、コマンドを拒否しました。再試行せず、この状況をユーザーに伝えてください。"
    };
  }
  if (input && (input.hook_event_name === "preToolUse" || (typeof input.command !== "string" && input.tool_input))) return decidePreToolUse(input);
  const command = String(input?.command ?? "").trim();
  let result;
  try {
    const { evaluateCommand } = await import("../../.agents/hooks/kint-origin-guard-core.mjs");
    result = evaluateCommand(command, { pushDecision: "deny", updateYesDecision: "deny" });
  } catch {
    return {
      permission: "deny",
      user_message: "kint-origin の共有ガードを読み込めませんでした。ドメインのターミナルで kint-origin update を実行してください。",
      agent_message: "共有ガードの読み込みに失敗しました。回避や再試行はせず、ユーザーへ状況を伝えてください。"
    };
  }
  if (result?.kind === "update") {
    return {
      permission: result.decision,
      user_message:
        "kint-origin update -y は、確認なしで CLAUDE.md・AGENTS.md・hook などの配布ファイルを上書きするため、Cursor のエージェントからは実行しません。" +
        "ドメインフォルダのターミナルで、-y を付けずに kint-origin update を実行してください（上書きされるファイルの一覧を見て y/N で確認できます）。" +
        `対象コマンド: ${command}`,
      agent_message:
        "hook が kint-origin update -y を拒否しました。回避や再試行はせず、ユーザーに kint-origin update（-y なし）を自分のターミナルで実行するよう依頼してください。"
    };
  }
  if (!result) return { permission: "allow" };

  return {
    permission: result.decision,
    user_message: [
      "Cursor のエージェントによる kint-origin push を拒否しました。",
      "ドメインの README の「反映前の確認」に沿って、対象と kint-origin diff の結果、反映の影響、復旧方法を確認してください。",
      "反映する場合は、ドメインフォルダのターミナルで実行してください。-y を付けなければ、CLI が反映内容を表示して y/N で確認します。",
      `実行するコマンドは ${command} です。`
    ].join(" "),
    agent_message:
      "hook が kint-origin push を拒否しました。再試行や書き方を変えた回避（別名や node での直接起動など）はしないでください。" +
      "操作に対応する kintone の差分を kint-origin diff で確認してください。kint-origin-push または kint-origin-records の承認形式に沿って、対象・差分・反映の影響・復旧方法・実行コマンドを提示し、" +
      "ユーザー自身のターミナルでの実行を依頼してください。実行結果はユーザーから共有してもらってください。"
  };
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
process.stdout.write(`${JSON.stringify(await decide(Buffer.concat(chunks).toString("utf8")))}\n`);
