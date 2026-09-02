// Cookie parsers shared by the auth adapter and config resolution.
// Split out of auth.ts so config.ts can read DIFY_CONSOLE_COOKIE without a cycle.

export function parseCookieString(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function parseCookieJson(jsonText: string): Record<string, string> {
  const out: Record<string, string> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return out;
  }
  let arr: unknown = parsed;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.cookies)) arr = obj.cookies;
    else {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  }
  if (!Array.isArray(arr)) return out;
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const name = (item as Record<string, unknown>).name;
    const value = (item as Record<string, unknown>).value;
    if (typeof name === "string" && typeof value === "string") out[name] = value;
  }
  return out;
}

const AUTH_COOKIE_RE = /(?:^|[-_])(access_token|console_token|csrf_token|refresh_token)$/i;
export function isAuthCookie(name: string): boolean {
  return AUTH_COOKIE_RE.test(name);
}
export function extractAuthCookies(cookies: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cookies)) {
    if (isAuthCookie(k)) out[k] = v;
  }
  return out;
}

export function parseAuthCookiesFromInput(input: unknown): Record<string, string> {
  if (input && typeof input === "object") {
    return extractAuthCookies(parseCookieJson(JSON.stringify(input)));
  }
  if (typeof input !== "string") return {};
  const trimmed = input.trim();
  const all = trimmed.startsWith("[") || trimmed.startsWith("{")
    ? parseCookieJson(trimmed)
    : parseCookieString(trimmed);
  return extractAuthCookies(all);
}

export function csrfValue(cookies: Record<string, string>): string | undefined {
  const key = Object.keys(cookies).find((k) => /csrf/i.test(k));
  return key ? cookies[key] : undefined;
}
