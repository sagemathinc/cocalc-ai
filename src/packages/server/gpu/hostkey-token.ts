/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU bring-your-own-key, step 4: the one-time token a pod uses to report its
SSH host key (see ~/ops2/runpod/HOSTKEY-REGISTRATION.md, approved 10-28).

    ccr1.<authority_bay_id>.<token_id>.<secret>

- authority_bay_id: the bay holding the pod's gpu_pods row, for routing only.
  It stays authoritative until the token expires; it is never read as the
  account's current home bay.
- token_id: a lowercase version-4 UUID.
- secret: 32 random bytes, base64url without padding (43 characters).

Only a verifier is stored: SHA-256 over length-prefixed canonical fields,
so no field can run into the next. Parsing is canonical, not merely shaped:
anything that would not re-encode to the identical token is refused, before
any database read or inter-bay send.

Nothing here logs; callers must never log a token or put one in an error.
*/

import { createHash, randomBytes, randomUUID } from "node:crypto";

export const HOSTKEY_TOKEN_PREFIX = "ccr1";
export const HOSTKEY_TOKEN_TTL_MS = 30 * 60_000;
// After consumption the verifier is kept this long, so a pod retrying after
// a lost response is answered (identical report: 200) rather than refused.
export const HOSTKEY_IDEMPOTENCY_WINDOW_MS = 10 * 60_000;

const DOMAIN = "cocalc-gpu-hostkey";
const VERSION = "v1";
const PURPOSE = "pod-host-key";

const BAY_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
// Longest possible token, to refuse oversized input before splitting it.
const MAX_TOKEN_LENGTH = HOSTKEY_TOKEN_PREFIX.length + 1 + 63 + 1 + 36 + 1 + 43;

export interface HostkeyToken {
  authority_bay_id: string;
  token_id: string;
  secret: string;
}

export interface NewHostkeyToken extends HostkeyToken {
  // The full token, for the pod's env only. Never stored or logged.
  token: string;
  // What gpu_pods stores.
  verifier: string;
}

// SHA-256 over 4-byte big-endian length-prefixed fields.
export function hostkeyVerifier(t: HostkeyToken): string {
  const hash = createHash("sha256");
  for (const field of [
    DOMAIN,
    VERSION,
    PURPOSE,
    t.authority_bay_id,
    t.token_id,
    t.secret,
  ]) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function newHostkeyToken(authority_bay_id: string): NewHostkeyToken {
  if (!BAY_ID.test(authority_bay_id)) throw new Error("invalid bay id");
  const t: HostkeyToken = {
    authority_bay_id,
    token_id: randomUUID(),
    secret: randomBytes(32).toString("base64url"),
  };
  return {
    ...t,
    token: formatHostkeyToken(t),
    verifier: hostkeyVerifier(t),
  };
}

export function formatHostkeyToken(t: HostkeyToken): string {
  return [HOSTKEY_TOKEN_PREFIX, t.authority_bay_id, t.token_id, t.secret].join(
    ".",
  );
}

// Canonical parse, or undefined. No lookups, no throwing on attacker input.
export function parseHostkeyToken(input: unknown): HostkeyToken | undefined {
  if (typeof input !== "string" || input.length > MAX_TOKEN_LENGTH) {
    return undefined;
  }
  const parts = input.split(".");
  if (parts.length !== 4 || parts[0] !== HOSTKEY_TOKEN_PREFIX) return undefined;
  const [, authority_bay_id, token_id, secret] = parts;
  if (!BAY_ID.test(authority_bay_id) || !UUID_V4.test(token_id)) {
    return undefined;
  }
  if (!SECRET.test(secret)) return undefined;
  const bytes = Buffer.from(secret, "base64url");
  // exactly 32 bytes, with no non-canonical final bits
  if (bytes.length !== 32 || bytes.toString("base64url") !== secret) {
    return undefined;
  }
  return { authority_bay_id, token_id, secret };
}

// The Authorization header must be exactly "Bearer <token>".
export function parseHostkeyAuthorization(
  header: unknown,
): HostkeyToken | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match ? parseHostkeyToken(match[1]) : undefined;
}

export const MAX_HOSTKEY_BODY_BYTES = 2048;
const POD_ID = /^[A-Za-z0-9_-]{6,64}$/;

export interface HostkeyReport {
  pod_id: string;
  host_public_key: string;
}

// The request body, exactly {pod_id, host_public_key} as strings, or
// undefined. The key itself is validated by parseEd25519PublicKey.
export function parseHostkeyReport(body: unknown): HostkeyReport | undefined {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const keys = Object.keys(body);
  if (
    keys.length !== 2 ||
    !keys.includes("pod_id") ||
    !keys.includes("host_public_key")
  ) {
    return undefined;
  }
  const { pod_id, host_public_key } = body as Record<string, unknown>;
  if (typeof pod_id !== "string" || !POD_ID.test(pod_id)) return undefined;
  if (typeof host_public_key !== "string") return undefined;
  return { pod_id, host_public_key };
}
