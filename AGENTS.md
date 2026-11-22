# AGENTS.md — kint-origin-tools

ここは `kint-origin` CLI本体。ドメインの取得データは別フォルダ・別Gitで管理する。

## 常時守ること

- テキストはUTF-8 BOMなし・LF。JSONは2space＋末尾改行。records.csvのUTF-8 BOMは維持する。
- ドメインの `data/` はAPI取得物。明示依頼なしに手作業で編集・整形・削除・移動せず、取得済みJSONを推測で書き換えない。`_agentdata/` はその運用規約に従う。
- `.env`、認証値、顧客情報をコミット・出力しない。CLIが作るローカル `log/` はAPI応答本文を含む非公開記録として扱い、Git除外を先に作成して共有・公開しない。
- `data/` と `.env` は実行cwd基準。テンプレートとcli-kintoneはパッケージroot基準。この境界、既存の出力パス、動的値の正規化、ja/enのソートを維持する。
- 本体ルートで `kint-origin init` / `update` を実行しない。生成検証は隔離領域で行う。
- kintoneへのpushは対象・差分・反映の影響・復旧プラン・実行コマンドを示し、実行の明示承認を得る。AIは本体開発中に `-y` / `--yes` を付けない。承認済みの依頼範囲を引き継ぐ。
- 個人設定、独自スキル、未登録ファイルを上書き・削除しない。生成物は正本から同期する。

## 作業の入口

作業に対応するスキルを読み、そこから関連コード・テスト・必要な参照資料へ進む。

| 作業 | 読むもの |
| --- | --- |
| CLIの実装・修正・公開準備 | [kint-origin-development](.agents/skills/kint-origin-development/SKILL.md) |
| 検証・リグレッション調査 | [kint-origin-validation](.agents/skills/kint-origin-validation/SKILL.md) |
| スキル・ルール・生成設定・知識配置の変更 | [kint-origin-agent-config](.agents/skills/kint-origin-agent-config/SKILL.md) |

開発用の正本は本書と `.agents/skills/`。`CLAUDE.md` は本書をimportする。役割の委譲は指定していない。
ドメイン利用AIの入口は [配布用AGENT_DOC](template/agents/common/AGENT_DOC.md) と、その作業別スキル。
配布正本は `template/agents/common/` とツール別extras。配布サブエージェントは置かない。
配布名 `kint-origin-*` のうち `kint-origin-local-*` はドメイン独自追加、`kint-origin-addon-*` は外部addonに予約する。

## 変更時に揃えるもの

| 変更 | 同じ作業で確認・更新する正本 |
| --- | --- |
| コマンド・オプション・許可 | `src/cli.ts` の定義とUSAGE、`src/policy.ts`、関連テスト |
| 入力形式・編集可能ファイル | パーサー・雛形・担当する配布スキルの参照資料・関連テスト |
| 結果JSON・終了コード・失敗の扱い | 返却処理・関連テスト・commandsスキルの「結果の読み方」 |
| 利用者の操作・承認・復旧 | 担当する配布スキル、人向け [反映前の確認](template/README.md#反映前の確認) |
| エージェント設定・参照先 | テンプレート・開発スキルの正本、生成・同期・参照検査 |
| 内部実装のみ | 関連テスト。利用手順への影響を確認する |

CLIの全仕様を別の文書へ複写しない。詳細説明の正本を一か所に置き、入口からリンクする。
変更した挙動と説明を照合し、完了報告に更新先、または更新不要と判断した理由を短く残す。

## 検証と納品

- コード・CLI挙動の改修は全 `npm run smoke` 成功まで確認する。設定・スキル変更は `npm run agents:sync` → `npm run agents:check` → `npm run agents:test`。配布テンプレート変更はsmokeの生成検証も行う。
- テストは `local-test/` と隔離した一時領域のみ。顧客ドメインでは実行しない。実URL入りの `local-test/.env` があると索引のライブ取得が自動実行されるため、オフライン確認は `.env` の無い隔離コピーを使う。push E2Eを勝手に有効化しない。
- 機能実装・不具合修正は必要な検証と既存のローカル配布（npm linkとbuild）まで行う。文書・ルール・開発設定だけの変更には不要な版上げや再配布を行わない。
- 出力構造を変える必要があるときは、理由と案をユーザーに確認する。取得物を不要と判断して削除・再構成しない。
