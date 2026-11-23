/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Source ranges that may reach managed compute VMs on port 22: explicit IPv4
// CIDRs for our own addresses (the bay control plane and the project hosts).
// Shared by the site setting, the server network checks and the Nebius
// security group, so every layer accepts exactly the same values.

// The widest prefix accepted. Our own addresses are single hosts (/32) or
// small provider blocks; anything wider is treated as public.
export const MIN_SSH_SOURCE_PREFIX = 16;

const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

export function parseSshSourceRange(value: string): string {
  const match = `${value ?? ""}`.trim().match(IPV4_CIDR);
  if (!match) {
    throw new Error(`SSH source range '${value}' must be an IPv4 CIDR`);
  }
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix > 32) {
    throw new Error(`SSH source range '${value}' is not a valid IPv4 CIDR`);
  }
  if (prefix < MIN_SSH_SOURCE_PREFIX) {
    throw new Error(
      `SSH source range '${value}' is wider than /${MIN_SSH_SOURCE_PREFIX}`,
    );
  }
  const address = octets.reduce((acc, octet) => acc * 256 + octet, 0);
  if (address % 2 ** (32 - prefix) !== 0) {
    throw new Error(`SSH source range '${value}' has host bits set`);
  }
  return `${octets.join(".")}/${prefix}`;
}

// Comma or whitespace separated; returns sorted, de-duplicated ranges and
// throws on the first invalid entry.
export function parseSshSourceRanges(value: unknown): string[] {
  const ranges = `${value ?? ""}`
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseSshSourceRange);
  return Array.from(new Set(ranges)).sort();
}
