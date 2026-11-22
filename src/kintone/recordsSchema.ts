export interface RecordsCsvSchema {
  schemaVersion: 1;
  appId: string;
  formRevision: string;
  csvSha256: string;
  fields: Record<string, string>;
}

export function recordsSchemaFromForm(appId: string, form: any): Omit<RecordsCsvSchema, "csvSha256"> {
  if (!form || typeof form !== "object" || !form.properties || typeof form.properties !== "object" || Array.isArray(form.properties)) {
    throw new Error(`アプリ ${appId} のフォーム定義が不正です。`);
  }
  if (form.revision === undefined || form.revision === null || String(form.revision).trim() === "") {
    throw new Error(`アプリ ${appId} のフォーム定義に revision がありません。`);
  }

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(form.properties as Record<string, any>)) {
    if (!value || typeof value !== "object" || typeof value.code !== "string" || !value.code || typeof value.type !== "string" || !value.type) {
      throw new Error(`アプリ ${appId} のフォーム定義に不正なフィールドがあります。`);
    }
    if (value.code !== key || Object.hasOwn(fields, value.code)) {
      throw new Error(`アプリ ${appId} のフォーム定義でフィールドコードが重複または一致しません: ${value.code}`);
    }
    fields[value.code] = value.type;
  }

  return {
    schemaVersion: 1,
    appId,
    formRevision: String(form.revision),
    fields: Object.fromEntries(Object.entries(fields).sort(([left], [right]) => left.localeCompare(right, "en")))
  };
}
