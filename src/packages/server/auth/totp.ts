/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD_S = 30;
const DEFAULT_WINDOW = 1;

function normalizeBase32(value: string): string {
  return `${value ?? ""}`
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/=+$/g, "");
}

export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const normalized = normalizeBase32(input);
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of normalized) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index === -1) {
      throw new Error("invalid base32 secret");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

function hotp({
  secret,
  counter,
  digits = DEFAULT_DIGITS,
}: {
  secret: string;
  counter: number;
  digits?: number;
}): string {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter), 0);
  const digest = createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const code = `${binary % 10 ** digits}`;
  return code.padStart(digits, "0");
}

function normalizeTotpCode(code: string): string {
  return `${code ?? ""}`.replace(/\s+/g, "");
}

export function verifyTotpCode({
  secret,
  code,
  at = Date.now(),
  window = DEFAULT_WINDOW,
  period_s = DEFAULT_PERIOD_S,
  digits = DEFAULT_DIGITS,
}: {
  secret: string;
  code: string;
  at?: number;
  window?: number;
  period_s?: number;
  digits?: number;
}): boolean {
  const normalized = normalizeTotpCode(code);
  if (!/^\d+$/.test(normalized) || normalized.length !== digits) {
    return false;
  }
  const counter = Math.floor(at / 1000 / period_s);
  const actual = Buffer.from(normalized);
  for (let delta = -window; delta <= window; delta += 1) {
    const expected = Buffer.from(
      hotp({
        secret,
        counter: counter + delta,
        digits,
      }),
    );
    if (
      expected.length === actual.length &&
      timingSafeEqual(expected, actual)
    ) {
      return true;
    }
  }
  return false;
}

export function buildTotpOtpauthUrl({
  accountLabel,
  issuer,
  secret,
  digits = DEFAULT_DIGITS,
  period_s = DEFAULT_PERIOD_S,
}: {
  accountLabel: string;
  issuer: string;
  secret: string;
  digits?: number;
  period_s?: number;
}): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: `${digits}`,
    period: `${period_s}`,
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

const RECOVERY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function normalizeRecoveryCode(code: string): string {
  return `${code ?? ""}`.toUpperCase().replace(/[\s-]+/g, "");
}

export function generateRecoveryCode(groupCount = 3, groupSize = 4): string {
  const groups: string[] = [];
  for (let i = 0; i < groupCount; i += 1) {
    let group = "";
    for (let j = 0; j < groupSize; j += 1) {
      group +=
        RECOVERY_CODE_ALPHABET[
          randomBytes(1)[0] % RECOVERY_CODE_ALPHABET.length
        ];
    }
    groups.push(group);
  }
  return groups.join("-");
}

export function generateRecoveryCodes(count = 10): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    codes.add(generateRecoveryCode());
  }
  return [...codes];
}
