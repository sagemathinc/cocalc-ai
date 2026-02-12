import { isIP } from "node:net";
import { URL } from "node:url";

function parseBoolean(value: string | undefined): boolean {
  const v = `${value ?? ""}`.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function trimIpv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

export function extractHost(value: string): string {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return "";
  try {
    if (raw.includes("://")) {
      return trimIpv6Brackets(new URL(raw).hostname).toLowerCase();
    }
  } catch {
    // fall through to non-URL parsing
  }
  const unbracketed = trimIpv6Brackets(raw);
  if (isIP(unbracketed)) return unbracketed.toLowerCase();

  // host:port (non-IPv6 host)
  const parts = raw.split(":");
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return trimIpv6Brackets(parts[0]).toLowerCase();
  }
  return unbracketed.toLowerCase();
}

export function isLoopbackHost(value: string): boolean {
  const host = extractHost(value);
  if (!host) return false;
  if (host === "localhost" || host === "::1") return true;
  if (host.startsWith("127.")) return true;
  return false;
}

export function isInsecureHttpModeAllowed(): boolean {
  return parseBoolean(process.env.COCALC_ALLOW_INSECURE_HTTP_MODE);
}

export function assertLocalBindOrInsecure({
  bindHost,
  serviceName,
}: {
  bindHost: string;
  serviceName: string;
}): void {
  if (isLoopbackHost(bindHost)) return;
  if (isInsecureHttpModeAllowed()) return;
  throw new Error(
    `${serviceName}: refusing non-loopback bind host '${bindHost}'. ` +
      `Set COCALC_ALLOW_INSECURE_HTTP_MODE=true to override.`,
  );
}

export function assertSecureUrlOrLocal({
  url,
  urlName,
}: {
  url: string;
  urlName: string;
}): void {
  const value = `${url ?? ""}`.trim();
  if (!value) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Not a URL; treat as host-like value and require loopback unless override.
    if (isLoopbackHost(value) || isInsecureHttpModeAllowed()) return;
    throw new Error(
      `${urlName}: expected URL for remote endpoint, got '${value}'. ` +
        `Set COCALC_ALLOW_INSECURE_HTTP_MODE=true to override.`,
    );
  }
  if (isLoopbackHost(parsed.hostname)) return;
  if (parsed.protocol === "https:") return;
  if (isInsecureHttpModeAllowed()) return;
  throw new Error(
    `${urlName}: refusing non-HTTPS URL '${value}' for non-loopback host. ` +
      `Set COCALC_ALLOW_INSECURE_HTTP_MODE=true to override.`,
  );
}
