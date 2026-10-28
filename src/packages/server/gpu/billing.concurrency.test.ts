/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Billing workers and the state ledger against a real PostgreSQL with
// concurrent connections: two workers claiming one pod make one provider
// call and apply once; a newer state change and an older effective time,
// committed in either order, never make intervals overlap or run backwards.
// Skips itself without the server binaries.

import { randomUUID } from "node:crypto";
import {
  postgresBinDir,
  startRealPostgres,
  type RealPostgres,
} from "@cocalc/server/test/real-postgres";
import { freshInventoryForTests } from "./test-inventory";

const describeRealPostgres = postgresBinDir() ? describe : describe.skip;

const HOUR = 3_600_000;

describeRealPostgres("GPU billing and the state ledger, concurrently", () => {
  let pg: RealPostgres;
  let getPool: any;
  let pods: typeof import("./pods");
  let fence: typeof import("./account-fence");
  let billing: typeof import("./billing");

  beforeAll(async () => {
    pg = startRealPostgres("gpu_billing_concurrency_test");
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
    await getPool().query(
      "INSERT INTO gpu_worker_leases (name, last_completed_at) VALUES ('reaper', now() + interval '10 years') ON CONFLICT (name) DO UPDATE SET last_completed_at = EXCLUDED.last_completed_at",
    );
    await freshInventoryForTests();
    pods = await import("./pods");
    fence = await import("./account-fence");
    billing = await import("./billing");
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
    const client = {
      createPod: async (body: any) => ({
        id: `pod_${randomUUID().slice(0, 8)}`,
        name: body.name,
        cost: 0.5,
      }),
      terminatePod: async () => {},
      findPodsByName: async () => [],
    };
    const deps = {
      isHomeBay: async () => true,
      isProjectCollaborator: async () => true,
      getLaunchAccess: async () => ({ client: client as any, credential_id }),
      getCleanup: async () => ({ ...client, credential_id }) as any,
      listPrice: async () => 0.5,
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
    return { account_id, credential_id, deps, launch };
  }

  const row = async (id: string) =>
    (await getPool().query("SELECT * FROM gpu_pods WHERE id = $1", [id]))
      .rows[0];

  it("two billing workers on one pod: one provider call, applied once", async () => {
    const s = setup();
    const p = await s.launch();
    await pods.terminateGpuPodLocal(
      { account_id: s.account_id, pod_id: p.id },
      s.deps,
    );
    const pod = await row(p.id);
    const start =
      Math.floor(new Date(pod.running_since).getTime() / HOUR) * HOUR;
    const end = Math.max(
      Math.ceil(new Date(pod.terminated_at).getTime() / HOUR) * HOUR,
      start + HOUR,
    );
    const recs: any[] = [];
    for (let h = start; h < end; h += HOUR) {
      recs.push({
        podId: pod.provider_pod_id,
        startTime: new Date(h).toISOString(),
        endTime: new Date(h + HOUR).toISOString(),
        totalAmount: 0.001,
      });
    }
    let calls = 0;
    const cap = {
      credential_id: s.credential_id,
      listPodBilling: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 50));
        return recs;
      },
    };
    const now = new Date(pod.terminated_at).getTime() + 3 * HOUR;
    const pass = () =>
      billing.reconcileKeyBilling(
        {
          credential_id: s.credential_id,
          key_owner_account_id: s.account_id,
          deadline: now + 30_000,
        },
        { now: () => now, getBilling: async () => cap as any },
      );
    const [a, b] = await Promise.all([pass(), pass()]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(a.billed + b.billed).toBe(1);
    expect(calls).toBe(1);
    const { rows: ev } = await getPool().query(
      "SELECT 1 FROM gpu_pod_events WHERE pod_id = $1 AND action = 'billed'",
      [p.id],
    );
    expect(ev.length).toBe(1);
  });

  it("a newer state change, then a later-committed older effective time: no overlap, nothing backwards", async () => {
    const s = setup();
    const p = await s.launch();
    // a transition holds the pod while an older-timestamped one waits on it
    const db = await getPool().connect();
    let older: Promise<unknown> | undefined;
    try {
      await db.query("BEGIN");
      await db.query("SELECT 1 FROM gpu_pods WHERE id = $1 FOR UPDATE", [p.id]);
      older = pods.transition(p.id, { state: "stopped" }, "", undefined, {
        effective_at: new Date(Date.now() - 2 * HOUR),
      });
      await new Promise((r) => setTimeout(r, 100));
      await db.query("COMMIT");
    } finally {
      db.release();
    }
    await older;
    await pods.transition(p.id, { state: "running" }, "", undefined, {
      effective_at: new Date(Date.now() - 3 * HOUR),
    });
    const { rows } = await getPool().query(
      "SELECT state, started, ended FROM gpu_pod_state_intervals WHERE pod_id = $1 ORDER BY started, ended NULLS LAST",
      [p.id],
    );
    expect(rows.filter((r: any) => r.ended == null).length).toBe(1);
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].ended) {
        expect(new Date(rows[i].ended).getTime()).toBeGreaterThanOrEqual(
          new Date(rows[i].started).getTime(),
        );
      }
      if (i > 0) {
        expect(new Date(rows[i].started).getTime()).toBeGreaterThanOrEqual(
          new Date(rows[i - 1].ended).getTime(),
        );
      }
    }
  });
});
