/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The broker's home-bay answer comes from the authority only (v3.3.2).
// Synthetic values only.

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { ensureClusterAccountDirectorySchema } from "@cocalc/server/accounts/cluster-directory";
import { authoritativeHomeBayId } from "./routing";

const U = (n: number) => `00000000-0000-4000-8000-${`${n}`.padStart(12, "0")}`;
const MOVED = U(41);
const LOCAL_ONLY = U(42);
const role = process.env.COCALC_CLUSTER_ROLE;

beforeAll(async () => {
  await initEphemeralDatabase({});
  await ensureClusterAccountDirectorySchema();
  // A stale bay-local row still names bay-a; the directory says bay-b.
  for (const [id, email] of [
    [MOVED, "moved@example.com"],
    [LOCAL_ONLY, "local@example.com"],
  ]) {
    await getPool().query(
      `INSERT INTO accounts (account_id, email_address, home_bay_id, created)
       VALUES ($1, $2, 'bay-a', NOW())`,
      [id, email],
    );
  }
  await getPool().query(
    `INSERT INTO cluster_account_directory
       (account_id, email_address, home_bay_id, provisioned)
     VALUES ($1, 'moved@example.com', 'bay-b', TRUE)`,
    [MOVED],
  );
}, 30_000);

afterAll(async () => {
  if (role == null) delete process.env.COCALC_CLUSTER_ROLE;
  else process.env.COCALC_CLUSTER_ROLE = role;
  await getPool().end();
});

describe("authoritativeHomeBayId", () => {
  it("in a multi-bay cluster, reads the directory table, ignoring a stale local row", async () => {
    process.env.COCALC_CLUSTER_ROLE = "seed";
    expect(await authoritativeHomeBayId(MOVED)).toBe("bay-b");
    // Not in the directory: unknown, never the local row's bay.
    expect(await authoritativeHomeBayId(LOCAL_ONLY)).toBeUndefined();
    expect(await authoritativeHomeBayId(U(43))).toBeUndefined();
  });

  it("in a single-bay site, is this bay for an existing account only", async () => {
    process.env.COCALC_CLUSTER_ROLE = "standalone";
    const here = await authoritativeHomeBayId(LOCAL_ONLY);
    expect(typeof here).toBe("string");
    expect(here).not.toBe("bay-a");
    expect(await authoritativeHomeBayId(U(43))).toBeUndefined();
  });
});
