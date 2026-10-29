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

  async function setup({ ambiguous = false } = {}) {
    const account_id = randomUUID();
    const credential_id = randomUUID();
    const client = {
      createPod: async (body: any) => {
        if (ambiguous) {
          const { RunpodApiError } =
            await import("@cocalc/cloud/runpod/client");
          throw new RunpodApiError("provider", 503);
        }
        return {
          id: `pod_${randomUUID().slice(0, 8)}`,
          name: body.name,
          cost: 0.5,
        };
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
    const provider_pod_id =
      (
        await getPool().query(
          "SELECT provider_pod_id FROM gpu_pods WHERE id = $1",
          [pod.id],
        )
      ).rows[0].provider_pod_id ?? "pod_none";
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
          getReconcile: async () =>
            ({
              credential_id,
              getPod: cap.getPod,
              // one page, handed over as it arrives (as the client does)
              listPods: async (opts: any = {}) => {
                await opts.beforePage?.();
                const page = await cap.listPods();
                await opts.onPage?.(page);
                return page;
              },
            }) as any,
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
    const podRow = async () =>
      (await getPool().query("SELECT * FROM gpu_pods WHERE id = $1", [pod.id]))
        .rows[0];
    // what a key change does under its fence: close the key's fence
    // (onKeyGone included), holding the account fence until `release`
    const closeUnderFence = async (release: Promise<void>) => {
      const keys = await import("./provider-keys");
      const db = await getPool().connect();
      try {
        await db.query("BEGIN");
        await deps.accountWriteFence(db, account_id, "remove a key");
        const { rows } = await db.query(
          `SELECT count(*)::int AS n FROM gpu_pods WHERE credential_id = $1
              AND state NOT IN ('terminated', 'failed', 'ambiguous') AND unmanaged_at IS NULL`,
          [credential_id],
        );
        await keys.closeKeyFence(db, account_id, credential_id, "removed");
        await release;
        await db.query("COMMIT");
        return rows[0].n as number;
      } catch (err) {
        await db.query("ROLLBACK");
        throw err;
      } finally {
        db.release();
      }
    };
    return {
      account_id,
      credential_id,
      ours,
      pass,
      alert,
      keyFence,
      pod,
      podRow,
      closeUnderFence,
    };
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

  it("a pass that finishes after the key was removed writes no alert and no pause", async () => {
    const s = await setup();
    const t0 = Date.now();
    const stranger = { id: "pod_strangerD", name: "x" };
    await s.pass(t0, {
      listPods: async () => [s.ours, stranger],
      getPod: async () => undefined,
    });
    await getPool().query(
      "UPDATE gpu_key_fences SET paused_reason = NULL WHERE credential_id = $1",
      [s.credential_id],
    );
    // a pass claims while the key is live, and its listing is slow
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
    // the key is removed (its unknown pod becomes the owner's to check)
    await s.closeUnderFence(Promise.resolve());
    // the pass's stale sighting lands, and a second stranger
    late.open([s.ours, stranger, { id: "pod_strangerE", name: "y" }]);
    await a;
    const [converted] = await s.alert(stranger.id);
    expect(converted.resolved_at).toBeNull();
    const { rows } = await getPool().query(
      "SELECT severity, details FROM gpu_alerts WHERE credential_id = $1 AND dedupe_key = $2",
      [s.credential_id, stranger.id],
    );
    expect(rows[0]).toEqual({
      severity: "warning",
      details: expect.objectContaining({ unverifiable: true }),
    });
    expect(await s.alert("pod_strangerE")).toEqual([]);
    const f = await s.keyFence();
    expect(f.state).toBe("closed");
    expect(f.paused_reason).toBeNull();
  });

  it("a late 401 after the key was removed doesn't reopen key_rejected", async () => {
    const s = await setup();
    const t0 = Date.now();
    const { RunpodApiError } = await import("@cocalc/cloud/runpod/client");
    await s.pass(t0, {
      listPods: async () => {
        throw new RunpodApiError("auth", 401);
      },
      getPod: async () => undefined,
    });
    expect((await s.alert("key"))[0].resolved_at).toBeNull();
    const late = gate();
    const listing = gate();
    const a = s.pass(t0 + 3 * MINUTE, {
      listPods: async () => {
        listing.open();
        await late.p;
        throw new RunpodApiError("auth", 401);
      },
      getPod: async () => undefined,
    });
    await listing.p;
    await s.closeUnderFence(Promise.resolve());
    late.open();
    await a;
    const rows = await s.alert("key");
    expect(rows.length).toBe(1);
    expect(rows[0].resolved_by).toBe("removed");
  });

  it("a key close and a bind are ordered: close first binds nothing; bind first, the close sees the live pod", async () => {
    // close first: the bind waits for the account fence, then binds nothing
    const a = await setup({ ambiguous: true });
    expect((await a.podRow()).state).toBe("ambiguous");
    const release = gate();
    const closing = a.closeUnderFence(release.p);
    // the closer holds the account fence; the bind queues behind it
    await new Promise((r) => setTimeout(r, 100));
    const bind = pods.reconcileBindPod(
      await a.podRow(),
      { id: "pod_bindA", name: a.pod.handle, cost: 0.5 } as any,
      { kind: "reconciler" },
      new Date(),
    );
    await new Promise((r) => setTimeout(r, 100));
    release.open();
    expect(await closing).toBe(0);
    expect((await bind).row).toBeUndefined();
    expect((await a.podRow()).state).toBe("ambiguous");
    // bind first: the closer, under the same fence, finds the pod live
    const b = await setup({ ambiguous: true });
    const bound = await pods.reconcileBindPod(
      await b.podRow(),
      { id: "pod_bindB", name: b.pod.handle, cost: 0.5 } as any,
      { kind: "reconciler" },
      new Date(),
    );
    expect(bound.row?.state).toBe("running");
    expect(await b.closeUnderFence(Promise.resolve())).toBe(1);
  });

  it("a 404 asked before a newer sighting doesn't end the pod; one asked after it does", async () => {
    const s = await setup();
    const t0 = Date.now();
    // A asks RunPod about our pod (omitted from its listing) at t0+1m...
    const answer = gate<undefined>();
    const asked = gate();
    let clockA = t0;
    const a = reconcile.reconcileKey(
      {
        credential_id: s.credential_id,
        key_owner_account_id: s.account_id,
        // (its clock moves a minute while it lists)
        deadline: t0 + 5 * MINUTE,
      },
      {
        now: () => clockA,
        getReconcile: async () =>
          ({
            credential_id: s.credential_id,
            listPods: async () => {
              clockA = t0 + MINUTE;
              return [];
            },
            getPod: async () => {
              asked.open();
              return await answer.p;
            },
          }) as any,
      },
    );
    await asked.p;
    // ...B lists it live, observing at t0+2m (after A asked)
    await s.pass(t0 + 2 * MINUTE, {
      listPods: async () => [s.ours],
      getPod: async () => undefined,
    });
    answer.open(undefined);
    await a;
    expect((await s.podRow()).state).toBe("running");
    // a 404 asked after the latest sighting ends it (RunPod says it's gone)
    await s.pass(t0 + 13 * MINUTE, {
      listPods: async () => [],
      getPod: async () => undefined,
    });
    expect((await s.podRow()).state).toBe("terminated");
  });

  it("a sighting that commits while a 404's end waits on the pod wins; one after it changes nothing", async () => {
    const s = await setup();
    const asked = new Date(Date.now() - MINUTE);
    const row = await s.podRow();
    // a newer listing's sighting, not yet committed, holds the pod's row
    const db = await getPool().connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "UPDATE gpu_pods SET provider_seen_at = $2 WHERE id = $1",
        [row.id, new Date()],
      );
      const ending = pods.endPodGoneAtProvider(
        row,
        { kind: "reconciler" },
        asked,
      );
      await new Promise((r) => setTimeout(r, 200));
      await db.query("COMMIT");
      // the end re-checked the sighting and did nothing: not even wanted
      // terminated, and its holds untouched
      expect(await ending).toBeUndefined();
    } finally {
      db.release();
    }
    const after = await s.podRow();
    expect(after.state).toBe("running");
    expect(after.desired_state).toBe("running");
    const { rows } = await getPool().query(
      "SELECT state FROM gpu_pod_reservations WHERE pod_id = $1",
      [row.id],
    );
    expect(rows.map((r: any) => r.state)).toEqual(["active"]);
    // a 404 asked after that sighting ends it, all at once
    const ended = await pods.endPodGoneAtProvider(
      after,
      { kind: "reconciler" },
      new Date(Date.now() + 1000),
    );
    expect(ended?.state).toBe("terminated");
    const { rows: settled } = await getPool().query(
      "SELECT state FROM gpu_pod_reservations WHERE pod_id = $1",
      [row.id],
    );
    expect(settled.map((r: any) => r.state)).toEqual(["settled"]);
  });

  it("the other order: a 404's end commits first, then a newer sighting confirmed live by id makes the pod CoCalc's again, to terminate", async () => {
    const s = await setup();
    const t0 = Date.now();
    const row = await s.podRow();
    const layerHeld = async () =>
      Number(
        (
          await getPool().query(
            "SELECT reserved_usd FROM gpu_budget_layers WHERE credential_id = $1 AND scope_kind = 'key'",
            [s.credential_id],
          )
        ).rows[0].reserved_usd,
      );
    const heldBefore = await layerHeld();
    expect(heldBefore).toBeGreaterThan(0);
    // the older "not found" lands first: ended and settled
    expect(
      (
        await pods.endPodGoneAtProvider(
          row,
          { kind: "reconciler" },
          new Date(t0 - MINUTE),
        )
      )?.state,
    ).toBe("terminated");
    expect(await layerHeld()).toBe(0);
    // a newer listing shows it, but RunPod says by id it's gone: the
    // listing lags; nothing changes
    await s.pass(t0 + MINUTE, {
      listPods: async () => [s.ours],
      getPod: async () => undefined,
    });
    expect((await s.podRow()).state).toBe("terminated");
    // nor if RunPod has it by id only as TERMINATED
    await s.pass(t0 + 2 * MINUTE, {
      listPods: async () => [s.ours],
      getPod: async (id: string) => ({ id, status: "TERMINATED" }),
    });
    expect((await s.podRow()).state).toBe("terminated");
    // a newer listing shows it and RunPod has it by id: CoCalc's again
    await s.pass(t0 + 12 * MINUTE, {
      listPods: async () => [s.ours],
      getPod: async (id: string) => ({ id, name: s.ours.name }),
    });
    const after = await s.podRow();
    expect(after).toEqual(
      expect.objectContaining({
        state: "terminating",
        desired_state: "terminated",
        terminated_at: null,
      }),
    );
    const { rows } = await getPool().query(
      "SELECT state FROM gpu_pod_reservations WHERE pod_id = $1",
      [row.id],
    );
    expect(rows.map((r: any) => r.state)).toEqual(["active"]);
    expect(await layerHeld()).toBeCloseTo(heldBefore);
    const { rows: ev } = await getPool().query(
      "SELECT details FROM gpu_pod_events WHERE pod_id = $1 AND details->>'seen_after_end' = 'true'",
      [row.id],
    );
    expect(ev.length).toBe(1);
  });
});
