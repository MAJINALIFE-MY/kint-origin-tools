---
name: kint-origin-records
description: kint-originでレコードの値を読む、ジョブCSVで更新・追加・添付やテーブルをコピーする、更新キー付きCSVを取り込む、差分・承認・結果不明・復旧を扱うときに使う。
---

# レコードの読み取り・変更・復旧

CLIのレコード取得・書込は運用環境を対象にする。push records / push importは運用環境へ即時反映する。AIのループや直接RESTで書き込まずCLIへ処理させる。フォーム変更後の手動CSV確認は [rehearsal手順](references/rehearsal.md) を読む。
`.env` と `runs/` はAIが編集しない。操作許可は個別の `--help` と `kint-origin policy` で確認する。

## 操作を選び、入力仕様を読む

| 目的 | 操作・読む資料 |
| --- | --- |
| ID・値・テーブル行ID・添付名の確認 | `show records --id <appId>`。必要なrecords・fields・condition・limitは個別ヘルプで確認 |
| レコード/フィールド単位の更新・新規・添付・テーブル | [job.csvの仕様](references/job-csv.md) を読んで `push/records/<ジョブ名>/job.csv` を作る。既存はID、新規は `new:<キー>` |
| 更新キーで一致なら更新、無ければ追加 | [CSV取込の仕様](references/import-csv.md) を読んで `push/import/<ジョブ名>/import.json` とrecords.csvを作る |
| フォーム変更後に検証用アプリで手動確認 | [rehearsal手順](references/rehearsal.md) を読み `diff rehearsal` を使う |
| 結果・終了コードの判断 | [結果の読み方](../kint-origin-commands/references/results.md) |

job.csv（`push records`）では、更新キーでの上書き・追加はできない。テーブル・添付が必要ならjob.csv、通常フィールドの更新キー取込ならimportを選ぶ。
読み取りはPULL_RECORDS、diffは加えてPULL_KINTONE、`push records` / `push import` はどちらも PULL_RECORDS と PUSH_RECORDS が必要。PUSH_RECORDS が許可する書き込みには更新キー付き CSV 取込も含む。アプリ設定・customize・新規アプリ作成は PUSH_APP が共通許可。許可不足は利用者に設定行を伝える。

## 変更の準備

1. `show records` で対象のID・フィールド・値を確認する。添付はfileKeyを出さず、名前とサイズで確認できる。
2. 対応する `_example/` を参考に、参照資料の形式で入力を作る。ジョブ名の制約も確認する。取得物を入力の代わりに書き換えない。
3. `diff records --name <ジョブ名>` / `diff import --name <ジョブ名>` を実行する。GETのみ。プレビューCSVは `runs/<時刻>-diff/preview.csv` に生成される。
4. 行番号付きの検証エラーを直し、更新・追加・変更なし・添付転送・推定API数・変更前後を確認する。検証は段階的なので、修正後に次の段階の問題が出ることがある。
5. `atomic: false` なら一括処理が複数回。ゲストを含む場合も分割され、途中失敗すると前の回は残る。承認依頼にも添える。

## 承認と実行

対象、件数、コピー元、変更前後、業務への影響（時間帯・Webhook・通知など）、復旧方法を示す。承認時は次の形で提示する。

```text
kintoneのレコード操作の承認をお願いします。
1. 対象（アプリID・接続先・ジョブ名）
2. 変更概要（diffの結果・更新と追加の件数・変更前後のプレビューCSVの絶対パス）
3. 反映の影響（運用環境へ即時反映。一括処理の分割、通知、Webhookなどへの影響）
4. 復旧プラン（値と添付のバックアップ先。--restoreで更新値を戻し、この実行で作成したレコードを削除する）
5. 実行コマンド `kint-origin push records --name <ジョブ名> -y`
（承認後に単体1行で実行。-yはCLIの確認を省略）
```

CSV取込の場合は `push import` へ置き換える。利用者には必要に応じて、ドメインの README の「反映前の確認」と、`kint-origin push records --help` または `kint-origin push import --help` を案内する。Cursorでは利用者が自分のターミナルで実行する。
更新者・更新日時が変わる。ルックアップのキーを書き込むと取得し直される。添付転送は時間とディスクを使うため、影響を先に確認する。
CLIは再計画→実行記録→バックアップ→添付転送→bulkRequest→検証の順に処理する。

## 結果と失敗

`runDir/result.json` とstdoutのupdated・created・bulks・verify・restoreCommandを確認し、実際に反映した範囲を報告する。

| 状態 | 対処 |
| --- | --- |
| 検証・バックアップ段階の失敗 | 書き込み前かを確認し、原因を直してdiffからやり直す |
| 1回目のbulkが4xxで拒否 | その回は原子的に取り消される。エラーの操作・行・revisionを確認する |
| 2回目以降の失敗 | 前の回は反映済み。全体が無変更とは報告しない |
| verifyの不一致・検証不能 | 反映済みでもexit 1。showで現状を確認し、復旧の要否を利用者と判断する |
| uncertain、通信断・5xx・タイムアウト | 反映されたか不明。再実行せず、showとバックアップで調べる |
| 強制終了、statusがrunningのまま | 同じく結果不明。現状を確認してから判断する |

同じ入力の反映済み・一部反映・結果不明・runningの記録があると、CLIは再実行を止める。重複作成や添付の二重追記を防ぐため、記録の編集や無意味な入力変更で回避しない。

## 復旧

1. 結果のrestoreCommandと `runs/<実行時刻>/backup/` を確認する。
2. 戻すフィールドと削除される新規レコードの件数を示し、同じ承認手順を取る。
3. `push records --name <ジョブ名> --restore <実行時刻>`、importはpush importで実行する。
4. 実行後に他者の編集があれば中断する。`--overwrite-remote` は利用者が明示したときだけ使う。

その実行で更新したフィールドだけを戻す。追加したテーブル行と新規レコードは削除される。削除済みの行ID・revisionまで同一に戻る保証はない。
復旧は1実行につき1回。復旧操作自体は元に戻せない。結果不明の回のレコードはCLIが把握できない場合があるので、自動復旧可能と決め付けない。
