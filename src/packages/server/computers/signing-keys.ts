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
  type KeyPair,
} from "@cocalc/backend/computers/crypto";
import type { SignedEnvelope } from "@cocalc/util/computers/protocol";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterRole } from "@cocalc/server/cluster-config";

const logger = getLogger("server:computers:signing-keys");

/** A signing key is trusted for a year; a new one is made after 300 days. */
export const SIGNING_KEY_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
export const SIGNING_KEY_ROTATE_AFTER_MS = 300 * 24 * 60 * 60 * 1000;

export interface DirectoryKey {
  kid: string;
  bay_id: string;
  public_key: string;
  not_after: number;
}

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
  const key = await createKey(row?.kid);
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
async function createKey(previousKid?: string): Promise<KeyPair> {
  const key = generateSigningKey();
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
      fresh.kid !== previousKid &&
      Date.now() - new Date(fresh.created_at).valueOf() <
        SIGNING_KEY_ROTATE_AFTER_MS
    ) {
      await client.query("COMMIT");
      return await decryptKey(fresh.kid, fresh.encrypted_private_key);
    }
    await client.query(
      `INSERT INTO bay_computer_signing_keys (kid, encrypted_private_key, created_at)
       VALUES ($1, $2, now())`,
      [key.fingerprint, encrypted],
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
  const entry: DirectoryKey = {
    kid: key.fingerprint,
    bay_id: getConfiguredBayId(),
    public_key: key.publicDer,
    not_after: Date.now() + SIGNING_KEY_LIFETIME_MS,
  };
  if (publishesLocally()) {
    await upsertDirectoryKeysLocal([entry], previousKid);
  }
  logger.info("created computer signing key", { kid: key.fingerprint });
  return key;
}

function publishesLocally(): boolean {
  const role = getConfiguredClusterRole();
  return role === "standalone" || role === "seed";
}

/**
 * Seed (or standalone): record public keys. A new key from a bay is endorsed
 * by that bay's previous key when there is one (the rotation chain daemons
 * follow); the endorsement is filled in by publishBaySigningKeys.
 */
export async function upsertDirectoryKeysLocal(
  keys: DirectoryKey[],
  endorsedBy?: string,
  endorsement?: string,
): Promise<void> {
  for (const key of keys) {
    // Refuse anything that isn't an Ed25519 key hashing to its kid.
    const parsed = signingPublicKeyFromDer(key.public_key);
    if (fingerprintOf(parsed) !== key.kid) {
      throw new Error("directory key does not match its kid");
    }
    await getPool().query(
      `INSERT INTO cluster_computer_signing_keys
         (kid, bay_id, public_key, endorsed_by, endorsement, created_at, not_after)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       ON CONFLICT (kid) DO NOTHING`,
      [
        key.kid,
        key.bay_id,
        key.public_key,
        endorsedBy ?? null,
        endorsement ?? null,
        new Date(key.not_after),
      ],
    );
  }
}

/** The directory daemons trust: every unrevoked, unexpired key. */
export async function listSigningKeyDirectory(): Promise<DirectoryKey[]> {
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
export async function trustedSigningKeys(): Promise<Map<string, KeyObject>> {
  const map = new Map<string, KeyObject>();
  for (const entry of await listSigningKeyDirectory()) {
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

/** For tests: forget the cached key. */
export function resetSigningKeyCacheForTesting(): void {
  cached = undefined;
}
