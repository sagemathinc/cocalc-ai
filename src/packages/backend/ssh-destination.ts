/*
Checks for values that end up in the argv of an ssh process the bay itself
runs: the login name, the host and the port of the destination.

Several of these come from stored project_hosts metadata, which host reports
and host creation could write, so each is checked against a strict shape and
anything else is refused (the caller gets undefined and does not run ssh).
The destination is also always placed after "--", so even a value that got
past these checks could never be read by ssh as an option.

Refused hosts, by class: loopback (127.0.0.0/8, ::1 and their IPv4-mapped,
-compatible and NAT64 forms, and the localhost names; allowed only with the
bay's development opt-in, COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS=1), the
unspecified addresses (0.0.0.0/8, ::), link-local (169.254.0.0/16, which
includes the cloud metadata server, and fe80::/10), and the metadata server
names. Private and LAN addresses are allowed: a self-hosted machine is often
on the owner's own network.
*/

import { isIP } from "node:net";
import {
  isRefusedTargetHostname,
  projectHostLoopbackUrlsAllowed,
} from "./project-host-target";

const LOGIN_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** `value` if it is a plain login name (a lowercase letter or underscore,
 * then up to 31 of [a-z0-9_-]), else undefined. Never starts with "-". */
export function safeSshLoginName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return LOGIN_NAME.test(value) ? value : undefined;
}

function isDnsHostname(h: string): boolean {
  if (h.length === 0 || h.length > 253) return false;
  const labels = h.split(".");
  if (!labels.every((label) => DNS_LABEL.test(label))) return false;
  // A numeric last label makes resolvers read the whole name as an IPv4
  // address in some legacy form (1.2.3, 0x7f.1, 2130706433), so such a name
  // must be a plain dotted-quad address instead, checked as one.
  const last = labels[labels.length - 1];
  return !/^(?:[0-9]+|0x[0-9a-f]*)$/i.test(last);
}

export interface SshHostOptions {
  /** Only an IP address, never a name. */
  requireIp?: boolean;
  allowLoopback?: boolean;
}

/** `value` if it is an IP address (IPv6 without brackets or zone id) or a DNS
 * hostname, not in a refused class (see above); else undefined. */
export function safeSshHost(
  value: unknown,
  {
    requireIp = false,
    allowLoopback = projectHostLoopbackUrlsAllowed(),
  }: SshHostOptions = {},
): string | undefined {
  if (typeof value !== "string") return undefined;
  const family = isIP(value);
  if (family === 6 && value.includes("%")) return undefined;
  if (family === 0 && (requireIp || !isDnsHostname(value))) return undefined;
  if (isRefusedTargetHostname(value, { allowLoopback })) return undefined;
  return value;
}

/** An integer port in 1..65535, from a number or a string of digits. */
export function safeSshPort(value: unknown): number | undefined {
  let port: number;
  if (typeof value === "number") {
    port = value;
  } else if (typeof value === "string" && /^[0-9]{1,5}$/.test(value)) {
    port = Number(value);
  } else {
    return undefined;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return port;
}

export interface SshTargetSpec {
  user?: string;
  host: string;
  port?: number;
}

/** Parses "[user@]host[:port]", where host is a DNS name, an IPv4 address, a
 * bracketed IPv6 address (port optional) or a bare IPv6 address (no port).
 * Every part must pass the checks above (which also refuse whitespace,
 * control characters, Unicode and a second "@"); else undefined. */
export function parseSshTargetSpec(
  raw: unknown,
  opts: SshHostOptions = {},
): SshTargetSpec | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  let user: string | undefined;
  let hostPart = s;
  const at = s.indexOf("@");
  if (at >= 0) {
    user = safeSshLoginName(s.slice(0, at));
    hostPart = s.slice(at + 1);
    if (user == null) return undefined;
  }
  let host: string;
  let portText: string | undefined;
  if (hostPart.startsWith("[")) {
    const m = hostPart.match(/^\[([^[\]]+)\](?::([^:]*))?$/);
    if (!m || isIP(m[1]) !== 6) return undefined;
    host = m[1];
    portText = m[2];
  } else {
    const colons = hostPart.split(":").length - 1;
    if (colons === 0) {
      host = hostPart;
    } else if (colons === 1) {
      [host, portText] = hostPart.split(":");
    } else {
      // Only a bare IPv6 address can have more colons, and leaves no room for
      // a port (the host check below refuses anything else).
      host = hostPart;
    }
  }
  if (safeSshHost(host, opts) == null) return undefined;
  let port: number | undefined;
  if (portText != null) {
    port = safeSshPort(portText);
    if (port == null) return undefined;
  }
  return { ...(user != null ? { user } : {}), host, ...(port ? { port } : {}) };
}

/** "user@host" for a checked login name and host, else undefined. */
export function safeSshDestination(
  user: unknown,
  host: unknown,
  opts: SshHostOptions = {},
): string | undefined {
  const login = safeSshLoginName(user);
  const address = safeSshHost(host, opts);
  if (login == null || address == null) return undefined;
  return `${login}@${address}`;
}

/** The end of an ssh argv: "--", the destination, then the remote command.
 * Every option must come before this. */
export function sshDestinationArgs(
  destination: string,
  command: string[] = [],
): string[] {
  return ["--", destination, ...command];
}

/** `arg` quoted for a POSIX shell, so the shell reads it back as exactly one
 * word with exactly this text. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_/.,:=+@-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** A shell command line that runs `argv` as is. */
export function shellCommand(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}
