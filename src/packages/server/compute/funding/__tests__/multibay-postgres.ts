/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema";
import { before, after } from "@cocalc/server/test";
import { ensureAccountUsageWindowSchema } from "@cocalc/server/membership/usage-windows";

export const bays = [
  "sponsor-payer",
  "sponsor-resource",
  "sponsor-course",
] as const;
export const pools = new Map<string, Pool>();

// One process emulates bay configuration, NOT bay storage. Cross-bay calls must
// be awaited sequentially, including nested Conat handlers. Concurrent financial
// transactions are supported inside a single onBay scope, never across scopes.
export async function onBay<T>(bay: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env.COCALC_BAY_ID;
  process.env.COCALC_BAY_ID = bay;
  try {
    return await fn();
  } finally {
    if (old == null) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = old;
  }
}

// Lazy exports avoid schema/pool import cycles. No query, transaction or lock is
// mocked: each bay gets a physical PostgreSQL database, using normal syncSchema.
export function poolModule() {
  return new Proxy(
    { __esModule: true },
    {
      get: (_target, key) => {
        if (key === "__esModule") return true;
        const actual = () => jest.requireActual("@cocalc/database/pool");
        const selected = () => pools.get(process.env.COCALC_BAY_ID ?? "");
        if (key === "default")
          return (...args) => selected() ?? actual().default(...args);
        if (key === "getClient")
          return () => {
            const pool = selected();
            return pool
              ? new (require("pg").Client)((pool as any).options)
              : actual().getClient();
          };
        if (key === "getTransactionClient")
          return async () => {
            const pool = selected();
            if (!pool) return actual().getTransactionClient();
            const db = await pool.connect();
            await db.query("BEGIN");
            return db;
          };
        return actual()[key];
      },
    },
  );
}

export function independentBayDatabases() {
  const names: string[] = [];
  let admin: Pool | undefined;
  const saved = new Map<string, string | undefined>();
  return {
    async start() {
      for (const [key, value] of Object.entries({
        COCALC_DB_SKIP_ENSURE_EXISTS: "1",
        COCALC_CLUSTER_BAY_IDS: bays.join(","),
        COCALC_COMPUTE_DEPLOYMENT_ID: "sponsorship-multibay-test",
        COCALC_ENABLE_FINANCIAL_REHOME: "yes",
      })) {
        saved.set(key, process.env[key]);
        process.env[key] = value;
      }
      await before();
      const source = getPool();
      const options = (source as any).options;
      if (options.database !== "smc_ephemeral_testing_database")
        throw Error("Requires the ephemeral test database");
      admin = new Pool({ ...options, database: "postgres" });
      await source.end();
      for (const bay of bays) {
        const database = `sponsor_test_${randomUUID().replace(/-/g, "")}`;
        await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
        names.push(database);
        pools.set(bay, new Pool({ ...options, database, max: 6 }));
        await onBay(bay, () => syncSchema());
        // This runtime schema is outside syncSchema and its default cache is
        // process-wide; provision it explicitly in each independent database.
        await ensureAccountUsageWindowSchema(pools.get(bay)!);
      }
    },
    async stop() {
      try {
        for (const pool of pools.values()) await pool.end();
        pools.clear();
        for (const name of names) await admin?.query(`DROP DATABASE "${name}"`);
        await admin?.end();
        await after();
      } finally {
        for (const [key, value] of saved) {
          if (value == null) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  };
}
