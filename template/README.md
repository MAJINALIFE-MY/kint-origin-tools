# kint-origin domain project

このフォルダは1つのcybozu.comドメインの設定・レコードを `kint-origin` で扱う非公開の作業フォルダです。`data/` と `.env` はこのフォルダ基準です。使う `kint-origin` はα版です。不具合が残っている前提で操作してください。

## 最初の設定

利用者が `.env.example` を `.env` へコピーし、接続先・ユーザー名・パスワード・操作許可を設定します。AIには `.env` を渡さず、作成・読み取り・変更をさせません。全アプリ一括取得の一度限り許可だけは、利用者が設定した `true` を CLI が確認後に自動で `false` に戻します。設定項目は [.env.example](.env.example) を参照してください。値の後ろにコメントを書かないでください。

`pull index` はアプリ索引とインストール済みプラグインの一覧を取得し、プラグイン一覧を `data/kintone/plugin/installed.json` に保存します。

```bash
kint-origin policy
kint-origin pull index
kint-origin pull app --id 303
kint-origin html --open
```

IDはこの環境のものへ置き換えます。接続先表示を確認してください。シェルの接続設定は `.env` より優先されます。必要な許可と使えるオプションは `kint-origin <コマンド> --help` で確認できます。許可不足は利用者が設定し、AIは回避しません。

`kint-origin secret` はパスワードの暗号化値を発行します。出力の `envLine` を利用者が `.env` へ設定してください。別のマシン・ログインユーザーでは再発行が必要です。マシン識別値は秘密鍵ではなく、認証情報の管理は引き続き必要です。

## 目的から読む

次のリンクはこのフォルダへ配布された資料です。Claudeには `.claude/skills/`、Codex・Cursorには `.agents/skills/` に同じスキルを配布します。

| 目的 | 読むもの |
| --- | --- |
| 取得・閲覧・操作を選ぶ | [commands](.agents/skills/kint-origin-commands/SKILL.md) |
| 全アプリのレコード・コメントを一括取得する | [pull](.agents/skills/kint-origin-pull/SKILL.md) |
| 結果JSON・終了コード・失敗を判断する | [結果の読み方](.agents/skills/kint-origin-commands/references/results.md) |
| アプリ・スペースの設定を変更する | [push](.agents/skills/kint-origin-push/SKILL.md) |
| レコードの読み取り・更新・CSV取込・復旧 | [records](.agents/skills/kint-origin-records/SKILL.md) |
| 独自のスキル・ルール・役割を追加する | [extend](.agents/skills/kint-origin-extend/SKILL.md) |
| ドメイン専用プラグインを置く・ソースを探す | [プラグインの置き場とソース参照](.agents/skills/kint-origin-extend/references/plugins.md) |
| 外部addonを利用・作成する | [addon](.agents/skills/kint-origin-commands/references/addons.md) |
| 人が反映を確認・承認する | [反映前の確認](#反映前の確認) |

AIは `AGENTS.md` / `CLAUDE.md` とツール別ルールから作業を始めます。公式API仕様はkintone documentation MCPで確認します。スキルの参照資料は、そのスキルで指定された作業のときに読みます。

## 作業ファイルと反映

- アプリ設定は、最新を `pull app` で取得した後に取得状態を Git commit し、その commit を基準に編集・反映します。`diff app` は Git 差分だけを確認し、APIを呼びません。`push app` は変更されたアプリ設定と customize だけを送信します。pull後に環境側で同じ設定が変わっていても、ローカルの変更で上書きされます。スペース設定は、接続先の現在値とローカルで編集した内容との差分を確認します。
- 検討メモは各アプリ・スペースの `_agentdata/`、新規ドラフトとレコードジョブは `push/`、監視対象グループは `favorites/` です。
- インストール済みプラグインの一覧は `kint-origin pull index` で `data/kintone/plugin/installed.json` に取得します。ソース参照は `data/kintone/plugin/sources.json`、端末ごとの参照先はGit除外される `data/kintone/plugin/sources.local.json` に登録します。ドメイン専用プラグインのソースは `data/kintone/plugin/<名前>/` に置きます。
- `runs/` はCLIの実行記録です。AIは編集しません。
- このリポジトリは非公開にします。設定JSON・HTML・バックアップ・ジョブ入力も機密情報を含み得ます。`.gitignore` だけで公開可否を判断しないでください。既定ではHTML本体・`_agentdata/`・job.csv・import.jsonや `.env` の派生ファイルは除外されません。

## 反映前の確認

### 1. 何が変わるか確認する

ドメインのフォルダで、作業に合った `diff` を実行します。例の ID、ドラフト名、ジョブ名は実際の対象に置き換えてください。

| 変えるもの | 最初に実行するコマンド |
| --- | --- |
| 既存アプリの設定・JS/CSS | `kint-origin diff app --id 303` |
| フォーム変更後の手動CSV確認 | `kint-origin diff rehearsal --id 303` |
| 新規アプリ | `kint-origin diff create --name 顧客管理` |
| スペースの設定・本文 | `kint-origin diff space --id 12` |
| レコード更新・追加 | `kint-origin diff records --name 添付移行` |
| 更新キー付きのCSV取込 | `kint-origin diff import --name 社員取込` |

接続先と対象が合っているか、変更内容が意図どおりかを見ます。アプリ設定は `diff app --base <pull後のcommit>` で Git 基準からの変更を確認します。push app は同じ設定への pull 後の変更を照合せず、ローカル内容で上書きします。レコード更新やCSV取込では、更新・追加の件数を確認し、表示されたパスの `preview.csv` で変更前後を見ます。

フォーム変更後に別の検証用アプリでレコードを確認する場合は、[rehearsal手順](.agents/skills/kint-origin-records/references/rehearsal.md) に従います。CSVを生成した後、検証用アプリの画面から読み込みます。

### 2. いつ反映され、どう戻せるか確認する

アプリ設定（JS/CSS を含む）と新規アプリは既定で運用環境まで反映します。動作テスト環境で止めるには `--no-deploy` を使います。運用環境への反映（deploy）では、ほかの人が保存した未反映の変更も一緒に反映されます。スペース・レコード・CSV取込は運用環境へ直接書き込まれます。使っている人への影響、バックアップ先、戻し方と戻せない変更を確認してください。

### 3. 確認したコマンドで実行する

AIから承認を求められたら、対象・差分・反映の影響・復旧方法・実行コマンドが揃っているか確認します。`-y` は CLI の確認を省略します。自分で反映するときは `-y` を付けずに実行し、表示された内容を見て承認を判断します。Cursorでは、自分のターミナルで実行してください。

使うコマンドを探すには `kint-origin push --help`、引数・必要な許可を見るには `kint-origin push import --help` のように対象を指定します。現在の許可は `kint-origin policy` で確認できます。入力ファイルは [アプリ・スペースの編集対象](.agents/skills/kint-origin-push/references/files.md) と [レコード操作の入力仕様](.agents/skills/kint-origin-records/SKILL.md) を参照してください。

失敗やタイムアウトの後は、一部だけ反映されている場合があります。[結果の読み方](.agents/skills/kint-origin-commands/references/results.md) に沿って、結果と環境の状態を確認してから復旧や再実行を判断します。

## 配布設定を更新する

本体更新後、このフォルダで `kint-origin update` を実行し、上書き予定を確認します。`README.md`・`AGENTS.md`・`CLAUDE.md`・配布スキル・ルール・hook・`_example` は更新されます。`data/`・`.env`・独自ジョブ・生成対象外のファイルは対象外です。

独自追加は `kint-origin-local-*` に置きます。配布ファイルへ直接追記すると次のupdateで失われます。`.claude/settings.local.json` などの個人設定は別に管理してください。外部addonのソースはドメインの外に置き、信頼したものだけを接続します。

## 共通設定とコメントの取得

`kint-origin init` は共通カスタマイズの保存先 `data/kintone/common/customize/` にデスクトップ・モバイル用の JavaScript / CSS フォルダーを作成します。システム管理画面から取得したファイルは対応するフォルダーへ手動で保存してください。`kint-origin pull common` は共通プラグイン情報の取得などに使えます。設定 JSON やテンプレートをまとめて取り込む方法は、配布スキルの `kint-origin-commands/references/common-settings.md` を参照してください。

`kint-origin pull comments --id <appId>[,<recordId>]` はレコードコメントを各アプリの `comments/` に保存します。取得するアプリやレコードの閲覧権限を確認し、コメントを含む data を Git で共有する範囲を管理してください。

全アプリのレコード・コメントは `pull records --all-indexed` / `pull comments --all-indexed` で個別に取得します。完全索引・ホスト・対象を確認し、実行時は対話承認とコマンド別の一度限り許可が必要です。詳しくは [一括取得スキル](.agents/skills/kint-origin-pull/SKILL.md) を参照してください。`pull kintone` はレコード・コメントを取得しません。
