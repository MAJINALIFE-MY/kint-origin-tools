<!-- このファイルは {{AGENT_NAME}} 用の {{AGENT_DOC}} です（kint-origin が生成）。 -->
<!-- 直接編集せず、テンプレ更新は `kint-origin update` で反映してください。 -->

# {{AGENT_DOC}} — kintone ドメインデータ作業フォルダ

<!-- kint-origin:addon-index:v1 -->
`.kint-origin/addons/INDEX.md` が存在する場合は作業前に読み、外部addonから導入されたプロジェクト横断ルールに従う。
<!-- /kint-origin:addon-index:v1 -->

このフォルダは 1 つの cybozu.com ドメインの設定情報を `kint-origin` で取得し、Git 管理する作業フォルダです。
{{AGENT_NAME}} がこのフォルダで作業するための前提とルールをまとめています。

## 絶対ルール

- ファイルは UTF-8 として扱う（日本語の文字化け防止）。
- `data/` のアプリ・スペースは `kint-origin` の API 取得物の作業コピー。ユーザーに依頼されたアプリ改修のための push 対象ファイルと `data/kintone/plugin/` の台帳・ソースは編集できる
  （それ以外は手作業で編集・整形・削除・移動しない）。未 push の編集が入っていることがあるため、`data/` を環境の状態の根拠にする前に `git status data/` で確認する。
- `.env` には認証情報と操作制限（`KINT_ORIGIN_ALLOW_*`）が含まれる。コミットしない・出力に含めない・作成や変更をしない。全件取得キーだけは、利用者が設定した `true` を CLI が確認後に自動で `false` に戻す。
- `kint-origin` は `.env` で許可された操作だけを実行できる（既定は `pull kintone` 相当のみ）。`操作制限:` で拒否されたら回避せず、
  必要な設定行をユーザーへ伝えて判断を依頼する（詳細は `{{AGENT_RULES_DIR}}/rules/kint-origin.md`）。
- 取得・反映は必ず `kint-origin` コマンド経由で行う（取得済み JSON を推測で書き換えない）。
- **`kint-origin push`（app / create / space / records / import）は kintone 環境を書き換える危険コマンド。勝手に実行しない。**
  実行前に対象・`kint-origin diff` の結果・反映の影響・復旧プラン・実行コマンドを提示し、ユーザーの明示承認を得る。
  承認後に単体 1 行で実行し、`-y` は承認済みの内容を CLI の確認なしで反映するために付ける（Cursor では hook が push を拒否するため、ユーザーが自分のターミナルで実行する）。
- アプリの修正・改修は最新を `kint-origin pull app --id <id>` で取得し、pull結果をGitに保存してから `data/.../app-<id>/` のpush対象を編集し、`kint-origin diff app --id <id>` で確認する（スペースは `data/kintone/spaces/(space|guestspace)-<id>/` の `settings.json`・`body.html` を編集して `kint-origin diff space --id <id>` で確認する）。
  検討メモ・バックアップは `_agentdata/`（AI 作業領域。pull 不干渉）に置き、着手時に必ず対象の `_agentdata/` を確認する。
- 作業の詳細ルール（シェルの使い方・`data/` の編集範囲・作業ファイルの置き場・取得データの読み方）は
  `{{AGENT_RULES_DIR}}/rules/kint-origin.md` に従う。

## 状況別に参照するもの

- kint-origin のコマンドで何ができるか・どれを使うか
  → [kint-origin-commands]({{AGENT_SKILLS_DIR}}/skills/kint-origin-commands/SKILL.md)（コマンド索引・全員共通スキル）
- 特定のアプリ・スペースだけを繰り返し取得したい（監視グループ）
  → `favorites/<グループ名>.json` を作成・編集して `kint-origin pull favorite --name <グループ名>`
  （書き方は [kint-origin-commands]({{AGENT_SKILLS_DIR}}/skills/kint-origin-commands/SKILL.md) の「お気に入りグループ」）
- kintone へ設定を反映（push）する手順・用意するファイル・復旧プラン・承認の取り方
  → [kint-origin-push]({{AGENT_SKILLS_DIR}}/skills/kint-origin-push/SKILL.md)（push を提案・実行する前に必読）
- レコードの読み取り・更新・追加・添付ファイルのコピー（ジョブ CSV で、レコード ID・フィールド単位）
  → [kint-origin-records]({{AGENT_SKILLS_DIR}}/skills/kint-origin-records/SKILL.md)（レコード操作を提案・実行する前に必読）
- 全アプリのレコード・コメント、またはお気に入りアプリのデータ一括取得
  → [kint-origin-pull]({{AGENT_SKILLS_DIR}}/skills/kint-origin-pull/SKILL.md)（一括取得を提案する前に必読。全アプリ取得は利用者の対話ターミナルで実行）
- kintone REST API / JS API / カスタマイズ / Tips などの公式仕様
  → kintone documentation MCP を使う（このフォルダの前提）。検索だけで判断せず、関連ページ本文を取得してから出典（URL/path・該当節・参照日）を残す。
  MCP が使えないときは、そのことをユーザーに伝えて設定を依頼する（設定方法: https://cybozu.dev/ja/kintone/ai/kintone-documentation-mcp-overview/ ）。公式 Web 検索で補うのは、ユーザーが了承したときだけにする。
- 作業の基本ルール → `{{AGENT_RULES_DIR}}/rules/kint-origin.md`
- ドメイン専用プラグインのソースを置く、ID未確認のソースを登録する、またはソースを探す
  → [プラグインの置き場とソース参照]({{AGENT_SKILLS_DIR}}/skills/kint-origin-extend/references/plugins.md)
- このドメイン用のスキル・ルール・役割を追加・改名する（独自の指示を書き足したいときも）
  → [kint-origin-extend]({{AGENT_SKILLS_DIR}}/skills/kint-origin-extend/SKILL.md)（名前は `kint-origin-local-<名前>`。`kint-origin-*` の配布スキルとこの `{{AGENT_DOC}}` は `kint-origin update` で上書きされるため、独自の指示はここに書かず `kint-origin-local-*` のスキルに書く。`kint-origin-addon-*` は外部addon用に予約）
  書式・置き場・弱めてはいけない安全条件は `{{AGENT_RULES_DIR}}/rules/kint-origin.md` の「スキル・ルール・役割の追加」

- コマンド実行後のJSON・終了コード・部分失敗の判断
  → [結果の読み方]({{AGENT_SKILLS_DIR}}/skills/kint-origin-commands/references/results.md)
