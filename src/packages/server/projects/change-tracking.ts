/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";

const logger = getLogger("server:projects:change-tracking");
const CHANGE_TRACKING_COLUMNS = [
  { name: "last_changed", definition: "TIMESTAMP" },
  { name: "last_changed_generation", definition: "BIGINT" },
  { name: "last_backup_generation", definition: "BIGINT" },
] as const;

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
    const { rows } = await db.query(
      `
        SELECT column_name
          FROM information_schema.columns
         WHERE table_name='projects'
           AND column_name=ANY($1::TEXT[])
      `,
      [CHANGE_TRACKING_COLUMNS.map(({ name }) => name)],
    );
    const existing = new Set(
      (rows as { column_name: string }[]).map(({ column_name }) => column_name),
    );
    for (const { name, definition } of CHANGE_TRACKING_COLUMNS) {
      if (existing.has(name)) continue;
      await db.query(`ALTER TABLE projects ADD COLUMN ${name} ${definition}`);
    }
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
  if (!Number.isFinite(date.getTime()))
    throw new Error("invalid project change time");
  return date;
}

function normalizeGeneration(value?: number | null): number | null {
  if (value == null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid project generation");
  }
  return value;
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
  host_id,
  project_id,
  backed_up_at,
  generation,
}: {
  host_id: string;
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
             last_backup_generation = $3::BIGINT
       WHERE project_id = $1
         AND host_id = $4
         AND deleted IS NOT true
         AND (last_backup IS NULL OR last_backup < $2::TIMESTAMP)
    `,
    [project_id, backedUpAt, normalizedGeneration, host_id],
  );
}
