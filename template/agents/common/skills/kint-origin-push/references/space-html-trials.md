# スペース本文 HTML の保存実験記録（参考資料）

このファイルは、kintone のスペース本文更新 API（`PUT /k/v1/space/body.json`）へ HTML を送信した直後に `GET /k/v1/space.json` で取り直し、保存結果に残った要素・消えた要素を記録したものです。

> **注意（公式仕様との区別）**:
> - 公式ドキュメント（https://cybozu.dev/ja/kintone/docs/rest-api/spaces/update-space-body/ ）には「許可されていないタグ、属性は保存時に削除される」とだけ記載されており、**許可タグや CSS プロパティの公式一覧はありません**。
> - 以下は **2026-11-11** に検証環境のマルチスレッドスペース（`space-2`）で `PUT` 直後の `GET` により確認した実験結果であり、公式の保証リストではありません。
> - ブラウザ画面のエディタで開き直して再保存したときの保持有無は**未試験**です。

---

## 1. 試して残らなかったもの（削除・書き換え・見た目不成立）

### `<svg>` 要素（要素ごと削除）
- `<svg>` とその内部の `<a href="https://drive.google.com/...">` を送信したところ、保存結果に `<svg` は残らず**要素ごと削除**されました。
- ボックス内リンクや図形リンクの用途に `<svg>` は使えません。

### `<img width="720">` の `width` 属性（属性削除・添付 URL への書き換え）
- `width="720"` は保存結果に残りませんでした。
- 画像要素そのものは残り、送信した `data-file` は次のような添付ダウンロード URL の形に書き換えられました:

```html
<img src="/k/api/space/blob/download.do/-/sales-process.png?hash=...&amp;id=1&amp;.png" class="ocean-attached-file" data-id="1" data-original="..." alt="営業プロセス" />
```

- 画像内の特定領域をクリックするリンクは、この表示方法では作れません。

### `<a>` の中の `<font color="#ffffff">`（見た目の不成立）
- `<td bgcolor>` の表として送り、`<a>` の中に `<font color="#ffffff">` を入れたところ、白い文字にはならず、通常のリンク色のまま隣同士にくっついて見えました（タグ削除までは未確認ですが、見た目として成立しませんでした）。
- リンク文字を白くするには、`<font>` ではなく `<a>` 自身に `style="color:#ffffff;background-color:...;text-decoration:none"` を付けたときだけ確認できています。

---

## 2. 試して残ったもの（`PUT` 直後の `GET` で確認）

同じマルチスレッドスペース（`space-2`）で、保存後の `body` から取り直して確認できたタグ・属性・`style` 指定です（公式の許可リストではありません）。

### `<a>` / `<span>` / `<div>` の `style` プロパティ
- 基本で確認できた指定:
  - `color`
  - `background-color`
  - `padding`
  - `margin`
  - `display:inline-block`
  - `border-radius`
  - `text-decoration`
  - `text-align`
  - `width`
- 続く本文で追加確認できた指定:
  - `vertical-align`
  - `line-height`
  - `min-width`
  - `font-weight`
  - `font-size`

### `<table>` / `<td>` / インライン要素
- `<table>`: `border-collapse`、`border-spacing`、`cellpadding`、`cellspacing` が残りました。
- `<td>`: `bgcolor`、`width`、`height`、`align`、および上記と同種の `style` が残りました。
- `<b>`、`<br>` も残りました。

### 属性と末尾セミコロンの自動整形
- `target="_blank"` は残り、kintone 側で自動的に `rel="nofollow noopener noreferrer"` が付与されました。
- `style` 属性値の末尾のセミコロン（`;`）は保存時に削除されました。
- このような保存時の自動整形・属性付与・削除があるため、`kint-origin push space` は反映直後に `GET /space.json` で取り直してローカルの `body.html` を保存結果に同期し、送信 HTML から変化があれば `sanitized: true` を返します。
