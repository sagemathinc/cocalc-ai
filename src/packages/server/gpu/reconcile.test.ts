/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The inventory reconciler against a real (PGlite) database and a fake
// RunPod, with a fake clock: a complete pass moves the watermark; an unknown
// pod raises a critical alert and pauses the key; absence is only RunPod's
// 404 for that id; a rejected key backs off and pauses; an older pass never
// overwrites a newer one; an ambiguous create seen later is bound back; and
// launches refuse without a recent inventory.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { RunpodApiError } from "@cocalc/cloud/runpod/client";
import { GPU_LAUNCH_IMAGES } from "@cocalc/util/gpu/launch-spec";
import { lockGpuAccountFence } from "./account-fence";
import {
  AMBIGUOUS_WINDOW_MS,
  launchGpuPodLocal,
  listManagedGpuPodsLocal,
  releaseQuarantinedLocal,
} from "./pods";
import {
  reconcileKey,
  runReconcileSweep,
  RECONCILE_KEY_PASS_MS,
} from "./reconcile";
import { INVENTORY_STALE_MS } from "./budgets";
import { freshInventoryForTests } from "./test-inventory";
import { allowStaleWorkersLocal } from "./admin";
import { resumeGpuLaunchesLocal } from "./budget-api";
import { testKeyUse } from "./key-use-testing";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const PROJECT = "00000000-1000-4000-8000-0000000000ab";
const SPEC = {
  gpu_type_id: "NVIDIA GeForce RTX 4090",
  image: GPU_LAUNCH_IMAGES[0],
  max_runtime_minutes: 60,
};
const MINUTE = 60_000;

function setup() {
  const account_id = randomUUID();
  const credential_id = randomUUID();
  const pods = new Map<string, any>();
  // what getPod answers, when it differs from the listing (RunPod's lag)
  const byId = new Map<string, any>();
  const client = {
    createPod: jest.fn(async (body: any) => {
      const pod = {
        id: `pod_${randomUUID().slice(0, 8)}`,
        name: body.name,
        cost: 0.5,
      };
      pods.set(pod.id, pod);
      return pod;
    }),
    terminatePod: jest.fn(async (id: string) => {
      pods.delete(id);
    }),
    findPodsByName: jest.fn(async (name: string) =>
      [...pods.values()].filter((p) => p.name === name),
    ),
  };
  let clock = Date.now();
  const reconcile = {
    credential_id,
    // one page, handed over as it arrives (as the client does)
    listPods: jest.fn(async (opts: any = {}) => {
      await opts.beforePage?.();
      const page = [...pods.values()];
      await opts.onPage?.(page);
      return page;
    }),
    getPod: jest.fn(async (id: string) =>
      byId.has(id) ? byId.get(id) : pods.get(id),
    ),
  };
  const deps = {
    isHomeBay: async () => true,
    isProjectCollaborator: async () => true,
    getLaunchAccess: async () => ({ client: client as any, credential_id }),
    getCleanup: async () => ({ ...client, credential_id }) as any,
    listPrice: async () => 0.5,
    siteUrl: async () => "https://cocalc.test",
    accountWriteFence: async (db: any, id: string, action: string) => {
      await db.query(
        "INSERT INTO accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [id],
      );
      await lockGpuAccountFence(db, id, action);
    },
    now: () => clock,
    holder: "hub-test",
  };
  const rdeps = {
    now: () => clock,
    getReconcile: async () => reconcile as any,
  };
  return {
    account_id,
    credential_id,
    client,
    pods,
    byId,
    reconcile,
    deps,
    rdeps,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
    launch: () =>
      launchGpuPodLocal(
        {
          key_use: testKeyUse("launch"),
          account_id,
          project_id: PROJECT,
          spec: SPEC,
        },
        deps,
      ),
    pass: (over: any = {}) =>
      reconcileKey(
        {
          credential_id,
          key_owner_account_id: account_id,
          deadline: clock + RECONCILE_KEY_PASS_MS,
        },
        { ...rdeps, ...over },
      ),
  };
}

async function fence(credential_id: string) {
  const { rows } = await getPool().query(
    "SELECT * FROM gpu_key_fences WHERE credential_id = $1",
    [credential_id],
  );
  return rows[0];
}

async function alerts(credential_id: string) {
  const { rows } = await getPool().query(
    "SELECT kind, severity, dedupe_key, resolved_at, resolved_by FROM gpu_alerts WHERE credential_id = $1 ORDER BY opened",
    [credential_id],
  );
  return rows;
}

async function row(id: string) {
  const { rows } = await getPool().query(
    "SELECT * FROM gpu_pods WHERE id = $1",
    [id],
  );
  return rows[0];
}

describeDb("GPU inventory reconciler", () => {
  beforeAll(async () => {
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS accounts (account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN)",
    );
    await syncSchema({
      gpu_key_fences: SCHEMA.gpu_key_fences,
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
      gpu_alerts: SCHEMA.gpu_alerts,
      gpu_provider_account_watch: SCHEMA.gpu_provider_account_watch,
      external_credentials: SCHEMA.external_credentials,
    });
    await getPool().query(
      "INSERT INTO gpu_worker_leases (name, last_completed_at) VALUES ('reaper', now() + interval '10 years') ON CONFLICT (name) DO UPDATE SET last_completed_at = EXCLUDED.last_completed_at",
    );
    // keys start launchable; each test sets the watermark it is about
    await freshInventoryForTests();
  });

  it("a complete pass moves the watermark and the cursor, and reads only", async () => {
    const s = setup();
    const pod = await s.launch();
    s.advance(MINUTE);
    const at = s.now();
    expect(await s.pass()).toEqual({
      claimed: true,
      complete: true,
      unknown_pods: 0,
    });
    const f = await fence(s.credential_id);
    expect(new Date(f.last_reconcile_attempt_at).getTime()).toBe(at);
    expect(new Date(f.next_reconcile_at).getTime()).toBe(at + 10 * MINUTE);
    expect(f.reconcile_attempts).toBe(0);
    expect(await alerts(s.credential_id)).toEqual([]);
    expect((await row(pod.id)).state).toBe("running");
    // the capability it had can't terminate; nothing else was called
    expect(s.client.terminatePod).not.toHaveBeenCalled();
  });

  it("the watermark only moves forward", async () => {
    const s = setup();
    await s.launch();
    // the test seed put it in the future
    const before = (await fence(s.credential_id)).last_inventory_at;
    await s.pass();
    expect((await fence(s.credential_id)).last_inventory_at).toEqual(before);
  });

  it("an unknown pod raises a critical alert and pauses; only RunPod's 404 resolves it", async () => {
    const s = setup();
    await s.launch();
    s.pods.set("pod_strange1", { id: "pod_strange1", name: "someone-else" });
    expect(await s.pass()).toEqual(
      expect.objectContaining({ complete: true, unknown_pods: 1 }),
    );
    expect(await alerts(s.credential_id)).toEqual([
      expect.objectContaining({
        kind: "unknown_pod",
        severity: "critical",
        dedupe_key: "pod_strange1",
        resolved_at: null,
      }),
    ]);
    expect((await fence(s.credential_id)).paused_reason).toBe("unknown_pod");
    await expect(s.launch()).rejects.toThrow(
      /needs you\. See cocalc gpu alerts/,
    );
    // the listing stops showing it, but RunPod still has it: stays open
    s.pods.delete("pod_strange1");
    s.byId.set("pod_strange1", { id: "pod_strange1" });
    s.advance(11 * MINUTE);
    await s.pass();
    expect((await alerts(s.credential_id))[0].resolved_at).toBeNull();
    // RunPod: no such pod. Resolved, but the pause stays for the owner
    s.byId.set("pod_strange1", undefined);
    s.advance(11 * MINUTE);
    await s.pass();
    expect((await alerts(s.credential_id))[0]).toEqual(
      expect.objectContaining({ resolved_by: "gone_at_provider" }),
    );
    expect((await fence(s.credential_id)).paused_reason).toBe("unknown_pod");
  });

  it("resume lifts the safety pause; the alert stays open until its pod is gone", async () => {
    const s = setup();
    await s.launch();
    s.pods.set("pod_strange2", { id: "pod_strange2", name: "someone-else" });
    await s.pass();
    await expect(s.launch()).rejects.toThrow(/See cocalc gpu alerts/);
    await resumeGpuLaunchesLocal(
      { account_id: s.account_id, fresh_auth_verified: true },
      { accountWriteFence: s.deps.accountWriteFence } as any,
    );
    expect((await s.launch()).state).toBe("running");
    expect((await alerts(s.credential_id))[0]).toEqual(
      expect.objectContaining({ kind: "unknown_pod", resolved_at: null }),
    );
    // seen again by the next pass: it pauses again (the owner decides)
    s.advance(11 * MINUTE);
    await s.pass();
    expect((await fence(s.credential_id)).paused_reason).toBe("unknown_pod");
  });

  it("a pod missing from the listing ends only on RunPod's 404 for its id", async () => {
    const s = setup();
    const pod = await s.launch();
    const provider_id = (await row(pod.id)).provider_pod_id;
    // RunPod's listing lags: it's still there by id
    s.pods.delete(provider_id);
    s.byId.set(provider_id, { id: provider_id, name: pod.handle });
    await s.pass();
    expect((await row(pod.id)).state).toBe("running");
    // gone
    s.byId.set(provider_id, undefined);
    s.advance(11 * MINUTE);
    await s.pass();
    const r = await row(pod.id);
    expect(r.state).toBe("terminated");
    // through the normal path, by the reconciler, without a DELETE
    const { rows: ev } = await getPool().query(
      "SELECT actor_kind, action, details FROM gpu_pod_events WHERE pod_id = $1 AND actor_kind = 'reconciler' ORDER BY at",
      [pod.id],
    );
    // one transaction (one timestamp): wanted terminated, and terminated
    expect(ev.map((e: any) => e.details?.state ?? e.action).sort()).toEqual([
      "terminate",
      "terminated",
    ]);
    expect(s.client.terminatePod).not.toHaveBeenCalled();
    const { rows } = await getPool().query(
      "SELECT state FROM gpu_pod_reservations WHERE pod_id = $1",
      [pod.id],
    );
    expect(rows.every((x: any) => x.state === "settled")).toBe(true);
  });

  it("a rejected key raises key_rejected, pauses and backs off; a complete pass resolves the alert", async () => {
    const s = setup();
    await s.launch();
    s.reconcile.listPods.mockRejectedValueOnce(new RunpodApiError("auth", 401));
    const at = s.now();
    expect(await s.pass()).toEqual({ claimed: true, rejected: true });
    let f = await fence(s.credential_id);
    expect(f.paused_reason).toBe("key_rejected");
    expect(f.reconcile_attempts).toBe(1);
    expect(new Date(f.next_reconcile_at).getTime()).toBe(at + 2 * MINUTE);
    expect(await alerts(s.credential_id)).toEqual([
      expect.objectContaining({ kind: "key_rejected", severity: "critical" }),
    ]);
    s.advance(3 * MINUTE);
    expect(await s.pass()).toEqual(expect.objectContaining({ complete: true }));
    f = await fence(s.credential_id);
    expect(f.reconcile_attempts).toBe(0);
    expect((await alerts(s.credential_id))[0].resolved_by).toBe(
      "complete_inventory",
    );
    // the pause is the owner's to lift
    expect(f.paused_reason).toBe("key_rejected");
  });

  it("an older pass can't claim or overwrite a newer one's outcome", async () => {
    const s = setup();
    await s.launch();
    s.advance(MINUTE);
    const newer = s.now();
    expect((await s.pass()).complete).toBe(true);
    // a pass that observed earlier (another hub, a slow clock) does nothing
    const older = await reconcileKey(
      {
        credential_id: s.credential_id,
        key_owner_account_id: s.account_id,
        deadline: newer + RECONCILE_KEY_PASS_MS,
      },
      { ...s.rdeps, now: () => newer - 1000 },
    );
    expect(older).toEqual({ claimed: false });
    expect(
      new Date((await fence(s.credential_id)).next_reconcile_at).getTime(),
    ).toBe(newer + 10 * MINUTE);
  });

  it("a pass that runs out of time records a backoff, not a complete inventory", async () => {
    const s = setup();
    await s.launch();
    await getPool().query(
      "UPDATE gpu_key_fences SET last_inventory_at = NULL WHERE credential_id = $1",
      [s.credential_id],
    );
    s.reconcile.listPods.mockImplementationOnce(async (opts: any) => {
      s.advance(RECONCILE_KEY_PASS_MS + 1);
      await opts.beforePage?.();
      return [];
    });
    expect(await s.pass()).toEqual({ claimed: true, cut: true });
    const f = await fence(s.credential_id);
    expect(f.last_inventory_at).toBeNull();
    expect(f.reconcile_attempts).toBe(1);
  });

  it("binds an ambiguous create's pod when it shows up under its handle", async () => {
    const s = setup();
    let handle = "";
    s.client.createPod.mockImplementationOnce(async (body: any) => {
      handle = body.name;
      throw new RunpodApiError("provider", 503);
    });
    const pod = await s.launch();
    expect(pod.state).toBe("ambiguous");
    s.pods.set("pod_late99", { id: "pod_late99", name: handle, cost: 0.5 });
    expect(await s.pass()).toEqual(
      expect.objectContaining({ complete: true, unknown_pods: 0 }),
    );
    expect(await row(pod.id)).toEqual(
      expect.objectContaining({
        state: "running",
        provider_pod_id: "pod_late99",
      }),
    );
    expect(await alerts(s.credential_id)).toEqual([]);
    // two pods under one handle: neither is assumed to be the record's
    const s2 = setup();
    let h2 = "";
    s2.client.createPod.mockImplementationOnce(async (body: any) => {
      h2 = body.name;
      throw new RunpodApiError("provider", 503);
    });
    const p2 = await s2.launch();
    s2.pods.set("pod_twin1", { id: "pod_twin1", name: h2 });
    s2.pods.set("pod_twin2", { id: "pod_twin2", name: h2 });
    expect((await s2.pass()).unknown_pods).toBe(2);
    expect((await row(p2.id)).state).toBe("ambiguous");
  });

  it("a hold the owner released for a pod that then shows up is held again in full, with a critical alert", async () => {
    const s = setup();
    let handle = "";
    s.client.createPod.mockImplementationOnce(async (body: any) => {
      handle = body.name;
      throw new RunpodApiError("provider", 503);
    });
    const pod = await s.launch();
    // CoCalc gives the create up (no pod by that name), holding its budget
    // (past the window, and past the lookup's backoff)
    s.advance(AMBIGUOUS_WINDOW_MS + 5 * MINUTE);
    await listManagedGpuPodsLocal(
      { key_use: testKeyUse("pod_read"), account_id: s.account_id },
      s.deps,
    );
    expect((await row(pod.id)).state).toBe("failed");
    expect((await alerts(s.credential_id)).map((a: any) => a.kind)).toEqual([
      "quarantined_reservation",
    ]);
    const held = async () =>
      (
        await getPool().query(
          "SELECT reserved_usd FROM gpu_budget_layers WHERE credential_id = $1 AND scope_kind = 'key'",
          [s.credential_id],
        )
      ).rows[0].reserved_usd;
    const before = Number(await held());
    expect(before).toBeGreaterThan(0);
    await releaseQuarantinedLocal(
      { account_id: s.account_id, pod_id: pod.id, fresh_auth_verified: true },
      s.deps,
    );
    expect(Number(await held())).toBe(0);
    // it existed after all
    s.pods.set("pod_after1", { id: "pod_after1", name: handle, cost: 0.5 });
    s.advance(11 * MINUTE);
    await s.pass();
    expect(await row(pod.id)).toEqual(
      expect.objectContaining({
        state: "running",
        provider_pod_id: "pod_after1",
      }),
    );
    expect(Number(await held())).toBeCloseTo(before);
    expect(await alerts(s.credential_id)).toContainEqual(
      expect.objectContaining({
        kind: "unknown_pod",
        severity: "critical",
        dedupe_key: "pod_after1",
        resolved_at: null,
      }),
    );
    expect((await fence(s.credential_id)).paused_reason).toBe("unknown_pod");
  });

  it("launches refuse without a recent complete inventory", async () => {
    const s = setup();
    await s.launch();
    await getPool().query(
      "UPDATE gpu_key_fences SET last_inventory_at = $2 WHERE credential_id = $1",
      [s.credential_id, new Date(s.now() - INVENTORY_STALE_MS - 1000)],
    );
    await expect(s.launch()).rejects.toThrow(/waiting for CoCalc to check/);
    s.advance(MINUTE);
    await s.pass();
    await expect(s.launch()).resolves.toEqual(
      expect.objectContaining({ state: "running" }),
    );
  });

  it("the admin override for stale workers also admits a launch without a recent inventory", async () => {
    const s = setup();
    await s.launch();
    await getPool().query(
      "UPDATE gpu_key_fences SET last_inventory_at = NULL WHERE credential_id = $1",
      [s.credential_id],
    );
    await expect(s.launch()).rejects.toThrow(/waiting for CoCalc to check/);
    await allowStaleWorkersLocal(
      {
        admin_account_id: randomUUID(),
        account_id: s.account_id,
        hours: 1,
        reason: "a good enough reason",
      },
      { accountWriteFence: s.deps.accountWriteFence },
    );
    await expect(s.launch()).resolves.toEqual(
      expect.objectContaining({ state: "running" }),
    );
  });

  it("the sweep takes due keys under its lease and records the backlog", async () => {
    const s = setup();
    await s.launch();
    await getPool().query(
      "UPDATE gpu_key_fences SET next_reconcile_at = NULL WHERE credential_id = $1",
      [s.credential_id],
    );
    const result = await runReconcileSweep({
      ...s.rdeps,
      // every due key in this shared database reads through the fake
      getReconcile: async (account_id: string) =>
        account_id === s.account_id ? (s.reconcile as any) : undefined,
    });
    expect(result.ran).toBe(true);
    expect((await fence(s.credential_id)).reconcile_attempts).toBe(0);
    const { rows } = await getPool().query(
      "SELECT holder, last_stats FROM gpu_worker_leases WHERE name = 'reconciler'",
    );
    expect(rows[0].holder).toBeNull();
    expect(rows[0].last_stats).toEqual(
      expect.objectContaining({
        due_keys: expect.any(Number),
        keys: expect.any(Number),
      }),
    );
  });

  it("a quarantined pod that shows up is live and managed again: its holds active (not settled), nothing terminated", async () => {
    const s = setup();
    let handle = "";
    s.client.createPod.mockImplementationOnce(async (body: any) => {
      handle = body.name;
      throw new RunpodApiError("provider", 503);
    });
    const pod = await s.launch();
    s.advance(AMBIGUOUS_WINDOW_MS + 5 * MINUTE);
    await listManagedGpuPodsLocal(
      { key_use: testKeyUse("pod_read"), account_id: s.account_id },
      s.deps,
    );
    expect((await row(pod.id)).state).toBe("failed");
    s.pods.set("pod_late77", { id: "pod_late77", name: handle, cost: 0.5 });
    await s.pass();
    expect(await row(pod.id)).toEqual(
      expect.objectContaining({
        state: "running",
        provider_pod_id: "pod_late77",
      }),
    );
    const { rows } = await getPool().query(
      "SELECT state FROM gpu_pod_reservations WHERE pod_id = $1",
      [pod.id],
    );
    expect(rows.map((r: any) => r.state)).toEqual(["active"]);
    // its hold alert ended; nothing else was raised, nothing terminated
    expect(
      (await alerts(s.credential_id)).map((a: any) => [a.kind, a.resolved_by]),
    ).toEqual([["quarantined_reservation", "pod_seen"]]);
    expect(s.client.terminatePod).not.toHaveBeenCalled();
    expect((await fence(s.credential_id)).paused_reason).toBeNull();
  });

  it("a release covers every layer of the pod at once, with one event", async () => {
    const s = setup();
    let handle = "";
    s.client.createPod.mockImplementationOnce(async (body: any) => {
      handle = body.name;
      throw new RunpodApiError("provider", 503);
    });
    // a project layer under the key's (as later steps create)
    const { rows: key } = await getPool().query(
      "SELECT id FROM gpu_budget_layers WHERE credential_id = $1 AND scope_kind = 'key'",
      [s.credential_id],
    );
    if (!key[0]) await s.launch(); // makes the key layer
    const keyLayer = (
      await getPool().query(
        "SELECT id FROM gpu_budget_layers WHERE credential_id = $1 AND scope_kind = 'key'",
        [s.credential_id],
      )
    ).rows[0].id;
    await getPool().query(
      `INSERT INTO gpu_budget_layers (id, credential_id, key_owner_account_id, scope_kind, parent_id, parent_scope_kind, project_id, authorized_usd, state, starts_at, ends_at, created, updated)
       SELECT $1, credential_id, key_owner_account_id, 'project', id, 'key', $2, 50, state, starts_at, ends_at, now(), now()
         FROM gpu_budget_layers WHERE id = $3`,
      [randomUUID(), PROJECT, keyLayer],
    );
    s.client.createPod.mockImplementationOnce(async (body: any) => {
      handle = body.name;
      throw new RunpodApiError("provider", 503);
    });
    const pod = await s.launch();
    s.advance(AMBIGUOUS_WINDOW_MS + 5 * MINUTE);
    await listManagedGpuPodsLocal(
      { key_use: testKeyUse("pod_read"), account_id: s.account_id },
      s.deps,
    );
    const held = async () =>
      (
        await getPool().query(
          "SELECT l.scope_kind, r.state FROM gpu_pod_reservations r JOIN gpu_budget_layers l ON l.id = r.layer_id WHERE r.pod_id = $1 ORDER BY l.scope_kind",
          [pod.id],
        )
      ).rows.map((r: any) => `${r.scope_kind}:${r.state}`);
    expect(await held()).toEqual(["key:quarantined", "project:quarantined"]);
    await releaseQuarantinedLocal(
      { account_id: s.account_id, pod_id: pod.id, fresh_auth_verified: true },
      s.deps,
    );
    expect(await held()).toEqual(["key:settled", "project:settled"]);
    const { rows: ev } = await getPool().query(
      "SELECT 1 FROM gpu_pod_events WHERE pod_id = $1 AND action = 'quarantine_released'",
      [pod.id],
    );
    expect(ev.length).toBe(1);
    // seen after all: held again on every layer
    s.pods.set("pod_late88", { id: "pod_late88", name: handle, cost: 0.5 });
    s.advance(11 * MINUTE);
    await s.pass();
    expect(await held()).toEqual(["key:active", "project:active"]);
  });

  it("403 is a rejected key too; only a complete pass resolves it, not a passing getPod", async () => {
    const s = setup();
    const pod = await s.launch();
    s.reconcile.listPods.mockRejectedValueOnce(
      new RunpodApiError("forbidden", 403),
    );
    expect(await s.pass()).toEqual({ claimed: true, rejected: true });
    // a pass whose getPod answers but which doesn't complete
    const provider_id = (await row(pod.id)).provider_pod_id;
    s.pods.delete(provider_id);
    s.byId.set(provider_id, { id: provider_id });
    s.advance(3 * MINUTE);
    s.reconcile.getPod.mockImplementationOnce(async (id: string) => {
      s.advance(RECONCILE_KEY_PASS_MS + 1);
      return { id };
    });
    expect(await s.pass()).toEqual({ claimed: true, cut: true });
    expect((await alerts(s.credential_id))[0].resolved_at).toBeNull();
    s.advance(30 * MINUTE);
    expect((await s.pass()).complete).toBe(true);
    expect((await alerts(s.credential_id))[0].resolved_by).toBe(
      "complete_inventory",
    );
  });

  it("resolving one alert keeps the pause; only resume lifts it", async () => {
    const s = setup();
    await s.launch();
    s.pods.set("pod_odd1", { id: "pod_odd1" });
    s.pods.set("pod_odd2", { id: "pod_odd2" });
    await s.pass();
    s.pods.delete("pod_odd1");
    s.byId.set("pod_odd1", undefined);
    s.advance(11 * MINUTE);
    await s.pass();
    const open = (await alerts(s.credential_id)).filter(
      (a: any) => a.resolved_at == null,
    );
    expect(open.map((a: any) => a.dedupe_key)).toEqual(["pod_odd2"]);
    expect((await fence(s.credential_id)).paused_reason).toBe("unknown_pod");
  });

  it("an idle key is swept again and again and stays launchable; a compromised key is never swept", async () => {
    const s = setup();
    await s.launch();
    // only this test's keys are due
    await getPool().query(
      "UPDATE gpu_key_fences SET next_reconcile_at = now() + interval '10 years' WHERE credential_id <> $1",
      [s.credential_id],
    );
    // idle: no pods at RunPod (the launched one is gone; its 404 ends it)
    s.pods.clear();
    await getPool().query(
      "UPDATE gpu_key_fences SET next_reconcile_at = NULL, last_inventory_at = NULL WHERE credential_id = $1",
      [s.credential_id],
    );
    const sweep = () =>
      runReconcileSweep({
        ...s.rdeps,
        getReconcile: async () => s.reconcile as any,
      });
    for (let i = 0; i < 3; i++) {
      await sweep();
      const f = await fence(s.credential_id);
      expect(new Date(f.last_inventory_at).getTime()).toBe(s.now());
      s.advance(10 * MINUTE + 1);
    }
    expect((await s.launch()).state).toBe("running");
    // compromised: no claim, no watermark, no action
    await getPool().query(
      "UPDATE gpu_key_fences SET state = 'compromised', next_reconcile_at = NULL WHERE credential_id = $1",
      [s.credential_id],
    );
    const before = await fence(s.credential_id);
    s.reconcile.listPods.mockClear();
    s.advance(11 * MINUTE);
    await sweep();
    expect(s.reconcile.listPods).not.toHaveBeenCalled();
    expect(await fence(s.credential_id)).toEqual(before);
    expect(
      await reconcileKey(
        {
          credential_id: s.credential_id,
          key_owner_account_id: s.account_id,
          deadline: s.now() + RECONCILE_KEY_PASS_MS,
        },
        s.rdeps,
      ),
    ).toEqual({ claimed: false });
  });

  it("keys that always fail can't starve a healthy one: they back off, the oldest go first, and the backlog shows", async () => {
    const healthy = setup();
    await healthy.launch();
    // ten failing keys, older (never inventoried) than the healthy one
    const failing: string[] = [];
    for (let i = 0; i < 10; i++) {
      const f = setup();
      await f.launch();
      failing.push(f.credential_id);
    }
    await getPool().query(
      "UPDATE gpu_key_fences SET next_reconcile_at = now() + interval '10 years'",
    );
    await getPool().query(
      // connected an hour ago, never inventoried since
      "UPDATE gpu_key_fences SET next_reconcile_at = NULL, last_inventory_at = NULL, created = now() - interval '1 hour' WHERE credential_id = ANY($1)",
      [failing],
    );
    await getPool().query(
      "UPDATE gpu_key_fences SET next_reconcile_at = NULL, last_inventory_at = now() - interval '1 hour' WHERE credential_id = $1",
      [healthy.credential_id],
    );
    // one key at a time, each pass taking 20 s of a 90 s sweep: 4 keys a sweep
    let clock = healthy.now();
    const order: string[] = [];
    const deps = {
      now: () => clock,
      concurrency: 1,
      getReconcile: async (account_id: string) => {
        clock += 20_000;
        if (account_id === healthy.account_id) {
          order.push("healthy");
          return healthy.reconcile as any;
        }
        order.push("failing");
        throw Error("RunPod is down for this key");
      },
    };
    const sweeps: any[] = [];
    for (let i = 0; i < 4; i++) {
      sweeps.push(await runReconcileSweep(deps));
      if (order.includes("healthy")) break;
    }
    // the never-inventoried go first, then the healthy key, within 3 sweeps
    expect(order.slice(0, 10)).toEqual(Array(10).fill("failing"));
    expect(order[10]).toBe("healthy");
    expect(sweeps.length).toBeLessThanOrEqual(3);
    // the failing keys backed off: each is due again only after its backoff
    const { rows: backoff } = await getPool().query(
      `SELECT reconcile_attempts,
              EXTRACT(EPOCH FROM (next_reconcile_at - last_reconcile_attempt_at)) AS wait_s
         FROM gpu_key_fences WHERE credential_id = ANY($1)`,
      [failing],
    );
    for (const b of backoff) {
      expect(b.reconcile_attempts).toBeGreaterThanOrEqual(1);
      expect(Number(b.wait_s)).toBeGreaterThanOrEqual(120);
    }
    const { rows } = await getPool().query(
      "SELECT last_stats FROM gpu_worker_leases WHERE name = 'reconciler'",
    );
    expect(rows[0].last_stats).toEqual(
      expect.objectContaining({ backlog: true }),
    );
  });

  it("a pass that can't finish in its time records nothing complete, and ends in time", async () => {
    const s = setup();
    await s.launch();
    await getPool().query(
      "UPDATE gpu_key_fences SET last_inventory_at = NULL WHERE credential_id = $1",
      [s.credential_id],
    );
    // RunPod never answers; the client gives up on the call (its timeout)
    s.reconcile.listPods.mockImplementationOnce(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new RunpodApiError("network")), 200),
        ),
    );
    const started = Date.now();
    const outcome = await reconcileKey(
      {
        credential_id: s.credential_id,
        key_owner_account_id: s.account_id,
        deadline: Date.now() + 100,
      },
      { getReconcile: async () => s.reconcile as any },
    );
    // cut at the pass's time, before RunPod's own failure arrives
    expect(outcome).toEqual({ claimed: true, cut: true });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await fence(s.credential_id)).last_inventory_at).toBeNull();
    await expect(s.launch()).rejects.toThrow(/waiting for CoCalc to check/);
  });

  it("an unknown pod on an early page is acted on even if a later page never comes: alert and pause, no complete inventory", async () => {
    const s = setup();
    await s.launch();
    await getPool().query(
      "UPDATE gpu_key_fences SET last_inventory_at = NULL WHERE credential_id = $1",
      [s.credential_id],
    );
    s.reconcile.listPods.mockImplementationOnce(async (opts: any) => {
      await opts.beforePage?.();
      await opts.onPage?.([{ id: "pod_page1x", name: "miner" }]);
      // page 2 hangs until the pass's time is up
      s.advance(RECONCILE_KEY_PASS_MS + 1);
      await opts.beforePage?.();
      return [];
    });
    expect(await s.pass()).toEqual({ claimed: true, cut: true });
    expect(await alerts(s.credential_id)).toEqual([
      expect.objectContaining({
        kind: "unknown_pod",
        dedupe_key: "pod_page1x",
      }),
    ]);
    const f = await fence(s.credential_id);
    expect(f.paused_reason).toBe("unknown_pod");
    expect(f.last_inventory_at).toBeNull();
  });

  it("after a resume, an unknown pod the listing omits but RunPod still has pauses again", async () => {
    const s = setup();
    await s.launch();
    s.pods.set("pod_hidden1", { id: "pod_hidden1", name: "x" });
    await s.pass();
    await resumeGpuLaunchesLocal(
      { account_id: s.account_id, fresh_auth_verified: true },
      { accountWriteFence: s.deps.accountWriteFence } as any,
    );
    expect((await fence(s.credential_id)).paused_reason).toBeNull();
    // the listing shifts past it, but it is there by id
    s.pods.delete("pod_hidden1");
    s.byId.set("pod_hidden1", { id: "pod_hidden1", name: "x" });
    s.advance(11 * MINUTE);
    expect((await s.pass()).complete).toBe(true);
    expect((await fence(s.credential_id)).paused_reason).toBe("unknown_pod");
    const [a] = await alerts(s.credential_id);
    expect(a.resolved_at).toBeNull();
  });

  it("a flooded inventory can't outlast the pass: past its time each pod's action stops, and nothing is complete", async () => {
    const s = setup();
    await s.launch();
    await getPool().query(
      "UPDATE gpu_key_fences SET last_inventory_at = NULL WHERE credential_id = $1",
      [s.credential_id],
    );
    const flood = Array.from({ length: 40 }, (_, i) => ({
      id: `pod_flood${String(i).padStart(3, "0")}`,
      name: `f${i}`,
    }));
    s.reconcile.listPods.mockImplementationOnce(async (opts: any) => {
      await opts.beforePage?.();
      await opts.onPage?.(flood);
      return flood;
    });
    // every guarded step takes a second of the pass's 30
    const outcome = await s.pass({
      guard: async () => {
        s.advance(1000);
      },
    });
    expect(outcome).toEqual({ claimed: true, cut: true });
    const n = (await alerts(s.credential_id)).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(40);
    expect((await fence(s.credential_id)).last_inventory_at).toBeNull();
  });

  it("a pass whose lease is lost stops at its next step and marks nothing complete", async () => {
    const s = setup();
    await s.launch();
    await getPool().query(
      "UPDATE gpu_key_fences SET last_inventory_at = NULL WHERE credential_id = $1",
      [s.credential_id],
    );
    const flood = Array.from({ length: 10 }, (_, i) => ({
      id: `pod_lease${String(i).padStart(3, "0")}`,
      name: `l${i}`,
    }));
    s.reconcile.listPods.mockImplementationOnce(async (opts: any) => {
      await opts.beforePage?.();
      await opts.onPage?.(flood);
      return flood;
    });
    let steps = 0;
    await expect(
      s.pass({
        guard: async () => {
          if (++steps > 4) throw Error("the reconciler lease was lost");
        },
      }),
    ).rejects.toThrow("lease was lost");
    expect((await alerts(s.credential_id)).length).toBeLessThan(10);
    expect((await fence(s.credential_id)).last_inventory_at).toBeNull();
  });

  it("a RunPod call still unanswered when the pass's time runs out cuts the pass then, not when RunPod gives up", async () => {
    const s = setup();
    const pod = await s.launch();
    await getPool().query(
      "UPDATE gpu_key_fences SET last_inventory_at = NULL WHERE credential_id = $1",
      [s.credential_id],
    );
    const never = () => new Promise<never>(() => {});
    const run = (deadlineMs: number) =>
      reconcileKey(
        {
          credential_id: s.credential_id,
          key_owner_account_id: s.account_id,
          // the pass's clock is the real one here, so its time is real
          deadline: Date.now() + deadlineMs,
        },
        { getReconcile: async () => s.reconcile as any },
      );
    // a listing that never answers
    s.reconcile.listPods.mockImplementationOnce(never);
    let started = Date.now();
    expect(await run(300)).toEqual({ claimed: true, cut: true });
    expect(Date.now() - started).toBeLessThan(2_000);
    // a by-id check that never answers, started near the end: the listing
    // takes 400 ms of a 600 ms pass, so the check gets the 200 ms left (a
    // fresh window per call would run to about 1 s)
    s.reconcile.listPods.mockImplementationOnce(async (opts: any) => {
      await opts.beforePage?.();
      await new Promise((r) => setTimeout(r, 400));
      await opts.onPage?.([]);
      return [];
    });
    s.reconcile.getPod.mockImplementationOnce(never);
    started = Date.now();
    expect(await run(600)).toEqual({ claimed: true, cut: true });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(550);
    expect(took).toBeLessThan(850);
    expect(s.reconcile.getPod).toHaveBeenCalledWith(
      (await row(pod.id)).provider_pod_id,
    );
    expect((await row(pod.id)).state).toBe("running");
    expect((await fence(s.credential_id)).last_inventory_at).toBeNull();
  });
});
