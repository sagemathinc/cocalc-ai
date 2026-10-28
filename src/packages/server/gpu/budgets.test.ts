/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// GPU budgets through launch and terminate, against a real (PGlite)
// database and a fake RunPod: admission, reservations, settlement (with the
// overrun case), release, quarantine, bind re-reservation and the key fence.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { RunpodApiError } from "@cocalc/cloud/runpod/client";
import { GPU_LAUNCH_IMAGES } from "@cocalc/util/gpu/launch-spec";
import { lockGpuAccountFence } from "./account-fence";
import { toDecimal } from "@cocalc/util/money";
import {
  AMBIGUOUS_WINDOW_MS,
  launchGpuPodLocal,
  listManagedGpuPodsLocal,
  terminateGpuPodLocal,
} from "./pods";
import { DEFAULT_KEY_LAYER } from "./budgets";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const PROJECT = "00000000-1000-4000-8000-0000000000aa";
const SPEC = {
  gpu_type_id: "NVIDIA GeForce RTX 4090",
  image: GPU_LAUNCH_IMAGES[0],
  max_runtime_minutes: 60,
};
// $0.50 per GPU-hour list price; RunPod bills each pod at `cost` per hour.
const LIST_PRICE = 0.5;

function fakeRunpod(cost = 0.5) {
  const pods = new Map<string, any>();
  const client = {
    createPod: jest.fn(async (body: any) => {
      const pod = {
        id: `pod_${randomUUID().slice(0, 8)}`,
        name: body.name,
        status: "PROVISIONING",
        cost,
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
  return { client, pods };
}

function setup({ cost = 0.5 }: { cost?: number } = {}) {
  const account_id = randomUUID();
  const credential_id = randomUUID();
  const rp = fakeRunpod(cost);
  const deps = {
    isHomeBay: async () => true,
    isProjectCollaborator: async () => true,
    getLaunchAccess: async () => ({ client: rp.client as any, credential_id }),
    getCleanup: async () => ({ ...rp.client, credential_id }) as any,
    listPrice: async () => LIST_PRICE,
    // the real fence, on the account row it needs (same transaction)
    accountWriteFence: async (db: any, id: string, action: string) => {
      await db.query(
        "INSERT INTO accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [id],
      );
      await lockGpuAccountFence(db, id, action);
    },
  };
  const launch = (spec: object = {}) =>
    launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: { ...SPEC, ...spec } },
      deps,
    );
  return { account_id, credential_id, rp, deps, launch };
}

async function keyLayer(credential_id: string) {
  const { rows } = await getPool().query(
    "SELECT * FROM gpu_budget_layers WHERE credential_id = $1 AND scope_kind = 'key'",
    [credential_id],
  );
  return rows[0];
}

async function reservations(pod_id: string) {
  const { rows } = await getPool().query(
    "SELECT * FROM gpu_pod_reservations WHERE pod_id = $1",
    [pod_id],
  );
  return rows;
}

const n = (v: unknown) => toDecimal(`${v ?? 0}`).toNumber();

describeDb("GPU budgets", () => {
  beforeAll(async () => {
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS accounts (account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN)",
    );
    await syncSchema({
      gpu_key_fences: SCHEMA.gpu_key_fences,
      gpu_budget_layers: SCHEMA.gpu_budget_layers,
      gpu_budget_events: SCHEMA.gpu_budget_events,
      gpu_pods: SCHEMA.gpu_pods,
      gpu_pod_events: SCHEMA.gpu_pod_events,
      gpu_pod_reservations: SCHEMA.gpu_pod_reservations,
    });
  });

  it("gives a new key the default budget and reserves list price x GPUs x runtime", async () => {
    const { credential_id, launch } = setup();
    const pod = await launch({ gpu_count: 2 });
    const layer = await keyLayer(credential_id);
    expect(n(layer.authorized_usd)).toBe(
      Number(DEFAULT_KEY_LAYER.authorized_usd),
    );
    // $0.50 x 2 GPUs x 1 h
    expect(n(layer.reserved_usd)).toBe(1);
    const [r] = await reservations(pod.id);
    expect(r).toEqual(
      expect.objectContaining({ state: "active", gpu_count: 2, pod_slots: 1 }),
    );
    expect(n(r.reserved_usd)).toBe(1);
  });

  it("refuses a launch over any cap and writes nothing for it", async () => {
    const { account_id, credential_id, rp, deps, launch } = setup();
    await launch();
    await launch();
    // the default allows 2 pods at once
    await expect(launch()).rejects.toThrow("at most 2 pods at once");
    // more GPUs than allowed, a runtime past the cap, and money
    await getPool().query(
      "UPDATE gpu_budget_layers SET max_concurrent_pods = 10 WHERE credential_id = $1",
      [credential_id],
    );
    await expect(launch({ gpu_count: 3 })).rejects.toThrow("at most 4 GPUs");
    await expect(launch({ max_runtime_minutes: 600 })).rejects.toThrow(
      "at most 480 minutes",
    );
    await getPool().query(
      "UPDATE gpu_budget_layers SET authorized_usd = 1.2 WHERE credential_id = $1",
      [credential_id],
    );
    await expect(launch()).rejects.toThrow(
      /needs up to \$0\.50 .* has \$0\.20 left/,
    );
    expect(rp.client.createPod).toHaveBeenCalledTimes(2);
    const pods = await listManagedGpuPodsLocal(
      { account_id, include_ended: true },
      deps,
    );
    expect(pods).toHaveLength(2);
  });

  it("settles a pod that ran: spent is what it cost, the rest returns", async () => {
    const { account_id, credential_id, launch, deps } = setup();
    const pod = await launch();
    // ran for 30 minutes at $0.50/h
    await getPool().query(
      "UPDATE gpu_pods SET running_since = now() - interval '30 minutes' WHERE id = $1",
      [pod.id],
    );
    await terminateGpuPodLocal({ account_id, pod_id: pod.handle }, deps);
    const layer = await keyLayer(credential_id);
    expect(n(layer.reserved_usd)).toBe(0);
    expect(n(layer.spent_usd)).toBeCloseTo(0.25, 3);
    // released stays retired-capacity only
    expect(n(layer.released_usd)).toBe(0);
    const [r] = await reservations(pod.id);
    expect(r.state).toBe("settled");
    expect(n(r.spent_usd)).toBeCloseTo(0.25, 3);
    expect(n(r.released_usd)).toBeCloseTo(0.25, 3);
    expect(n(r.overrun_usd)).toBe(0);
    // spent = estimate - released + overrun
    expect(n(r.spent_usd)).toBeCloseTo(
      n(r.reserved_usd) - n(r.released_usd) + n(r.overrun_usd),
      9,
    );
  });

  it("settles a pod RunPod reported no cost for at the reserved list rate, never at zero", async () => {
    const { account_id, credential_id, launch, deps } = setup({
      cost: null as any,
    });
    const pod = await launch();
    await getPool().query(
      "UPDATE gpu_pods SET running_since = now() - interval '30 minutes' WHERE id = $1",
      [pod.id],
    );
    await terminateGpuPodLocal({ account_id, pod_id: pod.handle }, deps);
    // 30 minutes at the reserved $0.50/h
    expect(n((await keyLayer(credential_id)).spent_usd)).toBeCloseTo(0.25, 3);
  });

  it("counts a late-bound pod's runtime from RunPod's start, not from the bind", async () => {
    const { account_id, credential_id, rp, launch, deps } = setup();
    // the create is unclear (the pod was made), and the first lookup by
    // name doesn't see it yet
    rp.client.createPod.mockImplementationOnce(async (body: any) => {
      const pod = {
        id: `pod_${randomUUID().slice(0, 8)}`,
        name: body.name,
        cost: 0.5,
        startedAt: new Date().toISOString(),
      };
      rp.pods.set(pod.id, pod);
      throw Error("socket hang up");
    });
    rp.client.findPodsByName.mockImplementationOnce(async () => []);
    const pending = await launch();
    expect(pending.state).toBe("ambiguous");
    // RunPod started it 12 minutes ago; it is found only now
    await getPool().query(
      "UPDATE gpu_pods SET created = now() - interval '13 minutes' WHERE id = $1",
      [pending.id],
    );
    const started = Date.now() - 12 * 60_000;
    for (const p of rp.pods.values()) {
      p.startedAt = new Date(started).toISOString();
    }
    await listManagedGpuPodsLocal({ account_id }, deps);
    const { rows } = await getPool().query(
      "SELECT state, running_since FROM gpu_pods WHERE id = $1",
      [pending.id],
    );
    expect(rows[0].state).toBe("running");
    expect(
      Math.abs(new Date(rows[0].running_since).getTime() - started),
    ).toBeLessThan(2000);
    await terminateGpuPodLocal({ account_id, pod_id: pending.handle }, deps);
    // 12 minutes at $0.50/h
    expect(n((await keyLayer(credential_id)).spent_usd)).toBeCloseTo(0.1, 3);
  });

  it("records an overrun in full and then refuses new launches", async () => {
    const { account_id, credential_id, launch, deps } = setup();
    const pod = await launch();
    await getPool().query(
      "UPDATE gpu_budget_layers SET authorized_usd = 1 WHERE credential_id = $1",
      [credential_id],
    );
    // ran 3 hours of a 1-hour reservation ($0.50 estimate, $1.50 actual)
    await getPool().query(
      "UPDATE gpu_pods SET running_since = now() - interval '3 hours' WHERE id = $1",
      [pod.id],
    );
    await terminateGpuPodLocal({ account_id, pod_id: pod.handle }, deps);
    const layer = await keyLayer(credential_id);
    // factual: more than authorized, recorded anyway
    expect(n(layer.spent_usd)).toBeCloseTo(1.5, 3);
    expect(n(layer.reserved_usd)).toBe(0);
    const [r] = await reservations(pod.id);
    expect(n(r.released_usd)).toBe(0);
    expect(n(r.overrun_usd)).toBeCloseTo(1, 3);
    expect(n(r.spent_usd)).toBeCloseTo(
      n(r.reserved_usd) - n(r.released_usd) + n(r.overrun_usd),
      9,
    );
    await expect(launch()).rejects.toThrow("has $0.00 left");
  });

  it("releases everything for a definite refusal", async () => {
    const { credential_id, rp, launch } = setup();
    rp.client.createPod.mockRejectedValueOnce(
      new RunpodApiError("invalid", 400),
    );
    await expect(launch()).rejects.toThrow("couldn't place this pod");
    const layer = await keyLayer(credential_id);
    expect(n(layer.reserved_usd)).toBe(0);
    expect(n(layer.spent_usd)).toBe(0);
    const { rows } = await getPool().query(
      "SELECT r.* FROM gpu_pod_reservations r JOIN gpu_pods p ON p.id = r.pod_id WHERE p.credential_id = $1",
      [credential_id],
    );
    expect(
      rows.map((r) => [r.state, n(r.spent_usd), n(r.released_usd)]),
    ).toEqual([["settled", 0, 0.5]]);
  });

  it("quarantines the reservation when an unclear create is given up", async () => {
    const { account_id, credential_id, rp, launch, deps } = setup();
    rp.client.createPod.mockRejectedValueOnce(new RunpodApiError("network"));
    const pod = await launch();
    expect(pod.state).toBe("ambiguous");
    const later = { ...deps, now: () => Date.now() + AMBIGUOUS_WINDOW_MS + 1 };
    await listManagedGpuPodsLocal({ account_id }, later);
    const [r] = await reservations(pod.id);
    expect(r.state).toBe("quarantined");
    // still held: a late, charging pod may show up
    expect(n((await keyLayer(credential_id)).reserved_usd)).toBe(0.5);
  });

  it("re-reserves at RunPod's real price, or terminates the pod if that doesn't fit", async () => {
    // billed $0.80/h against a $0.50/h list price
    const a = setup({ cost: 0.8 });
    const pod = await a.launch();
    expect(pod.state).toBe("running");
    const [r] = await reservations(pod.id);
    expect(n(r.hourly_usd)).toBe(0.8);
    expect(n((await keyLayer(a.credential_id)).reserved_usd)).toBe(0.8);

    const b = setup({ cost: 0.8 });
    await b.launch(); // creates the layer
    await getPool().query(
      "UPDATE gpu_budget_layers SET max_hourly_usd = 1.4 WHERE credential_id = $1",
      [b.credential_id],
    );
    // admitted at list price (0.8 held + 0.5 <= $1.40/h), but RunPod's real
    // price (0.8 + 0.8) doesn't fit
    const second = await b.launch();
    expect(second.state).toBe("terminated");
    expect(second.reason).toMatch(/more than your GPU budget allows/);
    expect(b.rp.client.terminatePod).toHaveBeenCalledWith(
      second.provider_pod_id,
    );
  });

  it("holds an over-price pod at its real price until its termination is confirmed", async () => {
    const b = setup({ cost: 0.8 });
    await b.launch();
    await getPool().query(
      "UPDATE gpu_budget_layers SET max_hourly_usd = 1.4 WHERE credential_id = $1",
      [b.credential_id],
    );
    // the second pod doesn't fit at RunPod's price, and its terminate fails
    b.rp.client.terminatePod.mockRejectedValueOnce(Error("RunPod is down"));
    const second = await b.launch();
    expect(second.desired_state).toBe("terminated");
    expect(b.rp.pods.has(second.provider_pod_id!)).toBe(true);
    const [r] = await reservations(second.id);
    expect(n(r.hourly_usd)).toBe(0.8);
    // even with more room per hour, the live pod's real price counts:
    // 0.8 + 0.8 + 0.5 > $2/h
    await getPool().query(
      "UPDATE gpu_budget_layers SET max_hourly_usd = 2 WHERE credential_id = $1",
      [b.credential_id],
    );
    await expect(b.launch()).rejects.toThrow(/at most \$2\.00\/h/);
  });

  it("launches nothing while the key's fence isn't active or is paused", async () => {
    const { credential_id, launch, rp } = setup();
    await launch(); // makes the fence
    await getPool().query(
      "UPDATE gpu_key_fences SET state = 'draining' WHERE credential_id = $1",
      [credential_id],
    );
    await expect(launch()).rejects.toThrow("being removed");
    await getPool().query(
      "UPDATE gpu_key_fences SET state = 'active', paused_reason = 'unknown_pod' WHERE credential_id = $1",
      [credential_id],
    );
    await expect(launch()).rejects.toThrow("paused");
    expect(rp.client.createPod).toHaveBeenCalledTimes(1);
  });

  it("holds the reservation when the server dies after it, and releases it once the intent is known never sent", async () => {
    const { account_id, credential_id, launch, deps } = setup();
    const pod = await launch();
    // as if the server died right after the intent committed
    await getPool().query(
      "UPDATE gpu_pods SET state = 'intent', provider_pod_id = NULL, updated = now() - interval '1 hour' WHERE id = $1",
      [pod.id],
    );
    await getPool().query(
      "UPDATE gpu_pod_reservations SET state = 'active' WHERE pod_id = $1",
      [pod.id],
    );
    expect(n((await keyLayer(credential_id)).reserved_usd)).toBe(0.5);
    await listManagedGpuPodsLocal({ account_id }, deps);
    const [r] = await reservations(pod.id);
    expect(r.state).toBe("settled");
    expect(n(r.spent_usd)).toBe(0);
    expect(n((await keyLayer(credential_id)).reserved_usd)).toBe(0);
  });
});
