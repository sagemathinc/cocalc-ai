/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";

import type { CoCalcUser } from "@cocalc/conat/auth/subject-policy";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getConfiguredBayCredential,
  getConfiguredClusterId,
  getConfiguredClusterRole,
} from "@cocalc/server/cluster-config";

const TABLE = "cluster_bay_credentials";
const PREFIX = "cocalc-bay-v1";

export interface BayCredentialMetadata {
  cluster_id: string;
  bay_id: string;
  credential_id: string;
  created_at: string;
  revoked_at: string | null;
  replaces_credential_id: string | null;
}

export interface IssuedBayCredential extends BayCredentialMetadata {
  credential: string;
}

let ensurePromise: Promise<void> | undefined;

function assertSeedCredentialAuthority(): void {
  if (getConfiguredClusterRole() !== "seed") {
    throw Error("bay credential registry is only available on the seed bay");
  }
}

function iso(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(`${value}`).toISOString();
}

function mapRow(row: any): BayCredentialMetadata {
  return {
    cluster_id: `${row.cluster_id}`,
    bay_id: `${row.bay_id}`,
    credential_id: `${row.credential_id}`,
    created_at: iso(row.created_at),
    revoked_at: row.revoked_at == null ? null : iso(row.revoked_at),
    replaces_credential_id:
      row.replaces_credential_id == null
        ? null
        : `${row.replaces_credential_id}`,
  };
}

async function ensureTable(): Promise<void> {
  assertSeedCredentialAuthority();
  ensurePromise ??= (async () => {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        credential_id UUID PRIMARY KEY,
        cluster_id TEXT NOT NULL,
        bay_id TEXT NOT NULL,
        secret_digest BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        revoked_at TIMESTAMPTZ,
        replaces_credential_id UUID REFERENCES ${TABLE}(credential_id)
      )
    `);
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_bay_idx
         ON ${TABLE} (cluster_id, bay_id, created_at DESC)`,
    );
  })();
  await ensurePromise;
}

function digest(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function encode(credential_id: string, secret: string): string {
  return `${PREFIX}.${credential_id}.${secret}`;
}

function parse(value: string): { credential_id: string; secret: string } {
  const [prefix, credential_id, secret, ...extra] = value.split(".");
  if (
    prefix !== PREFIX ||
    !/^[0-9a-f-]{36}$/i.test(credential_id ?? "") ||
    !secret ||
    extra.length
  ) {
    throw Error("invalid bay credential");
  }
  return { credential_id, secret };
}

function required(value: string, name: string): string {
  const normalized = `${value ?? ""}`.trim();
  if (!normalized) throw Error(`${name} is required`);
  return normalized;
}

export async function issueBayCredential({
  bay_id,
  replaces_credential_id,
}: {
  bay_id: string;
  replaces_credential_id?: string;
}): Promise<IssuedBayCredential> {
  await ensureTable();
  const cluster_id = getConfiguredClusterId();
  const credential_id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const { rows } = await getPool().query(
    `INSERT INTO ${TABLE}
       (credential_id, cluster_id, bay_id, secret_digest,
        replaces_credential_id)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING credential_id, cluster_id, bay_id, created_at, revoked_at,
               replaces_credential_id`,
    [
      credential_id,
      cluster_id,
      required(bay_id, "bay_id"),
      digest(secret),
      replaces_credential_id ?? null,
    ],
  );
  return { ...mapRow(rows[0]), credential: encode(credential_id, secret) };
}

export async function listBayCredentials({
  bay_id,
}: {
  bay_id?: string;
} = {}): Promise<BayCredentialMetadata[]> {
  await ensureTable();
  const params: unknown[] = [getConfiguredClusterId()];
  let filter = "";
  if (`${bay_id ?? ""}`.trim()) {
    params.push(`${bay_id}`.trim());
    filter = " AND bay_id=$2";
  }
  const { rows } = await getPool().query(
    `SELECT credential_id, cluster_id, bay_id, created_at, revoked_at,
            replaces_credential_id
       FROM ${TABLE}
      WHERE cluster_id=$1${filter}
      ORDER BY bay_id, created_at DESC`,
    params,
  );
  return rows.map(mapRow);
}

export async function revokeBayCredential({
  credential_id,
}: {
  credential_id: string;
}): Promise<BayCredentialMetadata> {
  await ensureTable();
  const { rows } = await getPool().query(
    `UPDATE ${TABLE}
        SET revoked_at=COALESCE(revoked_at, clock_timestamp())
      WHERE cluster_id=$1 AND credential_id=$2
      RETURNING credential_id, cluster_id, bay_id, created_at, revoked_at,
                replaces_credential_id`,
    [getConfiguredClusterId(), required(credential_id, "credential_id")],
  );
  if (!rows[0]) throw Error("bay credential not found");
  return mapRow(rows[0]);
}

export async function authenticateBayCredential(
  value: string,
): Promise<CoCalcUser> {
  await ensureTable();
  const { credential_id, secret } = parse(value);
  const { rows } = await getPool().query(
    `SELECT credential_id, bay_id, secret_digest
       FROM ${TABLE}
      WHERE cluster_id=$1 AND credential_id=$2 AND revoked_at IS NULL
      LIMIT 1`,
    [getConfiguredClusterId(), credential_id],
  );
  const stored = rows[0]?.secret_digest;
  const candidate = digest(secret);
  if (
    !Buffer.isBuffer(stored) ||
    stored.length !== candidate.length ||
    !timingSafeEqual(stored, candidate)
  ) {
    throw Error("invalid or revoked bay credential");
  }
  const bay_id = `${rows[0].bay_id}`;
  return {
    hub_id: `bay:${bay_id}`,
    bay_id,
    bay_credential_id: credential_id,
  };
}

export async function isBayCredentialUserActive(
  user: CoCalcUser,
): Promise<boolean> {
  if (!("bay_id" in user) || !user.bay_id || !user.bay_credential_id) {
    return true;
  }
  await ensureTable();
  const { rows } = await getPool().query(
    `SELECT 1 FROM ${TABLE}
      WHERE cluster_id=$1 AND bay_id=$2 AND credential_id=$3
        AND revoked_at IS NULL
      LIMIT 1`,
    [getConfiguredClusterId(), user.bay_id, user.bay_credential_id],
  );
  return rows.length === 1;
}

// The seed's own fabric client uses the same credential path as attached bays.
// Bootstrap only that local secret; attached credentials are issued explicitly.
export async function ensureLocalSeedBayCredential(): Promise<void> {
  const credential = getConfiguredBayCredential();
  if (!credential) return;
  const parsed = parse(credential);
  await ensureTable();
  await getPool().query(
    `INSERT INTO ${TABLE}
       (credential_id, cluster_id, bay_id, secret_digest)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (credential_id) DO NOTHING`,
    [
      parsed.credential_id,
      getConfiguredClusterId(),
      getConfiguredBayId(),
      digest(parsed.secret),
    ],
  );
  const bootstrapFile = `${
    process.env.COCALC_BAY_CREDENTIAL_BOOTSTRAP_FILE ?? ""
  }`.trim();
  if (!bootstrapFile) return;
  const entries = JSON.parse(await readFile(bootstrapFile, "utf8"));
  if (!Array.isArray(entries)) throw Error("invalid bay credential bootstrap");
  for (const entry of entries) {
    const credential_id = required(entry?.credential_id, "credential_id");
    const cluster_id = required(entry?.cluster_id, "cluster_id");
    const bay_id = required(entry?.bay_id, "bay_id");
    const digestHex = required(entry?.secret_digest, "secret_digest");
    if (!/^[0-9a-f]{64}$/i.test(digestHex)) {
      throw Error("invalid bay credential bootstrap digest");
    }
    if (cluster_id !== getConfiguredClusterId()) {
      throw Error("bay credential bootstrap cluster does not match");
    }
    await getPool().query(
      `INSERT INTO ${TABLE}
         (credential_id, cluster_id, bay_id, secret_digest)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (credential_id) DO NOTHING`,
      [credential_id, cluster_id, bay_id, Buffer.from(digestHex, "hex")],
    );
  }
}

export function resetBayCredentialTableForTests(): void {
  ensurePromise = undefined;
}
