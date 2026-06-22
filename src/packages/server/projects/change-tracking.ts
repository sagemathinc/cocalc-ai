/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";

const logger = getLogger("server:projects:change-tracking");

type Queryable = {
  query: (sql: string, params?: any[]) => Promise<any>;
};

let ensurePromise: Promise<void> | undefined;

export async function ensureProjectChangeTrackingColumns(
  db: Queryable = getPool(),
): Promise<void> {
  if (ensurePromise) {
    return ensurePromise;
  }
  ensurePromise = (async () => {
    await db.query(
      `ALTER TABLE projects
         ADD COLUMN IF NOT EXISTS last_changed TIMESTAMP`,
    );
    await db.query(
      `ALTER TABLE projects
         ADD COLUMN IF NOT EXISTS last_changed_generation BIGINT`,
    );
    await db.query(
      `ALTER TABLE projects
         ADD COLUMN IF NOT EXISTS last_backup_generation BIGINT`,
    );
  })().catch((err) => {
    ensurePromise = undefined;
    logger.warn("failed to ensure project change-tracking columns", { err });
    throw err;
  });
  return ensurePromise;
}

function normalizeDate(value?: Date | string | null): Date {
  if (value == null) {
    return new Date();
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function normalizeGeneration(value?: number | null): number | null {
  if (value == null) {
    return null;
  }
  const generation = Math.floor(Number(value));
  return Number.isFinite(generation) && generation >= 0 ? generation : null;
}

export async function markProjectChanged({
  host_id,
  project_id,
  changed_at,
  generation,
}: {
  host_id: string;
  project_id: string;
  changed_at?: Date | string | null;
  generation?: number | null;
}): Promise<boolean> {
  await ensureProjectChangeTrackingColumns();
  const changedAt = normalizeDate(changed_at);
  const normalizedGeneration = normalizeGeneration(generation);
  const { rowCount } = await getPool().query(
    `
      UPDATE projects
         SET last_changed = GREATEST(
               COALESCE(last_changed, to_timestamp(0)),
               $3::TIMESTAMP
             ),
             last_changed_generation = CASE
               WHEN $4::BIGINT IS NULL THEN last_changed_generation
               ELSE GREATEST(COALESCE(last_changed_generation, 0), $4::BIGINT)
             END
       WHERE project_id = $1
         AND host_id = $2
         AND deleted IS NOT true
    `,
    [project_id, host_id, changedAt, normalizedGeneration],
  );
  return !!rowCount;
}

export async function markProjectBackedUp({
  project_id,
  backed_up_at,
  generation,
}: {
  project_id: string;
  backed_up_at?: Date | string | null;
  generation?: number | null;
}): Promise<void> {
  await ensureProjectChangeTrackingColumns();
  const backedUpAt = normalizeDate(backed_up_at);
  const normalizedGeneration = normalizeGeneration(generation);
  await getPool().query(
    `
      UPDATE projects
         SET last_backup = $2::TIMESTAMP,
             last_backup_generation = CASE
               WHEN $3::BIGINT IS NULL THEN last_backup_generation
               ELSE GREATEST(COALESCE(last_backup_generation, 0), $3::BIGINT)
             END
       WHERE project_id = $1
    `,
    [project_id, backedUpAt, normalizedGeneration],
  );
}
