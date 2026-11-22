# ソース公開の手順

ソースの公開を準備するときだけ読む。通常の文書修正で公開・版上げは行わない。npmのprivate設定は維持する。

## 公開元を確定する

- READMEの導入手順を確認する。取得したソースのpackage.jsonがあるディレクトリから導入できることを確認する。
- 現行版はpackage.jsonとロックファイルから読む。版番号や成功件数をこの手順へ固定しない。
- CHANGELOG.mdは開発元に残す。公開スナップショットとnpm packには入れない。
- MITの著作権表示は維持する。authorフィールドや社用メールを追加しない。不具合・脆弱性の受付窓口、Issues・Pull requests・private vulnerability reportingを設けない既存方針はREADME/SECURITYを確認する。

## スナップショットと検証

1. 公開対象の差分とブランチをレビューする。既存の未コミット変更を勝手に取り消さない。公開用コミットとクリーンな状態を確定してから `git archive --format=zip --output=../kint-origin-tools-source.zip HEAD` で取り出す。`.gitattributes` の `export-ignore` により CHANGELOG.md は含まれない。
2. 新しい空のフォルダへ展開する。開発用.gitや作業フォルダ全体を持ち込まない。追跡対象でも秘密情報を含まないか確認する。
3. 展開先で `git init` を実行する。smokeはGitの除外設定も検査する。その後、npm ci、agents:sync、agents:check、agents:test、全smoke、versionを確認する。.env・取得データ・古いnode_modulesを持ち込まない。
4. npm auditと依存の版を確認する。packのdry-runでREADMEから参照する利用資料とSECURITYが収録され、CHANGELOG・開発設定・取得データ・認証値が入らないことを確認する。
5. テナントURL・メール・ユーザーパス・内部名・鍵を検索し、一致を一件ずつ精査する。gitleaks等はredact付きで検査し、検出値をログへ出さない。履歴を公開する場合は履歴も検査する。
6. 最初のコミット前に、展開先のローカルのuser.name/user.emailを公開用に設定する。コミット後にもメールを確認する。公開済みの変更履歴に社用メールを残さない。

## 公開先の確認

新規リポジトリをprivateで作り、確認したコミットを置いて設定を確認してからpublicに切り替える。開発リポジトリのvisibilityを変更しない。
Secret scanning・Push protection・Dependabot alerts、Issues/PRの無効化、既定ブランチの保護、ライセンスの検出を確認する。使える機能は公開先プランの実画面で確認する。
ソース公開用のCI・Dependabot更新PR設定は置かず、公開前の検証はローカルで行う。開発元を作業の正本、公開先を変更履歴を除いた現行ソースのコピーとする。
