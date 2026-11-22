---
name: kint-origin-extend
description: このドメイン用のスキル・ルール・役割を追加・改名するときや、ドメイン専用プラグインのソースを置く・登録するときに使う。独自の指示には kint-origin-local- の名前を使う。
---

# このドメイン独自のスキル・ルール・役割を追加する

`kint-origin update` は配布物のパスだけを上書きする。独自の追加は、次の名前と置き場にすれば残る。安全条件は `{{AGENT_RULES_DIR}}/rules/kint-origin.md` の「追加物が弱めてはいけない安全条件」に従う。

ドメイン専用プラグインを置くときや、別リポジトリ・提供済みのJSの所在を登録するときは [プラグイン一覧とソース参照](references/plugins.md) を読む。IDが未確認なら `pluginId` を省略し、必要な場合だけ `alias` を付ける。

## 名前

| 種類 | 名前 | 扱い |
| --- | --- | --- |
| 配布スキル | `kint-origin-commands`・`kint-origin-pull`・`kint-origin-push`・`kint-origin-records`・`kint-origin-extend` | `kint-origin update` で上書きされる。編集しない |
| 配布のルール・hook | `kint-origin.md`・`kint-origin-guard.mjs`・`kint-origin-guard-core.mjs`・`kint-origin.rules` | 同上 |
| **独自のスキル・ルール・役割** | **`kint-origin-local-<名前>`** | update で上書きも削除もされない |
| 外部addon | `kint-origin-addon-*` | `kint-origin addon` が管理するリンク。手で作らない・コピーしない |

- `<名前>` は英小文字・数字・ハイフン（例 `kint-origin-local-monthly-report`）。
- 上の表に無い名前（接頭辞の無い名前、`kint-origin-local-` 以外の `kint-origin-` 接頭辞）で新しく作らない。Claude・Cursor・Codex の hook が新規作成を拒否し、`kint-origin update` が警告する。

共有するスキル・コマンドを作る場合は [外部addon](../kint-origin-commands/references/addons.md) を読む。

## スキルを追加する

1. 同じフォルダを2か所に置く（Claude Code は `.claude/skills/`、Codex と Cursor は `.agents/skills/` を読む）。
   - `.claude/skills/kint-origin-local-<名前>/SKILL.md`
   - `.agents/skills/kint-origin-local-<名前>/SKILL.md`
2. `SKILL.md` の先頭に frontmatter を書く。

   ```markdown
   ---
   name: kint-origin-local-monthly-report
   description: 月次の案件報告書を data/ の取得内容から作る。月次報告を頼まれたときに使う。
   ---
   ```

   - `name`：フォルダ名と同じ。1〜64 文字。小文字の英数字とハイフンだけ（先頭・末尾・連続のハイフンは不可）。
   - `description`：1〜1024 文字。何をするかと、いつ使うかを書く（AI はこの文でスキルを選ぶ）。
3. 本文は 500 行未満を目安にする。長い資料は同じフォルダの別ファイルに分け、相対パスで参照する。

## ルール・役割を追加する

- ルール
  - Claude Code：`.claude/rules/kint-origin-local-<名前>.md`（`.md` だけを起動時に読む）
  - Cursor：`.cursor/rules/kint-origin-local-<名前>.mdc`
  - Codex 用の `.agents/rules/` は自動では読まれない。独自の作業手順は `kint-origin-local-*` のスキルに書き、必要な作業で明示的に使う。スキルの自動選択を常時適用の保証としない。
- 役割（サブエージェント）：`.claude/agents/kint-origin-local-<名前>.md`、`.cursor/agents/kint-origin-local-<名前>.md`、`.codex/agents/kint-origin-local-<名前>.toml`
- 独自の指示を `{{AGENT_DOC}}` に書かない（`kint-origin update` で上書きされる）。
- 個人の許可・設定は、ツールの個人用の設定ファイルに書く（Claude は `.claude/settings.local.json`）。

## 名前を直す（hook の拒否・update の警告・既存の接頭辞なしスキル）

1. 各置き場（`.claude/skills/`・`.agents/skills/`・`.cursor/skills/`）の旧フォルダを、シェルの移動で `kint-origin-local-<名前>` に変える。中のファイルもそのまま移る。新しい名前で一から作り直さない。
2. 各 `SKILL.md` の `name:` を新しいフォルダ名にする。
3. ドメイン内（`data/` を除く）で旧名を検索し、参照を新しい名前に直す。`data/` の中に見つかったら編集せず、ユーザーに伝える。
4. `kint-origin update` を `-y` なしで実行し、一覧の「そのまま残す独自スキル」に出ること、名前の警告が無いことを確かめる（`-y` はユーザーの承認なしに付けない）。
