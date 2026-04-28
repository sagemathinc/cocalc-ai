/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";

const SSH_KEY_TYPE_RE =
  /^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-[^\s]+|sk-[^\s]+|[^\s]+-cert-v01@openssh\.com)$/;

function addColons(value: string): string {
  return value.replace(/(.{2})(?=.)/g, "$1:");
}

export function computeSshFingerprintFromRawKey(raw: Uint8Array): string {
  return addColons(createHash("md5").update(raw).digest("hex"));
}

export function computeSshFingerprintFromBase64(base64: string): string {
  return computeSshFingerprintFromRawKey(Buffer.from(base64, "base64"));
}

export function extractAuthorizedKeyBase64(
  line: string,
): { key_type: string; base64: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return;
  const tokens = trimmed.split(/\s+/);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const key_type = tokens[i];
    const base64 = tokens[i + 1];
    if (!SSH_KEY_TYPE_RE.test(key_type)) continue;
    if (!/^[A-Za-z0-9+/=]+$/.test(base64)) continue;
    return { key_type, base64 };
  }
  return;
}

export function listAuthorizedKeyFingerprints(text: string): string[] {
  const fingerprints: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = extractAuthorizedKeyBase64(line);
    if (!entry) continue;
    try {
      fingerprints.push(computeSshFingerprintFromBase64(entry.base64));
    } catch {
      continue;
    }
  }
  return fingerprints;
}

export function authorizedKeysContainFingerprint(
  text: string,
  fingerprint: string,
): boolean {
  const normalized = fingerprint.trim().toLowerCase();
  if (!normalized) return false;
  for (const candidate of listAuthorizedKeyFingerprints(text)) {
    if (candidate.toLowerCase() === normalized) {
      return true;
    }
  }
  return false;
}
