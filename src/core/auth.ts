// Auth adapter. OpenAPI side: RFC 8628 device flow (same as difyctl).
// Console side: email/password session JWT (self-hosted fallback) or a
// user-supplied token. Storage: ~/.difywf/hosts.json (0600).
// The F1 spike (scripts/auth-spike.mjs) determines which credential can
// authorize console endpoints on a given instance.

import { err, ok, type Result } from "./contract.ts";
import { apiCall, fetchCapturingCookies } from "./http.ts";
import { loadHosts, saveHosts } from "./config.ts";

const CLIENT_ID = "difywf";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export type DeviceCodeInfo = {
  device_code: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
};

export async function deviceRequestCode(
  baseUrl: string,
  label?: string,
): Promise<Result<DeviceCodeInfo>> {
  return apiCall<DeviceCodeInfo>(baseUrl, "/openapi/v1/oauth/device/code", {
    body: { client_id: CLIENT_ID, device_label: label ?? "difywf" },
  });
}

export type DevicePollOutcome =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "approved"; token: Record<string, unknown> }
  | { status: "failed"; message: string };

export async function devicePollOnce(
  baseUrl: string,
  deviceCode: string,
): Promise<DevicePollOutcome> {
  const r = await apiCall<Record<string, unknown>>(baseUrl, "/openapi/v1/oauth/device/token", {
    body: { device_code: deviceCode, client_id: CLIENT_ID, grant_type: DEVICE_GRANT },
  });
  if (r.ok) return { status: "approved", token: r.data };
  const detail = r.error.details;
  const code =
    detail && typeof detail === "object"
      ? String((detail as Record<string, unknown>).error ?? "")
      : "";
  if (code === "authorization_pending") return { status: "pending" };
  if (code === "slow_down") return { status: "slow_down" };
  return { status: "failed", message: r.error.message };
}

export async function deviceLoginFlow(
  baseUrl: string,
  label: string | undefined,
  onCode: (info: DeviceCodeInfo) => void,
): Promise<Result<Record<string, unknown>>> {
  const code = await deviceRequestCode(baseUrl, label);
  if (!code.ok) return code;
  onCode(code.data);
  const deadline = Date.now() + (code.data.expires_in ?? 600) * 1000;
  let interval = Math.max(code.data.interval ?? 5, 2) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const outcome = await devicePollOnce(baseUrl, code.data.device_code);
    if (outcome.status === "approved") return ok(outcome.token);
    if (outcome.status === "slow_down") interval += 5000;
    if (outcome.status === "failed") return err("AUTH_EXPIRED", outcome.message);
  }
  return err("AUTH_EXPIRED", "device code expired before approval");
}

// Console auth is cookie-based on current Dify: POST /console/api/login sets
// console_token + refresh_token + csrf_token cookies and returns {result:"success"}.
// We capture those cookies and replay them (plus the X-CSRF-Token header) on every
// console call. refresh_token renews console_token via /console/api/refresh-token.
export async function consoleLogin(
  baseUrl: string,
  email: string,
  password: string,
  passwordEncoding: "plain" | "base64" = "plain",
): Promise<Result<Record<string, string>>> {
  const encodedPassword = passwordEncoding === "base64"
    ? Buffer.from(password, "utf8").toString("base64")
    : password;
  const r = await fetchCapturingCookies(baseUrl, "/console/api/login", {
    body: { email, password: encodedPassword, remember_me: true, language: "en-US" },
  });
  if (!r.ok) return r;
  const cookies = r.data.cookies;
  if (!Object.keys(cookies).length) {
    return err("SERVER_ERROR", "login returned 200 but set no session cookies", {
      details: r.data.data,
    });
  }
  return ok(cookies);
}

// Renew the console session using the refresh_token cookie. Merges so a missing
// refresh cookie in the response (server rotates only console_token) is preserved.
export async function refreshConsoleCookies(
  baseUrl: string,
  cookies: Record<string, string>,
): Promise<Result<Record<string, string>>> {
  const r = await fetchCapturingCookies(baseUrl, "/console/api/refresh-token", {
    method: "POST",
    cookies,
    csrfToken: csrfValue(cookies),
  });
  if (!r.ok) return r;
  return ok({ ...cookies, ...r.data.cookies });
}

// Parse a raw "k=v; k2=v2" Cookie header string. Pairs are separated by ';' ONLY -
// values may contain commas (e.g. the cookieyes-consent cookie), so splitting on ','
// corrupts them. This was the bug that caused a garbage AMP cookie to get stored.
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

// Parse a browser cookie-export JSON array ([{name, value, ...}, ...]) into a map.
// This is the format produced by cookie-editor / EditThisCookie extensions, so a user
// can export ALL cookies and difywf picks out the auth ones (see extractAuthCookies).
export function parseCookieJson(jsonText: string): Record<string, string> {
  const out: Record<string, string> = {};
  let arr: unknown;
  try {
    arr = JSON.parse(jsonText);
  } catch {
    return out;
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

// Match Dify console auth cookies by name, tolerating __Host- / __Secure- prefixes.
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

// Detect input format (JSON array vs raw Cookie header), parse, keep only auth cookies.
export function parseAuthCookiesFromInput(text: string): Record<string, string> {
  const trimmed = text.trim();
  const all = trimmed.startsWith("[") || trimmed.startsWith("{")
    ? parseCookieJson(trimmed)
    : parseCookieString(trimmed);
  return extractAuthCookies(all);
}

export function csrfValue(cookies: Record<string, string>): string | undefined {
  const key = Object.keys(cookies).find((k) => /csrf/i.test(k));
  return key ? cookies[key] : undefined;
}

export function storeCookies(baseUrl: string, cookies: Record<string, string>): void {
  const hosts = loadHosts();
  hosts.hosts[baseUrl] = { ...hosts.hosts[baseUrl], console_cookies: cookies };
  if (!hosts.active_host) hosts.active_host = baseUrl;
  saveHosts(hosts);
}

export function storeToken(
  baseUrl: string,
  kind: "openapi_token" | "console_token",
  token: string,
): void {
  const hosts = loadHosts();
  hosts.hosts[baseUrl] = { ...hosts.hosts[baseUrl], [kind]: token };
  if (!hosts.active_host) hosts.active_host = baseUrl;
  saveHosts(hosts);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
