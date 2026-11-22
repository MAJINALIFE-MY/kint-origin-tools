---
name: kint-origin-push
description: kint-originでアプリ・スペースの設定やcustomizeを改修・反映する、新規アプリを作る、差分・承認・復旧プランを準備するときに使う。
---

# アプリ・スペースの改修と反映

pushはkintone環境を書き換える。対象・差分・反映の影響・復旧プラン・実行コマンドを提示し、明示承認を得る。
レコードの操作・CSV取込は [records](../kint-origin-records/SKILL.md) を読む。
フォーム変更後に検証用アプリで手動CSV確認を行う場合は [rehearsal手順](../kint-origin-records/references/rehearsal.md) を読む。

## 作業前に読む

- 編集するファイルを決めるときは [push対象と送信内容](references/files.md) を読む。取得物のうちpush対象外は編集しない。
- 新規ドラフトを作るときは [空欄ドラフトの正本](references/app-blank/README.md) を読む。CLIのapp createは、このフォルダのファイルを使う。
- スペース本文の表示・整形を調べるときは [HTML試行の根拠](references/space-html-trials.md) を読む。
- 実行後の成否は [結果の読み方](../kint-origin-commands/references/results.md) で判断する。
- 使うコマンドのオプション・許可は `kint-origin <コマンド> --help` と `kint-origin policy` で確認する。

## 既存アプリ・スペース

### アプリ設定・customize

1. `pull app --id <id>` で最新設定を取得する。pull結果を含むGitコミットを編集前の基準として保存する。
2. [push対象と送信内容](references/files.md) にあるファイルだけを編集する。customizeも `data/.../customize/` のマニフェストとJS/CSSを編集する。
3. `diff app --id <id> --base <基準コミット>` でローカル差分を確認する。`--base` を省略した場合は `HEAD`。このコマンドはGit・pull状態・作業ツリーだけを読み、kintone APIを呼ばない。
4. `push app --id <id> --base <基準コミット>` を実行する。Git基準から変更されたリソースだけをpreviewへ送り、既定ではdeployする。`--only` で対象を絞り、`--no-deploy` でpreviewに止められる。
5. push後は結果と `git diff data/` を確認し、反映した変更をコミットする。次の編集ではそのコミットを新しいGit基準にする。

基準コミットの取得ファイルと現在のpull状態が一致しないと実行前に止まる。pullで更新したデータは先にコミットする。編集済みのコミットを基準にすると差分が消えるため、編集前のコミットを `--base` に指定する。通常は基準コミットを保存してから編集し、既定の `HEAD` を使う。

app設定ファイルの削除は反映しない。customizeのJS/CSS削除はマニフェストから項目を外す。変更グループ内のJS/CSSはkintoneのfileKeyを作り直すため、そのグループのファイルを全てアップロードする。

push appは事前の環境照合、全設定バックアップ、反映後の全設定pullを行わない。API呼び出しは変更リソースの書き込み、customizeのファイルアップロード、deploy状況の確認に限る。同じリソースがpull後に環境側で変更されていれば、ローカルの変更で上書きする。deployはpreviewにある全変更を運用環境へ反映する。

### スペース

1. 対象の `_agentdata/` の過去の経緯と `git status data/` を確認する。作業メモは `_agentdata/notes/`、領域の説明は `_agentdata/README.md`、バックアップは `_agentdata/backup/<時刻>/`。
2. `pull spaces` / `pull guestspaces` で取得する。編集前の状態をGitへ保存し、復旧元を確保する。
3. `settings.json` と `body.html` を編集する。
4. `diff space --id <id>` を実行し、環境との差分を確認する。
5. 影響・復旧方法を確認し、明示承認を得て `push space` を実行する。

`pull 状態がありません` のときは取得からやり直す。pull状態や取得済みJSONを推測で作らない。
## 新規アプリ

1. `app create --name <名前>` で空欄ドラフトを作る。API・認証値・許可は不要。IDは付かない。
2. zipを使う場合だけ `app templates` で確認し `--template` を使う。対応は空のアプリの形だけ。未知・対応外のzipを空欄へ読み替えない。
3. `push/new-apps/<名前>/` を編集する。組み込みフィールドの追加、作成前の組み込みコードの参照、一覧「（すべて）」は書かない。言語で変わるコードは作成後のfields.jsonで確認する。
4. 参照先は `{{app:名前}}` で指定する（ドラフト名・既存アプリコード・索引上一意な名前・ID）。`diff create --name <名前>` / `--all` で依存順を確認する。循環参照は片側を後からpush appで追加する。
5. 承認後に `push create`。`--all` は作成済みドラフトを飛ばす。作成の途中からリソース反映を再開するときは `--name <ドラフト名>` を指定する。作成後の変更は、pullされた `data/.../app-<id>/` を編集してpush appする。ドラフトのcreated.jsonは二重作成防止の記録。`--no-deploy` では運用環境とdataへ登録されない。

## 承認と実行

次の形式で承認を求める。操作の詳細を確認したい利用者には、ドメインの README の「反映前の確認」と、実行するコマンドの `--help` を案内する。

```text
kintoneへの反映（push）の承認をお願いします。
1. 対象（ID・名前・接続先）
2. 変更概要（diffの結果と、追加・変更・削除される内容）
3. 反映の影響（反映先・タイミング・ほかの未反映変更や業務への影響）
4. 復旧プラン（バックアップ先・戻し方・戻せない変更）
5. 実行コマンド `kint-origin push app --id <id> -y`
（承認後に実行。-yはCLIの確認を省略します）
```

- 承認済みの内容だけ `-y` で実行する。Claudeのhook、信頼したCodexのポリシーによる確認にも従う。Cursorはpushを拒否するため、AIは実行コマンドを提示し、利用者が自分のターミナルで実行する。拒否を回避しない。
- app/customize/createは動作テスト環境へ反映してdeployする。`--no-deploy` は動作テスト環境まで。
- deployはpreviewにある他の未反映変更も反映する。push appは未反映状態をAPIで事前確認しないため、previewに変更が無いことを画面で確認する。
- spaceは運用環境へ即時反映。設定と本文は別リクエストで、途中失敗すると一部だけ残り得る。保存時のHTMLサニタイズと表示も確認する。

## 復旧・失敗

- appのdeploy前に失敗し、previewへ一部反映された場合は、kintone画面で変更を確認してから「変更を中止」を使う。ほかの人の変更を含む可能性があるため自動revertしない。
- appのdeploy後は、編集前のGit基準から対象ファイルを戻し、diffと承認を経て再pushする。appの自動バックアップは作らない。spaceは `_agentdata/backup/` を使う。
- スペースのマルチスレッド化は戻せない。作成アプリの削除はkintoneの画面で行う。
- エラー時はどの段階まで反映されたか確認する。「運用環境は無傷」「再実行してよい」と一律に判断しない。
