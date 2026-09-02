export type FilePayload = {
  name: string;
  content_b64: string;
  mime?: string;
  field?: string;
};

export function isFilePayload(value: unknown): value is FilePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && v.name.length > 0 && typeof v.content_b64 === "string";
}

export function toFormData(file: FilePayload, field = "file"): FormData {
  const buf = Buffer.from(file.content_b64, "base64");
  const form = new FormData();
  const blob = new Blob([buf], { type: file.mime || "application/octet-stream" });
  form.append(file.field || field, blob, file.name);
  return form;
}
