/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";

const TABLE = "account_managed_egress_events";

export type ManagedProjectEgressCategory = "file-download";

type ManagedEgressUsage = {
  managed_egress_5h_bytes: number;
  managed_egress_7d_bytes: number;
  managed_egress_5h_remaining_bytes?: number;
  managed_egress_7d_remaining_bytes?: number;
  over_managed_egress_5h?: boolean;
  over_managed_egress_7d?: boolean;
  managed_egress_categories_5h_bytes: Record<string, number>;
  managed_egress_categories_7d_bytes: Record<string, number>;
};

let ensuredSchema: Promise<void> | undefined;

async function ensureSchema(): Promise<void> {
  if (!ensuredSchema) {
    ensuredSchema = (async () => {
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id UUID PRIMARY KEY,
          account_id UUID NOT NULL,
          project_id UUID NOT NULL,
          category TEXT NOT NULL,
          bytes BIGINT NOT NULL,
          metadata JSONB,
          occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_account_time_idx ON ${TABLE}(account_id, occurred_at DESC)`,
      );
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_project_time_idx ON ${TABLE}(project_id, occurred_at DESC)`,
      );
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_category_time_idx ON ${TABLE}(category, occurred_at DESC)`,
      );
    })();
  }
  await ensuredSchema;
}

export async function getProjectOwnerAccountId(
  project_id: string,
): Promise<string | undefined> {
  const { rows } = await getPool("medium").query<{ account_id: string }>(
    `
      SELECT owner.key AS account_id
      FROM projects,
           LATERAL jsonb_each(COALESCE(users, '{}'::jsonb)) AS owner(key, value)
      WHERE project_id = $1
        AND deleted IS NULL
        AND owner.value ->> 'group' = 'owner'
      LIMIT 1
    `,
    [project_id],
  );
  return rows[0]?.account_id;
}

export async function recordManagedProjectEgress(opts: {
  project_id: string;
  category: ManagedProjectEgressCategory;
  bytes: number;
  metadata?: Record<string, unknown>;
  occurred_at?: Date;
}): Promise<{ recorded: boolean; account_id?: string }> {
  const bytes = Math.floor(Number(opts.bytes) || 0);
  if (bytes <= 0) {
    return { recorded: false };
  }
  await ensureSchema();
  const account_id = await getProjectOwnerAccountId(opts.project_id);
  if (!account_id) {
    return { recorded: false };
  }
  await getPool("medium").query(
    `
      INSERT INTO ${TABLE}
        (id, account_id, project_id, category, bytes, metadata, occurred_at)
      VALUES
        (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, COALESCE($6, now()))
    `,
    [
      account_id,
      opts.project_id,
      opts.category,
      bytes,
      opts.metadata ?? null,
      opts.occurred_at ?? null,
    ],
  );
  return { recorded: true, account_id };
}

export async function getManagedEgressUsageForAccount(opts: {
  account_id: string;
  limit5h?: number;
  limit7d?: number;
}): Promise<ManagedEgressUsage> {
  await ensureSchema();
  const { rows } = await getPool("medium").query<{
    category: string;
    bytes_5h: string | number;
    bytes_7d: string | number;
  }>(
    `
      SELECT
        category,
        COALESCE(
          SUM(
            CASE
              WHEN occurred_at >= now() - interval '5 hours' THEN bytes
              ELSE 0
            END
          ),
          0
        ) AS bytes_5h,
        COALESCE(
          SUM(
            CASE
              WHEN occurred_at >= now() - interval '7 days' THEN bytes
              ELSE 0
            END
          ),
          0
        ) AS bytes_7d
      FROM ${TABLE}
      WHERE account_id = $1
        AND occurred_at >= now() - interval '7 days'
      GROUP BY category
      ORDER BY category
    `,
    [opts.account_id],
  );

  const managed_egress_categories_5h_bytes: Record<string, number> = {};
  const managed_egress_categories_7d_bytes: Record<string, number> = {};
  let managed_egress_5h_bytes = 0;
  let managed_egress_7d_bytes = 0;
  for (const row of rows) {
    const bytes5h = Math.max(0, Number(row.bytes_5h) || 0);
    const bytes7d = Math.max(0, Number(row.bytes_7d) || 0);
    managed_egress_categories_5h_bytes[row.category] = bytes5h;
    managed_egress_categories_7d_bytes[row.category] = bytes7d;
    managed_egress_5h_bytes += bytes5h;
    managed_egress_7d_bytes += bytes7d;
  }

  return {
    managed_egress_5h_bytes,
    managed_egress_7d_bytes,
    managed_egress_5h_remaining_bytes:
      typeof opts.limit5h === "number" && Number.isFinite(opts.limit5h)
        ? opts.limit5h - managed_egress_5h_bytes
        : undefined,
    managed_egress_7d_remaining_bytes:
      typeof opts.limit7d === "number" && Number.isFinite(opts.limit7d)
        ? opts.limit7d - managed_egress_7d_bytes
        : undefined,
    over_managed_egress_5h:
      typeof opts.limit5h === "number" && Number.isFinite(opts.limit5h)
        ? managed_egress_5h_bytes > opts.limit5h
        : undefined,
    over_managed_egress_7d:
      typeof opts.limit7d === "number" && Number.isFinite(opts.limit7d)
        ? managed_egress_7d_bytes > opts.limit7d
        : undefined,
    managed_egress_categories_5h_bytes,
    managed_egress_categories_7d_bytes,
  };
}
