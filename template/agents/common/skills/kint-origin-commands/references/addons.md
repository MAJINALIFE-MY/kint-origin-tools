# 外部アドオン

外部アドオンは、kint-origin の標準配布物に含めない共有コマンド・スキル・ルールを、開発者の管理する別フォルダから各ドメインへ接続する仕組みです。アドオンの正本は外部フォルダに置きます。ドメインには状態ファイル、AI向けの索引、シンボリックリンクまたはWindowsのジャンクションだけを作ります。

## 保存場所と設定

本体・ドメインから独立した外部フォルダを先に作り、各ドメインの `.env` に絶対パスを設定します。ドメインも本体の配下には置けません（`ADDON_CONFLICT`）。環境変数 `KINT_ORIGIN_ADDON_DIR` が設定されている場合は、`.env` より優先します。

```env
KINT_ORIGIN_ADDON_DIR=/path/to/kint-origin-addon
```

このフォルダはドメインの外、kint-origin 本体の外に置いてください。個人用・組織内用アドオンは、この外部フォルダの別Gitリポジトリで管理できます。kint-origin 本体のnpm配布物には、アドオンの内容やパスを含めません。

## コマンド

```powershell
kint-origin addon list
kint-origin addon create pj-management
kint-origin addon install pj-management
kint-origin addon update pj-management
kint-origin addon remove pj-management
kint-origin addon run pj-management <command> [...args]
```

`install`、`update`、`remove` は変更計画を表示して確認します。内容を確認・承認した場合だけ `-y` / `--yes` を付けます。アドオン管理処理と `addon list` は kintone API を呼びません。`addon run` の子コマンドは外部コードなので、kintone API を含むネットワーク通信が可能です。`kint-origin update` は通常のテンプレート更新確認にまとめて、インストール済みアドオンのリンクも同期します。

## アドオンの構成

`addon create <name>` は次の空の構成を外部フォルダに作ります。

```text
kint-origin-addon/
└── pj-management/
    ├── addon.json
    ├── commands/
    ├── rules/
    ├── skills/
    └── templates/
```

`addon.json` の形式は次のとおりです。`commands` のキーがCLIから指定するコマンド名になり、値はアドオンルートからの `.mjs` ファイルへの相対パスです。

```json
{
  "schemaVersion": 1,
  "name": "pj-management",
  "version": "0.1.0",
  "description": "Project management helpers",
  "commands": {
    "quote": "commands/quote.mjs"
  }
}
```

アドオン名は小文字の英数字とハイフンで指定します（先頭・末尾・連続のハイフンは不可、48 文字まで）。バージョンは `major.minor.patch` 形式です。エントリーファイルはアドオンフォルダ配下に置き、シンボリックリンクを含めないでください。

## スキルとルール

スキルのフォルダ名は `kint-origin-addon-<addon-name>` または `kint-origin-addon-<addon-name>-<用途>` とします。例えば `pj-management` の共通スキルは `kint-origin-addon-pj-management` です。`SKILL.md` のfrontmatterの `name` はフォルダ名と一致させてください。

インストール時はスキルが `.agents/skills/` と `.claude/skills/` にリンクされます。`kint-origin-addon-*` はアドオン用の予約名です。ドメイン独自のスキルには `kint-origin-local-<name>` を使います。Cursor向けには `.cursor/rules/kint-origin-addon-index.mdc` を生成し、アドオンのルール索引を作業開始時に読むよう案内します。CodexとClaude Codeには `AGENTS.md` / `CLAUDE.md` へ索引参照を生成します。

アドオンの `rules/` と `templates/` は外部ソースに残り、`.kint-origin/addons/linked/<name>/` から参照できます。各アドオンの `rules/` には、AIが読む手順や適用条件をMarkdownで記述してください。ルールはプロジェクト全体へ適用されるため、案件横断で使える内容にします。顧客固有情報や認証情報は含めないでください。

## コマンドの実行環境

アドオンコマンドはNode.jsの子プロセスとして実行します。シェルを介さず、コマンド引数をそのまま渡します。`addon run` の残りの引数は加工せず、アドオンコマンドへ転送します。

コマンドには次の環境変数を渡します。

| 環境変数 | 内容 |
| --- | --- |
| `KINT_ORIGIN_DOMAIN_ROOT` | 実行中ドメインの絶対パス |
| `KINT_ORIGIN_ADDON_ROOT` | 外部アドオンフォルダの絶対パス |
| `KINT_ORIGIN_ADDON_STATE_DIR` | ドメイン内のアドオン状態ディレクトリ |
| `KINT_ORIGIN_CLI_PATH` | kint-origin CLIエントリーポイント |

OS起動に必要な環境変数以外はアドオンプロセスへ継承しません。`.env` の認証値や `KINT_ORIGIN_ALLOW_*` はプロセス環境から渡しません。ただし、アドオンコマンドは実行ユーザーと同じファイルアクセス権で動き、ドメイン内のファイルを読み、ネットワークへ接続できます。`.env` を自分で読んだり、別プロセスや API を直接呼んだりすることも可能で、`KINT_ORIGIN_ALLOW_*` の制限や標準の push 確認はこの外部コードには適用されません。リンク先の更新は各ドメインから直ちに見えるため、`addon update` を実行する前でもコード・スキル・ルールの内容は変わります。信頼できるソースだけをインストールし、必要なファイルだけを扱うようにしてください。

## Gitと更新の保護

インストール時にドメイン `.gitignore` の管理ブロックへ次のパスを追加します。

- `.kint-origin/addons/` の状態・生成索引・リンク
- `.agents/skills/kint-origin-addon-*`
- `.claude/skills/kint-origin-addon-*`
- `.cursor/rules/kint-origin-addon-*`

既にGit追跡されているアドオン管理パスがあれば、インストールを止めます。独自に編集したリンク先は上書き・削除せず、状態ファイルや生成索引が登録後に編集されていた場合も処理を止めます。`remove` はドメイン内の管理リンクと登録を削除しますが、外部のアドオンソースは削除しません。

## v1の範囲

v1はローカルの外部フォルダをアドオンソースにします。ZIPのインポート、アドオンレジストリ、ネットワークからの自動更新は含めません。導入前にコードとルールをレビューしてから、外部フォルダへ配置してください。
