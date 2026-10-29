/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Admission is atomic: launches racing against one budget can't together
// exceed it. This needs concurrent transactions, hence a real PostgreSQL
// (PGlite has a single connection); it skips itself without the server
// binaries.

import { randomUUID } from "node:crypto";
import {
  postgresBinDir,
  startRealPostgres,
  type RealPostgres,
} from "@cocalc/server/test/real-postgres";
import { freshInventoryForTests } from "./test-inventory";

const describeRealPostgres = postgresBinDir() ? describe : describe.skip;

describeRealPostgres("GPU budget admission under concurrency", () => {
  let pg: RealPostgres;
  let getPool: any;
  let pods: typeof import("./pods");
  let fence: typeof import("./account-fence");

  beforeAll(async () => {
    pg = startRealPostgres("gpu_budget_concurrency_test");
    getPool = (await import("@cocalc/database/pool")).default;
    const { SCHEMA } = await import("@cocalc/util/db-schema");
    const { syncSchema } =
      await import("@cocalc/database/postgres/schema/sync");
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS accounts (account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN)",
    );
    await syncSchema({
      gpu_key_fences: SCHEMA.gpu_key_fences,
      gpu_alerts: SCHEMA.gpu_alerts,
      gpu_provider_account_watch: SCHEMA.gpu_provider_account_watch,
      gpu_key_events: SCHEMA.gpu_key_events,
      gpu_budget_layers: SCHEMA.gpu_budget_layers,
      gpu_budget_events: SCHEMA.gpu_budget_events,
      gpu_pods: SCHEMA.gpu_pods,
      gpu_pod_state_intervals: SCHEMA.gpu_pod_state_intervals,
      gpu_admin_alerts: SCHEMA.gpu_admin_alerts,
      gpu_worker_runs: SCHEMA.gpu_worker_runs,
      gpu_pod_events: SCHEMA.gpu_pod_events,
      gpu_pod_reservations: SCHEMA.gpu_pod_reservations,
      gpu_worker_leases: SCHEMA.gpu_worker_leases,
      gpu_worker_overrides: SCHEMA.gpu_worker_overrides,
    });
    // the reaper has just completed a sweep (admission requires it)
    await getPool().query(
      "INSERT INTO gpu_worker_leases (name, last_completed_at) VALUES ('reaper', now() + interval '10 years') ON CONFLICT (name) DO UPDATE SET last_completed_at = EXCLUDED.last_completed_at",
    );
    // and every key has a recent complete inventory (likewise)
    await freshInventoryForTests();
    pods = await import("./pods");
    fence = await import("./account-fence");
  }, 120_000);

  afterAll(async () => {
    try {
      await getPool?.().end();
    } finally {
      pg?.stop();
    }
  });

  function setup() {
    const account_id = randomUUID();
    const credential_id = randomUUID();
    const created: string[] = [];
    const client = {
      createPod: async (body: any) => {
        // a slow RunPod, so admissions overlap with creates in flight
        await new Promise((r) => setTimeout(r, 20));
        const pod = {
          id: `pod_${randomUUID().slice(0, 8)}`,
          name: body.name,
          cost: 0.5,
        };
        created.push(pod.id);
        return pod;
      },
      terminatePod: async () => {},
      findPodsByName: async () => [],
    };
    const deps = {
      isHomeBay: async () => true,
      isProjectCollaborator: async () => true,
      getLaunchAccess: async () => ({ client: client as any, credential_id }),
      getCleanup: async () => ({ ...client, credential_id }) as any,
      listPrice: async () => 0.5,
      // the real fence, on the account row it needs (same transaction)
      accountWriteFence: async (db: any, id: string, action: string) => {
        await db.query(
          "INSERT INTO accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
          [id],
        );
        await fence.lockGpuAccountFence(db, id, action);
      },
    };
    const launch = () =>
      pods.launchGpuPodLocal(
        {
          account_id,
          project_id: "00000000-1000-4000-8000-0000000000aa",
          spec: {
            gpu_type_id: "NVIDIA GeForce RTX 4090",
            image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
            max_runtime_minutes: 60,
          },
        },
        deps,
      );
    return { account_id, credential_id, created, launch };
  }

  it("admits exactly as many concurrent launches as the pod cap allows", async () => {
    const s = setup();
    await s.launch(); // makes the budget
    await getPool().query(
      "UPDATE gpu_budget_layers SET max_concurrent_pods = 3 WHERE credential_id = $1",
      [s.credential_id],
    );
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => s.launch()),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(2); // 1 already running + 2 = the cap of 3
    for (const r of results) {
      if (r.status === "rejected") {
        expect(`${r.reason}`).toMatch(/at most 3 pods at once/);
      }
    }
    expect(s.created).toHaveLength(3);
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n, sum(r.reserved_usd) AS reserved
         FROM gpu_pod_reservations r JOIN gpu_pods p ON p.id = r.pod_id
        WHERE p.credential_id = $1 AND r.state = 'active'`,
      [s.credential_id],
    );
    expect(rows[0].n).toBe(3);
    const { rows: layer } = await getPool().query(
      "SELECT reserved_usd FROM gpu_budget_layers WHERE credential_id = $1",
      [s.credential_id],
    );
    expect(Number(layer[0].reserved_usd)).toBeCloseTo(
      Number(rows[0].reserved),
      9,
    );
  });

  it("admits exactly as much as the money allows", async () => {
    const s = setup();
    await s.launch();
    // $0.50 per launch; $1.70 authorized leaves room for 2 more ($1.50)
    await getPool().query(
      "UPDATE gpu_budget_layers SET authorized_usd = 1.7, max_concurrent_pods = 50, max_gpu_count = 50, max_hourly_usd = NULL WHERE credential_id = $1",
      [s.credential_id],
    );
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => s.launch()),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(s.created).toHaveLength(3);
  });
});
