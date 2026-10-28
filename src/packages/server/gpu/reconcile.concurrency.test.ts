/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Reconcile passes that overlap (another hub, the request-time pass at
// connect), against a real PostgreSQL with concurrent connections: whichever
// order their writes land in, the newer observation wins. An older pass can
// neither resolve what a newer one saw, nor reopen (or re-pause for) what a
// newer one proved gone; the watermark and the cursor never go backwards.
// Skips itself without the server binaries.

import { randomUUID } from "node:crypto";
import {
  postgresBinDir,
  startRealPostgres,
  type RealPostgres,
} from "@cocalc/server/test/real-postgres";
import { freshInventoryForTests } from "./test-inventory";

const describeRealPostgres = postgresBinDir() ? describe : describe.skip;

const MINUTE = 60_000;

// A promise and the function that settles it.
function gate<T = void>() {
  let open!: (v: T) => void;
  const p = new Promise<T>((r) => (open = r));
  return { p, open };
}

describeRealPostgres("GPU reconcile passes that overlap", () => {
  let pg: RealPostgres;
  let getPool: any;
  let pods: typeof import("./pods");
  let fence: typeof import("./account-fence");
  let reconcile: typeof import("./reconcile");

  beforeAll(async () => {
    pg = startRealPostgres("gpu_reconcile_concurrency_test");
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
    reconcile = await import("./reconcile");
  }, 120_000);

  afterAll(async () => {
    try {
      await getPool?.().end();
    } finally {
      pg?.stop();
    }
  });

  async function setup() {
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
    const pod = await pods.launchGpuPodLocal(
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
    const provider_pod_id = (
      await getPool().query(
        "SELECT provider_pod_id FROM gpu_pods WHERE id = $1",
        [pod.id],
      )
    ).rows[0].provider_pod_id;
    // passes observe from here on (the seed put the watermark far ahead)
    await getPool().query(
      "UPDATE gpu_key_fences SET last_inventory_at = NULL WHERE credential_id = $1",
      [credential_id],
    );
    const ours = { id: provider_pod_id, name: pod.handle, cost: 0.5 };
    // one pass: its clock, its listing, and its getPod answers
    const pass = (at: number, cap: { listPods: any; getPod: any }) =>
      reconcile.reconcileKey(
        {
          credential_id,
          key_owner_account_id: account_id,
          deadline: at + reconcile.RECONCILE_KEY_PASS_MS,
        },
        {
          now: () => at,
          getReconcile: async () => ({ credential_id, ...cap }) as any,
        },
      );
    const alert = async (dedupe_key: string) =>
      (
        await getPool().query(
          "SELECT resolved_at, resolved_by, last_seen FROM gpu_alerts WHERE credential_id = $1 AND dedupe_key = $2 ORDER BY opened DESC",
          [credential_id, dedupe_key],
        )
      ).rows;
    const keyFence = async () =>
      (
        await getPool().query(
          "SELECT * FROM gpu_key_fences WHERE credential_id = $1",
          [credential_id],
        )
      ).rows[0];
    return { account_id, credential_id, ours, pass, alert, keyFence };
  }

  it("an older pass's 404 can't resolve what a newer pass saw; its outcome doesn't overwrite the newer one's", async () => {
    const s = await setup();
    const t0 = Date.now();
    const stranger = { id: "pod_strangerA", name: "x" };
    // t0: the stranger is seen
    await s.pass(t0, {
      listPods: async () => [s.ours, stranger],
      getPod: async () => undefined,
    });
    // A (t1) doesn't list it, and its getPod answer is slow
    const slow = gate<undefined>();
    const asked = gate();
    const a = s.pass(t0 + 11 * MINUTE, {
      listPods: async () => [s.ours],
      getPod: async () => {
        asked.open();
        return await slow.p;
      },
    });
    await asked.p;
    // B (t2 > t1) lists it again, and completes
    expect(
      (
        await s.pass(t0 + 12 * MINUTE, {
          listPods: async () => [s.ours, stranger],
          getPod: async () => undefined,
        })
      ).complete,
    ).toBe(true);
    // now A's "not found" (observed at t1, before B's sighting) lands
    slow.open(undefined);
    expect((await a).complete).toBe(true);
    const [open] = await s.alert(stranger.id);
    expect(open.resolved_at).toBeNull();
    expect(new Date(open.last_seen).getTime()).toBe(t0 + 12 * MINUTE);
    // the watermark and the cursor are B's
    const f = await s.keyFence();
    expect(new Date(f.last_inventory_at).getTime()).toBe(t0 + 12 * MINUTE);
    expect(new Date(f.last_reconcile_attempt_at).getTime()).toBe(
      t0 + 12 * MINUTE,
    );
    expect(new Date(f.next_reconcile_at).getTime()).toBe(
      t0 + 12 * MINUTE + 10 * MINUTE,
    );
  });

  it("an older pass's sighting can't reopen (or re-pause for) what a newer pass proved gone", async () => {
    const s = await setup();
    const t0 = Date.now();
    const stranger = { id: "pod_strangerB", name: "x" };
    await s.pass(t0, {
      listPods: async () => [s.ours, stranger],
      getPod: async () => undefined,
    });
    // the owner looked and resumed
    await getPool().query(
      "UPDATE gpu_key_fences SET paused_reason = NULL WHERE credential_id = $1",
      [s.credential_id],
    );
    // A (t1) lists the stranger, but its listing comes back late
    const late = gate<any[]>();
    const listing = gate();
    const a = s.pass(t0 + 11 * MINUTE, {
      listPods: async () => {
        listing.open();
        return await late.p;
      },
      getPod: async () => undefined,
    });
    await listing.p;
    // B (t2 > t1): not listed, and RunPod says it is gone: resolved
    await s.pass(t0 + 12 * MINUTE, {
      listPods: async () => [s.ours],
      getPod: async () => undefined,
    });
    expect((await s.alert(stranger.id))[0].resolved_by).toBe(
      "gone_at_provider",
    );
    // A's stale sighting lands: nothing reopens, nothing pauses
    late.open([s.ours, stranger]);
    await a;
    const rows = await s.alert(stranger.id);
    expect(rows.length).toBe(1);
    expect(rows[0].resolved_by).toBe("gone_at_provider");
    const f = await s.keyFence();
    expect(f.paused_reason).toBeNull();
    // the watermark never went back to A's
    expect(new Date(f.last_inventory_at).getTime()).toBe(t0 + 12 * MINUTE);
  });

  it("a newer sighting still reopens what an older pass resolved", async () => {
    const s = await setup();
    const t0 = Date.now();
    const stranger = { id: "pod_strangerC", name: "x" };
    await s.pass(t0, {
      listPods: async () => [s.ours, stranger],
      getPod: async () => undefined,
    });
    await s.pass(t0 + 11 * MINUTE, {
      listPods: async () => [s.ours],
      getPod: async () => undefined,
    });
    expect((await s.alert(stranger.id))[0].resolved_at).not.toBeNull();
    // it is back (RunPod's listing lagged, or someone started it again)
    await s.pass(t0 + 22 * MINUTE, {
      listPods: async () => [s.ours, stranger],
      getPod: async () => undefined,
    });
    const rows = await s.alert(stranger.id);
    expect(rows.length).toBe(2);
    expect(rows[0].resolved_at).toBeNull();
    expect((await s.keyFence()).paused_reason).toBe("unknown_pod");
  });

  it("two passes at once on one key: one claims, the other does nothing", async () => {
    const s = await setup();
    const t = Date.now();
    const cap = {
      listPods: async () => [s.ours],
      getPod: async () => undefined,
    };
    const [x, y] = await Promise.all([s.pass(t, cap), s.pass(t, cap)]);
    expect([x.claimed, y.claimed].sort()).toEqual([false, true]);
  });
});
