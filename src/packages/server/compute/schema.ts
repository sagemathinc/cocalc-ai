/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";

/**
 * Keep the durable compute worker compatible with databases created before
 * queue_order was added to the declarative schema.
 */
export async function ensureComputeWorkQueueSchema(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('compute-work-queue-schema-v1', 0))",
    );
    await client.query(`
      ALTER TABLE compute_resource_work
      ADD COLUMN IF NOT EXISTS queue_order BIGSERIAL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS compute_resource_work_queue_order_key
      ON compute_resource_work (queue_order)
    `);
    const { rows } = await client.query<{
      has_default: boolean;
      is_not_null: boolean;
      is_unique: boolean;
    }>(`
      SELECT
        column_default LIKE 'nextval(%' AS has_default,
        is_nullable = 'NO' AS is_not_null,
        EXISTS (
          SELECT 1
          FROM pg_index
          WHERE indrelid = 'compute_resource_work'::regclass
            AND indexrelid =
              'compute_resource_work_queue_order_key'::regclass
            AND indisunique
        ) AS is_unique
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'compute_resource_work'
        AND column_name = 'queue_order'
    `);
    const shape = rows[0];
    if (!shape?.has_default || !shape.is_not_null || !shape.is_unique) {
      throw new Error(
        "compute_resource_work.queue_order is not a non-null, sequence-backed unique column",
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function ensureComputeScheduledStopSchema(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('compute-scheduled-stop-schema-v1', 0))",
    );
    await client.query(`ALTER TABLE compute_vms
      ADD COLUMN IF NOT EXISTS stop_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS stop_after_minutes INTEGER,
      ADD COLUMN IF NOT EXISTS stop_generation INTEGER DEFAULT 0`);
    await client.query(`CREATE INDEX IF NOT EXISTS compute_vms_scheduled_stop
      ON compute_vms (owning_bay_id, stop_at)
      WHERE deleted_at IS NULL AND stop_at IS NOT NULL`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
