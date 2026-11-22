# 新規アプリのドラフト（kint-origin app create）

`kint-origin app create` が書いたドラフトです。kintone のアプリはまだ作られていません（アプリ ID も付いていません）。
`kint-origin push create --name <このフォルダ名>` で、kintone に作成します。

```
app.json            # アプリ名・作成先（space / thread / guestSpaceId）
form/fields.json    # フィールド（pull の出力と同じ形式）。空欄では properties が空
form/layout.json    # フォームのレイアウト。空欄では layout が空
views/views.json    # 一覧。空欄では views が空（空のときは送りません）
```

- **フィールドは `form/fields.json` の `properties` に足し、`form/layout.json` の `layout` に並べます。** 形式は `push/new-apps/_example/` と、取得済みアプリの `form/fields.json`・`form/layout.json` が手本です。
- **組み込みフィールド（レコード番号・作成者・作成日時・更新者・更新日時・ステータス・作業者・カテゴリー）は書きません。** kintone がアプリの作成時に自動で作り、フィールドの追加 API では追加できません（公式）。`push` も送りません。
- **組み込みフィールドのコード（名称）は、アプリを作る API を実行したユーザーの表示言語で決まります**（公式）。日本語のユーザーでは `レコード番号` などですが、ドラフトの段階では確定しません。
  このため、**作成前のドラフトの一覧（`fields`・`sort`）やレイアウトに、組み込みフィールドのコードを書かないでください**（コードが違うと、一覧の反映が「指定されたフィールドが見つかりません」で失敗します）。
  一覧に組み込みフィールドを入れたいときは、作成後に取得された `data/.../app-<新しいID>/form/fields.json` で実際のコードを確かめてから、`views/views.json` を編集して `push app` で足します。
- 一覧（`views/views.json`）は、定義全体を送ります（書かなかった一覧は、kintone 側で削除されます）。`views` が空のときは送りません。
- 別のアプリへの参照（ルックアップなど）は `{{app:名前}}` で書けます。詳しくは `push/new-apps/_example/README.md` を参照してください。

作成の手順:

1. このフォルダのファイルを編集する（`--name` には、フォルダ名と `app.json` の `name` のどちらでも指定できます）。
2. `kint-origin diff create --name <フォルダ名>` で、作成順・ファイル・参照・復旧プランを確認する（API を呼ばず、許可は不要）。
3. ユーザーの承認を得て、`kint-origin push create --name <フォルダ名>` を実行する（`.env` の `KINT_ORIGIN_ALLOW_PUSH_APP=true` が必要）。
4. 作成後は、`created.json` が書かれ、`data/.../app-<新しいID>/` に取得されます。**以後の修正は、このフォルダではなく、取得された `data/` を編集して `push app` で行います。**
