const PRIVATE_HOST =
  /^(localhost|metadata\.google\.internal)$/i;

export function hostnameOfUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname;
  } catch {
    return undefined;
  }
}

export function isPrivateHostname(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (PRIVATE_HOST.test(h) || h === "0.0.0.0" || h === "::" || h === "::1") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}

export function isPrivateUrl(raw: string): boolean {
  const host = hostnameOfUrl(raw);
  return host ? isPrivateHostname(host) : false;
}
