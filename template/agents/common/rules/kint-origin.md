---
description: kint-origin ドメインフォルダでの作業の基本ルール
alwaysApply: true
---

# kint-origin 作業ルール

このフォルダは `kint-origin` で取得した 1 ドメイン分の設定データを Git 管理する場所です。

## 基本方針

- データの取得・反映は必ず `kint-origin` コマンド経由で行う。`data/kintone/plugin/installed.json` は `pull index` が取得する一覧、`sources.json` と `sources.local.json` はソース参照台帳。
- まず何ができるかは `{{AGENT_SKILLS_DIR}}/skills/kint-origin-commands/SKILL.md`（コマンド索引）を参照する。
- 全アプリのレコード・コメント取得は `{{AGENT_SKILLS_DIR}}/skills/kint-origin-pull/SKILL.md` を必ず読む。AI エージェントは実取得コマンドを起動せず、利用者が対話ターミナルで実行する。
- 取得は対象ドメインのフォルダ内（cwd）で実行する。`data/` と `.env` は cwd 基準で解決される。

## 実行ポリシー（権限）

### シェルの使い方（確認を減らすために）

Claude の権限設定（settings.json）は、読み取り系のコマンドを単体なら自動で許可する。連結や `cd`・リダイレクトが付くと、許可済みのコマンドでも毎回ユーザー確認になるため、次を推奨する。

- ファイルの探索・閲覧・検索は、シェルより Read / Glob / Grep ツールを優先する（権限確認が出ない）。
- シェルを使うときは 1 回に 1 コマンドにする。`;`・`&&`・`|`・`$(...)` で連結しない。`cd` を付けない（作業ディレクトリは既にこのフォルダ。パスは `data/...` の相対で指定する）。`2>/dev/null` などのリダイレクトも付けない。
- 件数を絞るときは、パイプではなくコマンドのオプション（`find -maxdepth` など）か Grep ツールの絞り込みを使う。

### 参照系 / kint-origin

- **参照系コマンド**（`find` / `grep` / `rg` / `cat` / `ls` / `head` / `tail` / `wc` / `git status|log|diff`、PowerShell の `Get-Content` / `Get-ChildItem` / `Select-String` / `Test-Path` 等の読み取り専用）は自由に使ってよい（単体なら既定で許可される）。
- **`kint-origin` 系コマンドは、ユーザーの明示的な指示があるまで実行しない**。実行前に必ずユーザーへ確認する（API を消費し `data/` を変更するため）。
- `kint-origin` を確認する／実行するときは、**そのコマンド単体のシンプルな1行**で提示する。`cd`・`echo`・`find` などと連結しない。
  - 良い例: `kint-origin pull records --id 303`
  - 避ける: `cd xxx; echo ...; kint-origin pull records --id 303`

### 操作制限（.env の KINT_ORIGIN_ALLOW_*）

- `kint-origin` は `.env` の `KINT_ORIGIN_ALLOW_*` で許可された操作だけを実行する。未設定時は `pull kintone` 相当（アプリ設定・スペース）だけで、records・users・push は禁止。
- 実行可否を事前に知りたいときは `kint-origin policy` で実効値を確認してよい（ローカルのみ。API を使わない）。
- `操作制限:` で始まるエラーで拒否されたら、**`.env` を作成・変更しない**。環境変数での上書き、`dist/cli.js` の直接起動、別コマンドへの言い換えで回避しない。拒否された操作・エラーが示す設定行・目的をユーザーへ伝えて判断を仰ぐ。
- 全アプリの records/comments はコマンド別の `*_ALL_ONCE` を使う。利用者が設定した `true` は、CLI が対象確認後・データ API の前に自動で `false` に戻す。AI は `.env` を読み書きせず、キーの消費を回避・再設定しない。
- 代替案は、エラーが示すもの（`pull all` → `pull kintone`、`push app` → `diff app`）だけを、ユーザーの依頼範囲内で提案する。


## push の実行規約（最重要・環境を書き換える操作）

`kint-origin push`（`app` / `create` / `space` / `records` / `import`）は **kintone 環境そのものを書き換える危険コマンド**。
手順の詳細は `{{AGENT_SKILLS_DIR}}/skills/kint-origin-push/SKILL.md` を必ず読む。以下は絶対規約:

- **勝手に push しない**。`.env` で許可されていても、実行前に必ずユーザーの明示承認を得る。
- 承認を求めるときは、次の 5 点を提示する。
  1. 接続先と対象（アプリ・スペース・ドラフト・ジョブ）
  2. 対応する `kint-origin diff` の結果と変更の要約（レコード更新・CSV 取込はプレビュー CSV も示す）
  3. 反映の影響（反映先、反映のタイミング、未反映の他の変更や業務への影響）
  4. 復旧プラン（バックアップ先、戻し方、戻せない変更）
  5. 実行するコマンド単体 1 行（承認後に付ける `-y` を含めて提示する）
- 承認されたら、そのコマンドを**単体 1 行**で実行する。`-y` は、承認済みの内容を CLI の y/N 確認なしで反映するために付ける（承認のない `-y` は付けない）。
  Claude では hook の確認ダイアログ、Codex では承認ダイアログが出る。**Cursor では hook が push を拒否する**ため AI は実行せず、diff の結果とコマンドを提示してユーザー自身にターミナルで実行してもらう。
- push 前の事前条件: pull 済みで、編集を始める前の状態（pull 直後）が **git に commit 済み**であること（復旧の前提）。
- `push app` 実行後は結果 JSON と `git diff data/` を確認し、反映した変更をコミットして次の編集の基準にする（`push create` と `push space` は反映後に自動取得される結果を確認する）。
- 複数アプリを新規作成するときは依存順序（ルックアップ先が先）に注意する。`push create` は `{{app:名前}}` 参照から自動で順序解決する。
- 新規アプリのドラフトは `kint-origin app create --name <アプリ名>` で作る（API を呼ばず許可不要。アプリ ID は付かない。AI が実行してよい）。編集して `diff create` で確認し、公開は承認後に `push create` で行う（手順は kint-origin-push スキル）。

## レコード操作（show / diff / push records / push import）

- レコードの読み取り・更新・追加・添付コピーは、**シェルのループや REST API の直接呼び出しで処理しない**。対応関係を `push/records/<ジョブ名>/job.csv` に書き、`kint-origin diff records` → 承認 → `kint-origin push records` で CLI に処理させる。手順は `{{AGENT_SKILLS_DIR}}/skills/kint-origin-records/SKILL.md`（必読）。
- 大量の読み取り・バックアップ用途の全アプリ取得は、ジョブ実行と混同せず `{{AGENT_SKILLS_DIR}}/skills/kint-origin-pull/SKILL.md` の確認・許可・一度限り手順に従う。
- 複数レコードの読み取りも `kint-origin show records --id <appId> --records 12,15,18` の **1 コマンド**で行う（1 件ずつ繰り返さない）。
- 更新キー付き CSV の一括取込（kintone の「ファイルから読み込む」相当）は `push/import/<ジョブ名>/`（`import.json` と `records.csv`）に書き、`kint-origin diff import` → 承認 → `kint-origin push import` で行う。job.csv では更新キーによる上書き・追加はできない。
- フォーム変更後に別の検証用アプリで手動確認するCSVは `kint-origin diff rehearsal --id <appId> [--import <ジョブ名>]` で作る。手順は `{{AGENT_SKILLS_DIR}}/skills/kint-origin-records/references/rehearsal.md` を読む。生成CSVは利用者が画面から読み込み、AIは `push import` を実行しない。
- `push/records/<ジョブ名>/runs/` と `push/import/<ジョブ名>/runs/` は CLI が書く実行記録（バックアップ・結果。顧客データ）。**編集・作成しない・コミットしない**。

## data/ の作業コピー・プラグイン台帳とソース

- `data/` のアプリ・スペースは `kint-origin pull` が環境から取得した設定の作業コピー。**編集してよいのは、ユーザーに依頼されたアプリ・スペース改修のための push 対象ファイル**:
  `form/fields.json`・`form/layout.json`・`views/views.json`・`reports/reports.json`・`app_settings/`・`notifications/`・`acl/`、
  `customize/` のマニフェスト（`customize-manifest.json`）と `desktop|mobile/{js,css}/` の JS・CSS、
  スペースの `spaces/(space|guestspace)-<id>/(settings.json|body.html)`。
  それ以外の取得物（`app.json`・`space.json`・`apps.json`・`form/form.json`・`customize/plugins.json`・`customize/customize.json`・`customize/plugin-configs/`・`records/`・`index/`・`plugin/installed.json`・`.kint-origin-pull.json` など）は書き換えない。Claude では hook が強制する。
- 編集したら `kint-origin diff app --id <id>`（スペースは `kint-origin diff space --id <id>`）で差分を確認する。appの差分は編集前のGit基準とpull状態から算出し、API照合は行わない。`pull` はローカル編集を上書きせず保持する。
- **未 push の編集は環境の状態ではない**。問い合わせ調査などで `data/` を根拠にする前に `git status data/` を確認し、未コミットの編集があれば、環境の状態として断定しない。
- `data/.../app-<id>/_agentdata/` および `data/kintone/spaces/<space>/_agentdata/` は **AI 作業領域**（pull は一切書き込まない）。push 前バックアップ（`_agentdata/backup/`）・検討メモ（`_agentdata/notes/`）を置く。
  アプリ・スペースの修正・改修を検討するときは、**必ず対象の `_agentdata/` を先に確認**する（過去の検討経緯・push 履歴がある）。
- `favorites/`（`data/` の外）はお気に入りグループの定義（`pull favorite` の入力）。ユーザーに依頼されたら AI が作成・編集してよい（`_example.json` はツール管理の雛形なので編集しない）。
- `data/kintone/plugin/` のソース参照台帳とプラグインのソースは利用者が管理する。`installed.json` は取得物として編集しない。配置と登録は kint-origin-extend のプラグイン参照資料に従う。

- **`data/` の取得物にエージェントが新しいファイルを作らない・展開しない**（上記の push 対象ファイル、`_agentdata/`、`data/kintone/plugin/` を除く）。それ以外の手動の編集・整形・削除・移動・**ファイル生成**をしない（明示依頼がない限り）。
- zip / Excel(xlsx) などの**展開・変換・一時作業で生成するファイルは、リポジトリ外の一時ディレクトリ**に作る（Windows は `%TEMP%`、macOS / Linux は `$TMPDIR` や `mktemp -d`）。
  - 例: 添付の中身を確認したいだけなら、`data/...` 内で展開せず、一時ディレクトリにコピーして展開してから読む。
- 作業が終わったら一時ファイルは片付ける（残骸を `data/` やリポジトリ内に残さない）。
- 取得済み添付ファイル（`records/attachments/...`）の中身を見たいだけなら、まず Read ツールで直接開けるか試す。展開が必要な場合のみ一時ディレクトリで行う。

## 取得データ（CSV / JSON / 添付）の読み方

- `data/` 配下の取得物（`records.csv`・`*.json`・`*.md` などのテキスト）は **Read / Grep ツールで直接読む**。
- `records.csv` は **UTF-8 BOM**。引用符で囲んだフィールド内に**改行**が入ることがある（複数行入力・サブテーブル行）。
  - 全体を把握: Read で開く（大きいときは `offset` / `limit` で範囲読み）。
  - 特定レコードを探す: Grep（ただし複数行フィールドをまたぐ値はヒットしないことがある点に注意。前後行も Read で確認）。
- スクリプトで集計・変換するときは、生成物・中間ファイルを一時ディレクトリに置き、`data/` 配下に作らない。
- 添付の Excel(xlsx) / zip などバイナリは Read でそのまま読めないことがある。中身が要るときは**一時ディレクトリに展開**してから読む。

## 参照先

- どのコマンドで何を取得/反映できるか → 共通スキル `kint-origin-commands` を参照する。
- kintone REST API / JS API / カスタマイズ / Tips などの公式仕様 → kintone documentation MCP を使う（このフォルダの前提）。
  - 検索結果だけで判断せず、関連ページ本文を取得してから根拠にする。
  - MCP が使えないときは、そのことをユーザーに伝えて設定を依頼する（設定方法: https://cybozu.dev/ja/kintone/ai/kintone-documentation-mcp-overview/ ）。公式 Web 検索で補うのは、ユーザーが了承したときだけにする。
  - kint-origin の実行時に「kintone documentation MCP の設定が見つかりません」と出たら、同じくユーザーへ伝える。`.env` は変更しない。

## スキル・ルール・役割の追加

ユーザーに頼まれて、このドメイン用のスキル・ルール・役割を追加・改名するときは、先に `{{AGENT_SKILLS_DIR}}/skills/kint-origin-extend/SKILL.md` を読む。`kint-origin update` は配布物のパスだけを上書きするので、次の名前で置けば残る。

**名前**

- 配布物は、スキルの `kint-origin-commands`・`kint-origin-pull`・`kint-origin-push`・`kint-origin-records`・`kint-origin-extend` と、ルール・hook の `kint-origin.md`・`kint-origin-guard.mjs`・`kint-origin-guard-core.mjs`・`kint-origin.rules`。`kint-origin update` で上書きされるので編集しない。
- 独自のスキル・ルール・役割は **`kint-origin-local-<名前>`**（英小文字・数字・ハイフン。例 `kint-origin-local-monthly-report`）にする。`kint-origin update` は上書きも削除もしない。
- `kint-origin-addon-*` は外部addon（`kint-origin addon`）が管理する名前。手で作らない・コピーしない。
- これ以外の名前（接頭辞の無い名前、`kint-origin-local-` 以外の `kint-origin-` 接頭辞）で新しく作らない。hook が新規作成を拒否し、`kint-origin update` が警告する。拒否・警告が出たら、`kint-origin-extend` の手順で名前を直す。

**置き場**

- スキル：`{{AGENT_SKILLS_DIR}}/skills/kint-origin-local-<名前>/SKILL.md`。ほかの AI ツールでも使うときは、そのツールのスキル置き場にも同じフォルダを置く（ツールごとの置き場は `kint-origin-extend` スキルで確認する）。`SKILL.md` の先頭に YAML の `name`（フォルダ名と同じ）と `description`（何をするか・いつ使うか）を書く。
- ルール：Claude Code は rules の `kint-origin-local-<名前>.md` を起動時に読む（`.mdc` は読まれない。このファイルも Claude の rules にあるときは自動で読まれる）。Cursor は `.cursor/rules/kint-origin-local-<名前>.mdc` を読み、`.agents/rules/` は自動では読まない。Codex は markdown のルールを持たず AGENTS.md を読むので、確実に読ませたい独自の内容は `kint-origin-local-*` のスキルに書く。
- 独自の指示を `{{AGENT_DOC}}` に書かない（`kint-origin update` で上書きされる）。`kint-origin-local-*` のスキルに書く。
- サブエージェント（役割）: 使うツールのドキュメントが定める置き場に、名前を `kint-origin-local-` で始めて置く（形式もツールで違う）。配布物は役割を含まないので `kint-origin update` は触らない。
- 個人の許可・設定は、配布の設定ファイルではなく、ツールの個人用の設定ファイルに書く（配布の設定ファイルは `kint-origin update` で上書きされる）。

**追加物が弱めてはいけない安全条件**

- `kint-origin push`（app / create / space / records / import）は、ユーザーが内容を承認してから実行する。追加するスキル・ルールに、承認を省く手順を書かない。
- `.env` を作成・変更・読み取りしない。許可の変更が必要なら、必要な設定行をユーザーに伝えて依頼する。
- `data/` の取得物を手作業で書き換えない。認証情報・個人情報・顧客データをスキルやルールに書かない。
- hook・共有判定（`.agents/hooks/kint-origin-guard-core.mjs`）・権限設定・実行ポリシー（ガードの hook と、そのツールの設定ファイル）を編集しない。

> ルール/スキル/この文書はツール側テンプレートの正本から生成されています。最新化は `kint-origin update`。
