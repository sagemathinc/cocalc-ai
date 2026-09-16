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
import { readFile, unlink, writeFile } from "node:fs/promises";

import type { CoCalcUser } from "@cocalc/conat/auth/subject-policy";
import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getConfiguredBayCredential,
  getConfiguredClusterId,
  getConfiguredClusterRole,
} from "@cocalc/server/cluster-config";

const TABLE = "cluster_bay_credentials";
const PREFIX = "cocalc-bay-v1";
const BOOTSTRAP_POLL_MS = 1_000;
const ACTIVE_CHECK_TIMEOUT_MS = 2_000;
const logger = getLogger("inter-bay:bay-credentials");

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
let bootstrapTimer: NodeJS.Timeout | undefined;

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
    cluster_id: getConfiguredClusterId(),
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
  let timer: NodeJS.Timeout | undefined;
  try {
    const { rows } = await Promise.race([
      getPool().query(
        `SELECT 1 FROM ${TABLE}
          WHERE cluster_id=$1 AND bay_id=$2 AND credential_id=$3
            AND revoked_at IS NULL
          LIMIT 1`,
        [getConfiguredClusterId(), user.bay_id, user.bay_credential_id],
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("bay credential registry check timed out")),
          ACTIVE_CHECK_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    return rows.length === 1;
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

interface BootstrapEntry {
  credential_id: string;
  cluster_id: string;
  bay_id: string;
  secret_digest: Buffer;
}

function bootstrapFile(): string | undefined {
  return (
    `${process.env.COCALC_BAY_CREDENTIAL_BOOTSTRAP_FILE ?? ""}`.trim() ||
    undefined
  );
}

function parseBootstrap(value: unknown): BootstrapEntry[] {
  if (!Array.isArray(value)) throw Error("invalid bay credential bootstrap");
  const seen = new Set<string>();
  return value.map((entry) => {
    const credential_id = required(entry?.credential_id, "credential_id");
    if (seen.has(credential_id)) {
      throw Error(`duplicate bootstrap credential '${credential_id}'`);
    }
    seen.add(credential_id);
    const cluster_id = required(entry?.cluster_id, "cluster_id");
    const bay_id = required(entry?.bay_id, "bay_id");
    const digestHex = required(entry?.secret_digest, "secret_digest");
    if (!/^[0-9a-f]{64}$/i.test(digestHex)) {
      throw Error("invalid bay credential bootstrap digest");
    }
    if (cluster_id !== getConfiguredClusterId()) {
      throw Error("bay credential bootstrap cluster does not match");
    }
    return {
      credential_id,
      cluster_id,
      bay_id,
      secret_digest: Buffer.from(digestHex, "hex"),
    };
  });
}

async function insertOrVerifyBootstrapEntry(
  db: { query: (sql: string, params?: unknown[]) => Promise<any> },
  entry: BootstrapEntry,
): Promise<void> {
  await db.query(
    `INSERT INTO ${TABLE}
       (credential_id, cluster_id, bay_id, secret_digest)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (credential_id) DO NOTHING`,
    [entry.credential_id, entry.cluster_id, entry.bay_id, entry.secret_digest],
  );
  const { rows } = await db.query(
    `SELECT cluster_id, bay_id, secret_digest, revoked_at
       FROM ${TABLE}
      WHERE credential_id=$1
      FOR UPDATE`,
    [entry.credential_id],
  );
  const existing = rows[0];
  const stored = existing?.secret_digest;
  if (
    !existing ||
    existing.cluster_id !== entry.cluster_id ||
    existing.bay_id !== entry.bay_id ||
    existing.revoked_at != null ||
    !Buffer.isBuffer(stored) ||
    stored.length !== entry.secret_digest.length ||
    !timingSafeEqual(stored, entry.secret_digest)
  ) {
    throw Error(
      `bay credential bootstrap conflicts with registry for '${entry.credential_id}'`,
    );
  }
}

async function importBootstrapFile(filename: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(filename, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
  const entries = parseBootstrap(JSON.parse(text));
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const entry of entries) {
      await insertOrVerifyBootstrapEntry(client, entry);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await writeFile(
    `${filename}.complete`,
    `${createHash("sha256").update(text, "utf8").digest("hex")}\n`,
    { mode: 0o600 },
  );
  try {
    await unlink(filename);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  logger.info("imported one-shot bay credential bootstrap", {
    count: entries.length,
  });
  return true;
}

function startBootstrapWatcher(filename: string): void {
  if (bootstrapTimer != null) return;
  let running = false;
  bootstrapTimer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await importBootstrapFile(filename);
    } catch (err) {
      logger.error("failed to import bay credential bootstrap", err);
    } finally {
      running = false;
    }
  }, BOOTSTRAP_POLL_MS);
  bootstrapTimer.unref?.();
}

// The raw local file proves possession but never enrolls itself. Enrollment is
// an explicit, one-shot registry import, so deleting or revoking registry state
// cannot silently resurrect a credential on restart.
export async function ensureLocalSeedBayCredential(): Promise<void> {
  const credential = getConfiguredBayCredential();
  if (!credential) return;
  const filename = bootstrapFile();
  await ensureTable();
  if (filename) await importBootstrapFile(filename);
  const principal = await authenticateBayCredential(credential);
  if (!("bay_id" in principal) || principal.bay_id !== getConfiguredBayId()) {
    throw Error("configured seed bay credential has the wrong bay identity");
  }
  if (filename) startBootstrapWatcher(filename);
}

export function resetBayCredentialTableForTests(): void {
  ensurePromise = undefined;
  if (bootstrapTimer != null) clearInterval(bootstrapTimer);
  bootstrapTimer = undefined;
}
