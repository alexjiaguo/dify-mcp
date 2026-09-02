const SENSITIVE_KEY =
  /token|secret|credential|password|passwd|api[-_]?key|authorization|cookie|csrf|refresh|^yaml$|graph_json|content_b64|^graph$/i;

export function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item, i) => redactValue(String(i), item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 4000) {
    return `${value.slice(0, 256)}…[truncated ${value.length} chars]`;
  }
  return value;
}

export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return redactValue("args", args) as Record<string, unknown>;
}
