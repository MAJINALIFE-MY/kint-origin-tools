# push 対象ファイルの仕様

`kint-origin push app` は、pull時点のGit基準から変更されたアプリ設定・customizeだけを、kintone の REST API で反映します。この文書は、どのファイルがどの API に対応し、何を送り、何を送らないかをまとめたものです。

ファイルを編集する前にこの資料を読む。編集・承認・実行は [pushスキル](../SKILL.md) に従う。

## 前提

- ファイルの形式は、`pull app` が書き出す形式と**同じ**です。pullした取得結果をGitへコミットし、それを編集前の基準にします。
- `diff app` と `push app` はGit基準・pull状態・作業ツリーを比較し、変更リソースだけを対象にします。`diff app` はAPIを呼びません。基準コミットは `--base <ref>` で指定し、省略時は `HEAD` です。基準のファイル内容が現在のpull状態と一致しない場合は中断します。
- push前にkintoneの設定を照合せず、全設定バックアップ・反映後の全設定pullも行いません。pull後に環境側で同じリソースが変更されていても、Git基準からのローカル変更で上書きします。
- `revision` は送りません。反映はまず**動作テスト環境**へ送り、続けて運用環境へdeployします。`--no-deploy` で動作テスト環境までで止められます。deployはpreviewにある全ての未反映変更を反映します。

## 対応表

| `--only` のキー | ファイル（`data/.../app-<id>/` から） | 反映先の API | 空・未設定のとき |
| --- | --- | --- | --- |
| `fields` | `form/fields.json` | フィールドの追加（POST）・変更（PUT）`/k/v1/preview/app/form/fields.json` | — |
| `customize` | `customize/customize-manifest.json` とマニフェスト記載のJS/CSS | ファイルは `/k/v1/file.json`、設定は `PUT /k/v1/preview/app/customize.json` | 変更グループ内のFILEを全て再アップロード |
| `layout` | `form/layout.json` | `/k/v1/preview/app/form/layout.json` | `layout` が無ければ送らない |
| `views` | `views/views.json` | `/k/v1/preview/app/views.json` | **一覧が空なら送らない**（kintone は、指定しなかった一覧を削除するため） |
| `reports` | `reports/reports.json` | `/k/v1/preview/app/reports.json` | 空なら送らない |
| `settings` | `app_settings/settings.json` | `/k/v1/preview/app/settings.json` | — |
| `status` | `app_settings/status.json` | `/k/v1/preview/app/status.json` | プロセス管理が未設定（`states` が無い）なら送らない |
| `actions` | `app_settings/app_actions.json` | `/k/v1/preview/app/actions.json` | 空なら送らない |
| `notifications_general` | `notifications/notifications_general.json` | `/k/v1/preview/app/notifications/general.json` | — |
| `notifications_per_record` | `notifications/notifications_perRecord.json` | `/k/v1/preview/app/notifications/perRecord.json` | — |
| `notifications_reminder` | `notifications/notifications_reminder.json` | `/k/v1/preview/app/notifications/reminder.json` | — |
| `app_acl` | `acl/app_acl.json` | `/k/v1/preview/app/acl.json` | `rights` が空なら送らない |
| `record_acl` | `acl/record_acl.json` | `/k/v1/preview/record/acl.json` | `rights` が空なら送らない |
| `field_acl` | `acl/field_acl.json` | `/k/v1/preview/field/acl.json` | `rights` が空なら送らない |

`--only fields,views` のようにカンマ区切りで、送るリソースを絞れます。customizeだけなら `--only customize` です。不明なキーは、有効なキーの一覧つきでエラーになります。

### 一部のファイルの扱い

| ファイル | 扱い |
| --- | --- |
| `form/fields.json` | フィールドコードごとに、編集前のGit基準に**ないもの**は追加、**あるもの**は変更として送ります。**フィールドの削除はしません**（環境にだけあるフィールドは、`push` の結果の `fieldsMissingOnLocal` に警告として出るだけです）。次の**組み込みフィールドは送りません**: `RECORD_NUMBER`・`CREATOR`・`CREATED_TIME`・`MODIFIER`・`UPDATED_TIME`・`STATUS`・`STATUS_ASSIGNEE`・`CATEGORY`（このうち `STATUS`・`STATUS_ASSIGNEE`・`CATEGORY` は、kintone の仕様で変更・追加・削除ができません。残りの 5 つは、このツールの方針として送りません） |
| `app_settings/settings.json` | **アイコンが画像ファイル（`icon.type` が `FILE`）の場合は、アイコンを送りません**（アイコンの画像には、ファイルのアップロード API で得た `fileKey` が必要ですが、取得物の `fileKey` は `-` に置き換えて保存しているため）。プリセットのアイコンはそのまま送ります |
| `views/views.json`・`reports/reports.json`・`app_settings/app_actions.json`・`notifications/*.json`・`app_settings/status.json` の `states` | **定義全体**を送ります（変更した項目だけを送るのではありません）。**ファイルから項目を消して push すると、環境の同じ項目も削除されます**（kintone の仕様。公式ドキュメントに「指定しないとその一覧は削除されます」など、一覧・グラフ・アクション・通知・ステータスについて同じ記述があります）。変更したファイル全体を反映するため、`diff app` で内容を確認し、必要なら `--no-deploy` でpreviewに止めてください。ビュー・グラフ・アクションを空にしたときだけは、送りません |
| `acl/*.json` | **`rights` 全体**を送ります。`rights` に含めなかった既存の権限が、保持されるか置き換えられるかは、kintone の公式ドキュメントに記載がありません。アクセス権を誤って変えると、操作できなくなるユーザーが出るため、`diff app` の結果を確認し、`--no-deploy` で動作テスト環境に反映して画面で確かめてから、運用環境へ反映してください |
| `app_settings/app_actions.json` | `destApp`（アクションの宛先アプリ）は、`{{app:名前}}` のような参照も解決して送ります |

## 新規アプリのドラフト（`push create`）

`push/new-apps/<名前>/` に、**同じ相対パス**のファイルを置きます（`app.json` が必須で、そのほかは任意）。`form/fields.json` などの形式は上の表と同じです。`{{app:名前}}` で、ほかのドラフトや既存アプリへの参照（ルックアップなど）を書けます。詳しくは `push/new-apps/_example/README.md` を参照してください。

ドラフトは `kint-origin app create --name <名前>` でローカルに作れます（API を呼ばず、許可は不要。アプリ ID は付きません。ID が付くのは `push create` が作成した後で、そのとき `created.json`（`appId`）がドラフトに書かれ、deploy 後の検証 pull で `data/.../app-<新しいID>/` と索引に登録されます。`--no-deploy` のときは運用環境に出ず、`data/` への登録もしません）。

- **既定は空欄のドラフト**です。`app.json`（`--name` のアプリ名と、任意の `space` / `thread` / `guestSpaceId`）・`form/fields.json`（`properties` が空）・`form/layout.json`（`layout` が空）・`views/views.json`（`views` が空）・`README.md` を書きます。正本は、スキル参照 `template/agents/common/skills/kint-origin-push/references/app-blank/` のテキストで、コマンドはパッケージ内のこの正本をコピーします。ホスト・アプリ ID・ユーザー・`fileKey`・アクセス権・通知は入れません。
- **組み込みフィールド（レコード番号・作成者・作成日時・更新者・更新日時・ステータス・作業者・カテゴリー）は、ドラフトに書きません。** kintone がアプリの作成時に自動で作り、フィールドの追加 API では追加できません（公式）。また、そのコード（名称）は、アプリを作る API を実行したユーザーの表示言語で決まります（公式。日本語のユーザーでは `レコード番号` など）。ドラフトの段階ではコードが確定しないので、**作成前のドラフトの一覧（`fields`・`sort`）やレイアウトに組み込みコードを書くと、言語によっては「指定されたフィールドが見つかりません」で失敗します**。組み込みフィールドを使う一覧は、作成後に取得された `data/.../app-<新しいID>/form/fields.json` で実際のコードを確かめてから、`push app` で足します。
- **一覧「（すべて）」も書きません。** 全アプリに最初からある組み込みの一覧で、API で同じ名前の一覧を作ろうとすると「一覧の名前が重複しています」で拒否されます（`views` が空のときは送りません）。API で作ったアプリの `views` は、作成直後は空です。
- `--template <名前>` を付けたときだけ、kintone のアプリテンプレート zip（`01/template.json`）が「空のアプリ」の形かを検査します。扱えるのは、kintone の「空のアプリ」（blankapp.zip）と**同じ形・同じ既定の設定**のテンプレートだけです。カスタムフィールドなし・レイアウトが空・一覧が組み込みの「（すべて）」だけ（表示項目が既定のレコード番号だけで、絞り込み・並び替えなし）・プロセス管理／プラグイン／JS・CSS／ルックアップ／関連レコード一覧／グラフ／アクセス権／アプリアクションが空で、一般設定（テーマ・アイコン・説明・アプリコード・小数の桁・履歴やコメントの有無など）と組み込みフィールドの設定（名称・必須・ラベルの表示）が既定のままであること。通知は既定のもの（コメントが書かれたとき、作成者・更新者へ）だけで、内部 ID と `uuid` は書きません。範囲内のテンプレートが表すのは空のアプリそのものなので、ドラフトの中身は空欄と同じになります（アプリ名は `--name`）。**黙って捨てないため、検査は「知らない項目がないか」「想定した形か」も見ます**。既定と違う設定・未知の項目・想定外の形がある zip は、未対応の箇所をすべて示してドラフトを作らずに終了します（kintone が `template.json` に新しい項目を足した場合も、その項目を示して拒否します）。zip を kintone へそのまま渡す経路はありません（kintone の REST API には、アプリテンプレートを読み込む API が公開されていないため）。

## 反映できないもの

| 対象 | 理由と代替 |
| --- | --- |
| `form/form.json`（旧フォーム API） | 取得専用です |
| プラグインの追加・設定（`customize/plugins.json`・`plugin-configs/`） | このツールでは扱いません（kintone の REST API には、プラグインを追加する API があります）。kintone の画面から追加してください |
| レコード | `kint-origin push records`（ジョブ CSV）、更新キー付き CSV の一括取込は `kint-origin push import`（[recordsスキル](../../kint-origin-records/SKILL.md)） |
| `app.json`・`records/`・`index/`・`.kint-origin-pull.json` など、取得物 | 編集しないでください（`pull` が書き直します） |

## スペースの設定・本文（`push space`）

`data/kintone/spaces/space-<id>/`（ゲストは `guestspace-<id>/`）の次の 2 ファイルが `push space` の対象です（`space.json`・`apps.json` は取得物のため編集しません）。

| `--only` のキー | ファイル | 反映先の API | 備考 |
| --- | --- | --- | --- |
| `settings` | `settings.json` | `PUT /k/(guest/<id>/)?v1/space.json` | `name`（1〜128 文字）、`isPrivate`、`fixedMember`、`useMultiThread`（`false`→`true` のみ）、`showAnnouncement` / `showThreadList` / `showAppList` / `showMemberList` / `showRelatedLinkList`（マルチスレッドのみ）、`permissions.createApp`（`"EVERYONE"` / `"ADMIN"`） |
| `body` | `body.html` | マルチスレッド: `PUT /k/(guest/<id>/)?v1/space/body.json`<br>シングルスレッド: `PUT /k/(guest/<id>/)?v1/space/thread.json`（`defaultThread`） | UTF-8 BOM なし・LF。ブロック要素（div, table, p 等）基準で 2 スペース階層インデントして保存されます。diff は正規化した HTML のハッシュで比較します。整形ではブロック間の空白・要素内の前後の空白・終了タグの表記が変わる場合があり、元の HTML をバイト単位で復元する機能ではありません。空白が表示に影響する本文は反映前後に画面でも確認してください。反映直後に `GET /space.json` で取り直し、kintone の保存時 HTML サニタイズがあればローカルの `body.html` を保存結果（インデント整形済み）で更新し `"sanitized": true` を返します。 |

## 編集してよい場所

AI エージェントが書き込める場所は、ドメインのルールで次に限られます（Claude では hook がそれ以外の `data/` への書き込みを拒否します）。

- 上の対応表の push 対象ファイル、`customize/` のマニフェスト・JS・CSS、スペースの `settings.json`・`body.html`
- `data/.../app-<id>/_agentdata/` および `data/kintone/spaces/<space>/_agentdata/`（検討メモ・バックアップ。`pull` が触れません）
- `push/`（新規アプリのドラフト・レコードのジョブ）と `favorites/`
