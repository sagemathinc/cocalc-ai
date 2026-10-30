/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Request paths must not run DDL on hot tables such as accounts and
// api_keys: an ALTER TABLE waits for an AccessExclusiveLock, and every query
// on the table queues behind it. Those columns are declared in the schema
// (util/db-schema) and created by the bay's schema synchronization; request
// paths only check, read-only and once per process, that it has run.

import getPool from "@cocalc/database/pool";

const checked = new Map<string, Promise<void>>();

export async function assertSchemaColumns(
  table: string,
  columns: readonly string[],
): Promise<void> {
  const key = `${table}:${[...columns].sort().join(",")}`;
  let pending = checked.get(key);
  if (!pending) {
    pending = (async () => {
      const { rows } = await getPool().query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = $1
           AND column_name = ANY($2::TEXT[])`,
        [table, columns],
      );
      const present = new Set(rows.map(({ column_name }) => column_name));
      const missing = columns.filter((column) => !present.has(column));
      if (missing.length > 0) {
        throw Error(
          `database schema is out of date: ${table} lacks ${missing.join(", ")}; run the schema synchronization`,
        );
      }
    })();
    checked.set(key, pending);
    // Retry after a failure (e.g. once the schema sync has run).
    pending.catch(() => checked.delete(key));
  }
  await pending;
}
