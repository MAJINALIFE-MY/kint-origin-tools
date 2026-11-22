const DYNAMIC_VALUE_PLACEHOLDER = "-";

export function dynamicPlaceholder(): string {
  return DYNAMIC_VALUE_PLACEHOLDER;
}

// 取得のたびに変わる値（リビジョン・アップロード済みファイルの fileKey）を "-" に置き換えて差分を安定させる。
// キー名だけで置換しない。フィールドコード・ビュー名・アクション名などは任意の文字列を取れるため、
// `revision` / `fileKey` というコードのフィールド定義（値はオブジェクト）まで潰してしまう。
// 実際の値は常に文字列か数値なので、そのときだけ置き換える。さらに revision は API 応答のトップレベルにしか無い。
function isDynamicValue(key: string, value: unknown, depth: number): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  if (key === "revision") return depth === 0;
  return key === "fileKey";
}

function normalizeAt(value: any, depth: number): any {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeAt(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, childValue]) => [
        key,
        isDynamicValue(key, childValue, depth) ? DYNAMIC_VALUE_PLACEHOLDER : normalizeAt(childValue, depth + 1)
      ])
    );
  }
  return value;
}

export function normalizeDynamicValues(value: any): any {
  return normalizeAt(value, 0);
}

// キーを再帰的にソートした JSON 文字列。ハッシュ比較用（配列の順序は保持する）。
export function canonicalJson(value: unknown): string {
  const sortKeys = (node: any): any => {
    if (Array.isArray(node)) return node.map(sortKeys);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.keys(node)
          .sort()
          .map((key) => [key, sortKeys(node[key])])
      );
    }
    return node;
  };
  return JSON.stringify(sortKeys(value));
}

export function sanitizeName(name: string): string {
  return String(name || "")
    .trim()
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^\.+$/, "")
    .trim();
}

// ファイル名として安全化する。パス区切り・Windows 不正文字のみを `_` に置換し、
// 内部の空白やハイフン・ドットは保持する（sanitizeName より穏当）。末尾のドット/空白は Windows 対策で除去。
export function sanitizeFileName(name: string): string {
  const cleaned = String(name || "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  return cleaned || "_";
}

export function sortByNameThenId<T>(list: T[], nameKey = "name", idKey = "id"): T[] {
  return [...list].sort((a: any, b: any) => {
    const nameA = String(a?.[nameKey] || "");
    const nameB = String(b?.[nameKey] || "");
    const byName = nameA.localeCompare(nameB, "ja");
    if (byName !== 0) return byName;
    return String(a?.[idKey] || "").localeCompare(String(b?.[idKey] || ""), "en");
  });
}
