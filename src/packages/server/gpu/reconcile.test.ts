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
import { launchGpuPodLocal } from "./pods";
import {
  reconcileKey,
  runReconcileSweep,
  RECONCILE_KEY_PASS_MS,
} from "./reconcile";
import { INVENTORY_STALE_MS } from "./budgets";
import { freshInventoryForTests } from "./test-inventory";
import { allowStaleWorkersLocal } from "./admin";

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
    listPods: jest.fn(async (opts: any = {}) => {
      await opts.beforePage?.();
      return [...pods.values()];
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
      launchGpuPodLocal({ account_id, project_id: PROJECT, spec: SPEC }, deps),
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
      gpu_pod_events: SCHEMA.gpu_pod_events,
      gpu_pod_reservations: SCHEMA.gpu_pod_reservations,
      gpu_worker_leases: SCHEMA.gpu_worker_leases,
      gpu_worker_overrides: SCHEMA.gpu_worker_overrides,
      gpu_alerts: SCHEMA.gpu_alerts,
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
    await expect(s.launch()).rejects.toThrow(/paused until an alert/);
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
    expect(ev.map((e: any) => e.details?.state ?? e.action)).toEqual([
      "terminate",
      "terminating",
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
});
