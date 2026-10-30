/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Auto's picks for one account serialize across the hub processes of its
// home bay, and each sees the turns the others reserved. Two separately
// loaded instances of the module (each with its own connection pool) stand
// in for two processes. Needs a real PostgreSQL (PGlite has one connection);
// skips itself when the server binaries are not installed.

import {
  postgresBinDir,
  startRealPostgres,
  waitForLockWaiters,
  type RealPostgres,
} from "@cocalc/server/test/real-postgres";
import { uuid } from "@cocalc/util/misc";

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  encryptSecretStorageValue: async (_name: string, value: string) => value,
  decryptSecretStorageValue: async (_name: string, value: string) => ({
    value,
  }),
}));

const describeRealPostgres = postgresBinDir() ? describe : describe.skip;
const HOUR = 3600;

describeRealPostgres("Auto picks across hub processes", () => {
  let pg: RealPostgres;
  let getPool: any;
  let store: typeof import("@cocalc/server/external-credentials/store");
  const instances: (typeof import("./claude-pool"))[] = [];
  const pools: any[] = [];

  beforeAll(async () => {
    pg = startRealPostgres("claude_pool_concurrency_test");
    getPool = (await import("@cocalc/database/pool")).default;
    const { SCHEMA } = await import("@cocalc/util/db-schema");
    const { syncSchema } =
      await import("@cocalc/database/postgres/schema/sync");
    await syncSchema({ external_credentials: SCHEMA.external_credentials });
    store = await import("@cocalc/server/external-credentials/store");
    for (let i = 0; i < 2; i++) {
      jest.isolateModules(() => {
        instances.push(require("./claude-pool"));
        pools.push(require("@cocalc/database/pool").default);
      });
    }
  }, 120_000);

  afterAll(async () => {
    try {
      for (const pool of [getPool, ...pools]) await pool?.().end();
    } finally {
      pg?.stop();
    }
  });

  const selectorFor = (owner_account_id: string) => ({
    provider: "anthropic",
    kind: "claude-subscription-home-v1",
    scope: "account" as const,
    owner_account_id,
  });

  function usage(five: number, weekResetsIn: number) {
    const now = Math.floor(Date.now() / 1000);
    return {
      observed_at: new Date().toISOString(),
      windows: {
        five_hour: { utilization: five, resets_at: now + 2 * HOUR },
        seven_day: { utilization: 0.1, resets_at: now + weekResetsIn },
      },
    };
  }

  async function account() {
    const owner = uuid();
    const create = async (label: string, claude_usage: unknown) =>
      (
        await store.createExternalCredential({
          selector: selectorFor(owner),
          payload: `token-${label}`,
          metadata: { label, claude_usage },
        })
      ).id;
    // "soon" is preferred (its week resets first) until a large turn no
    // longer fits beside the turns reserved on it.
    const soon = await create("soon", usage(0.82, 10 * HOUR));
    const later = await create("later", usage(0.2, 100 * HOUR));
    return { owner, soon, later };
  }

  const project_id = uuid();

  it("simultaneous turns from two processes see each other's reservations", async () => {
    const { owner, soon, later } = await account();
    const picks = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        instances[i % 2].pickClaudePool({
          account_id: owner,
          target: { project_id, thread_id: `t${i}` },
        }),
      ),
    );
    const onSoon = picks.filter((p) => p.credential_id === soon).length;
    const onLater = picks.filter((p) => p.credential_id === later).length;
    expect(onSoon + onLater).toBe(8);
    // Without shared reservations, every turn would land on "soon".
    expect(onSoon).toBeGreaterThan(0);
    expect(onSoon).toBeLessThan(8);
    // Every turn's reservation was kept: none overwrote another's.
    const { rows } = await getPool().query(
      "SELECT id, metadata FROM external_credentials WHERE owner_account_id=$1",
      [owner],
    );
    const reserved = rows.reduce(
      (n: number, row: any) =>
        n + Object.keys(row.metadata.claude_pool_reservations ?? {}).length,
      0,
    );
    expect(reserved).toBe(8);
  });

  it("a pick waits for another process's pick of the same account", async () => {
    const { owner } = await account();
    const blocker = await getPool().connect();
    let open = false;
    try {
      await blocker.query("BEGIN");
      open = true;
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `claude-pool:${store.selectorLockKey(selectorFor(owner))}`,
      ]);
      let done = false;
      const pending = instances[1]
        .pickClaudePool({
          account_id: owner,
          target: { project_id, thread_id: "waiting" },
        })
        .then((r) => {
          done = true;
          return r;
        });
      await waitForLockWaiters((sql) => getPool().query(sql), 1);
      expect(done).toBe(false);
      await blocker.query("COMMIT");
      open = false;
      expect((await pending).credential_id).toBeTruthy();
    } finally {
      if (open) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });
});
