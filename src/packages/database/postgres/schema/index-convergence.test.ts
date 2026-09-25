/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client } from "@cocalc/database/pool";
import { PglitePool } from "@cocalc/database/pool/pglite";
import { getIndexActions, syncTableSchemaIndexes } from "./index-convergence";
import { createIndexes } from "./indexes";
import {
  addSchemaIndexMarker,
  quoteLiteral,
  schemaIndexHash,
} from "./index-metadata";
import type { TableSchema } from "./types";

function schema({
  table,
  name = `${table}_value_idx`,
  query = "(value)",
  unique = false,
}: {
  table: string;
  name?: string;
  query?: string;
  unique?: boolean;
}): TableSchema {
  return {
    name: table,
    primary_key: "id",
    fields: {
      id: { type: "integer" },
      value: { type: "string" },
      state: { type: "string" },
    },
    pg_custom_indexes: [{ name, query, unique }],
  };
}

describe("declarative index convergence", () => {
  let db: PglitePool;
  let oldDatabase: string | undefined;

  beforeEach(() => {
    oldDatabase = process.env.COCALC_DB;
    process.env.COCALC_DB = "pglite";
    db = new PglitePool();
  });

  afterEach(async () => {
    await db.end();
    if (oldDatabase == null) {
      delete process.env.COCALC_DB;
    } else {
      process.env.COCALC_DB = oldDatabase;
    }
  });

  async function createTable(table: string): Promise<void> {
    await db.query(
      `CREATE TABLE ${table} (id integer PRIMARY KEY, value text, state text)`,
    );
  }

  it("rebuilds a same-name index whose definition is wrong", async () => {
    const table = "index_wrong_definition_test";
    const indexName = `${table}_value_idx`;
    const definition = schema({
      table,
      name: indexName,
      query: "(value DESC) WHERE state IN ('active', 'queued')",
    });
    await createTable(table);
    await db.query(`CREATE INDEX ${indexName} ON ${table} (state)`);

    await syncTableSchemaIndexes(db as unknown as Client, definition);

    const { rows } = await db.query(
      `SELECT pg_get_indexdef($1::regclass) AS definition,
              obj_description($1::regclass, 'pg_class') AS comment`,
      [indexName],
    );
    expect(rows[0].definition).toContain("(value DESC)");
    expect(rows[0].definition).toContain("state = ANY");
    expect(rows[0].comment).toContain(
      schemaIndexHash({
        name: indexName,
        query: "(value DESC) WHERE state IN ('active', 'queued')",
        unique: false,
      }),
    );
    expect(await getIndexActions(db as unknown as Client, definition)).toEqual(
      [],
    );
    const leftovers = await db.query(
      `SELECT relname FROM pg_class
        WHERE relkind='i' AND relname LIKE 'cocalc_index_%'`,
    );
    expect(leftovers.rows).toEqual([]);
  });

  it("marks indexes created with a new table as already converged", async () => {
    const table = "index_new_table_test";
    const definition = schema({ table });
    await createTable(table);

    await createIndexes(db as unknown as Client, definition);

    expect(await getIndexActions(db as unknown as Client, definition)).toEqual(
      [],
    );
  });

  it("migrates owner uniqueness to live records while preserving canceled history", async () => {
    const table = "team_owner_migration_test";
    const name = `${table}_value_unique_idx`;
    await createTable(table);
    await db.query(`CREATE UNIQUE INDEX ${name} ON ${table} (value)`);
    await db.query(`INSERT INTO ${table} VALUES (1, 'owner', 'canceled')`);
    const definition = schema({
      table,
      name,
      unique: true,
      query: "(value) WHERE state IS DISTINCT FROM 'canceled'",
    });
    await syncTableSchemaIndexes(db as unknown as Client, definition);
    await db.query(`INSERT INTO ${table} VALUES (2, 'owner', 'active')`);
    await expect(
      db.query(`INSERT INTO ${table} VALUES (3, 'owner', 'past_due')`),
    ).rejects.toThrow();
    expect(
      (await db.query(`SELECT id FROM ${table} ORDER BY id`)).rows,
    ).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await getIndexActions(db as unknown as Client, definition)).toEqual(
      [],
    );
  });

  it("adopts an equivalent legacy name instead of creating a duplicate", async () => {
    const table = "index_legacy_name_test";
    const definition = schema({ table });
    await createTable(table);
    await db.query(`CREATE INDEX legacy_value_lookup ON ${table} (value)`);

    await syncTableSchemaIndexes(db as unknown as Client, definition);

    const indexes = await db.query(
      `SELECT index_class.relname AS name,
              obj_description(index_class.oid, 'pg_class') AS comment
         FROM pg_index AS index_row
         JOIN pg_class AS index_class ON index_class.oid=index_row.indexrelid
        WHERE index_row.indrelid=$1::regclass
          AND NOT index_row.indisprimary`,
      [table],
    );
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0].name).toBe("legacy_value_lookup");
    expect(indexes.rows[0].comment).toContain(
      schemaIndexHash({
        name: `${table}_value_idx`,
        query: "(value)",
        unique: false,
      }),
    );
    expect(await getIndexActions(db as unknown as Client, definition)).toEqual(
      [],
    );
  });

  it("drops only indexes previously marked as schema-owned", async () => {
    const table = "index_owned_cleanup_test";
    await createTable(table);
    await db.query(`CREATE INDEX user_kept_idx ON ${table} (state)`);
    await db.query(`CREATE INDEX schema_removed_idx ON ${table} (value)`);
    await db.query(
      `COMMENT ON INDEX schema_removed_idx IS ${quoteLiteral(
        addSchemaIndexMarker(null, "f".repeat(64)),
      )}`,
    );
    const definition = schema({ table });
    definition.pg_custom_indexes = [];

    await syncTableSchemaIndexes(db as unknown as Client, definition);

    const { rows } = await db.query(
      `SELECT index_class.relname AS name
         FROM pg_index AS index_row
         JOIN pg_class AS index_class ON index_class.oid=index_row.indexrelid
        WHERE index_row.indrelid=$1::regclass
          AND NOT index_row.indisprimary
        ORDER BY name`,
      [table],
    );
    expect(rows).toEqual([{ name: "user_kept_idx" }]);
  });

  it("refuses to claim an index owned by a table constraint", async () => {
    const table = "index_constraint_collision_test";
    const name = "index_constraint_collision";
    await createTable(table);
    await db.query(
      `ALTER TABLE ${table} ADD CONSTRAINT ${name} UNIQUE (value)`,
    );

    await expect(
      syncTableSchemaIndexes(
        db as unknown as Client,
        schema({ table, name, unique: true }),
      ),
    ).rejects.toThrow(`constraint ${name}`);
  });
});
