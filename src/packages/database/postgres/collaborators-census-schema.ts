/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";

/** Additive metadata-only status table for existing installations. */
export async function syncCollaborationCensusSchema(
  db: Pick<PoolClient, "query">,
) {
  await db.query(`CREATE TABLE IF NOT EXISTS collaboration_discovery (
    project_id UUID PRIMARY KEY, writer_host_id UUID, run_id UUID,
    sequence BIGINT NOT NULL DEFAULT 0, report JSONB, updated_at TIMESTAMP WITH TIME ZONE
  )`);
}
