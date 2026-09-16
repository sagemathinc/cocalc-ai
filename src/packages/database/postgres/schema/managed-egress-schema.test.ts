/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client } from "@cocalc/database/pool";
import { PglitePool } from "@cocalc/database/pool/pglite";
import { SCHEMA } from "@cocalc/util/db-schema";
import { getColumnInvariantActions } from "./column-invariants";
import { getIndexActions } from "./index-convergence";
import { createTable } from "./table";

const TABLES = [
  "account_managed_egress_events",
  "account_managed_egress_rollups",
] as const;

describe("managed-egress declarative schema", () => {
  let db: PglitePool;

  beforeEach(() => {
    db = new PglitePool();
  });

  afterEach(async () => {
    await db.end();
  });

  it("creates the complete schema and is immediately converged", async () => {
    const client = db as unknown as Client;
    for (const table of TABLES) {
      await createTable(client, SCHEMA[table]);
    }

    const { rows: columns } = await db.query(
      `SELECT table_name, column_name, data_type, column_default, is_nullable
         FROM information_schema.columns
        WHERE table_name = ANY($1::text[])
        ORDER BY table_name, ordinal_position`,
      [[...TABLES]],
    );
    expect(columns).toEqual([
      {
        table_name: "account_managed_egress_events",
        column_name: "id",
        data_type: "uuid",
        column_default: null,
        is_nullable: "NO",
      },
      {
        table_name: "account_managed_egress_events",
        column_name: "account_id",
        data_type: "uuid",
        column_default: null,
        is_nullable: "NO",
      },
      {
        table_name: "account_managed_egress_events",
        column_name: "project_id",
        data_type: "uuid",
        column_default: null,
        is_nullable: "YES",
      },
      {
        table_name: "account_managed_egress_events",
        column_name: "category",
        data_type: "text",
        column_default: null,
        is_nullable: "NO",
      },
      {
        table_name: "account_managed_egress_events",
        column_name: "bytes",
        data_type: "bigint",
        column_default: null,
        is_nullable: "NO",
      },
      {
        table_name: "account_managed_egress_events",
        column_name: "metadata",
        data_type: "jsonb",
        column_default: null,
        is_nullable: "YES",
      },
      {
        table_name: "account_managed_egress_events",
        column_name: "occurred_at",
        data_type: "timestamp with time zone",
        column_default: "now()",
        is_nullable: "NO",
      },
      {
        table_name: "account_managed_egress_rollups",
        column_name: "bucket_start",
        data_type: "timestamp with time zone",
        column_default: null,
        is_nullable: "NO",
      },
      {
        table_name: "account_managed_egress_rollups",
        column_name: "account_id",
        data_type: "uuid",
        column_default: null,
        is_nullable: "NO",
      },
      {
        table_name: "account_managed_egress_rollups",
        column_name: "project_id",
        data_type: "uuid",
        column_default: "'00000000-0000-0000-0000-000000000000'::uuid",
        is_nullable: "NO",
      },
      {
        table_name: "account_managed_egress_rollups",
        column_name: "category",
        data_type: "text",
        column_default: null,
        is_nullable: "NO",
      },
      {
        table_name: "account_managed_egress_rollups",
        column_name: "bytes",
        data_type: "bigint",
        column_default: "0",
        is_nullable: "NO",
      },
      {
        table_name: "account_managed_egress_rollups",
        column_name: "event_count",
        data_type: "integer",
        column_default: "0",
        is_nullable: "NO",
      },
      {
        table_name: "account_managed_egress_rollups",
        column_name: "first_occurred_at",
        data_type: "timestamp with time zone",
        column_default: null,
        is_nullable: "NO",
      },
      {
        table_name: "account_managed_egress_rollups",
        column_name: "last_occurred_at",
        data_type: "timestamp with time zone",
        column_default: null,
        is_nullable: "NO",
      },
      {
        table_name: "account_managed_egress_rollups",
        column_name: "metadata_sample",
        data_type: "jsonb",
        column_default: null,
        is_nullable: "YES",
      },
    ]);

    const { rows: indexes } = await db.query(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE tablename = ANY($1::text[])
          AND indexname NOT LIKE '%_pkey'
        ORDER BY indexname`,
      [[...TABLES]],
    );
    expect(indexes.map(({ indexname }) => indexname)).toEqual([
      "account_managed_egress_events_account_project_time_idx",
      "account_managed_egress_events_account_time_idx",
      "account_managed_egress_events_category_time_idx",
      "account_managed_egress_events_project_time_idx",
      "account_managed_egress_events_time_admin_idx",
      "account_managed_egress_rollups_account_category_time_cover_idx",
      "account_managed_egress_rollups_account_recent_idx",
      "account_managed_egress_rollups_account_time_idx",
      "account_managed_egress_rollups_category_time_idx",
      "account_managed_egress_rollups_project_time_idx",
      "account_managed_egress_rollups_time_idx",
    ]);
    expect(
      indexes.find(
        ({ indexname }) =>
          indexname === "account_managed_egress_events_time_admin_idx",
      )?.indexdef,
    ).toContain("INCLUDE (account_id, project_id, category, bytes)");
    expect(
      indexes.find(
        ({ indexname }) =>
          indexname ===
          "account_managed_egress_rollups_account_category_time_cover_idx",
      )?.indexdef,
    ).toContain("INCLUDE (bytes)");

    for (const table of TABLES) {
      expect(await getColumnInvariantActions(client, SCHEMA[table])).toEqual(
        [],
      );
      expect(await getIndexActions(client, SCHEMA[table])).toEqual([]);
    }
  });
});
