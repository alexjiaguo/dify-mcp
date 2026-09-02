import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const DEFAULT_MCP_MAX_BODY = 2 * 1024 * 1024;

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1";
}

export function bindRequiresToken(bindHost: string, token: string | undefined): string | undefined {
  if (token && token.length > 0) return undefined;
  if (isLoopbackHost(bindHost)) return undefined;
  return "DIFYWF_MCP_TOKEN is required when binding a non-loopback MCP HTTP address";
}

export function extractMcpToken(headers: IncomingHttpHeaders): string | undefined {
  const auth = headers.authorization;
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const header = headers["x-difywf-token"];
  if (typeof header === "string" && header) return header;
  if (Array.isArray(header) && header[0]) return header[0];
  return undefined;
}

export function mcpTokenMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Loopback anonymous traffic must present a loopback Host. Token-gated binds may use any Host. */
export function hostHeaderAllowed(
  hostHeader: string | undefined,
  bindHost: string,
  tokenConfigured: boolean,
): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.split(":")[0]?.replace(/^\[|\]$/g, "").toLowerCase() ?? "";
  if (isLoopbackHost(hostname)) return true;
  if (hostname === bindHost.toLowerCase()) return true;
  const extra = (process.env.DIFYWF_MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (extra.includes(hostname)) return true;
  return tokenConfigured && !isLoopbackHost(bindHost);
}

export function maxBodyBytes(env = process.env): number {
  const n = Number(env.DIFYWF_MCP_MAX_BODY_BYTES ?? DEFAULT_MCP_MAX_BODY);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MCP_MAX_BODY;
}
