# kint-origin-tools

cybozu.com / kintoneの設定をドメインごとのローカルフォルダへ取得し、Gitで差分を管理する非公式CLIです。設定・レコードの差分確認と反映、ローカルHTMLでの閲覧、Claude・Codex・Cursor向けの作業設定を扱います。サイボウズ株式会社の公式ツールではありません。

このツールはα版です。不具合が残っている前提で使ってください。

Node.js 22以上、npm、Gitが必要です。認証はユーザー名とパスワードです。認証情報・取得データは非公開で管理してください。[安全上の前提](SECURITY.md) と [ライセンス](LICENSE) を確認してから使ってください。

## 導入

ソースをクローンするかZIPを展開し、`package.json` があるディレクトリで実行します。

```bash
npm ci
npm link
```

`npm ci` のprepareでビルドします。本体更新後は `npm run build`。Windows PowerShellで `npm.ps1` が拒否される場合は `npm.cmd` を使います。依存としてのtarball導入より、このソースからの利用を推奨します（cli-kintoneの配置に依存します）。

新しいドメインは、本体の外に作業フォルダを作り、現行版の `kint-origin init` から始めます。旧版のコマンド名や設定キーの移行はサポート範囲外です。

```bash
mkdir my-domain
cd my-domain
kint-origin init
```

既に `.gitignore` があるフォルダでは、既存の行を残したまま `.env` などの除外を追記します。利用者が `.env.example` を `.env` へコピーし、接続先と許可を設定します。[設定雛形](template/.env.example) が設定項目の正本です。`CYBOZU_BASE_URL` は `https://<サブドメイン>.cybozu.com` のようにoriginだけを指定し、パス・クエリ・フラグメントは付けません。値の後ろにコメントを書かないでください。シェルの接続設定は `.env` より優先されます。

`pull index` はアプリ索引とインストール済みプラグインの一覧を取得し、プラグイン一覧をAPI応答形式の `data/kintone/plugin/installed.json` に保存します。プラグイン一覧だけを更新するときは `pull plugins` を使います。ソース参照は `data/kintone/plugin/sources.json` で別に管理します。

```bash
kint-origin policy
kint-origin pull index
kint-origin pull app --id 303
kint-origin html --open
```

`data/` と `.env` は実行フォルダ基準です。IDは自分の環境のものへ置き換えます。必要な許可は `kint-origin <コマンド> --help` で確認できます。`secret` はパスワードの暗号化値を発行するローカルコマンドで、`.env` は書き換えません。

プロキシはシェルで設定します。本体のfetchは `NODE_USE_ENV_PROXY=1` と `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`、cli-kintoneは `HTTPS_PROXY` を使います（Nodeの環境プロキシは22.21.0以降）。

## 目的から読む

コマンドとオプションは `kint-origin --help`、個別操作は `kint-origin pull app --help` のように確認します。ヘルプは認証値・APIを使いません。

| 目的 | 作業手順の正本 |
| --- | --- |
| 取得・閲覧・コマンドを選ぶ | [commandsスキル](template/agents/common/skills/kint-origin-commands/SKILL.md) |
| 結果JSON・終了コードを読む | [結果の読み方](template/agents/common/skills/kint-origin-commands/references/results.md) |
| アプリ・スペースの設定を変更する | [pushスキル](template/agents/common/skills/kint-origin-push/SKILL.md) |
| レコードの読み取り・更新・CSV取込・復旧 | [recordsスキル](template/agents/common/skills/kint-origin-records/SKILL.md) |
| 独自スキル・ルールを追加する | [extendスキル](template/agents/common/skills/kint-origin-extend/SKILL.md) |
| ドメイン専用プラグインを置く・ソースを探す | [プラグインの置き場とソース参照](template/agents/common/skills/kint-origin-extend/references/plugins.md) |
| 外部addonを利用・作成する | [addonの仕様と手順](template/agents/common/skills/kint-origin-commands/references/addons.md) |
| 反映内容を人が確認・承認する | [反映前の確認](template/README.md#反映前の確認) |

ドメインでは `init` が配るREADMEとAI設定から、同じスキルへ辿れます。[ドメインREADMEの雛形](template/README.md) も参照できます。初期化済みのドメインで配布設定を同期するときは `kint-origin update` を使います。変更予定を表示し、確認後に反映します。独自追加は `kint-origin-local-*`、共有addonは `kint-origin-addon-*` を使います。

`push` は kintone 環境を書き換えます。対象・差分・反映の影響・復旧方法・実行するコマンドを確認してから承認してください。

## 本体を開発する

開発用の入口はソース内のAGENTS.mdです。作業別スキルからコード・テスト・担当する説明を同じ作業で更新します。

ZIPから展開したソースを検証する場合は、先にそのディレクトリで `git init` を実行します。smokeはGitの除外設定も検査します。

```bash
npm run agents:sync
npm run agents:check
npm run agents:test
npm run smoke
```

オフラインsmokeは `.env` の無い隔離コピーで行います。実URL入りの `local-test/.env` があるとライブの索引取得も実行されます。本体ルートで `kint-origin init` / `update` は実行しません。検証・ソース公開の手順は開発用スキルから参照します。

ソース公開を目的とする個人用ツールです。不具合報告・機能要望・外部からのプルリクエストを受け付ける窓口は設けていません。継続的な保守や修正期限は保証しません。保守対象は最新の版のみです。
