# 結果の読み方

コマンド実行後、stdout・終了コード・stderrを合わせて確認する。stdoutは通常JSON、stderrは進捗・警告・接続先。ログイン名やレコード値は共有前に伏せる。
CLI は実行ごとに cwd の `log/run-<開始時刻>-<実行ID>/` へ記録する。ファイル名は `log-yyyymmdd-HHmmss-SSS-0001.log` 形式で、作成時刻順に並びます。内容はUTF-8 BOMなしのJSON Lines形式で、各行に実行ID・連番・UTC時刻・開始からの経過ミリ秒・イベント種別を持ち、10,000行または10 MiBで分割します。API応答本文は、JSON・テキストの認証値を伏せて記録し、プラグイン設定値は省きます。バイナリ本文はBase64で記録します。顧客データを含むため公開・共有せず、端末内の非公開記録として扱います。開始時に記録できない場合はコマンドを実行せず、実行中に保存できなくなった場合は後続のAPI操作と出力ファイル確定を止めて終了コード1にします。
`--help` と `version` は文字列、`addon run` は外部コマンドの出力をそのまま返し、JSONとは限らない。

## 成否を判断する

| 結果 | 判断・次の操作 |
| --- | --- |
| 例外でexit 1、stdoutなし | stderrの引数・許可・認証・接続エラーを読む。書き込みの成否はエラーの段階で判断する |
| `aborted: true`、exit 1 | 確認で承認されず中断。成功として報告しない |
| pullがexit 0 | `failures`・`spaceFailures`・`apps.failed` を確認。一部失敗でもexit 0になる |
| pullの `resourceFailures` | app単位で部分取得したリソース。該当アプリは次回pullでも再試行される。詳細は `key` と `message` を確認し、`_error` を正常な設定値として扱わない |
| `pull index` の取得エラー | アプリ索引またはプラグイン一覧の取得に失敗するとexit 1。両方の取得完了前は既存の索引と `installed.json` を保持する。`apiCalls` は両方の取得ページ数の合計 |
| `pull plugins` の取得エラー | exit 1。全ページ取得前は既存の `installed.json` を保持する。成功時は `plugins` 件数、`apiCalls`、`written` を返す |
| 取得JSONに `_error` | 取得エラーのスタブ。実際の設定値ではない。通常のデータとして解析・転記せず原因を確認する |
| `permissionSkips` / `denied` | 管理権限不足で未取得。全設定を取得できたという意味ではない |
| `localEdits` / `spaceLocalEdits` | ローカル編集を保持した。取得物が環境と同一とは限らない |
| pushの `applied: false` / `nothingToDo: true` | 送信対象なし。`skipped` の理由も読む |
| `deployed: false` | 動作テスト環境まで、または反映なし。運用環境への公開とは区別する |
| spaceの `verifyError` | 反映後の再取得失敗。exit 0でも検証未完了。結果を保持してpullし直す |
| records/importの `verify.mismatches` が空でない | 反映後に不一致、または検証不能。exit 1でも反映済み。`show records` で確認する |
| `policy.errors` が空でない | 設定エラー、exit 1。AIが `.env` を変更せず利用者へ伝える |
| `show plugin-source` の `status` | `found` は `path` または `githubUrl`（設定時は `githubPath` も）と、その参照先を設定した `sourceFile` を返す。`no-source` は `installed.json` にあるが参照先が未登録で、`displayName` と `version` を返す。`unregistered` はaliasやIDが登録されていない。`missing-path` は台帳に載っているローカルの参照先が見つからない。いずれもexit 0。引数・台帳のエラーはexit 1 |

`pull records` の確認辞退は `aborted: true` を返し、exit 1。レコードデータは取得・更新されていない。
`addon run` は子コマンドの終了コードを返す（割り込みは130/143）。0/1だけと仮定しない。

`show plugin-source --name` が登録済みの項目を返したとき、`pluginId: null` はソース参照に実IDが登録されていないことを示す。IDを推測して補わない。

## diffとpushの主な項目

- `diff app` は `baseCommit` とGit差分から `same` / `local` / `skipped` を返す。環境への問い合わせは行わない。基準コミットの内容がpull状態と異なるときはpushを止める。
- `push app` の `status` は `no_changes` / `aborted` / `preview_saved` / `deployed`。`pushed` は成功した書き込みAPI、`uploadedCustomizeFiles` はcustomizeでアップロードしたファイルを示す。push前の全件バックアップと反映後pullは行わない。
- `push app` はpull後に環境側で同じリソースが変更されてもGit基準からのローカル変更を送る。deployはpreviewにある全変更を運用環境へ反映する。deploy成功後は送信済みファイルのpull状態を進め、Git差分はコミットするまで残る。
- recordsのdiffは更新・新規・添付転送・一括処理数、importは `update`・`create`・`unchanged` を読む。プレビューCSVのパスから変更前後を確認する。
- `atomic: false` は一括処理が複数回。途中失敗でも前の回は残る。
- 実行結果の `runId`・`runDir`・`updated`・`created`・`bulks`・`verify`・`restoreCommand` を報告する。実行記録は顧客データであり、AIは編集しない。
- `partial` は一部反映、`uncertain: true` は反映されたか不明。`status: "running"` のまま残った記録も結果不明として調査する。同じ入力を安易に再実行しない。
- spaceの `sanitized: true` はkintoneの保存結果でbody.htmlを更新した印。保存結果と見た目を確認する。
- `diff rehearsal` は `generated` でexit 0ならCSV生成完了、`issues` でexit 1なら `report.json` の `issues` を確認する。`warningDetails` は生成CSVを画面へ読み込む前の確認事項。`baselineFile` / `changesFile` が `null` のCSVは生成されていない。

## よくある中断

| 文言 | 対処 |
| --- | --- |
| `操作制限:` | 個別ヘルプで許可キーを確認し、設定行を利用者へ伝える。コマンド判定の拒否ならAPI送信前。下位層の拒否では先行するGETが済んでいる場合がある |
| `不明なオプションです` / `不明な引数です` | 個別ヘルプを読み直す |
| `Missing required argument` | 必須引数を補う |
| `対話確認ができない実行環境` | 承認済みの内容か確認する。updateとpushの確認をAIが回避しない |
| `ツール本体…のフォルダでは実行できません` | ドメインのフォルダでinit/updateする |

出力の全フィールド一覧は複写しない。本体改修時は返却型・printJsonの呼び出し・関連テストを確認し、利用者の判断が変わる項目をここへ反映する。

## 共通設定・コメント

- pull common: API 取得は `plugins/required.json` と `plugin/installed.json` を更新する。失敗時は exit 1。手動取り込みは `--from` のローカルファイルだけを読み、ネットワーク・`.env` を使わない。
- pull comments: `records` は対象件数、`comments` は取得コメント数、`written` / `unchanged` は保存結果、`failures` はレコード単位の取得失敗。失敗が1件でもあれば exit 1。失敗したレコードの既存 JSON は維持する。

## 一括レコード・コメント取得

- pull records --all-indexed / pull comments --all-indexed の status は completed / partial / aborted / dry-run。partial は failures を確認し、失敗分の既存ファイルを維持したまま exit 1。aborted は確認拒否・実行条件不足でデータAPI実行前に停止し exit 1。
- oneShotConsumed: true は、.env の対応する KINT_ORIGIN_ALLOW_*_ALL_ONCE=true を実行直前に消費し、.env 上で false に戻したことを示す。false のままなら実データ取得は始まっていない。
- settingsTargets は --favorite --with-records/--with-comments を指定した際に通常の設定取得も行う対象、targets はデータ取得対象。--dry-run は対象と保存先を表示するが、レコード・コメント取得とファイル更新はしない。
