# 共通設定・カスタマイズの取得

`data/kintone/common/` は、アプリに属さない kintone 共通設定を Git で管理する場所です。

## API で取得する設定

```sh
kint-origin pull common
```

このコマンドはプラグイン一覧 API を呼び出し、インストール済みプラグインを `data/kintone/plugin/installed.json` に、インストール必須プラグインを `data/kintone/common/plugins/required.json` に保存します。取得完了後は通常の `git status` と `git diff` で差分を確認できます。必要な権限は `pull:kintone` です。

## 手動で保存する共通カスタマイズ

`kint-origin init` は次の保存先を作成します。システム管理画面から取得した JavaScript / CSS カスタマイズは、対応するフォルダーへ直接保存できます。

```text
data/kintone/common/customize/
  desktop/
    js/
    css/
  mobile/
    js/
    css/
```

## 設定やテンプレートを取り込む場合

kintone のシステム管理画面にあるカスタマイズの manifest や、REST API が提供されていない管理設定・テンプレートをまとめて取り込む場合は、管理画面から取得し、まず画面上で設定値を JSON に転記して次の構成で保存します。

```text
captures/kintone-common/
  customize/
    customize-manifest.json
    desktop/js/example.js
    desktop/css/example.css
    mobile/js/example.js
    mobile/css/example.css
  settings/
    user-management.json
    notifications.json
  templates/
    apps/index.json
    apps/example.zip
    spaces/index.json
    spaces/example.sptpl
```

カスタマイズの manifest は次の形です。ローカルファイルは `customize/` からの相対パスで記し、URL 登録のものは `http(s)` の URL を記します。

```json
{
  "scope": "ALL",
  "desktop": {
    "js": ["desktop/js/example.js"],
    "css": ["https://example.invalid/custom.css"]
  },
  "mobile": {
    "js": [],
    "css": []
  }
}
```

テンプレートの `index.json` は取り込む ZIP または kintone のスペーステンプレート `.sptpl` のファイル名を列挙します。

```json
{
  "archives": ["example.sptpl"]
}
```

取り込んだ ZIP / `.sptpl` は保持し、ZIP 内の JSON ファイルは拡張子を除いた archive 名のディレクトリへ整形して展開します。

準備後に実行します。

```sh
kint-origin pull common --from captures/kintone-common
```

これはローカルだけで動くため、認証情報・ネットワーク・`.env` を使いません。`--from` には別の入力ディレクトリも指定できます。取り込み先は常に `data/kintone/common/` です。

取り込み結果は次の場所に保存されます。

- `data/kintone/common/customize/` — manifest とローカル JavaScript / CSS
- `data/kintone/common/settings/` — 管理画面から転記した設定 JSON と管理索引
- `data/kintone/common/templates/apps/` — アプリテンプレート ZIP、ZIP 内 JSON、管理索引
- `data/kintone/common/templates/spaces/` — スペーステンプレート ZIP、ZIP 内 JSON、管理索引

入力に含まれないカテゴリは前回の結果を残します。入力にカテゴリを含めた場合はそのカテゴリを同期し、設定ディレクトリが空なら設定 JSON を空にし、テンプレート索引の `archives: []` はその種類のテンプレートを空にします。前回の索引が管理していたファイルだけを削除し、未管理ファイルは上書きしません。ZIP は 100 MB 以下、ZIP 内の各エントリは 20 MB 以下にしてください。

## アプリのレコードコメント

```sh
kint-origin pull comments --id 303
kint-origin pull comments --id 303,1201
```

アプリ ID だけを渡すと全レコードのコメントを取得し、`<app directory>/comments/record-<recordId>.json` に保存します。アプリ索引からスペース位置を解決します。ゲストスペースのアプリが索引にない場合は `--guestspace <guestSpaceId>` を指定してください。対象アプリ・レコードを閲覧できる権限が必要です。機密情報を含むコメントがある場合は、そのアプリの data を Git で共有する範囲に注意してください。

## スペースのスレッド

kint-origin はスレッド本文・投稿コメントを API 取得しません。スペースを取得すると `data/kintone/spaces/(space|guestspace)-<id>/threads/` を用意します。必要な資料は利用者がこのフォルダーに置いてください。通常の Git 差分に含まれます。
