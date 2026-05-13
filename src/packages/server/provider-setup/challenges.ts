/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";

import getPool from "@cocalc/database/pool";

export type ProviderSetupChallengeProvider = "gcp" | "nebius";
export type ProviderSetupChallengeStatus = "pending" | "uploaded" | "expired";

export interface ProviderSetupChallenge {
  id: string;
  provider: ProviderSetupChallengeProvider;
  status: ProviderSetupChallengeStatus;
  created_at: string;
  expires_at: string;
  uploaded_at?: string;
  payload?: Record<string, unknown>;
  error?: string;
}

export interface CreatedProviderSetupChallenge extends ProviderSetupChallenge {
  token: string;
}

const TABLE = "provider_setup_challenges";
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 256 * 1024;

function pool() {
  return getPool();
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeProvider(provider: string): ProviderSetupChallengeProvider {
  if (provider === "gcp" || provider === "nebius") {
    return provider;
  }
  throw new Error("unsupported provider setup challenge provider");
}

function normalizePayload(payload: unknown): Record<string, unknown> {
  const encoded = Buffer.byteLength(JSON.stringify(payload ?? null), "utf8");
  if (encoded > MAX_PAYLOAD_BYTES) {
    throw new Error("provider setup payload is too large");
  }
  if (
    payload == null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new Error("provider setup payload must be a JSON object");
  }
  return payload as Record<string, unknown>;
}

async function ensureTable(): Promise<void> {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      provider VARCHAR(32) NOT NULL,
      account_id UUID NOT NULL,
      token_hash TEXT NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      payload_json JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      uploaded_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ
    )
  `);
  await pool().query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_account_idx ON ${TABLE} (account_id, created_at DESC)`,
  );
  await pool().query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_expires_idx ON ${TABLE} (expires_at)`,
  );
  await pool().query(
    `DELETE FROM ${TABLE} WHERE expires_at < NOW() - INTERVAL '1 day'`,
  );
}

function rowToChallenge(row: any): ProviderSetupChallenge {
  const expired =
    row.status === "pending" &&
    new Date(row.expires_at).getTime() <= Date.now();
  return {
    id: row.id,
    provider: normalizeProvider(row.provider),
    status: expired ? "expired" : row.status,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    uploaded_at: row.uploaded_at
      ? new Date(row.uploaded_at).toISOString()
      : undefined,
    payload: row.payload_json ?? undefined,
    error: row.error ?? undefined,
  };
}

export async function createProviderSetupChallenge(opts: {
  account_id: string;
  provider: ProviderSetupChallengeProvider;
  ttl_ms?: number;
}): Promise<CreatedProviderSetupChallenge> {
  await ensureTable();
  const provider = normalizeProvider(opts.provider);
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const ttl = Math.max(
    60_000,
    Math.min(opts.ttl_ms ?? DEFAULT_TTL_MS, 60 * 60 * 1000),
  );
  const expires = new Date(Date.now() + ttl);
  const { rows } = await pool().query(
    `INSERT INTO ${TABLE}
       (id, provider, account_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [id, provider, opts.account_id, tokenHash(token), expires],
  );
  return { ...rowToChallenge(rows[0]), token };
}

export async function getProviderSetupChallenge(opts: {
  account_id: string;
  id: string;
}): Promise<ProviderSetupChallenge> {
  await ensureTable();
  const { rows } = await pool().query(
    `SELECT * FROM ${TABLE} WHERE id=$1 AND account_id=$2`,
    [opts.id, opts.account_id],
  );
  if (!rows[0]) {
    throw new Error("provider setup challenge not found");
  }
  return rowToChallenge(rows[0]);
}

export async function clearProviderSetupChallenge(opts: {
  account_id: string;
  id: string;
}): Promise<{ deleted: boolean }> {
  await ensureTable();
  const { rowCount } = await pool().query(
    `DELETE FROM ${TABLE} WHERE id=$1 AND account_id=$2`,
    [opts.id, opts.account_id],
  );
  return { deleted: (rowCount ?? 0) > 0 };
}

export async function uploadProviderSetupChallengePayload(opts: {
  id: string;
  token: string;
  payload: unknown;
}): Promise<ProviderSetupChallenge> {
  await ensureTable();
  const payload = normalizePayload(opts.payload);
  const { rows } = await pool().query(`SELECT * FROM ${TABLE} WHERE id=$1`, [
    opts.id,
  ]);
  const row = rows[0];
  if (!row) {
    throw new Error("provider setup challenge not found");
  }
  if (!safeEqual(row.token_hash, tokenHash(opts.token))) {
    throw new Error("invalid provider setup upload token");
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await pool().query(`UPDATE ${TABLE} SET status='expired' WHERE id=$1`, [
      opts.id,
    ]);
    throw new Error("provider setup challenge has expired");
  }
  const { rows: updated } = await pool().query(
    `UPDATE ${TABLE}
        SET status='uploaded', payload_json=$2::jsonb, uploaded_at=NOW(), error=NULL
      WHERE id=$1
      RETURNING *`,
    [opts.id, JSON.stringify(payload)],
  );
  return rowToChallenge(updated[0]);
}
