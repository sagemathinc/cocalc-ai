/*
Checks for values that pick where the bay itself sends traffic to a project
host: a reverse-tunnel port on this machine, or a host's reported URL.

These values come from project_hosts rows, and some of them were written by
host reports. A bad value must never become a request target, so every check
fails closed: it returns undefined and the caller refuses to route.

Two layers: the lexical checks below look at the value itself, and the
connection agents at the end check the address actually connected to, after
DNS resolution, so a name that resolves to a refused address is refused too.
*/

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import getLogger from "./logger";

const logger = getLogger("project-host-target");

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

/* Connection agents.

The lexical checks above see only the name in a URL. These http(s) agents
check the address a connection is actually opened to:

- a literal IP host is checked as it is;
- a name goes through the lookup hook, which resolves it ONCE, checks EVERY
  address in the answer, and hands only those checked addresses to the
  socket, so nothing resolves the name again before the connect;
- a unix socket path is refused.

Loopback is never allowed for a name that merely resolves to it: with
allowLoopback, a loopback literal (the bay's own 127.0.0.1 tunnel) or a
localhost name may connect to loopback, and nothing else may. Link-local,
unspecified and metadata addresses are refused always. A refusal fails the
connection with REFUSED_TARGET_CODE and is logged without the value.

The agents keep no sockets alive between requests, and they have no proxy
configuration, so HTTP(S)_PROXY in the environment does not apply to them. */

export const REFUSED_TARGET_CODE = "ECOCALC_REFUSED_TARGET";

type Lookup = typeof dnsLookup;

function refusedTargetError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    "project host connection refused: the target address is not allowed",
  );
  err.code = REFUSED_TARGET_CODE;
  return err;
}

function normalizedHost(host: unknown): string {
  let h = `${host ?? ""}`.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

function isLocalhostName(h: string): boolean {
  return h === "localhost" || h.endsWith(".localhost");
}

/** A dns.lookup replacement that refuses unless every resolved address is
 * allowed. With allowLoopback, only a localhost name may resolve to loopback
 * (and then must). */
export function guardedLookup({
  allowLoopback = false,
  lookup = dnsLookup,
}: { allowLoopback?: boolean; lookup?: Lookup } = {}) {
  return function (hostname: string, options: any, callback?: any): void {
    if (typeof options === "function") {
      callback = options;
      options = {};
    } else if (typeof options === "number") {
      options = { family: options };
    } else {
      options = options ?? {};
    }
    const name = normalizedHost(hostname);
    const loopbackName = allowLoopback && isLocalhostName(name);
    const refuse = () => {
      logger.warn(
        "refused project host connection: resolved address not allowed",
      );
      process.nextTick(callback, refusedTargetError());
    };
    if (
      !name ||
      (!loopbackName && isRefusedTargetHostname(name, { allowLoopback: false }))
    ) {
      refuse();
      return;
    }
    (lookup as any)(
      hostname,
      { ...options, all: true },
      (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
        if (err) {
          callback(err);
          return;
        }
        const list = Array.isArray(addresses) ? addresses : [];
        const allowed = (a: LookupAddress) =>
          loopbackName
            ? isLoopbackHostname(normalizedHost(a?.address))
            : !isRefusedTargetHostname(`${a?.address ?? ""}`, {
                allowLoopback: false,
              });
        if (list.length === 0 || !list.every(allowed)) {
          refuse();
          return;
        }
        if (options.all) {
          callback(null, list);
        } else {
          callback(null, list[0].address, list[0].family);
        }
      },
    );
  };
}

function guardAgent<T extends http.Agent>(
  agent: T,
  { allowLoopback, lookup }: { allowLoopback: boolean; lookup?: Lookup },
): T {
  const hook = guardedLookup({ allowLoopback, lookup });
  const createConnection = (agent as any).createConnection;
  (agent as any).createConnection = function (options: any, callback?: any) {
    const host = normalizedHost(options?.host ?? options?.hostname);
    const refusedLiteral =
      isIP(host) !== 0 && isRefusedTargetHostname(host, { allowLoopback });
    if (options?.socketPath != null || refusedLiteral) {
      logger.warn("refused project host connection: address not allowed");
      const err = refusedTargetError();
      if (typeof callback === "function") {
        process.nextTick(callback, err);
        return undefined;
      }
      throw err;
    }
    // The hook wins over any lookup in the request options.
    return createConnection.call(this, { ...options, lookup: hook }, callback);
  };
  return agent;
}

/** A new guarded agent: https when `secure`, else http. */
export function createProjectHostAgent({
  secure,
  allowLoopback = false,
  lookup,
}: {
  secure: boolean;
  allowLoopback?: boolean;
  lookup?: Lookup;
}): http.Agent {
  const agent = secure
    ? new https.Agent({ keepAlive: false })
    : new http.Agent({ keepAlive: false });
  return guardAgent(agent, { allowLoopback, lookup });
}

/** True if `target` is exactly the bay's own reverse-tunnel form,
 * http://127.0.0.1:PORT with an allowed tunnel port and nothing else. */
export function isBayTunnelAddress(target: string | URL): boolean {
  let url: URL;
  try {
    url = typeof target === "string" ? new URL(target) : target;
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    safeTunnelPort(url.port) != null &&
    !url.username &&
    !url.password &&
    (url.pathname === "/" || url.pathname === "") &&
    !url.search &&
    !url.hash
  );
}

const sharedAgents = new Map<string, http.Agent>();

/** The shared guarded agent for connecting to `target` (http/ws or
 * https/wss). Loopback is allowed when the caller says so for this target,
 * for the bay's own tunnel form, or with the development opt-in. */
export function projectHostAgentFor(
  target: string | URL,
  { allowLoopback }: { allowLoopback?: boolean } = {},
): http.Agent {
  const url = typeof target === "string" ? new URL(target) : target;
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const loopback =
    allowLoopback === true ||
    isBayTunnelAddress(url) ||
    projectHostLoopbackUrlsAllowed();
  const key = `${secure}:${loopback}`;
  let agent = sharedAgents.get(key);
  if (agent == null) {
    agent = createProjectHostAgent({ secure, allowLoopback: loopback });
    sharedAgents.set(key, agent);
  }
  return agent;
}
