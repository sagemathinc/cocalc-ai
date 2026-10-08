/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Table setup that includes ALTER TABLE takes an ACCESS EXCLUSIVE lock even
// when nothing changes, so it must run once per process (production outage
// 2026-10-06), including under concurrent cold-start calls and when the first
// use is inside a caller's transaction. Each test file gets fresh modules, so
// these setups have not run yet.

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { ensureCopySchema } from "./copy-db";
import { ensureProjectSecretsSchema } from "./project-secrets";

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 15000);

afterAll(async () => {
  await getPool().end();
});

function ddl(spy: jest.SpyInstance): string[] {
  return spy.mock.calls
    .map(([sql]) => String(sql))
    .filter((sql) => /\b(ALTER|CREATE) (TABLE|INDEX)\b/.test(sql));
}

it("shares one setup among concurrent cold-start callers", async () => {
  const spy = jest.spyOn(getPool(), "query");
  try {
    await Promise.all([
      ensureCopySchema(),
      ensureCopySchema(),
      ensureCopySchema(),
    ]);
    const statements = ddl(spy);
    expect(statements.length).toBeGreaterThan(0);
    // Each statement ran once, not once per caller.
    expect(new Set(statements).size).toBe(statements.length);
    spy.mockClear();
    await ensureCopySchema();
    expect(ddl(spy)).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

it("inside another transaction, only creates missing tables", async () => {
  const run = async (check: (statements: string[]) => void) => {
    const client = await getPool().connect();
    const spy = jest.spyOn(client, "query");
    try {
      await client.query("BEGIN");
      await ensureProjectSecretsSchema(client);
      await client.query("COMMIT");
      check(ddl(spy));
    } finally {
      spy.mockRestore();
      client.release();
    }
  };
  // On a new database the transaction creates the tables it needs.
  await run(() => {});
  // They exist: no DDL (above all no ALTER TABLE) inside the transaction, and
  // the full setup is not started alongside it.
  await run((statements) => expect(statements).toEqual([]));
  // The full setup runs once on the pool, before this module's transactions.
  const spy = jest.spyOn(getPool(), "connect");
  try {
    await ensureProjectSecretsSchema();
    await ensureProjectSecretsSchema();
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});
