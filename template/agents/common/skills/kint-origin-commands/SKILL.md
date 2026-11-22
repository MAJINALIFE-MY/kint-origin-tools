---
name: kint-origin-commands
description: kint-originで設定やレコードを取得・閲覧する、プラグインのソースをaliasやIDから探す、結果を読む、監視グループや外部addonを使うときに、目的に合うコマンドと担当スキルを選ぶ。
---

# kint-originの操作を選ぶ

ドメインのフォルダで実行する。接続先と操作許可は `kint-origin policy` で確認し、`.env` は読まない・変更しない。

## 操作を選び、ヘルプを読む

| 目的 | コマンド・次に読むもの |
| --- | --- |
| 全アプリ索引とプラグイン一覧 | `pull index`。プラグイン一覧だけなら `pull plugins`。取得一覧とソース参照は [一覧とソース参照](../kint-origin-extend/references/plugins.md) |
| 共通設定・全体カスタマイズ | pull common / pull common --from <directory>。取得方法と入力形式は [共通設定の取得](references/common-settings.md) |
| アプリのレコードコメント | `pull comments --id <appId>[,<recordId>] [--guestspace <id>]`。全件取得は [pull skill](../kint-origin-pull/SKILL.md) |
| 設定の取得 | `pull app` / `pull kintone`、スペースは `pull spaces` / `pull guestspaces` / `pull tracked-spaces` |
| 選んだ対象の繰り返し取得 | `pull favorite`。設定は下の「お気に入りグループ」、レコード・コメントを含めるときは [pull skill](../kint-origin-pull/SKILL.md) |
| レコードCSV・添付の取得 | `pull records`。CSVはUTF-8 BOM、サブテーブルは先頭 `*` の行形式。全アプリ取得は [pull skill](../kint-origin-pull/SKILL.md) |
| ユーザー情報も取得 | `pull users` / `pull all`。個人情報の取得許可が必要 |
| アプリ・スペースの改修、新規作成 | `diff app` / `push app` / `diff space` / `push space` / `app create` / `diff create` / `push create`。実行準備の前に [push](../kint-origin-push/SKILL.md) |
| レコードの読み取り・更新・CSV取込 | `show records` / `diff records` / `push records` / `diff import` / `push import`。提案前に [records](../kint-origin-records/SKILL.md) |
| フォーム変更後の手動CSV確認 | `diff rehearsal --id <appId> [--import <ジョブ名>]`。手順は [rehearsal](../kint-origin-records/references/rehearsal.md) |
| ローカル閲覧 | `html`（`--open` でブラウザを開く） |
| プラグインのソースを探す | `show plugin-source --name <alias>` または `--id <pluginId>`。[一覧とソース参照](../kint-origin-extend/references/plugins.md) |
| パスワード暗号化値の発行 | `secret`。stdoutのenvLineを利用者が設定する |
| 外部addonの管理・実行・作成 | `addon`。接続前に [addonの仕様と手順](references/addons.md) |
| 独自スキル・ルールの追加・改名 | [extend](../kint-origin-extend/SKILL.md) |

選んだ操作の `kint-origin <コマンド> --help` を実行し、使えるオプションと必要な許可を確認する。オプションを推測しない。ヘルプは認証値・APIを使わない。
`pull app --a`、`pull records -y` はレコードと添付も確認なしで取得するため、必要な取得範囲を先に確認する。全アプリの records/comments は必ず [一括取得手順](../kint-origin-pull/SKILL.md) に従い、AI エージェントは実コマンドを起動せず、利用者が対話ターミナルから実行する。
`pull users` の許可なしで `pull all` は使えない。設定だけなら `pull kintone` を選ぶ。

## 許可・結果の判断

- `.env` の `KINT_ORIGIN_ALLOW_*` が操作を制限する。既定は設定取得のみ。レコードには `KINT_ORIGIN_ALLOW_PULL_RECORDS=true` が必要。全件取得は加えて `KINT_ORIGIN_ALLOW_BULK_RECORDS=true` とコマンド別の一度限り許可を使う。
- 必要な許可は個別ヘルプ、実効値は `policy` を読む。拒否されたら設定行を利用者へ伝え、環境変数や直接APIで回避しない。
- コマンド実行後は [結果の読み方](references/results.md) で、部分失敗・検証結果・終了コードを判断する。
- push提案・承認・復旧は担当スキルに従う。利用者にはドメインの README の「反映前の確認」と、対象コマンドの `--help` を案内できる。
- documentation MCPの警告は、接続済みのサービスがローカル設定から見えない場合もある。ユーザーに接続状況を確認し、AIが `.env` を変更しない。

## お気に入りグループ

`favorites/_example.json` を参考に `favorites/<グループ名>.json` を作る。`description` は任意、`apps`・`spaces`・`guestSpaces` の少なくとも1つに対象を入れる。
アプリは数値ID、または `{ "id": 303, "guestSpaceId": 10 }`。通常・ゲストスペースは数値IDの配列。IDは正の整数。
`pull favorite --name <グループ名>` で取得する。`--all` は `_` / `.` 始まりを除く全グループを合算する。ユーザー定義はupdateで上書きされない。
スペース配下と個別指定の重複はまとめられ、索引は追記される。範囲を絞った取得なので削除判定はしない。既定ではレコード・コメントを取得しない。アプリのデータを加える場合は `--with-records` / `--with-comments` と `--expect-host` を使い、必ず [pull skill](../kint-origin-pull/SKILL.md) に従う。データ対象は `apps` に明示したアプリだけ。

## データを探す

| 対象 | ドメインルートからのパス |
| --- | --- |
| 通常アプリ（通常スペース内も同じ） | `data/kintone/apps/app-<id>/` |
| ゲストアプリ | `data/kintone/spaces/guestspace-<spaceId>/apps/app-<id>/` |
| スペース | `data/kintone/spaces/space-<id>/`、ゲストは `guestspace-<id>/` |
| 索引・取得できなかった管理設定 | `data/kintone/index/apps.json`・`permission-denies.json` |
| レコードCSV・添付 | アプリ内 `records/records.csv`・`records/attachments/<recordId>/<fieldCode>/<filename>`。同じ元ファイル名の別添付や保存名の衝突は内容ハッシュ `-<sha256先頭12文字>` で区別し、フィールドごとの `.kint-origin-attachments.json` で管理する |
| ユーザー・グループ・組織 | `data/cybozu-common/` |
| HTMLビューア | `html/index.html` |

ブラウザの `/k/<appId>/` は通常アプリ、`/k/guest/<spaceId>/<appId>/` はゲストアプリ。取得物を根拠にするときは `git status data/` とdiffで未反映の編集を確認する。
`pull kintone` / `pull tracked-spaces` の削除判定は404のときだけ `data/kintone/deleted/` へ移す。403や一時障害を削除と判断しない。
添付の再取得は管理JSONに記録したファイルだけを整理する。管理外のファイルとハッシュが変わった管理ファイルは残り、JSONが不正な場合も推測で削除しない。
HTMLは毎回作り直される。マーカー付き `html/` に手作業のファイルを置かない。HTML本体や設定JSONにも業務情報が含まれるので公開しない。
