/*
Checks for values that pick where the bay itself sends traffic to a project
host: a reverse-tunnel port on this machine, or a host's reported URL.

These values come from project_hosts rows, and some of them were written by
host reports. A bad value must never become a request target, so every check
fails closed: it returns undefined and the caller refuses to route.
*/

import { isIP } from "node:net";

// Reverse-tunnel ports are allocated by the bay (backend/get-port), so they
// are never privileged ports.
const MIN_TUNNEL_PORT = 1024;
const MAX_TUNNEL_PORT = 65535;

/** A tunnel port if `value` is an integer in 1024..65535 (a JSON number, or a
 * string of digits as read through SQL ->>), else undefined. */
export function safeTunnelPort(value: unknown): number | undefined {
  let port: number;
  if (typeof value === "number") {
    port = value;
  } else if (typeof value === "string" && /^[0-9]{1,5}$/.test(value)) {
    port = Number(value);
  } else {
    return undefined;
  }
  if (!Number.isInteger(port)) return undefined;
  if (port < MIN_TUNNEL_PORT || port > MAX_TUNNEL_PORT) return undefined;
  return port;
}

function ipv4Octets(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split(".").map((x) => Number(x));
}

function isRefusedIpv4(address: string): boolean {
  const o = ipv4Octets(address);
  if (!o) return false;
  return (
    o[0] === 127 || // loopback
    o[0] === 0 || // "this network", including 0.0.0.0
    (o[0] === 169 && o[1] === 254) // link-local, including cloud metadata
  );
}

function isRefusedIpv6(address: string): boolean {
  if (isIP(address) !== 6) return false;
  const a = address.toLowerCase();
  if (a === "::" || a === "::1") return true;
  // fe80::/10 is link-local
  if (/^fe[89ab][0-9a-f]:/.test(a)) return true;
  // IPv4-mapped and IPv4-compatible forms of a refused IPv4 address
  const mapped = a.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && isRefusedIpv4(mapped[1])) return true;
  const hexMapped = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    const v4 = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    if (isRefusedIpv4(v4)) return true;
  }
  return false;
}

function isLoopbackHostname(h: string): boolean {
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const o = ipv4Octets(h);
  if (o) return o[0] === 127;
  if (isIP(h) === 6) {
    if (h === "::1") return true;
    const mapped = h.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    return !!mapped && ipv4Octets(mapped[1])?.[0] === 127;
  }
  return false;
}

/** Single-machine development runs hub and project host on one machine, with
 * loopback URLs. That is opt-in on the BAY (never set in production); the
 * unspecified, link-local and metadata addresses stay refused even then. */
export function projectHostLoopbackUrlsAllowed(): boolean {
  return process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS === "1";
}

/** True for a hostname a project host must never name as its address: the
 * loopback, unspecified or link-local addresses, "localhost", and the cloud
 * metadata server. `hostname` is as parsed by URL (IPv6 in brackets). */
export function isRefusedTargetHostname(
  hostname: string,
  { allowLoopback = false }: { allowLoopback?: boolean } = {},
): boolean {
  let h = `${hostname ?? ""}`.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  if (!h) return true;
  if (allowLoopback && isLoopbackHostname(h)) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata.google.internal" || h === "metadata") return true;
  return isRefusedIpv4(h) || isRefusedIpv6(h);
}

/** The URL string if it is a plain http(s) URL, with no credentials, whose
 * host is not refused (see isRefusedTargetHostname); else undefined. URL
 * parsing normalizes forms like http://2130706433/ to 127.0.0.1 first. */
export function safeProjectHostUrl(
  value: unknown,
  {
    allowLoopback = projectHostLoopbackUrlsAllowed(),
  }: { allowLoopback?: boolean } = {},
): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  if (parsed.username || parsed.password) return undefined;
  if (isRefusedTargetHostname(parsed.hostname, { allowLoopback })) {
    return undefined;
  }
  return raw;
}
