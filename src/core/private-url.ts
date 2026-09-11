const PRIVATE_HOST =
  /^(localhost\.?|metadata\.google\.internal)$/i;

export function hostnameOfUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname;
  } catch {
    return undefined;
  }
}

function stripZone(host: string): string {
  return host.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
}

function isIpv4MappedIpv6(host: string): string | undefined {
  // ::ffff:127.0.0.1 or ::ffff:7f00:1
  const m = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(host);
  if (m) return m[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (hex) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return undefined;
}

function isPrivateIpv4(h: string): boolean {
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  // CGNAT / shared address space (RFC 6598)
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}

function isPrivateIpv6(h: string): boolean {
  if (h === "::" || h === "::1" || h === "0:0:0:0:0:0:0:0" || h === "0:0:0:0:0:0:0:1") return true;
  // Unique local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{0,2}:/i.test(h) || /^fe[89ab][0-9a-f]?:/i.test(h)) return true;
  const mapped = isIpv4MappedIpv6(h);
  if (mapped) return isPrivateIpv4(mapped);
  return false;
}

export function isPrivateHostname(host: string): boolean {
  const h = stripZone(host);
  // Trailing-dot FQDN form of localhost
  const bare = h.replace(/\.$/, "");
  if (PRIVATE_HOST.test(h) || PRIVATE_HOST.test(bare) || bare === "localhost") return true;
  if (h === "0.0.0.0") return true;
  if (isPrivateIpv4(h)) return true;
  if (h.includes(":")) return isPrivateIpv6(h);
  return false;
}

export function isPrivateUrl(raw: string): boolean {
  const host = hostnameOfUrl(raw);
  return host ? isPrivateHostname(host) : false;
}
