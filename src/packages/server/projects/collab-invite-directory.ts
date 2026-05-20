/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  ProjectCollabInviteDirectoryEntry,
  ResolveProjectCollabInviteDirectoryRequest,
  UpsertProjectCollabInviteDirectoryRequest,
} from "@cocalc/conat/inter-bay/api";
import { createInterBayDirectoryClient } from "@cocalc/conat/inter-bay/api";
import getPool from "@cocalc/database/pool";
import { getConfiguredClusterRole } from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { is_valid_uuid_string } from "@cocalc/util/misc";

const TABLE = "project_collab_invite_directory";

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

export async function ensureProjectCollabInviteDirectorySchema(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      invite_id UUID PRIMARY KEY,
      project_id UUID NOT NULL,
      owning_bay_id VARCHAR(64) NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      invite_source VARCHAR(24),
      scope VARCHAR(48),
      status VARCHAR(24),
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      updated TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_token_hash_idx ON ${TABLE} (token_hash)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_project_id_idx ON ${TABLE} (project_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_owning_bay_id_idx ON ${TABLE} (owning_bay_id)`,
  );
}

function rowToEntry(row: any): ProjectCollabInviteDirectoryEntry {
  return {
    invite_id: row.invite_id,
    project_id: row.project_id,
    owning_bay_id: row.owning_bay_id,
    token_hash: row.token_hash,
    invite_source: row.invite_source ?? null,
    scope: row.scope ?? null,
    status: row.status ?? null,
  };
}

export async function upsertProjectCollabInviteDirectoryDirect(
  opts: UpsertProjectCollabInviteDirectoryRequest,
): Promise<void> {
  assertUuid(opts.invite_id, "invite_id");
  assertUuid(opts.project_id, "project_id");
  const owningBayId = normalizeOptional(opts.owning_bay_id);
  const tokenHash = normalizeOptional(opts.token_hash);
  if (!owningBayId) {
    throw new Error("owning_bay_id must be specified");
  }
  if (!tokenHash) {
    throw new Error("token_hash must be specified");
  }
  await ensureProjectCollabInviteDirectorySchema();
  await getPool().query(
    `INSERT INTO ${TABLE}
       (invite_id, project_id, owning_bay_id, token_hash,
        invite_source, scope, status, created, updated)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT (invite_id)
     DO UPDATE SET
       project_id=EXCLUDED.project_id,
       owning_bay_id=EXCLUDED.owning_bay_id,
       token_hash=EXCLUDED.token_hash,
       invite_source=EXCLUDED.invite_source,
       scope=EXCLUDED.scope,
       status=EXCLUDED.status,
       updated=NOW()`,
    [
      opts.invite_id,
      opts.project_id,
      owningBayId,
      tokenHash,
      normalizeOptional(opts.invite_source),
      normalizeOptional(opts.scope),
      normalizeOptional(opts.status),
    ],
  );
}

export async function resolveProjectCollabInviteDirectoryDirect(
  opts: ResolveProjectCollabInviteDirectoryRequest,
): Promise<ProjectCollabInviteDirectoryEntry | null> {
  const inviteId = normalizeOptional(opts.invite_id);
  const tokenHash = normalizeOptional(opts.token_hash);
  if (!inviteId && !tokenHash) {
    throw new Error("invite_id or token_hash must be specified");
  }
  if (inviteId) {
    assertUuid(inviteId, "invite_id");
  }
  await ensureProjectCollabInviteDirectorySchema();
  const { rows } = await getPool().query(
    `SELECT invite_id, project_id, owning_bay_id, token_hash,
            invite_source, scope, status
       FROM ${TABLE}
      WHERE ($1::uuid IS NULL OR invite_id=$1::uuid)
        AND ($2::text IS NULL OR token_hash=$2::text)
      LIMIT 1`,
    [inviteId, tokenHash],
  );
  return rows[0] ? rowToEntry(rows[0]) : null;
}

export async function upsertProjectCollabInviteDirectory(
  opts: UpsertProjectCollabInviteDirectoryRequest,
): Promise<void> {
  if (isSeedDirectoryLocal()) {
    return await upsertProjectCollabInviteDirectoryDirect(opts);
  }
  return await createInterBayDirectoryClient({
    client: getInterBayFabricClient(),
  }).upsertProjectCollabInvite(opts);
}

export async function resolveProjectCollabInviteDirectory(
  opts: ResolveProjectCollabInviteDirectoryRequest,
): Promise<ProjectCollabInviteDirectoryEntry | null> {
  if (isSeedDirectoryLocal()) {
    return await resolveProjectCollabInviteDirectoryDirect(opts);
  }
  return await createInterBayDirectoryClient({
    client: getInterBayFabricClient(),
  }).resolveProjectCollabInvite(opts);
}
