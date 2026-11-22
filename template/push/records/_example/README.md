# レコード操作ジョブの書き方（_example）

このフォルダは `kint-origin push records` の**雛形**です（`_` 始まりのフォルダは実行対象外）。
レコードを操作するときは、このフォルダを `push/records/<ジョブ名>/` にコピーして `job.csv` を編集してください。

```
push/records/添付移行/
  job.csv      # 必須。1 行 = 1 フィールドの操作（この雛形のとおりの列）
  files/       # 任意。set で添付するローカルファイルを置く（job.csv からの相対パスで指定）
  runs/        # kint-origin が書く実行記録（プレビュー・バックアップ・結果）。編集しない。コミットされない
```

`runs/` は Git 除外されますが、`job.csv` と `files/` は既定では除外されません。顧客データを入れる場合は個別に除外し、このフォルダ全体を公開しないでください。

## 手順

1. `kint-origin show records --id 303 --records 12,15 --fields 顧客名,添付資料` でレコード ID・値・テーブルの行 ID を確認する（読み取りのみ）。
2. `job.csv` を編集する。
3. `kint-origin diff records --name <ジョブ名>` で検証する（API は GET のみ。変更前後が `runs/<時刻>-diff/preview.csv` に出る）。
4. 内容を確認して `kint-origin push records --name <ジョブ名>`（y/N 確認あり）。**運用環境のレコードが即時に書き換わる**（動作テスト環境は無い）。
5. 戻す場合は `kint-origin push records --name <ジョブ名> --restore <実行時刻>`（実行時刻は `runs/` のフォルダ名。作成したレコードは削除される）。

`.env` の `KINT_ORIGIN_ALLOW_PULL_RECORDS=true`（読み取り・diff）と `KINT_ORIGIN_ALLOW_PUSH_RECORDS=true`（push）が必要です。

## 列

| 列 | 意味 |
| --- | --- |
| `op` | `copy`（別レコードの値をコピー）／`set`（`value` を設定）／`clear`（空にする） |
| `from_app` `from_record` `from_field` | `copy` のコピー元。`set` / `clear` では空にする |
| `to_app` `to_record` `to_field` | 書き込み先。`to_record` は既存のレコード ID か `new:<キー>`（新規レコード。同じキーは同じレコード） |
| `mode` | 添付とテーブル全体だけ。`append`（既定・追記）／`replace`（置換） |
| `value` | `set` の値。複数の値は改行区切り |
| `note` | メモ（処理には使わない） |

フィールドは、通常は**フィールドコード**、テーブルのセルは `テーブル[行ID].フィールド`、新しい行は `テーブル[new:キー].フィールド` です。
`#` で始まる `op` の行と空行は無視されます。詳しい書式（値の書き方・コピーできる型・書き込めないフィールド）は、AI エージェント用の `kint-origin-records` スキル（`.claude/skills/` または `.agents/skills/`）にあります。
