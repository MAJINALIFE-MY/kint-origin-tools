---
name: kint-origin-validation
description: kint-originの改修検証・リグレッション調査で、対応するテスト、隔離したオフラインsmoke、専用環境での手動検証を選ぶ。
---

# kint-originを検証する

顧客ドメインでは実行しない。`local-test/` と隔離した一時領域だけを使い、認証値をログへ出さない。

## オフラインで確認する

1. 初回は `npm ci` と `npm run agents:sync`。本体ルートでkint-origin init/updateは使わない。
2. スキル・ルール変更は `agents:check` と `agents:test`。前者は修復せず、欠落・内容差分・参照切れ・文字コードを検査する。
3. 改修中は `SMOKE_ONLY` で関連グループを選ぶ。最後は指定なしの `npm run smoke` を全件成功させる。smokeはビルドと開発設定の検査も行う。
4. 実URL入りの `local-test/.env` があると、SMOKE_APP_ID無しでも索引をライブ取得する。完全なオフライン確認は `.env` と取得データを含めない隔離ソースコピーで行う。認証環境変数とSMOKE_PUSH_LIVEも持ち込まない。

PowerShellでは `$env:SMOKE_ONLY="agents,safety"` を設定して実行し、最終確認前にこの変数を削除する。npm.ps1が制限される場合はnpm.cmdを使う。

## 関連テストを探す

正本は `scripts/smoke-test.mjs` 末尾のrunGroupと各expect。期待値の全文を文書へ再掲しない。変更対象・メッセージ・返却キーでテストを検索する。

| 対象 | 探すグループ・実装 |
| --- | --- |
| コマンド・許可・入力 | offline、policy、kintoneClientPolicy、pushCli、recordsCli、safety |
| HTTP・添付・CSV | http、limit、attachment、recordCsv、pluginConfig |
| pull・ゲスト・差分 | guestSpace、pullKintoneGuestE2E、permissionDeny、favorite、appDiff系 |
| app/create/customize/space | pushItems、appDraft、appCreate、pushDeploy、customizeE2E、spacePush |
| レコード | recordJob、recordValues、recordCopy、recordsReadE2E、recordsDiffErrorE2E、recordsPushE2E、recordsPushFailureE2E、import |
| 配布・開発設定・参照資料 | agents、safety、`scripts/dev-agents.test.mjs`・`agent-knowledge.test.mjs` |
| HTML・MCP・addon | html、docsMcp、addon |

安全性の検査はsmoke-safety、CSV取込はsmoke-import、新規ドラフトはsmoke-app-create、addonはsmoke-addonへ分離されている。
失敗したら最初の原因と対象を絞る。環境不足と実装不具合を区別し、無関係な成功済み検査を繰り返さない。

## 実環境・AIクライアントの確認

必要な変更のときだけ [手動・ライブ確認](references/live-checks.md) を読む。push E2Eを検証の都合で勝手に有効化しない。
結果は実行した範囲・対象版・未検証の範囲を分けて報告する。生成ファイルとhookのfixture検査の成功を、実クライアント上のスキル発動や承認UIの確認と同一視しない。
