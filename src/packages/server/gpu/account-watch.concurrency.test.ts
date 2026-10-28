/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The provider-account checks (5d-2b) against a real PostgreSQL with
// concurrent connections: two overlapping passes asked RunPod at different
// times; whichever finishes first, the samples end at the newer one and
// never move backward, and the older one changes nothing once a newer one is
// written. Skips itself without the server binaries.

import { randomUUID } from "node:crypto";
import {
  postgresBinDir,
  startRealPostgres,
  type RealPostgres,
} from "@cocalc/server/test/real-postgres";

const describeRealPostgres = postgresBinDir() ? describe : describe.skip;

const MINUTE = 60_000;
const T0 = new Date("2026-10-28T00:00:00Z").getTime();

describeRealPostgres("GPU provider-account checks, concurrently", () => {
  let pg: RealPostgres;
  let getPool: any;
  let watch: typeof import("./account-watch");
  let fence: typeof import("./account-fence");

  beforeAll(async () => {
    pg = startRealPostgres("gpu_account_watch_concurrency_test");
    getPool = (await import("@cocalc/database/pool")).default;
    const { SCHEMA } = await import("@cocalc/util/db-schema");
    const { syncSchema } =
      await import("@cocalc/database/postgres/schema/sync");
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS accounts (account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN)",
    );
    await syncSchema({
      external_credentials: SCHEMA.external_credentials,
      gpu_key_fences: SCHEMA.gpu_key_fences,
      gpu_alerts: SCHEMA.gpu_alerts,
      gpu_budget_layers: SCHEMA.gpu_budget_layers,
      gpu_pods: SCHEMA.gpu_pods,
      gpu_pod_state_intervals: SCHEMA.gpu_pod_state_intervals,
      gpu_pod_reservations: SCHEMA.gpu_pod_reservations,
      gpu_provider_account_watch: SCHEMA.gpu_provider_account_watch,
    });
    watch = await import("./account-watch");
    fence = await import("./account-fence");
  }, 120_000);

  afterAll(async () => {
    try {
      await getPool?.().end();
    } finally {
      pg?.stop();
    }
  });

  async function confirmedKey() {
    const owner = randomUUID();
    const key = randomUUID();
    await getPool().query(
      `INSERT INTO external_credentials (id, provider, kind, scope, owner_account_id,
         encrypted_payload, metadata, created, updated)
       VALUES ($1, 'runpod', 'gpu-provider-api-key', 'account', $2, 'x', $3, now(), now())`,
      [
        key,
        owner,
        {
          provider_account_kind: "personal",
          provider_account_id: randomUUID(),
        },
      ],
    );
    await getPool().query(
      `INSERT INTO gpu_key_fences (credential_id, key_owner_account_id, state, created, updated)
       VALUES ($1, $2, 'active', now(), now())`,
      [key, owner],
    );
    await watch.confirmAccountChecksLocal(
      { account_id: owner, confirm: true, fresh_auth_verified: true },
      {
        accountWriteFence: async (db: any, id: string, action: string) => {
          await db.query(
            "INSERT INTO accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
            [id],
          );
          await fence.lockGpuAccountFence(db, id, action);
        },
        isHomeBay: async () => true,
      },
    );
    return { owner, key };
  }

  // A pass that asked RunPod at `ms` and gets its answer when `answer` is
  // called.
  function slowPass(owner: string, key: string, ms: number, balance: number) {
    let answer!: () => void;
    const gate = new Promise<void>((r) => (answer = r));
    const done = watch.watchProviderAccount(
      { credential_id: key, key_owner_account_id: owner },
      {
        now: () => T0 + ms,
        getAccountBalance: async () => {
          await gate;
          return { balance, spendPerHour: 0 };
        },
      },
    );
    return { answer, done };
  }

  async function samples(key: string) {
    const { rows } = await getPool().query(
      "SELECT last_asked_at, last_balance_usd FROM gpu_provider_account_watch WHERE credential_id = $1",
      [key],
    );
    return {
      asked: new Date(rows[0].last_asked_at).getTime() - T0,
      balance: Number(rows[0].last_balance_usd),
    };
  }

  it("the newer pass answers first: the older one is stale and changes nothing", async () => {
    const { owner, key } = await confirmedKey();
    const older = slowPass(owner, key, 1 * MINUTE, 50);
    const newer = slowPass(owner, key, 2 * MINUTE, 40);
    newer.answer();
    expect((await newer.done).checked).toBe(true);
    older.answer();
    expect(await older.done).toEqual({ checked: false, reason: "stale" });
    expect(await samples(key)).toEqual({ asked: 2 * MINUTE, balance: 40 });
  });

  it("the older pass answers first: both are written, in order", async () => {
    const { owner, key } = await confirmedKey();
    const older = slowPass(owner, key, 1 * MINUTE, 50);
    const newer = slowPass(owner, key, 2 * MINUTE, 40);
    older.answer();
    expect((await older.done).checked).toBe(true);
    newer.answer();
    expect((await newer.done).checked).toBe(true);
    expect(await samples(key)).toEqual({ asked: 2 * MINUTE, balance: 40 });
  });

  it("both answer at once: the samples end at the newer one", async () => {
    const { owner, key } = await confirmedKey();
    const older = slowPass(owner, key, 1 * MINUTE, 50);
    const newer = slowPass(owner, key, 2 * MINUTE, 40);
    newer.answer();
    older.answer();
    await Promise.all([older.done, newer.done]);
    expect(await samples(key)).toEqual({ asked: 2 * MINUTE, balance: 40 });
  });
});
