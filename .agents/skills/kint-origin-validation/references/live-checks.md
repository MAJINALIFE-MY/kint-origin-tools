# 手動・ライブ確認

外部APIや実クライアントに依存する変更のときに読む。専用テストドメインと許可を使い、顧客環境では行わない。認証値を出力しない。

## ハーネスの開始条件

- 実URL入りのlocal-test/.envがあるとliveのpull indexは自動で実行される。SMOKE_APP_ID無しでも動く。
- レコードはSMOKE_APP_ID、添付はSMOKE_ATTACHMENT_APP_IDとPULL_RECORDSの許可が必要。ゲスト用の変数はハーネスのliveTestsを確認する。
- pushLiveは実ドメイン、SMOKE_PUSH_LIVE=1、PUSH_APPの許可が必要。明示承認なしに有効化しない。作成アプリが残るので復旧・削除方法を先に示す。
- 新規ソースのオフライン検証は.envを含めずに行う。SMOKE_ONLYとSMOKE_PUSH_LIVEを最終確認へ意図せず引き継がない。

## 変更に応じて選ぶ観点

| 対象 | 確認すること |
| --- | --- |
| records取得 | CSVのBOM・フォームレイアウト順・サブテーブルの先頭*・1レコード再取得で他行が保持されること |
| 添付 | 通常/ゲスト・テーブル内FILE・添付なし・同名上書き・保存先とファイル内容 |
| app/customize | diffのlocal/remote/conflict、バックアップ、未反映変更の巻き込み防止、no-deployの反映先、検証pull |
| space | settingsと本文、保存時のHTMLサニタイズ、表示、通常/ゲスト、戻せないマルチスレッド化 |
| job.csv | 値・添付・テーブル部分更新・新規、通常/ゲスト間コピー、複数bulk、他者編集後のrestore中断と承認付き上書き |
| CSV取込 | 更新キーの照合、変更なし・更新・追加、空セル、数値/日時の同値判定、アプリコードの取り違え、復旧 |
| HTML | file://で検索・ページング・添付リンク・日本語パス・データ未取得時の表示 |
| AI設定 | 3クライアントでスキル発見、push承認/拒否、env/取得物の保護、独自スキルの追加とupdate後の温存 |

Claudeではpushのask、対象外の取得物へのWrite/Editのdenyを確認する。Cursorではpushのdenyと理由表示、Codexでは信頼後のポリシー・hookを確認する。静的fixtureの成功と実UIの成功は区別する。
実施日・対象版・範囲・結果・未検証項目を作業報告へ残す。過去の成功を現在版の検証済みという意味で使わない。
