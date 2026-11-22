# プラグイン一覧とソース参照

## 取得一覧

`kint-origin pull index` と `kint-origin pull plugins` はインストール済みプラグイン一覧を `data/kintone/plugin/installed.json` に保存する。`pull plugins` は一覧だけを更新し、アプリ索引とソース参照台帳には触れない。内容は `GET /k/v1/plugins.json` の応答と同じ `{ "plugins": [...] }` 形式で、各プラグインの `id`、`name`、`description`、`isMarketPlugin`、`version` を保持する（[公式API仕様](https://cybozu.dev/ja/kintone/docs/rest-api/plugins/get-plugins/)）。100件ずつ全ページを取得し、再実行すると最新の一覧に置き換える。取得エラー時は既存ファイルを保持する。

この一覧は取得データなので、AIは編集しない。プラグインのID・名前・説明・バージョンを調べるときはこのファイルを読む。

## ソース参照を登録する

ドメインで共有する参照先は `data/kintone/plugin/sources.json` に配列で登録する。ここには参照先が分かっているプラグインだけを置く。未登録のプラグイン情報は `installed.json` にあるため、名前やバージョンだけの項目を `sources.json` に作らない。

```json
[
  {
    "alias": "ganttchart",
    "githubUrl": "https://github.com/kintone-samples/plugin-samples",
    "githubPath": "examples/ganttchart"
  }
]
```

`alias` は `--name` で参照先を照会するための任意の短い管理名。名前を決めにくい場合は省略し、確認済みの `pluginId` で照会する。IDが分からない場合にIDを推測したり、仮のIDを作ったりしない。IDが確認できた場合は同じ項目へ `pluginId` を追加する。

```json
[
  {
    "alias": "ganttchart",
    "pluginId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "githubUrl": "https://github.com/kintone-samples/plugin-samples",
    "githubPath": "examples/ganttchart"
  }
]
```

- 参照先には `path` または `githubUrl` のどちらかを指定する。`path` は `data/kintone/plugin/` 基準の `/` 区切り相対パスで、配下のファイル・ディレクトリを指す。個人用台帳では絶対パスも使える。
- `githubUrl` は `https://github.com/<owner>/<repo>` 形式。リポジトリ内のフォルダやファイルは任意の `githubPath` に `/` 区切り相対パスで指定する。
- `pluginId` は `installed.json` などで確認した小文字32文字の実IDを指定する。`alias` と `pluginId` はどちらも任意だが、少なくとも一方は必要。
- 個人用の参照先は `data/kintone/plugin/sources.local.json` に同じ `alias` または `pluginId` を指定して登録する。個人用が共有項目に一致した場合は参照先が優先され、共有側の `alias`・`pluginId` のうち省略した値を引き継ぐ。`sources.local.json` はGit除外される。
- `init`・`update` は `sources.json` がなければ `[]` の雛形を作成し、同じディレクトリの `.gitignore` で個人用台帳を除外する。`pull index` も雛形がなければ作るが、既存のソース参照は変更しない。

## ソースを調べる

ドメインルートで `alias` または確認済みのプラグインIDから照会する。

```bash
kint-origin show plugin-source --name ganttchart
kint-origin show plugin-source --id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

`path` が返ったら、そのファイルまたはフォルダを参照する。`githubUrl` が返ったら、アクセス権のあるアカウントでGitHubを参照し、`githubPath` があればそのファイルまたはフォルダを開く。手元で読む必要がある場合は、例えば別の作業フォルダで `gh repo clone https://github.com/kintone-samples/plugin-samples` を使う。[GitHub CLIの公式例](https://cli.github.com/manual/gh_repo_clone)

IDで照会した結果が `no-source` の場合、プラグインは `installed.json` にありますが、`sources.json` に参照先がありません。参照先が分かった時点で台帳に追加します。
