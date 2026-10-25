/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Hashing of secrets.

Human-chosen secrets (account passwords, 2FA and passkey recovery codes) use
`hashPassword` / `checkPassword`: scrypt, asynchronous, with a bound on how
many run at once. Random high-entropy tokens (remember-me session ids, API
keys, host and connector tokens) use `tokenHash` / `verifyToken`: their
entropy protects them, so they keep the fast legacy scheme and API calls do
not pay for a slow KDF.

Stored formats (all self-describing, so parameters can change at any time):

- legacy:       sha512$<salt>$<iterations>$<hex>   (HMAC iterations, the
                password-hash npm package's format; also <algo>$<salt>$<hex>)
- scrypt$v1:    scrypt$v1$<N>$<r>$<p>$<salt>$<key>
- scrypt-wrap:  scrypt-wrap$v1$<N>$<r>$<p>$<salt>$<key>$<algo>$<salt0>$<iter0>
                scrypt over the legacy hex digest, so every existing hash can
                be strengthened without knowing the password.

salt and key are base64url. Which format new hashes use is the caller's
choice (the password_kdf site setting); every format always verifies.
*/

import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "crypto";
import LRU from "lru-cache";

export type PasswordKdf = "legacy" | "scrypt";

const LEGACY_ALGORITHM = "sha512";
const LEGACY_ITERATIONS = 1000;
const LEGACY_SALT_LENGTH = 32;

const SCRYPT_PREFIX = "scrypt$v1$";
const WRAP_PREFIX = "scrypt-wrap$v1$";
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_SALT_BYTES = 32;
const SCRYPT_KEY_BYTES = 32;
// The envelope of parameters accepted from a stored hash: a bad row must not
// be able to make one check use much more memory or work than the policy.
const MAX_SCRYPT_MEMORY = 64 * 1024 * 1024; // 128 * N * r bytes
const MAX_SCRYPT_WORK = 4 * SCRYPT_N * SCRYPT_R * SCRYPT_P; // N * r * p
const MIN_SCRYPT_BYTES = 16;
const MAX_SCRYPT_BYTES = 64;
// The old code refused more than 10000 iterations too (server/auth/hash.ts).
const MAX_LEGACY_ITERATIONS = 10_000;

function scryptMaxmem(N: number, r: number): number {
  return 128 * N * r + 1024 * 1024;
}

// Admission for scrypt. At most MAX_ACTIVE_KDF run at once, below the libuv
// default pool of 4 threads, so file system and DNS work never starves. At
// most MAX_WAITING_KDF wait; beyond that a request fails at once with a
// generic busy error (sign-in throttling counts only completed checks, so it
// cannot bound a burst of concurrent requests by itself). This also bounds
// how many submitted secrets are held in memory while waiting.
const MAX_ACTIVE_KDF = 2;
const MAX_WAITING_KDF = 32;
let activeKdf = 0;
const waitingKdf: (() => void)[] = [];

/** Thrown when too many password checks are in progress. */
export class PasswordHashBusyError extends Error {
  code = "password_hash_busy";
  constructor() {
    super("The server is busy checking passwords. Please try again shortly.");
  }
}

export function passwordHashQueueStats(): { active: number; waiting: number } {
  return { active: activeKdf, waiting: waitingKdf.length };
}

async function withKdfSlot<T>(f: () => Promise<T>): Promise<T> {
  if (activeKdf >= MAX_ACTIVE_KDF) {
    if (waitingKdf.length >= MAX_WAITING_KDF) {
      throw new PasswordHashBusyError();
    }
    await new Promise<void>((resolve) => waitingKdf.push(resolve));
  } else {
    activeKdf += 1;
  }
  try {
    return await f();
  } finally {
    const next = waitingKdf.shift();
    if (next != null) {
      next(); // hand the slot over
    } else {
      activeKdf -= 1;
    }
  }
}

function scryptKey(
  secret: string | Buffer,
  salt: Buffer,
  { N, r, p, keylen }: { N: number; r: number; p: number; keylen: number },
): Promise<Buffer> {
  return withKdfSlot(
    () =>
      new Promise<Buffer>((resolve, reject) =>
        scrypt(
          secret,
          salt,
          keylen,
          { N, r, p, maxmem: scryptMaxmem(N, r) },
          (err, key) => (err ? reject(err) : resolve(key)),
        ),
      ),
  );
}

function equal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Legacy scheme: iterated HMAC (the password-hash npm package).

function legacyDigest(
  algorithm: string,
  salt: string,
  iterations: number,
  secret: string,
): string {
  let hash = secret;
  for (let i = 0; i < iterations; i++) {
    hash = createHmac(algorithm, salt).update(hash).digest("hex");
  }
  return hash;
}

interface LegacyHash {
  algorithm: string;
  salt: string;
  iterations: number;
  digest: string;
}

function parseLegacy(stored: string): LegacyHash | undefined {
  const parts = stored.split("$");
  if (parts.length === 3) {
    parts.splice(2, 0, "1"); // the package's oldest format had no iterations
  }
  if (parts.length !== 4) return;
  const [algorithm, salt, iterationsText, digest] = parts;
  const iterations = Number(iterationsText || 1);
  if (
    !algorithm ||
    !digest ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > MAX_LEGACY_ITERATIONS
  ) {
    return;
  }
  return { algorithm, salt, iterations, digest };
}

function verifyLegacy(secret: string, stored: string): boolean {
  const parsed = parseLegacy(stored);
  if (parsed == null) return false;
  let digest: string;
  try {
    digest = legacyDigest(
      parsed.algorithm,
      parsed.salt,
      parsed.iterations,
      secret,
    );
  } catch {
    return false; // unknown digest algorithm
  }
  return equal(Buffer.from(digest), Buffer.from(parsed.digest));
}

function newLegacyHash(secret: string): string {
  const salt = randomBytes(Math.ceil(LEGACY_SALT_LENGTH / 2))
    .toString("hex")
    .slice(0, LEGACY_SALT_LENGTH);
  const digest = legacyDigest(
    LEGACY_ALGORITHM,
    salt,
    LEGACY_ITERATIONS,
    secret,
  );
  return `${LEGACY_ALGORITHM}$${salt}$${LEGACY_ITERATIONS}$${digest}`;
}

// ---------------------------------------------------------------------------
// Tokens: random, high-entropy secrets.

// Some callers (e.g. the lite auth cookie) hash the same token repeatedly and
// expect a stable value for a few minutes. The cache is keyed by a digest of
// the token, never by the token itself.
const tokenCache = new LRU<string, string>({
  max: 1000,
  ttl: 1000 * 60 * 5,
});

/** Hash a random high-entropy token (fast). Not for human-chosen secrets. */
export function tokenHash(token: string): string {
  if (typeof token != "string") throw new Error("invalid token");
  const key = createHash("sha256").update(token).digest("hex");
  const cached = tokenCache.get(key);
  if (cached != null) return cached;
  const hash = newLegacyHash(token);
  tokenCache.set(key, hash);
  return hash;
}

/** Verify a token against a tokenHash value. */
export function verifyToken(token: string, stored: string): boolean {
  if (!token || !stored || typeof stored != "string") return false;
  return verifyLegacy(token, stored);
}

// ---------------------------------------------------------------------------
// Passwords: human-chosen secrets.

interface ScryptParams {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseScryptFields(fields: string[]): ScryptParams | undefined {
  if (fields.length !== 5) return;
  const [Ntext, rtext, ptext, saltText, keyText] = fields;
  const N = Number(Ntext);
  const r = Number(rtext);
  const p = Number(ptext);
  if (
    !Number.isInteger(N) ||
    N < 2 ||
    (N & (N - 1)) !== 0 ||
    !Number.isInteger(r) ||
    r < 1 ||
    !Number.isInteger(p) ||
    p < 1 ||
    128 * N * r > MAX_SCRYPT_MEMORY ||
    N * r * p > MAX_SCRYPT_WORK
  ) {
    return;
  }
  const salt = Buffer.from(saltText, "base64url");
  const key = Buffer.from(keyText, "base64url");
  for (const bytes of [salt, key]) {
    if (bytes.length < MIN_SCRYPT_BYTES || bytes.length > MAX_SCRYPT_BYTES) {
      return;
    }
  }
  return { N, r, p, salt, key };
}

function formatScrypt({ N, r, p, salt, key }: ScryptParams): string {
  return `${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

async function newScrypt(secret: string): Promise<ScryptParams> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await scryptKey(secret, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keylen: SCRYPT_KEY_BYTES,
  });
  return { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt, key };
}

// A stored hash that scrypt rejects is a non-match, not a server error; only
// the busy error propagates (the check did not happen).
async function scryptMatches(
  secret: string,
  params: ScryptParams,
): Promise<boolean> {
  let key: Buffer;
  try {
    key = await scryptKey(secret, params.salt, {
      N: params.N,
      r: params.r,
      p: params.p,
      keylen: params.key.length,
    });
  } catch (err) {
    if (err instanceof PasswordHashBusyError) throw err;
    return false;
  }
  return equal(key, params.key);
}

/**
 * Hash a human-chosen secret (an account password or a recovery code).
 * "scrypt" writes the strong format. "legacy" writes the old one, which
 * every release can verify (phase 1 of the rollout: see password_kdf).
 */
export async function hashPassword(
  password: string,
  { kdf }: { kdf: PasswordKdf },
): Promise<string> {
  if (typeof password != "string") throw new Error("invalid password");
  if (kdf === "scrypt") {
    return SCRYPT_PREFIX + formatScrypt(await newScrypt(password));
  }
  return newLegacyHash(password);
}

/** Whether a stored hash of a human-chosen secret is in any accepted format. */
export function isPasswordHash(stored: unknown): boolean {
  if (typeof stored != "string" || !stored) return false;
  if (stored.startsWith(SCRYPT_PREFIX)) {
    return (
      parseScryptFields(stored.slice(SCRYPT_PREFIX.length).split("$")) != null
    );
  }
  if (stored.startsWith(WRAP_PREFIX)) {
    return parseWrap(stored) != null;
  }
  return parseLegacy(stored) != null;
}

function parseWrap(
  stored: string,
): { outer: ScryptParams; legacy: Omit<LegacyHash, "digest"> } | undefined {
  const fields = stored.slice(WRAP_PREFIX.length).split("$");
  if (fields.length !== 8) return;
  const outer = parseScryptFields(fields.slice(0, 5));
  const [algorithm, salt, iterationsText] = fields.slice(5);
  const iterations = Number(iterationsText);
  if (
    outer == null ||
    !algorithm ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > MAX_LEGACY_ITERATIONS
  ) {
    return;
  }
  return { outer, legacy: { algorithm, salt, iterations } };
}

/** Whether a stored hash is a well-formed scrypt or scrypt-wrap hash. */
export function isStrongPasswordHash(stored: unknown): boolean {
  if (typeof stored != "string") return false;
  if (stored.startsWith(SCRYPT_PREFIX)) {
    return (
      parseScryptFields(stored.slice(SCRYPT_PREFIX.length).split("$")) != null
    );
  }
  return stored.startsWith(WRAP_PREFIX) && parseWrap(stored) != null;
}

/** Check a human-chosen secret against a stored hash in any format. */
export async function checkPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!password || typeof password != "string") return false;
  if (!stored || typeof stored != "string") return false;
  if (stored.startsWith(SCRYPT_PREFIX)) {
    const params = parseScryptFields(
      stored.slice(SCRYPT_PREFIX.length).split("$"),
    );
    return params != null && (await scryptMatches(password, params));
  }
  if (stored.startsWith(WRAP_PREFIX)) {
    const wrap = parseWrap(stored);
    if (wrap == null) return false;
    let digest: string;
    try {
      const { algorithm, salt, iterations } = wrap.legacy;
      digest = legacyDigest(algorithm, salt, iterations, password);
    } catch {
      return false;
    }
    return await scryptMatches(digest, wrap.outer);
  }
  return verifyLegacy(password, stored);
}

/**
 * Whether a stored password hash should be replaced, after a successful
 * check, by a fresh hash in the format `kdf` writes.
 */
export function passwordNeedsRehash(
  stored: string | null | undefined,
  { kdf }: { kdf: PasswordKdf },
): boolean {
  if (kdf !== "scrypt" || !stored) return false;
  if (!stored.startsWith(SCRYPT_PREFIX)) return true;
  const params = parseScryptFields(
    stored.slice(SCRYPT_PREFIX.length).split("$"),
  );
  // Anything but exactly the current policy is replaced.
  return (
    params == null ||
    params.N !== SCRYPT_N ||
    params.r !== SCRYPT_R ||
    params.p !== SCRYPT_P ||
    params.salt.length !== SCRYPT_SALT_BYTES ||
    params.key.length !== SCRYPT_KEY_BYTES
  );
}

/**
 * Strengthen a legacy hash without the password: scrypt over its digest.
 * Returns undefined when `stored` is not a legacy hash (already strong, or
 * not a hash at all), so callers can skip it.
 */
export async function wrapLegacyPasswordHash(
  stored: string | null | undefined,
): Promise<string | undefined> {
  if (!stored || typeof stored != "string") return;
  if (stored.startsWith(SCRYPT_PREFIX) || stored.startsWith(WRAP_PREFIX)) {
    return;
  }
  const legacy = parseLegacy(stored);
  if (legacy == null) return;
  const outer = await newScrypt(legacy.digest);
  return (
    WRAP_PREFIX +
    formatScrypt(outer) +
    `$${legacy.algorithm}$${legacy.salt}$${legacy.iterations}`
  );
}
