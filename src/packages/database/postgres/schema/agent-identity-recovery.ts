/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { Client } from "@cocalc/database/pool";

export const LEGACY_AGENT_IDENTITY_THREAD_CONSTRAINT =
  "agent_identities_project_id_path_thread_id_key";

export async function agentIdentityRecoverySchemaNeedsSync(
  db: Client,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT EXISTS(
       SELECT 1 FROM pg_constraint
       WHERE conname=$1 AND conrelid=to_regclass('agent_identities')
     ) AS exists`,
    [LEGACY_AGENT_IDENTITY_THREAD_CONSTRAINT],
  );
  return rows[0]?.exists === true;
}

export async function ensureAgentIdentityRecoverySchema(
  db: Client,
): Promise<void> {
  await db.query(
    `ALTER TABLE agent_identities
       DROP CONSTRAINT IF EXISTS ${LEGACY_AGENT_IDENTITY_THREAD_CONSTRAINT}`,
  );
}
