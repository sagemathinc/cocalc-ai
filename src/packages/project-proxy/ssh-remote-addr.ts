/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

function stripIpv4MappedPrefix(host: string): string {
  const trimmed = host.trim();
  return trimmed.startsWith("::ffff:")
    ? trimmed.slice("::ffff:".length)
    : trimmed;
}

export function canonicalizeSshRemoteAddrParts(
  host: string,
  port: number,
): string {
  const normalizedHost = stripIpv4MappedPrefix(host);
  if (!normalizedHost || !Number.isInteger(port) || port <= 0) {
    throw new Error("invalid SSH remote address");
  }
  const isIpv6 = normalizedHost.includes(":");
  return isIpv6 ? `[${normalizedHost}]:${port}` : `${normalizedHost}:${port}`;
}

export function canonicalizeSshRemoteAddr(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error("invalid SSH remote address");
  }
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end <= 0 || value[end + 1] !== ":") {
      throw new Error("invalid SSH remote address");
    }
    const host = value.slice(1, end);
    const port = Number(value.slice(end + 2));
    return canonicalizeSshRemoteAddrParts(host, port);
  }
  const idx = value.lastIndexOf(":");
  if (idx <= 0) {
    throw new Error("invalid SSH remote address");
  }
  const host = value.slice(0, idx);
  const port = Number(value.slice(idx + 1));
  return canonicalizeSshRemoteAddrParts(host, port);
}
