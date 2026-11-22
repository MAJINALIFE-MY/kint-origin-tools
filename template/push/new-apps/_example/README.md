# 新規アプリドラフトの書き方（_example）

このフォルダは `kint-origin push create` の**雛形**です（`_` 始まりのフォルダは push 対象外）。
新規アプリを作るときは、`kint-origin app create --name <アプリ名>` で空欄のドラフトを作るか（API を呼ばず許可不要）、このフォルダを `push/new-apps/<アプリ名>/` にコピーして編集してください。

```
push/new-apps/顧客管理/
  app.json            # 必須。アプリ名・作成先スペース
  form/fields.json    # 任意。フィールド定義（pull 出力と同じ形式）
  form/layout.json    # 任意。フォームレイアウト
  views/views.json    # 任意。一覧の定義
  ...                 # そのほか pull 出力と同じ相対パスの設定 JSON を置ける
```

- **ファイル形式は pull の出力と同一**。既存アプリの取得物（`data/kintone/apps/app-<id>/`）を
  丸ごとコピーしてドラフト化することもできます（`app.json` はこの雛形の形式に置き換える）。
- 実行: `kint-origin push create --name 顧客管理`（まず `kint-origin diff create --name 顧客管理` で作成順・参照を確認することを推奨。API を呼ばず許可不要）。
- 作成後はフォルダ内に `created.json`（作成済みマーカー）が書かれます。以後の変更は
  pull された `data/.../app-<新id>/` の設定ファイルを編集し、`kint-origin diff app` で確認して `kint-origin push app` で行ってください。

## app.json（必須）

```json
{
  "name": "顧客管理",
  "space": "12",
  "thread": "",
  "guestSpaceId": ""
}
```

- `name`: アプリ名（必須）
- `space`: 作成先スペース ID（省略時はスペース外に作成。`thread` 省略時はスペースの既定スレッド）
- `guestSpaceId`: ゲストスペースに作る場合のみ指定

## 別アプリへの参照（ルックアップ等）は `{{app:名前}}` で書く

appId を直書きせず、プレースホルダで書くと push 時に自動解決されます。
名前には「他ドラフト名／既存アプリのコード／索引上一意なアプリ名／appId」が使えます。

```json
"顧客名": {
  "type": "SINGLE_LINE_TEXT",
  "code": "顧客名",
  "label": "顧客名",
  "lookup": {
    "relatedApp": { "app": "{{app:顧客マスタ}}" },
    "relatedKeyField": "会社名",
    "fieldMappings": [],
    "lookupPickerFields": ["会社名"],
    "filterCond": "",
    "sort": "会社名 asc"
  }
}
```

> **注意（組み込みフィールドのコード）**: 組み込みフィールド（レコード番号・作成者・作成日時・更新者・更新日時・ステータス・作業者・カテゴリー）は、
> kintone がアプリの作成時に自動で作り、フィールドの追加 API では追加できません（公式）。ドラフトには書きません。
> そのコードは、アプリを作る API を実行したユーザーの表示言語で決まります（公式。日本語のユーザーでは `レコード番号` など）。
> 作成前のドラフトでは確定しないので、一覧の `fields`・`sort`、ルックアップの `sort`、レイアウトには、組み込みコードではなく
> **自分で追加したフィールドのコード**を書いてください。組み込みフィールドを使う一覧は、作成後に pull した `form/fields.json` で
> 実際のコードを確かめてから、`push app` で足します。一覧「（すべて）」は全アプリにある組み込みの一覧で、API では作れません。

複数ドラフトが互いを参照する場合、`push create --all` が**依存順（参照される側が先）**に自動で作成します。
循環参照（A⇄B）はエラーになるため、片方の参照フィールドを外して作成し、後から pull された `data/` の `form/fields.json` を編集して `push app` で追補してください。
