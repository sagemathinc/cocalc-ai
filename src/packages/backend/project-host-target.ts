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

// The eight 16-bit groups of an IPv6 address (any spelling: "::", an embedded
// dotted quad, a zone id), or undefined if it is not one.
function ipv6Groups(address: string): number[] | undefined {
  let a = address.toLowerCase();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  if (isIP(a) !== 6) return undefined;
  const dotted = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = ipv4Octets(dotted[2]);
    if (!o) return undefined;
    a = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = a.includes("::") ? a.split("::") : [a, undefined];
  const parse = (s: string) =>
    s ? s.split(":").map((x) => parseInt(x, 16)) : [];
  const h = parse(head);
  if (tail === undefined) return h.length === 8 ? h : undefined;
  const t = parse(tail);
  const fill = 8 - h.length - t.length;
  if (fill < 1) return undefined;
  return [...h, ...new Array(fill).fill(0), ...t];
}

function embeddedIpv4(g: number[]): string {
  return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
}

// The IPv4 address an IPv6 address stands for: IPv4-mapped ::ffff:0:0/96,
// IPv4-translated ::ffff:0:0:0/96, IPv4-compatible ::/96 and the NAT64
// well-known prefix 64:ff9b::/96. Undefined for any other IPv6 address.
function ipv4InIpv6(g: number[]): string | undefined {
  const zero = (from: number, to: number) =>
    g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return embeddedIpv4(g);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return embeddedIpv4(g);
  if (zero(0, 6)) return embeddedIpv4(g);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return embeddedIpv4(g);
  return undefined;
}

function isRefusedIpv6(address: string): boolean {
  const g = ipv6Groups(address);
  if (!g) return false;
  // ::1 and :: are covered below as ::0.0.0.1 and ::0.0.0.0 (0.0.0.0/8).
  // fe80::/10 is link-local
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  const v4 = ipv4InIpv6(g);
  return v4 != null && isRefusedIpv4(v4);
}

// Loopback only in the forms a bay uses for itself: 127.0.0.0/8, ::1, the
// IPv4-mapped ::ffff:127.0.0.0/104, and the localhost names.
function isLoopbackHostname(h: string): boolean {
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const o = ipv4Octets(h);
  if (o) return o[0] === 127;
  const g = ipv6Groups(h);
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  return mapped && g[6] >> 8 === 127;
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
