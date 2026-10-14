/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Each bay's Ed25519 key for computers: it signs computer certificates,
// project attestations and tickets. Daemons on connected computers verify
// those signatures against the cluster's key directory.
// Plan: src/.agents/computers-plan-2026-10-11.md ("Enrollment and the
// daemon's identity", "Privacy fence across bays").
//
// - The private key stays on its bay, encrypted by secret storage
//   (bay_computer_signing_keys), and is only decrypted in memory.
// - The public key goes into the seed's directory
//   (cluster_computer_signing_keys): written directly on a standalone or seed
//   bay; attached bays publish it with their registration heartbeat.
// - When a key rotates, the outgoing key endorses its successor, and the
//   seed accepts a bay's later keys only with that endorsement.

import { createPublicKey, type KeyObject } from "node:crypto";
import getPool from "@cocalc/database/pool";
import {
  decryptSecretStorageValue,
  encryptSecretStorageValue,
} from "@cocalc/database/settings/secret-settings";
import getLogger from "@cocalc/backend/logger";
import {
  fingerprintOf,
  generateSigningKey,
  privateKeyFromPem,
  privateKeyToPem,
  signEnvelope,
  signingPublicKeyFromDer,
  verifyEnvelope,
  type KeyPair,
} from "@cocalc/backend/computers/crypto";
import {
  parseSignedEnvelope,
  parseSigningKeyEndorsement,
  SIGNED_KINDS,
  type SignedEnvelope,
} from "@cocalc/util/computers/protocol";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterRole } from "@cocalc/server/cluster-config";
import type {
  DirectorySigningKey,
  PublishedSigningKey,
} from "@cocalc/util/computers/api";
import { createInterBayBayRegistryClient } from "@cocalc/conat/inter-bay/api";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { lastKnownSeedRead } from "@cocalc/server/inter-bay/last-known-seed-read";

const logger = getLogger("server:computers:signing-keys");

/** A signing key is trusted for a year; a new one is made after 300 days. */
export const SIGNING_KEY_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
export const SIGNING_KEY_ROTATE_AFTER_MS = 300 * 24 * 60 * 60 * 1000;

export type DirectoryKey = DirectorySigningKey;

/** Attached bays re-read the seed's directory at most this often. */
const DIRECTORY_CACHE_MS = 30_000;

let cached: { key: KeyPair; created: number } | undefined;

function aadName(kid: string): string {
  return `computer-signing-key:${kid}`;
}

/** This bay's current signing key, created on first use. */
export async function getBaySigningKey(): Promise<KeyPair> {
  const now = Date.now();
  if (cached && now - cached.created < SIGNING_KEY_ROTATE_AFTER_MS) {
    return cached.key;
  }
  const pool = getPool();
  const { rows } = await pool.query<{
    kid: string;
    encrypted_private_key: string;
    created_at: Date;
  }>(
    `SELECT kid, encrypted_private_key, created_at
       FROM bay_computer_signing_keys
      WHERE retired_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
  );
  const row = rows[0];
  if (
    row &&
    now - new Date(row.created_at).valueOf() < SIGNING_KEY_ROTATE_AFTER_MS
  ) {
    const key = await decryptKey(row.kid, row.encrypted_private_key);
    cached = { key, created: new Date(row.created_at).valueOf() };
    return key;
  }
  // Rotating: the outgoing key endorses its successor.
  const previous =
    row == null
      ? undefined
      : await decryptKey(row.kid, row.encrypted_private_key);
  const key = await createKey(previous);
  cached = { key, created: now };
  return key;
}

async function decryptKey(kid: string, encrypted: string): Promise<KeyPair> {
  const { value: pem } = await decryptSecretStorageValue(
    aadName(kid),
    encrypted,
  );
  const privateKey = privateKeyFromPem(pem);
  const publicKey = createPublicKey(privateKey);
  const fingerprint = fingerprintOf(publicKey);
  if (fingerprint !== kid) {
    throw new Error("stored computer signing key does not match its kid");
  }
  return {
    privateKey,
    publicKey,
    fingerprint,
    publicDer: publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
  };
}

/** Create a key, store it encrypted, and publish its public half. */
async function createKey(previous?: KeyPair): Promise<KeyPair> {
  const key = generateSigningKey();
  const bay_id = getConfiguredBayId();
  const not_after = Date.now() + SIGNING_KEY_LIFETIME_MS;
  const endorsement =
    previous == null
      ? null
      : signEnvelope(
          SIGNED_KINDS.key_endorsement,
          parseSigningKeyEndorsement({
            type: "cocalc-computer-key-endorsement",
            version: 1,
            bay_id,
            kid: key.fingerprint,
            public_key: key.publicDer,
            not_after,
          }),
          previous,
        );
  const encrypted = await encryptSecretStorageValue(
    aadName(key.fingerprint),
    privateKeyToPem(key.privateKey),
  );
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // One creator at a time on this bay; a racing creator reuses the winner's.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('bay_computer_signing_keys'))",
    );
    const { rows } = await client.query(
      `SELECT kid, encrypted_private_key, created_at FROM bay_computer_signing_keys
        WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    );
    const fresh = rows[0];
    if (
      fresh &&
      fresh.kid !== previous?.fingerprint &&
      Date.now() - new Date(fresh.created_at).valueOf() <
        SIGNING_KEY_ROTATE_AFTER_MS
    ) {
      await client.query("COMMIT");
      return await decryptKey(fresh.kid, fresh.encrypted_private_key);
    }
    await client.query(
      `INSERT INTO bay_computer_signing_keys
         (kid, encrypted_private_key, public_key, not_after, endorsed_by,
          endorsement, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [
        key.fingerprint,
        encrypted,
        key.publicDer,
        new Date(not_after),
        endorsement?.kid ?? null,
        endorsement == null ? null : JSON.stringify(endorsement),
      ],
    );
    // Older keys stop signing but stay valid until their not_after, so
    // daemons keep accepting what they already received.
    await client.query(
      `UPDATE bay_computer_signing_keys SET retired_at=now()
        WHERE retired_at IS NULL AND kid <> $1`,
      [key.fingerprint],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (publishesLocally()) {
    await acceptDirectoryKeys(bay_id, await localPublishedSigningKeys());
  }
  // Attached bays publish with their next registration heartbeat.
  logger.info("created computer signing key", { kid: key.fingerprint });
  return key;
}

function publishesLocally(): boolean {
  const role = getConfiguredClusterRole();
  return role === "standalone" || role === "seed";
}

/** The public halves of this bay's keys that are still valid, oldest first. */
export async function localPublishedSigningKeys(): Promise<
  PublishedSigningKey[]
> {
  const { rows } = await getPool().query(
    `SELECT kid, public_key, not_after, endorsement
       FROM bay_computer_signing_keys
      WHERE not_after > now()
      ORDER BY created_at`,
  );
  return rows.map((r) => ({
    kid: r.kid,
    public_key: r.public_key,
    not_after: new Date(r.not_after).valueOf(),
    endorsement: r.endorsement == null ? null : JSON.parse(r.endorsement),
  }));
}

/**
 * Seed (or standalone): add a bay's public keys to the directory. A bay's
 * first key is accepted as is (it arrives over the authenticated inter-bay
 * fabric); every later key must be endorsed by a key of that same bay that
 * is already trusted, so nobody can slip in a key for an existing bay
 * without its current private key. A kid is never moved to another bay.
 * Returns the kids added and the kids refused (with reasons).
 */
export async function acceptDirectoryKeys(
  bay_id: string,
  keys: unknown,
): Promise<{ added: string[]; refused: { kid: string; reason: string }[] }> {
  const added: string[] = [];
  const refused: { kid: string; reason: string }[] = [];
  if (!Array.isArray(keys)) return { added, refused };
  const published = keys
    .slice(0, MAX_PUBLISHED_KEYS)
    .map((k) => {
      try {
        return parsePublishedSigningKey(k);
      } catch (err) {
        refused.push({ kid: `${k?.kid ?? "?"}`, reason: `${err}` });
        return undefined;
      }
    })
    .filter((k): k is PublishedSigningKey => k != null)
    .sort((a, b) => a.not_after - b.not_after);
  for (const key of published) {
    const reason = await acceptOne(bay_id, key);
    if (reason == null) added.push(key.kid);
    else if (reason !== "known") refused.push({ kid: key.kid, reason });
  }
  if (refused.length > 0) {
    logger.warn("refused computer signing keys", { bay_id, refused });
  }
  return { added, refused };
}

const MAX_PUBLISHED_KEYS = 8;
const KEY_SKEW_MS = 5 * 60 * 1000;

async function acceptOne(
  bay_id: string,
  key: PublishedSigningKey,
): Promise<string | undefined> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // One bay's keys at a time, so two first keys can't both be "first".
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `cluster_computer_signing_keys:${bay_id}`,
    ]);
    const existing = (
      await client.query(
        "SELECT bay_id FROM cluster_computer_signing_keys WHERE kid=$1",
        [key.kid],
      )
    ).rows[0];
    if (existing != null) {
      await client.query("ROLLBACK");
      return existing.bay_id === bay_id
        ? "known"
        : "kid belongs to another bay";
    }
    if (key.not_after > Date.now() + SIGNING_KEY_LIFETIME_MS + KEY_SKEW_MS) {
      await client.query("ROLLBACK");
      return "key lifetime is too long";
    }
    // Older keys still verify what they signed, but only the bay's newest
    // trusted key may authorize a successor.
    const trusted = (
      await client.query(
        `SELECT kid, public_key FROM cluster_computer_signing_keys
          WHERE bay_id=$1 AND revoked_at IS NULL AND not_after > now()
          ORDER BY created_at DESC, not_after DESC`,
        [bay_id],
      )
    ).rows;
    if (trusted.length > 0) {
      const e = key.endorsement;
      const endorser = trusted[0].kid === e?.kid ? trusted[0] : undefined;
      if (e == null || endorser == null) {
        await client.query("ROLLBACK");
        return "not endorsed by a trusted key of this bay";
      }
      const p = e.payload;
      if (
        p.bay_id !== bay_id ||
        p.kid !== key.kid ||
        p.public_key !== key.public_key ||
        p.not_after !== key.not_after ||
        !verifyEnvelope(SIGNED_KINDS.key_endorsement, e, (kid) =>
          kid === endorser.kid
            ? signingPublicKeyFromDer(endorser.public_key)
            : undefined,
        )
      ) {
        await client.query("ROLLBACK");
        return "endorsement does not match";
      }
    }
    await client.query(
      `INSERT INTO cluster_computer_signing_keys
         (kid, bay_id, public_key, endorsed_by, endorsement, created_at, not_after)
       VALUES ($1, $2, $3, $4, $5, now(), $6)`,
      [
        key.kid,
        bay_id,
        key.public_key,
        key.endorsement?.kid ?? null,
        key.endorsement == null ? null : JSON.stringify(key.endorsement),
        new Date(key.not_after),
      ],
    );
    await client.query("COMMIT");
    return undefined;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function parsePublishedSigningKey(input: any): PublishedSigningKey {
  if (input == null || typeof input !== "object") {
    throw new Error("a published key is an object");
  }
  const parsed = signingPublicKeyFromDer(`${input.public_key ?? ""}`);
  if (fingerprintOf(parsed) !== input.kid) {
    throw new Error("public key does not match its kid");
  }
  const not_after = Number(input.not_after);
  if (!Number.isSafeInteger(not_after) || not_after <= Date.now()) {
    throw new Error("not_after must be a future time in ms");
  }
  return {
    kid: input.kid,
    public_key: input.public_key,
    not_after,
    endorsement:
      input.endorsement == null
        ? null
        : parseSignedEnvelope(
            input.endorsement,
            parseSigningKeyEndorsement,
            "endorsement",
          ),
  };
}

/**
 * The directory of trusted bay keys. It is seed-global: the seed (or a
 * standalone bay) reads its own table; an attached bay asks the seed, caching
 * the answer for 30 s. Readers that allow it (allowStale, the default) keep
 * using the last answer for at most 10 minutes while the seed is
 * unreachable; ticket issuance does not, and fails closed instead.
 */
export async function listSigningKeyDirectory({
  allowStale = true,
}: { allowStale?: boolean } = {}): Promise<DirectoryKey[]> {
  if (publishesLocally()) return await listSigningKeyDirectoryLocal();
  const now = Date.now();
  if (directoryCache != null && now - directoryCache.at < DIRECTORY_CACHE_MS) {
    return directoryCache.keys;
  }
  const keys = await seedDirectoryRead(
    "directory",
    async (timeout) =>
      await createInterBayBayRegistryClient({
        client: getInterBayFabricClient(),
        timeout,
      }).computerSigningKeys({}),
    { allowStale },
  );
  directoryCache = { keys, at: now };
  return keys;
}

let directoryCache: { keys: DirectoryKey[]; at: number } | undefined;
const seedDirectoryRead = lastKnownSeedRead<DirectoryKey[]>(
  "computer signing key directory",
);

/** The seed's own table (or a standalone bay's). */
export async function listSigningKeyDirectoryLocal(): Promise<DirectoryKey[]> {
  const { rows } = await getPool().query<{
    kid: string;
    bay_id: string;
    public_key: string;
    not_after: Date;
  }>(
    `SELECT kid, bay_id, public_key, not_after
       FROM cluster_computer_signing_keys
      WHERE revoked_at IS NULL AND not_after > now()
      ORDER BY created_at`,
  );
  return rows.map((r) => ({
    kid: r.kid,
    bay_id: r.bay_id,
    public_key: r.public_key,
    not_after: new Date(r.not_after).valueOf(),
  }));
}

/** Look up a trusted public key by kid (for verifying envelopes). */
export async function trustedSigningKeys(
  opts: { allowStale?: boolean } = {},
): Promise<Map<string, KeyObject>> {
  return keyMap(await listSigningKeyDirectory(opts));
}

export function keyMap(entries: DirectoryKey[]): Map<string, KeyObject> {
  const map = new Map<string, KeyObject>();
  for (const entry of entries) {
    map.set(entry.kid, signingPublicKeyFromDer(entry.public_key));
  }
  return map;
}

/** Sign an object with this bay's key. */
export async function signAsBay<T>(
  kind: string,
  payload: T,
): Promise<SignedEnvelope<T>> {
  return signEnvelope(kind, payload, await getBaySigningKey());
}

/** Until when this bay's key may be trusted (undefined: not ours). */
export async function signingKeyNotAfter(
  kid: string,
): Promise<number | undefined> {
  const { rows } = await getPool().query(
    "SELECT not_after FROM bay_computer_signing_keys WHERE kid=$1",
    [kid],
  );
  return rows[0] == null ? undefined : new Date(rows[0].not_after).valueOf();
}

const byKid = new Map<string, KeyPair>();

/**
 * Sign with one exact key of this bay, retired or not, while it is still
 * valid: a computer's state is signed with its certificate's issuing key,
 * which the daemon trusts at least as long as the certificate. Undefined if
 * this bay no longer has that key (past its not_after).
 */
export async function signWithBayKey<T>(
  kid: string,
  kind: string,
  payload: T,
): Promise<SignedEnvelope<T> | undefined> {
  const { rows } = await getPool().query(
    `SELECT encrypted_private_key FROM bay_computer_signing_keys
      WHERE kid=$1 AND not_after > now()`,
    [kid],
  );
  if (rows[0] == null) {
    byKid.delete(kid);
    return undefined;
  }
  let key = byKid.get(kid);
  if (key == null) {
    key = await decryptKey(kid, rows[0].encrypted_private_key);
    byKid.set(kid, key);
  }
  return signEnvelope(kind, payload, key);
}

/** For tests: forget the cached key. */
export function resetSigningKeyCacheForTesting(): void {
  cached = undefined;
  directoryCache = undefined;
  byKid.clear();
}
