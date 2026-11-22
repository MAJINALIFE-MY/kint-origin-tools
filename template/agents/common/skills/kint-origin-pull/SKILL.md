---
name: kint-origin-pull
description: kint-originで全アプリのレコード・コメント、またはお気に入りアプリのデータを一括取得するときに使う。対象ドメイン確認、プレビュー、対話確認、一度限り許可の扱い、Git差分の確認を行う。
---

# kint-origin の一括取得

全アプリのレコード・コメント取得は顧客データを大量に読み出します。`pull kintone` はアプリ・スペース設定だけを取得し、レコードやコメントには触れません。

## AI エージェントが行うこと

- まず `kint-origin policy` と `kint-origin pull <records|comments> --help` を確認し、対象ドメイン・対象範囲・保存先を利用者へ示す。
- 全アプリ取得は最初に `--dry-run` のコマンドを提示する。実際の全件取得は利用者が自分の対話ターミナルで実行する。AI エージェントから一括取得コマンドを実行しない。
- `.env` は変更しない。実行を希望する利用者には必要なキーを案内し、実行の直前だけ `true` にしてもらう。CLI が確認後にそのキーを自動で `false` にする。
- 実行後は JSON の `status`・`failures`・`oneShotConsumed` と `git status -- data/` を確認する。失敗があれば成功として報告しない。

## 全アプリのレコード

1. 完全なアプリ一覧を作る。

   ```sh
   kint-origin pull index
   ```

   または、設定も更新する場合は `kint-origin pull kintone` を使う。`pull index` / `pull kintone` は完全索引の接続先と指紋を記録する。部分取得やお気に入り取得は完全索引にならない。

2. 対象ホストを指定して対象・保存先をプレビューする。

   ```sh
   kint-origin pull records --all-indexed --expect-host <hostname> --dry-run
   ```

3. 内容を確認した利用者が `.env` に `KINT_ORIGIN_ALLOW_PULL_RECORDS_ALL_ONCE=true` を一時設定し、対話ターミナルで次を実行する。

   ```sh
   kint-origin pull records --all-indexed --expect-host <hostname>
   ```

   レコード添付も必要なときだけ `--attachments` を付ける。実行確認に `y` と答えると、CLI はデータ取得を始める直前に `PULL_RECORDS_ALL_ONCE` を `false` に戻す。辞退・dry-run・事前検証失敗では消費しない。`--yes` は全件モードで使えない。

## 全アプリのコメント

全件レコードとは別の操作で、各アプリの全レコードについてコメントを取得する。先に完全索引を用意し、次のプレビューを行う。

```sh
kint-origin pull comments --all-indexed --expect-host <hostname> --dry-run
```

利用者が `.env` に `KINT_ORIGIN_ALLOW_PULL_COMMENTS_ALL_ONCE=true` を一時設定し、対話ターミナルから実行する。

```sh
kint-origin pull comments --all-indexed --expect-host <hostname>
```

確認後、CLI が `PULL_COMMENTS_ALL_ONCE` を `false` に戻してからコメント API を呼ぶ。取得先はアプリごとの `data/kintone/.../apps/app-<id>/comments/record-<recordId>.json`。

## お気に入りのアプリだけ取得

`favorites/<name>.json` の `apps` に列挙したアプリだけがレコード・コメントのデータ対象です。`spaces` と `guestSpaces` は設定取得対象で、そこに含まれる全アプリのレコード・コメントには広げません。データ取得時は `--all` ではなく `--name` を使います。

```sh
kint-origin pull favorite --name <group> --with-records --expect-host <hostname> --dry-run
kint-origin pull favorite --name <group> --with-records --expect-host <hostname>
kint-origin pull favorite --name <group> --with-comments --expect-host <hostname>
```

`--with-records` と `--with-comments` は同時指定できます。添付は `--with-records --with-attachments` とします。お気に入りの設定と選んだデータを同じ実行で取得し、実行のたびに対話確認します。こちらは一度限りキーを使いません。

## 必要な許可

| 操作 | `.env` のキー |
| --- | --- |
| 個別アプリのレコード・コメント | `KINT_ORIGIN_ALLOW_PULL_RECORDS=true` |
| 全件 dry-run | `KINT_ORIGIN_ALLOW_PULL_RECORDS=true` と `KINT_ORIGIN_ALLOW_BULK_RECORDS=true` |
| 全アプリのレコード実取得 | 上記に加えて `KINT_ORIGIN_ALLOW_PULL_RECORDS_ALL_ONCE=true` |
| 全アプリのコメント実取得 | 上記に加えて `KINT_ORIGIN_ALLOW_PULL_COMMENTS_ALL_ONCE=true` |
| お気に入りのレコード・コメント | `KINT_ORIGIN_ALLOW_PULL_KINTONE=true`、`KINT_ORIGIN_ALLOW_PULL_RECORDS=true`、`KINT_ORIGIN_ALLOW_BULK_RECORDS=true` |

実行時には `--expect-host`、完全索引と現在のアプリ位置、既存 `app.json` / `space.json` の取得元を照合する。確認中に `.env` または完全索引が変わった場合、重複・不正な索引、対象不明、保存先の別ドメイン記録がある場合は停止する。ロックが残った場合は別の実行が動いていないことを確認するまで削除しない。

## Git の扱い

- `records.csv` と `records/attachments/` は配布 `.gitignore` で除外される。
- コメント JSON は現在の Git 設定に従う。既定では ignore しないため、`git status -- data/` と差分で共有範囲を確認する。
- `data/kintone/index/.bulk-source.json` は完全索引検証専用で、配布 `.gitignore` で除外される。
- 取得した作業コピーは復旧用世代管理ではない。kintone へ戻す操作は別の push 手順と承認が必要。
