/*
IP/CIDR allowlist parsing and matching for security-sensitive endpoints.

This is intentionally standalone so it can be reused across hub, conat, and
other services. Typical uses include protecting metrics endpoints, restricting
admin-only APIs, or limiting access to project hosts by source IP on on-prem
deployments.
*/

import { isIP } from "node:net";

export type AllowlistEntry = {
  family: 4 | 6;
  network: bigint;
  mask: number;
  original: string;
};

const IPV4_BITS = 32;
const IPV6_BITS = 128;

function parseIPv4(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!part.length) return null;
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    value = (value << 8n) + BigInt(num);
  }
  return value;
}

function expandIPv4ToIPv6(ip: string): number[] | null {
  const v4 = parseIPv4(ip);
  if (v4 == null) return null;
  const high = Number((v4 >> 16n) & 0xffffn);
  const low = Number(v4 & 0xffffn);
  return [high, low];
}

function parseIPv6(ip: string): bigint | null {
  const zoneIndex = ip.indexOf("%");
  if (zoneIndex >= 0) {
    ip = ip.slice(0, zoneIndex);
  }
  const parts = ip.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];

  const expandPart = (segments: string[]): number[] | null => {
    if (segments.length === 0) return [];
    const last = segments[segments.length - 1];
    if (last.includes(".")) {
      const v4 = expandIPv4ToIPv6(last);
      if (v4 == null) return null;
      const prefix = segments.slice(0, -1);
      return [...prefix, v4[0].toString(16), v4[1].toString(16)].map((seg) =>
        parseInt(seg, 16),
      );
    }
    return segments.map((seg) => parseInt(seg, 16));
  };

  const headNums = expandPart(head);
  const tailNums = expandPart(tail);
  if (headNums == null || tailNums == null) return null;

  const missing =
    parts.length === 2
      ? IPV6_BITS / 16 - (headNums.length + tailNums.length)
      : 0;
  if (missing < 0) return null;

  const full = [
    ...headNums,
    ...Array(missing).fill(0),
    ...tailNums,
  ];
  if (full.length !== IPV6_BITS / 16) return null;

  let value = 0n;
  for (const num of full) {
    if (!Number.isInteger(num) || num < 0 || num > 0xffff) return null;
    value = (value << 16n) + BigInt(num);
  }
  return value;
}

function normalizeIp(raw?: string | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (!ip) return null;
  if (ip.includes(",")) {
    ip = ip.split(",")[0].trim();
  }
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    if (end > 0) {
      ip = ip.slice(1, end);
    }
  }
  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }
  if (
    ip.includes(".") &&
    ip.includes(":") &&
    ip.indexOf(":") === ip.lastIndexOf(":")
  ) {
    const [host, port] = ip.split(":");
    if (port && /^[0-9]+$/.test(port)) {
      ip = host;
    }
  }
  return ip;
}

function toBigInt(ip: string): { family: 4 | 6; value: bigint } | null {
  const normalized = normalizeIp(ip);
  if (!normalized) return null;
  const family = isIP(normalized);
  if (family === 4) {
    const value = parseIPv4(normalized);
    if (value == null) return null;
    return { family: 4, value };
  }
  if (family === 6) {
    const value = parseIPv6(normalized);
    if (value == null) return null;
    return { family: 6, value };
  }
  return null;
}

function maskValue(value: bigint, mask: number, bits: number): bigint {
  const shift = BigInt(bits - mask);
  return (value >> shift) << shift;
}

export function parseAllowlist(value?: string | null): AllowlistEntry[] {
  if (!value) return [];
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const rules: AllowlistEntry[] = [];
  for (const entry of entries) {
    const [addrRaw, maskRaw] = entry.split("/");
    const parsed = toBigInt(addrRaw);
    if (!parsed) continue;
    const maxBits = parsed.family === 4 ? IPV4_BITS : IPV6_BITS;
    const mask = maskRaw ? parseInt(maskRaw, 10) : maxBits;
    if (!Number.isInteger(mask) || mask < 0 || mask > maxBits) continue;
    const network = maskValue(parsed.value, mask, maxBits);
    rules.push({
      family: parsed.family,
      network,
      mask,
      original: entry,
    });
  }
  return rules;
}

export function isIpAllowed(
  ip: string | null | undefined,
  allowlist: AllowlistEntry[],
): boolean {
  if (!ip || allowlist.length === 0) return false;
  const parsed = toBigInt(ip);
  if (!parsed) return false;
  const bits = parsed.family === 4 ? IPV4_BITS : IPV6_BITS;
  for (const rule of allowlist) {
    if (rule.family !== parsed.family) continue;
    const masked = maskValue(parsed.value, rule.mask, bits);
    if (masked === rule.network) return true;
  }
  return false;
}

export function extractForwardedIp(
  header?: string | string[] | null,
): string | null {
  if (!header) return null;
  if (Array.isArray(header)) {
    return header.length > 0 ? header[0].trim() : null;
  }
  return header.split(",")[0].trim();
}
