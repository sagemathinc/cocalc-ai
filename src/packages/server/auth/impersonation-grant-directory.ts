/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  AccountImpersonationGrantDirectoryEntry,
  ResolveAccountImpersonationGrantDirectoryRequest,
  UpsertAccountImpersonationGrantDirectoryRequest,
} from "@cocalc/conat/inter-bay/api";
import { createInterBayDirectoryClient } from "@cocalc/conat/inter-bay/api";
import getPool from "@cocalc/database/pool";
import { getConfiguredClusterRole } from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { is_valid_uuid_string } from "@cocalc/util/misc";

const TABLE = "account_impersonation_grant_directory";

function normalizeOptional(value: unknown): string | null {
  const normalized = `${value ?? ""}`.trim();
  return normalized || null;
}

function assertUuid(value: string, label: string): void {
  if (!is_valid_uuid_string(value)) {
    throw new Error(`${label} must be a valid uuid`);
  }
}

function isSeedDirectoryLocal(): boolean {
  const role = getConfiguredClusterRole();
  return role === "standalone" || role === "seed";
}

export async function ensureAccountImpersonationGrantDirectorySchema(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      grant_id UUID PRIMARY KEY,
      subject_account_id UUID NOT NULL,
      subject_home_bay_id VARCHAR(64) NOT NULL,
      status VARCHAR(24),
      expires_at TIMESTAMP,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      updated TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_subject_account_id_idx ON ${TABLE} (subject_account_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_subject_home_bay_id_idx ON ${TABLE} (subject_home_bay_id)`,
  );
}

function rowToEntry(row: any): AccountImpersonationGrantDirectoryEntry {
  return {
    grant_id: row.grant_id,
    subject_account_id: row.subject_account_id,
    subject_home_bay_id: row.subject_home_bay_id,
    status: row.status ?? null,
    expires_at: row.expires_at ?? null,
  };
}

export async function upsertAccountImpersonationGrantDirectoryDirect(
  opts: UpsertAccountImpersonationGrantDirectoryRequest,
): Promise<void> {
  assertUuid(opts.grant_id, "grant_id");
  assertUuid(opts.subject_account_id, "subject_account_id");
  const subjectHomeBayId = normalizeOptional(opts.subject_home_bay_id);
  if (!subjectHomeBayId) {
    throw new Error("subject_home_bay_id must be specified");
  }
  await ensureAccountImpersonationGrantDirectorySchema();
  await getPool().query(
    `INSERT INTO ${TABLE}
       (grant_id, subject_account_id, subject_home_bay_id,
        status, expires_at, created, updated)
     VALUES
       ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (grant_id)
     DO UPDATE SET
       subject_account_id=EXCLUDED.subject_account_id,
       subject_home_bay_id=EXCLUDED.subject_home_bay_id,
       status=EXCLUDED.status,
       expires_at=EXCLUDED.expires_at,
       updated=NOW()`,
    [
      opts.grant_id,
      opts.subject_account_id,
      subjectHomeBayId,
      normalizeOptional(opts.status),
      opts.expires_at ?? null,
    ],
  );
}

export async function resolveAccountImpersonationGrantDirectoryDirect(
  opts: ResolveAccountImpersonationGrantDirectoryRequest,
): Promise<AccountImpersonationGrantDirectoryEntry | null> {
  const grantId = normalizeOptional(opts.grant_id);
  if (!grantId) {
    throw new Error("grant_id must be specified");
  }
  assertUuid(grantId, "grant_id");
  await ensureAccountImpersonationGrantDirectorySchema();
  const { rows } = await getPool().query(
    `SELECT grant_id, subject_account_id, subject_home_bay_id,
            status, expires_at
       FROM ${TABLE}
      WHERE grant_id=$1
      LIMIT 1`,
    [grantId],
  );
  return rows[0] ? rowToEntry(rows[0]) : null;
}

export async function upsertAccountImpersonationGrantDirectory(
  opts: UpsertAccountImpersonationGrantDirectoryRequest,
): Promise<void> {
  if (isSeedDirectoryLocal()) {
    return await upsertAccountImpersonationGrantDirectoryDirect(opts);
  }
  return await createInterBayDirectoryClient({
    client: getInterBayFabricClient(),
  }).upsertAccountImpersonationGrant(opts);
}

export async function resolveAccountImpersonationGrantDirectory(
  opts: ResolveAccountImpersonationGrantDirectoryRequest,
): Promise<AccountImpersonationGrantDirectoryEntry | null> {
  if (isSeedDirectoryLocal()) {
    return await resolveAccountImpersonationGrantDirectoryDirect(opts);
  }
  return await createInterBayDirectoryClient({
    client: getInterBayFabricClient(),
  }).resolveAccountImpersonationGrant(opts);
}
