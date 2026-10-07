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

it("is ready after a first use inside a committed transaction", async () => {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await ensureProjectSecretsSchema(client);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  // The pool setup finishes in the background once the caller's locks are
  // gone, without another caller having to trigger it.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const spy = jest.spyOn(getPool(), "query");
  try {
    await ensureProjectSecretsSchema();
    expect(ddl(spy)).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});
