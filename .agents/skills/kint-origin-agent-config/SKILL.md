---
name: kint-origin-agent-config
description: kint-originのスキル・ルール・知識配置、init/updateのAI設定生成を変更し、正本・生成物・参照資料・配布内容を揃える。
---

# エージェント設定と作業知識を保守する

## 正本を選ぶ

| 対象 | 編集する正本 |
| --- | --- |
| 本体開発の常時指示 | `AGENTS.md`。CLAUDE.mdはこれをimportする |
| 開発スキル・役割 | `.agents/skills/`・任意の `.agents/roles/`。登録は `.agents/dev-config.json` |
| ドメイン向け手順・参照資料 | `template/agents/common/skills/`。必要な作業のときに読む資料は担当スキルのreferencesへ |
| 常時ルール・入口 | `template/agents/common/rules/`・`AGENT_DOC.md` |
| hook・権限 | `template/agents/common/hooks/` とツール別extras |
| 人向けの承認説明 | [反映前の確認](../../../template/README.md#反映前の確認) |

1. 対象のコード・テスト・既存の独自変更を確認し、正本を変更する。開発用と配布用を混ぜない。
2. SKILL.mdのdescriptionに具体的な発動条件を書く。本文は実行手順と判断に絞り、資料へ「いつ読むか」を付けてMarkdownリンクする。コードの網羅表や監査ログを複写しない。
3. 参照資料の詳細は一か所に置く。同じ配布スキル間は相対リンクにし、生成後に本体リポジトリのdocやsrcを必要としない構成にする。
4. UTF-8 BOMなし・LF、nameとフォルダ名の一致を維持する。descriptionは本体validatorに合わせ1行の文字列にする。
5. `npm run agents:sync` → `npm run agents:check` → `npm run agents:test`。配布変更は隔離領域のsmokeでinit/update・参照・個人設定温存を確認する。
6. npm packのdry-runでREADMEと配布資料の参照先が収録されることを確認する。文書の表現そのものをテストへ固定しない。

初回配置、リンク/コピー方式の変更、同期の競合・欠落は [同期の運用](references/sync.md) を読む。
設定の実クライアント確認が必要なら [検証スキル](../kint-origin-validation/SKILL.md) を読む。

配布スキルは `kint-origin-*`（local/addonを除く）。独自追加の手順は [extend](../../../template/agents/common/skills/kint-origin-extend/SKILL.md)。配布物にサブエージェントを追加しない。
生成物に独自変更がある場合は停止し、必要な内容を正本へ取り込むか保全してから再同期する。個人設定や未登録ファイルは触らない。
