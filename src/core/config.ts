// Config resolution: flags > env > hosts store (~/.difywf/hosts.json, mode 0600).
// Same resolution path for CLI and MCP so behavior is identical on both surfaces.
// Secrets prefer the OS keychain when DIFYWF_HOME is unset; file is the fallback.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseAuthCookiesFromInput } from "./cookies.ts";
import { difywfHome } from "./paths.ts";

export type HostEntry = {
  openapi_token?: string;
  console_token?: string;
  console_cookies?: Record<string, string>;
  workspace_id?: string;
};
export type HostsFile = { active_host?: string; hosts: Record<string, HostEntry> };

export type Config = {
  baseUrl: string;
  openapiToken?: string;
  consoleToken?: string;
  consoleCookies?: Record<string, string>;
  workspaceId?: string;
};

export type Flags = Record<string, unknown>;

export const storePath = (): string => path.join(difywfHome(), "hosts.json");

function ensureHome(): string {
  const dir = difywfHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore platforms that cannot chmod
  }
  return dir;
}

function keychainEnabled(): boolean {
  if (process.env.DIFYWF_HOME) return false;
  if (process.env.DIFYWF_KEYCHAIN === "0") return false;
  if (process.env.DIFYWF_KEYCHAIN === "1") return true;
  return process.platform === "darwin";
}

function keychainGet(): string | undefined {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", "difywf-hosts", "-a", "difywf", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

function keychainSet(json: string): boolean {
  try {
    execFileSync(
      "security",
      ["add-generic-password", "-U", "-s", "difywf-hosts", "-a", "difywf", "-w", json],
      { encoding: "utf8", stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function readFileStore(): HostsFile {
  try {
    return JSON.parse(fs.readFileSync(storePath(), "utf8")) as HostsFile;
  } catch {
    return { hosts: {} };
  }
}

export function loadHosts(): HostsFile {
  if (keychainEnabled()) {
    const blob = keychainGet();
    if (blob) {
      try {
        return JSON.parse(blob) as HostsFile;
      } catch {
        // fall through to file
      }
    }
  }
  return readFileStore();
}

function publicHostsView(h: HostsFile): HostsFile {
  const hosts: Record<string, HostEntry> = {};
  for (const [url, entry] of Object.entries(h.hosts)) {
    hosts[url] = { workspace_id: entry.workspace_id };
  }
  return { active_host: h.active_host, hosts };
}

export function saveHosts(h: HostsFile): void {
  ensureHome();
  const full = JSON.stringify(h, null, 2);
  let wroteKeychain = false;
  if (keychainEnabled()) wroteKeychain = keychainSet(full);
  const onDisk = wroteKeychain ? publicHostsView(h) : h;
  fs.writeFileSync(storePath(), JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(storePath(), 0o600);
  } catch {
    // ignore
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

function cookiesFrom(value: unknown): Record<string, string> | undefined {
  const parsed = parseAuthCookiesFromInput(value);
  return Object.keys(parsed).length ? parsed : undefined;
}

export function resolveConfig(flags: Flags): Config {
  const hosts = loadHosts();
  const baseUrl =
    str(flags["base-url"]) ?? process.env.DIFY_API_BASE ?? hosts.active_host ?? "";
  const entry = baseUrl ? hosts.hosts[baseUrl] ?? {} : {};
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    openapiToken:
      str(flags["openapi-token"]) ?? process.env.DIFY_OPENAPI_TOKEN ?? entry.openapi_token,
    consoleToken:
      str(flags["console-token"]) ?? process.env.DIFY_CONSOLE_TOKEN ?? entry.console_token,
    consoleCookies:
      cookiesFrom(flags["console-cookie"]) ??
      cookiesFrom(process.env.DIFY_CONSOLE_COOKIE) ??
      entry.console_cookies,
    workspaceId:
      str(flags.workspace) ?? process.env.DIFY_WORKSPACE_ID ?? entry.workspace_id,
  };
}

export function storeWorkspace(baseUrl: string, workspaceId: string): void {
  const hosts = loadHosts();
  hosts.hosts[baseUrl] = { ...hosts.hosts[baseUrl], workspace_id: workspaceId };
  if (!hosts.active_host) hosts.active_host = baseUrl;
  saveHosts(hosts);
}

export function maskToken(t?: string): string | null {
  if (!t) return null;
  if (t.length <= 8) return "***";
  return `${t.slice(0, 4)}...${t.slice(-4)}`;
}
