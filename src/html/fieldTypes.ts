// kintone フィールド型コード → 日本語表示ラベル。
const FIELD_TYPE_LABELS: Record<string, string> = {
  RECORD_NUMBER: "レコード番号",
  CREATOR: "作成者",
  CREATED_TIME: "作成日時",
  MODIFIER: "更新者",
  UPDATED_TIME: "更新日時",
  SINGLE_LINE_TEXT: "文字列（1行）",
  MULTI_LINE_TEXT: "文字列（複数行）",
  RICH_TEXT: "リッチエディター",
  NUMBER: "数値",
  CALC: "計算",
  RADIO_BUTTON: "ラジオボタン",
  CHECK_BOX: "チェックボックス",
  MULTI_SELECT: "複数選択",
  DROP_DOWN: "ドロップダウン",
  DATE: "日付",
  TIME: "時刻",
  DATETIME: "日時",
  LINK: "リンク",
  FILE: "添付ファイル",
  USER_SELECT: "ユーザー選択",
  ORGANIZATION_SELECT: "組織選択",
  GROUP_SELECT: "グループ選択",
  CATEGORY: "カテゴリー",
  STATUS: "ステータス",
  STATUS_ASSIGNEE: "作業者",
  SUBTABLE: "テーブル",
  REFERENCE_TABLE: "関連レコード一覧",
  GROUP: "グループ",
  SPACER: "スペース",
  LABEL: "ラベル",
  HR: "罫線"
};

export function fieldTypeLabel(type: unknown): string {
  const key = String(type || "");
  return FIELD_TYPE_LABELS[key] || key;
}
