---
name: kint-origin-development
description: kint-origin CLIの機能追加・不具合修正・ソース公開準備で、変更箇所、維持する契約、利用手順の更新先を確認する。
---

# kint-origin本体を改修する

本体ルートでドメイン用init/updateを実行しない。実装前に関連するコードとテストを読み、利用者の判断・入力・出力に影響する変更を特定する。

## 実装を探す

| 対象 | コードの入口 |
| --- | --- |
| コマンド・引数・ヘルプ・結果表示 | `src/cli.ts`。許可は `src/policy.ts` |
| 取得・索引・削除判定・出力 | `src/kintone/apps.ts`・`pull.ts`・`appIndex.ts`・`deletedEntries.ts`・`serializers.ts` |
| 三方比較と編集の保持 | `pullState.ts`・`appDiff.ts`・`customize.ts`、`src/normalize.ts` |
| アプリ反映・新規ドラフト | `push.ts`・`pushItems.ts`・`appDraft.ts`・`appTemplate.ts` |
| スペースの設定・本文 | `spacePush.ts`・`htmlFormat.ts` |
| レコードジョブ | `recordJob.ts`（CSV）→`recordValues.ts`（型・値）→`recordPlan.ts`（GETのみの計画）→`recordExec.ts`（バックアップ・転送・bulk・検証）→`recordPush.ts`（公開関数と復旧） |
| 更新キー付きCSV | `recordImport.ts`・`recordImportPush.ts`。復旧はrecordPushのrestoreRunを共有 |
| REST・cli-kintone・添付 | `src/http.ts`・`src/kintone/client.ts`・`cliKintone.ts`・`recordAttachments.ts` |
| 認証・取得元・暗号化 | `src/env.ts`・`crypto.ts`・`src/kintone/tenant.ts` |
| HTML・addon | `src/html/`・`src/addon/` |
| 配布生成・本体保護 | `src/agents.ts`・`init.ts`・`update.ts`・`domainGitignore.ts`・`domainGuard.ts` |

省略したkintoneのファイル名は `src/kintone/` 内。テストの探し方は [検証スキル](../kint-origin-validation/SKILL.md)。

## 変更を揃える

- コマンド追加はcli.tsの振り分け・COMMAND_OPTIONS・BOOLEAN_FLAGSと、policy.tsの対応するREQUIREMENTSを揃える。主体IDは `--id`。未登録引数をAPIの前に拒否する契約を維持する。
- USAGEの各ブロック（形式の先頭行＋深くインデントした説明行）から個別ヘルプを生成する。書式を崩さず、登録したサブコマンドのヘルプを検証する。許可・オプションの網羅表をスキルへ再掲しない。
- AGENTS.mdの「変更時に揃えるもの」に従い、利用AIの手順へ影響する説明を更新する。内部変更だけなら、説明が変わらない根拠を完了報告に残す。

| 利用者へ影響する変更 | 説明の正本 |
| --- | --- |
| コマンドの選び方・データの探し方 | [commands](../../../template/agents/common/skills/kint-origin-commands/SKILL.md) |
| 結果・終了コード・失敗の判断 | [結果の読み方](../../../template/agents/common/skills/kint-origin-commands/references/results.md) |
| 設定ファイル・反映範囲・復旧 | [push](../../../template/agents/common/skills/kint-origin-push/SKILL.md) とその参照資料 |
| job.csv・更新キー付きCSV | [records](../../../template/agents/common/skills/kint-origin-records/SKILL.md) とその入力仕様、`template/push/` の雛形 |
| addon・独自追加 | commandsのaddon参照資料、[extend](../../../template/agents/common/skills/kint-origin-extend/SKILL.md) |
| 導入・認証・安全上の前提 | ルート/配布README・`template/.env.example`・SECURITY。網羅表は雛形かコードに置く |

## 壊してはいけない境界

- cwdのdata/.envと、パッケージ内のtemplate/cli-kintoneを分ける。グローバルlink時も同じ入力を解決する。
- normalizeDynamicValuesは応答トップのrevision、再帰的な文字列・数値のfileKeyを正規化する。同名のフィールド定義やビュー定義は保持する。exportedAtの正規化、ja/enソート、JSON改行を維持する。
- pullは既存のローカル編集・正常な取得物を一時障害で壊さない。削除判定は404のみ。ゲストと権限不足を不在と取り違えない。
- 設定のpushは差分・バックアップ・未反映変更・検証を扱う。レコードの書き込みはRESTのbulkRequestで、cli-kintoneのrecord importへ置き換えない。結果不明の再実行ガードを維持する。
- CSVの引用符内改行・BOM・サブテーブル形式、HTMLのエスケープ・生成先マーカー保護を維持する。

変更後は関連テストから確認し、最後に全smokeを通す。設定生成の改修は [設定スキル](../kint-origin-agent-config/SKILL.md) も読む。
ソースの公開を準備するときだけ [公開手順](references/publishing.md) を読む。文書・ルール・開発設定だけの変更では不要な版上げ・公開を行わない。
