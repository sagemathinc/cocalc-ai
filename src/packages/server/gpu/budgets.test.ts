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
  killSwitchLocal,
  resolvePendingForAccount,
} from "./pods";
import { DEFAULT_KEY_LAYER } from "./budgets";
import { resumeGpuLaunchesLocal } from "./budget-api";
import { deleteGpuProviderKeyLocal } from "./provider-keys";
import {
  continueCompromiseCleanups,
  reportCompromisedLocal,
  runCompromiseCleanup,
} from "./compromise";

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

// the stored key a fence belongs to (what the kill switch acts on)
async function storeKey(account_id: string, credential_id: string) {
  await getPool().query(
    "INSERT INTO external_credentials (id, provider, kind, scope, owner_account_id, encrypted_payload, created, updated) VALUES ($1, 'runpod', 'gpu-provider-api-key', 'account', $2, 'x', now(), now())",
    [credential_id, account_id],
  );
}

function setup({ cost = 0.5 }: { cost?: number } = {}) {
  const account_id = randomUUID();
  const credential_id = randomUUID();
  const stored = storeKey(account_id, credential_id);
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
  const launch = async (spec: object = {}) => {
    await stored;
    return await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: { ...SPEC, ...spec } },
      deps,
    );
  };
  return { account_id, credential_id, rp, deps, launch, stored };
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
      gpu_key_events: SCHEMA.gpu_key_events,
      gpu_budget_layers: SCHEMA.gpu_budget_layers,
      gpu_budget_events: SCHEMA.gpu_budget_events,
      gpu_pods: SCHEMA.gpu_pods,
      gpu_pod_events: SCHEMA.gpu_pod_events,
      gpu_pod_reservations: SCHEMA.gpu_pod_reservations,
      gpu_worker_leases: SCHEMA.gpu_worker_leases,
      gpu_worker_overrides: SCHEMA.gpu_worker_overrides,
      external_credentials: SCHEMA.external_credentials,
    });
    // the reaper has just completed a sweep (admission requires it)
    await getPool().query(
      "INSERT INTO gpu_worker_leases (name, last_completed_at) VALUES ('reaper', now() + interval '10 years') ON CONFLICT (name) DO UPDATE SET last_completed_at = EXCLUDED.last_completed_at",
    );
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

  describe("the kill switch", () => {
    it("pauses a key connected but never used yet", async () => {
      const s = setup();
      await s.stored; // connected; no fence or layer yet
      expect(
        (await killSwitchLocal({ account_id: s.account_id }, s.deps)).paused,
      ).toBe(true);
      await expect(s.launch()).rejects.toThrow("paused by your kill switch");
    });

    it("pauses and logs only the connected key, not a closed earlier one", async () => {
      const s = setup();
      await s.launch();
      const old = randomUUID();
      await getPool().query(
        "INSERT INTO gpu_key_fences (credential_id, key_owner_account_id, state, created, updated) VALUES ($1, $2, 'closed', now(), now())",
        [old, s.account_id],
      );
      await killSwitchLocal({ account_id: s.account_id }, s.deps);
      const { rows } = await getPool().query(
        "SELECT credential_id, kill_switch_at FROM gpu_key_fences WHERE key_owner_account_id = $1",
        [s.account_id],
      );
      const byId = Object.fromEntries(
        rows.map((r) => [r.credential_id, r.kill_switch_at]),
      );
      expect(byId[s.credential_id]).not.toBeNull();
      expect(byId[old]).toBeNull();
      const { rows: log } = await getPool().query(
        "SELECT count(*)::int AS n FROM gpu_key_events WHERE credential_id = $1",
        [old],
      );
      expect(log[0].n).toBe(0);
    });

    it("reports the persisted pause: --no-pause never lifts one, and no key means nothing paused", async () => {
      const s = setup();
      await s.launch();
      expect(
        (await killSwitchLocal({ account_id: s.account_id }, s.deps)).paused,
      ).toBe(true);
      expect(
        (
          await killSwitchLocal(
            { account_id: s.account_id, pause: false },
            s.deps,
          )
        ).paused,
      ).toBe(true);
      // no connected key (removed): nothing to pause
      const none = setup();
      await none.stored;
      await getPool().query(
        "UPDATE external_credentials SET revoked = now() WHERE id = $1",
        [none.credential_id],
      );
      expect(
        (await killSwitchLocal({ account_id: none.account_id }, none.deps))
          .paused,
      ).toBe(false);
    });

    it("terminates every live pod and pauses launches until a fresh-auth resume", async () => {
      const s = setup();
      const a = await s.launch();
      const b = await s.launch();
      const result = await killSwitchLocal(
        { account_id: s.account_id },
        s.deps,
      );
      expect(result).toEqual({ marked: 2, remaining: 0, paused: true });
      for (const pod of [a, b]) {
        expect(s.rp.pods.has(pod.provider_pod_id!)).toBe(false);
      }
      await expect(s.launch()).rejects.toThrow("paused by your kill switch");
      await expect(
        resumeGpuLaunchesLocal({ account_id: s.account_id }, s.deps as any),
      ).rejects.toThrow("sign in again");
      expect(
        await resumeGpuLaunchesLocal(
          { account_id: s.account_id, fresh_auth_verified: true },
          s.deps as any,
        ),
      ).toEqual({ resumed: 1 });
      expect((await s.launch()).state).toBe("running");
      // both recorded in the key's security log
      const { rows: log } = await getPool().query(
        "SELECT action, actor_kind FROM gpu_key_events WHERE credential_id = $1 ORDER BY at",
        [s.credential_id],
      );
      expect(log).toEqual([
        { action: "kill_switch", actor_kind: "user" },
        { action: "resumed", actor_kind: "user" },
      ]);
    });

    it("stops only one project's pods, never pausing the key", async () => {
      const s = setup();
      const other = "00000000-1000-4000-8000-0000000000bb";
      const here = await s.launch();
      const there = await launchGpuPodLocal(
        { account_id: s.account_id, project_id: other, spec: SPEC },
        s.deps,
      );
      expect(
        await killSwitchLocal(
          { account_id: s.account_id, project_id: PROJECT },
          s.deps,
        ),
      ).toEqual({ marked: 1, remaining: 0, paused: false });
      expect(s.rp.pods.has(here.provider_pod_id!)).toBe(false);
      expect(s.rp.pods.has(there.provider_pod_id!)).toBe(true);
      await expect(
        killSwitchLocal(
          { account_id: s.account_id, project_id: PROJECT, pause: true },
          s.deps,
        ),
      ).rejects.toThrow("whole key");
      // launches still work
      expect((await s.launch()).state).toBe("running");
    });

    it("leaves a safety pause alone, and retries what RunPod didn't confirm", async () => {
      const s = setup();
      const pod = await s.launch();
      await getPool().query(
        "UPDATE gpu_key_fences SET paused_reason = 'unknown_pod' WHERE credential_id = $1",
        [s.credential_id],
      );
      s.rp.client.terminatePod.mockRejectedValueOnce(
        new RunpodApiError("provider", 503),
      );
      expect(
        await killSwitchLocal({ account_id: s.account_id }, s.deps),
      ).toEqual({ marked: 1, remaining: 1, paused: true });
      // resume lifts the kill switch's pause only
      await resumeGpuLaunchesLocal(
        { account_id: s.account_id, fresh_auth_verified: true },
        s.deps as any,
      );
      const { rows } = await getPool().query(
        "SELECT paused_reason, kill_switch_at FROM gpu_key_fences WHERE credential_id = $1",
        [s.credential_id],
      );
      expect(rows[0]).toEqual({
        paused_reason: "unknown_pod",
        kill_switch_at: null,
      });
      // a second kill switch marks nothing new but retries the backed-off
      // terminate at once
      expect(
        await killSwitchLocal(
          { account_id: s.account_id, pause: false },
          s.deps,
        ),
      ).toEqual({ marked: 0, remaining: 0, paused: false });
    });
  });

  it("a forced key removal leaves a pod RunPod won't terminate unmanaged: quarantined, never claimed stopped", async () => {
    const s = setup();
    const pod = await s.launch();
    s.rp.client.terminatePod.mockRejectedValue(
      new RunpodApiError("provider", 503),
    );
    const removal = {
      isHomeBay: async () => true,
      storedKeyRejected: async () => false,
      drain: async () => {},
      drainMs: 0,
    };
    // without force, the key stays while the pod drains
    expect(
      await deleteGpuProviderKeyLocal(
        { account_id: s.account_id, provider: "runpod" },
        removal,
      ),
    ).toEqual({ revoked: false, remaining: [pod.handle] });
    const result = await deleteGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod", force: true },
      removal,
    );
    expect(result).toEqual(
      expect.objectContaining({ revoked: true, unmanaged: [pod.handle] }),
    );
    const { rows } = await getPool().query(
      "SELECT state, desired_state, unmanaged_at, terminated_at FROM gpu_pods WHERE id = $1",
      [pod.id],
    );
    expect(rows[0].state).toBe("running");
    expect(rows[0].unmanaged_at).not.toBeNull();
    expect(rows[0].terminated_at).toBeNull();
    const [r] = await reservations(pod.id);
    expect(r.state).toBe("quarantined");
    const { rows: fence } = await getPool().query(
      "SELECT state FROM gpu_key_fences WHERE credential_id = $1",
      [s.credential_id],
    );
    expect(fence[0].state).toBe("closed");
    const { rows: log } = await getPool().query(
      "SELECT action FROM gpu_key_events WHERE credential_id = $1 ORDER BY at",
      [s.credential_id],
    );
    expect(log.map((l) => l.action)).toEqual([
      "removal_started",
      "removal_started",
      "forced_removal",
    ]);
    // outside management: the kill switch neither marks nor counts it
    expect(await killSwitchLocal({ account_id: s.account_id }, s.deps)).toEqual(
      expect.objectContaining({ marked: 0, remaining: 0 }),
    );
  });

  describe("reporting a key compromised", () => {
    // a fake RunPod account whose listing is complete unless told to fail
    function account(s: ReturnType<typeof setup>) {
      let listFails = false;
      const cleanup = {
        ...s.rp.client,
        credential_id: s.credential_id,
        listPods: jest.fn(async () => {
          if (listFails) throw new RunpodApiError("provider", 503);
          return [...s.rp.pods.values()];
        }),
        // RunPod still accepts the key until the owner deletes it there
        getProviderIdentity: jest.fn(async () => ({
          kind: "personal",
          id: "user_1",
        })),
      };
      const deps = {
        getCleanup: async () => cleanup as any,
        resolvePending: (a: string, guard: () => Promise<void>) =>
          resolvePendingForAccount(
            a,
            {
              ...s.deps,
              getCleanup: async () => cleanup as any,
            },
            { guard },
          ),
      };
      return {
        cleanup,
        deps,
        failListing: (v: boolean) => (listFails = v),
      };
    }

    it("needs fresh auth and the CoCalc-only confirmation", async () => {
      const s = setup();
      await s.stored;
      const { deps } = account(s);
      await expect(
        reportCompromisedLocal(
          { account_id: s.account_id, confirm_cocalc_only: true },
          deps,
        ),
      ).rejects.toThrow("sign in again");
      await expect(
        reportCompromisedLocal(
          { account_id: s.account_id, fresh_auth_verified: true },
          deps,
        ),
      ).rejects.toThrow("used only for CoCalc");
    });

    it("blocks the key before asking RunPod, resumes after a failed listing, terminates pods CoCalc didn't start, and closes only on an empty account", async () => {
      const s = setup();
      const pod = await s.launch();
      const a = account(s);
      s.rp.pods.set("pod_miner1", { id: "pod_miner1", name: "miner\u0000x" });
      // the first pass can't list the account
      a.failListing(true);
      expect(
        await reportCompromisedLocal(
          {
            account_id: s.account_id,
            confirm_cocalc_only: true,
            fresh_auth_verified: true,
          },
          a.deps,
        ),
      ).toEqual({ closed: false, listing_failed: true });
      const fence = async () =>
        (
          await getPool().query(
            "SELECT state FROM gpu_key_fences WHERE credential_id = $1",
            [s.credential_id],
          )
        ).rows[0].state;
      expect(await fence()).toBe("compromised");
      // no launches, and no removal without force, meanwhile
      await expect(s.launch()).rejects.toThrow("reported compromised");
      await expect(
        deleteGpuProviderKeyLocal(
          { account_id: s.account_id, provider: "runpod" },
          { isHomeBay: async () => true },
        ),
      ).rejects.toThrow("still cleaning up");
      // the next pass lists the account: CoCalc's pod and the unknown one go
      a.failListing(false);
      const second = await runCompromiseCleanup(
        s.account_id,
        s.credential_id,
        a.deps,
      );
      expect(second.closed).toBe(false); // they were still listed
      expect(s.rp.pods.size).toBe(0);
      expect(
        (
          await getPool().query("SELECT state FROM gpu_pods WHERE id = $1", [
            pod.id,
          ])
        ).rows[0].state,
      ).toBe("terminated");
      // an empty account, but RunPod still accepts the key: CoCalc keeps its
      // copy (its only way to see and stop a thief's pods) and keeps going
      expect(
        await runCompromiseCleanup(s.account_id, s.credential_id, a.deps),
      ).toEqual({
        closed: false,
        awaiting_provider_revocation: true,
        provider_pods: 0,
        managed_pods: 0,
      });
      expect(await fence()).toBe("compromised");
      // a pod the thief starts meanwhile is terminated on the next pass
      s.rp.pods.set("pod_miner2", { id: "pod_miner2", name: "miner2" });
      await runCompromiseCleanup(s.account_id, s.credential_id, a.deps);
      expect(s.rp.pods.size).toBe(0);
      // the owner deleted the key at RunPod: now closed, CoCalc's copy revoked
      a.cleanup.getProviderIdentity.mockRejectedValue(
        new RunpodApiError("auth", 401),
      );
      expect(
        await runCompromiseCleanup(s.account_id, s.credential_id, a.deps),
      ).toEqual({ closed: true, provider_pods: 0, managed_pods: 0 });
      expect(await fence()).toBe("closed");
      const { rows: cred } = await getPool().query(
        "SELECT revoked IS NOT NULL AS revoked, encrypted_payload IS NULL AS nulled FROM external_credentials WHERE id = $1",
        [s.credential_id],
      );
      expect(cred[0]).toEqual({ revoked: true, nulled: true });
      const { rows: log } = await getPool().query(
        "SELECT action, details FROM gpu_key_events WHERE credential_id = $1 ORDER BY at",
        [s.credential_id],
      );
      expect(log.map((l) => l.action)).toEqual([
        "compromised",
        "unknown_pod_seen",
        "unknown_pod_terminated",
        "unknown_pod_seen",
        "unknown_pod_terminated",
        "compromise_closed",
      ]);
      // the provider name is sanitized and bounded
      expect(log[1].details).toEqual({
        provider_pod_id: "pod_miner1",
        name: "minerx",
      });
    });

    it("ends a pod a complete listing no longer shows, through the normal terminated path", async () => {
      const s = setup();
      const pod = await s.launch();
      const a = account(s);
      // RunPod won't confirm terminating it, and its listing comes back empty
      s.rp.client.terminatePod.mockRejectedValue(
        new RunpodApiError("provider", 503),
      );
      a.cleanup.listPods.mockResolvedValue([]);
      const result = await reportCompromisedLocal(
        {
          account_id: s.account_id,
          confirm_cocalc_only: true,
          fresh_auth_verified: true,
        },
        a.deps,
      );
      expect(result).toEqual({
        closed: false,
        awaiting_provider_revocation: true,
        provider_pods: 0,
        managed_pods: 0,
      });
      expect(
        (
          await getPool().query("SELECT state FROM gpu_pods WHERE id = $1", [
            pod.id,
          ])
        ).rows[0].state,
      ).toBe("terminated");
      const [r] = await reservations(pod.id);
      expect(r.state).toBe("settled");
    });

    it("closes when the owner deletes the key at RunPod and the listing itself is rejected", async () => {
      const s = setup();
      await s.launch();
      const a = account(s);
      const report = {
        account_id: s.account_id,
        confirm_cocalc_only: true,
        fresh_auth_verified: true,
      };
      expect(await reportCompromisedLocal(report, a.deps)).toEqual(
        expect.objectContaining({ closed: false }),
      );
      expect(
        await runCompromiseCleanup(s.account_id, s.credential_id, a.deps),
      ).toEqual(
        expect.objectContaining({ awaiting_provider_revocation: true }),
      );
      // deleted at RunPod: every call with the key is rejected, the listing
      // first
      a.cleanup.listPods.mockRejectedValue(new RunpodApiError("auth", 401));
      a.cleanup.getProviderIdentity.mockRejectedValue(
        new RunpodApiError("auth", 401),
      );
      expect(
        await runCompromiseCleanup(s.account_id, s.credential_id, a.deps),
      ).toEqual({ closed: true, provider_pods: 0, managed_pods: 0 });
      const { rows } = await getPool().query(
        "SELECT state FROM gpu_key_fences WHERE credential_id = $1",
        [s.credential_id],
      );
      expect(rows[0].state).toBe("closed");
      const { rows: cred } = await getPool().query(
        "SELECT revoked IS NOT NULL AS revoked FROM external_credentials WHERE id = $1",
        [s.credential_id],
      );
      expect(cred[0].revoked).toBe(true);
    });

    it("a rejected listing doesn't close while CoCalc has an unfinished pod on the key; other listing failures never close", async () => {
      const s = setup();
      const pod = await s.launch();
      const a = account(s);
      s.rp.client.terminatePod.mockRejectedValue(
        new RunpodApiError("provider", 503),
      );
      a.cleanup.listPods.mockRejectedValue(new RunpodApiError("auth", 401));
      const result = await reportCompromisedLocal(
        {
          account_id: s.account_id,
          confirm_cocalc_only: true,
          fresh_auth_verified: true,
        },
        a.deps,
      );
      expect(result).toEqual({
        closed: false,
        provider_rejected: true,
        managed_pods: 1,
        warning: expect.stringContaining("Remove anyway"),
      });
      const { rows } = await getPool().query(
        "SELECT state FROM gpu_key_fences WHERE credential_id = $1",
        [s.credential_id],
      );
      expect(rows[0].state).toBe("compromised");
      expect(
        (
          await getPool().query("SELECT state FROM gpu_pods WHERE id = $1", [
            pod.id,
          ])
        ).rows[0].state,
      ).not.toBe("terminated");
      a.cleanup.listPods.mockRejectedValue(new RunpodApiError("provider", 503));
      expect(
        await runCompromiseCleanup(s.account_id, s.credential_id, a.deps),
      ).toEqual({ closed: false, listing_failed: true });
    });

    it("a pod bound after the listing began isn't ended for being absent from it", async () => {
      const s = setup();
      const pod = await s.launch();
      const a = account(s);
      const { rows: bound } = await getPool().query(
        "SELECT provider_pod_id FROM gpu_pods WHERE id = $1",
        [pod.id],
      );
      const provider_pod_id = bound[0].provider_pod_id;
      // still creating when the pass starts
      await getPool().query(
        "UPDATE gpu_pods SET provider_pod_id = NULL, state = 'creating' WHERE id = $1",
        [pod.id],
      );
      const report = await reportCompromisedLocal(
        {
          account_id: s.account_id,
          confirm_cocalc_only: true,
          fresh_auth_verified: true,
        },
        { ...a.deps, resolvePending: async () => {} },
      );
      expect(report.closed).toBe(false);
      // RunPod's snapshot is taken before its create reply; the launch binds
      // the new pod meanwhile
      a.cleanup.listPods.mockImplementationOnce(async () => {
        await getPool().query(
          "UPDATE gpu_pods SET provider_pod_id = $2, state = 'running' WHERE id = $1",
          [pod.id, provider_pod_id],
        );
        return [];
      });
      await runCompromiseCleanup(s.account_id, s.credential_id, {
        ...a.deps,
        resolvePending: async () => {},
      });
      const { rows } = await getPool().query(
        "SELECT state, terminated_at FROM gpu_pods WHERE id = $1",
        [pod.id],
      );
      expect(rows[0].state).not.toBe("terminated");
      expect(rows[0].terminated_at).toBeNull();
      // the next pass, with its normal path, terminates it at RunPod
      await runCompromiseCleanup(s.account_id, s.credential_id, a.deps);
      expect(s.rp.pods.has(provider_pod_id)).toBe(false);
    });

    it("retries a backed-off managed pod on every compromise pass", async () => {
      const s = setup();
      const pod = await s.launch();
      const a = account(s);
      s.rp.client.terminatePod.mockRejectedValueOnce(
        new RunpodApiError("provider", 503),
      );
      await reportCompromisedLocal(
        {
          account_id: s.account_id,
          confirm_cocalc_only: true,
          fresh_auth_verified: true,
        },
        a.deps,
      );
      const row = async () =>
        (
          await getPool().query(
            "SELECT state, reap_after FROM gpu_pods WHERE id = $1",
            [pod.id],
          )
        ).rows[0];
      // the failed terminate backed off into the future
      expect((await row()).state).not.toBe("terminated");
      expect(new Date((await row()).reap_after).getTime()).toBeGreaterThan(
        Date.now(),
      );
      // the next pass retries it at once
      await runCompromiseCleanup(s.account_id, s.credential_id, a.deps);
      expect((await row()).state).toBe("terminated");
    });

    it("bounds the whole pass, resolving CoCalc's own pods included", async () => {
      const s = setup();
      await s.launch();
      const a = account(s);
      const result = await reportCompromisedLocal(
        {
          account_id: s.account_id,
          confirm_cocalc_only: true,
          fresh_auth_verified: true,
        },
        { ...a.deps, passMs: 0 },
      );
      // out of time before the first pod: nothing terminated, nothing listed
      expect(result).toEqual({ closed: false, managed_pods: 1 });
      expect(s.rp.client.terminatePod).not.toHaveBeenCalled();
      expect(a.cleanup.listPods).not.toHaveBeenCalled();
      // the next pass, with time, continues
      await runCompromiseCleanup(s.account_id, s.credential_id, a.deps);
      expect(s.rp.client.terminatePod).toHaveBeenCalled();
    });

    it("refuses a report for a key whose removal already closed its fence, claiming nothing; removing again finishes", async () => {
      const s = setup();
      await s.stored;
      const a = account(s);
      await getPool().query(
        "INSERT INTO accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [s.account_id],
      );
      // the crash state: the removal closed the fence, then stopped before
      // revoking CoCalc's copy
      await getPool().query(
        `INSERT INTO gpu_key_fences (credential_id, key_owner_account_id, state, created, updated)
         VALUES ($1, $2, 'closed', now(), now())
         ON CONFLICT (credential_id) DO UPDATE SET state = 'closed'`,
        [s.credential_id, s.account_id],
      );
      await expect(
        reportCompromisedLocal(
          {
            account_id: s.account_id,
            confirm_cocalc_only: true,
            fresh_auth_verified: true,
          },
          a.deps,
        ),
      ).rejects.toThrow("already removed from CoCalc");
      const { rows } = await getPool().query(
        "SELECT state FROM gpu_key_fences WHERE credential_id = $1",
        [s.credential_id],
      );
      expect(rows[0].state).toBe("closed");
      const { rows: log } = await getPool().query(
        "SELECT action FROM gpu_key_events WHERE credential_id = $1",
        [s.credential_id],
      );
      expect(log).toEqual([]);
      expect(
        await deleteGpuProviderKeyLocal(
          { account_id: s.account_id, provider: "runpod" },
          { isHomeBay: async () => true },
        ),
      ).toEqual({ revoked: true });
    });

    it("removal first, report second: the removal yields to the compromise cleanup and keeps the key", async () => {
      const s = setup();
      await s.launch();
      const a = account(s);
      const removal = deleteGpuProviderKeyLocal(
        { account_id: s.account_id, provider: "runpod" },
        {
          isHomeBay: async () => true,
          storedKeyRejected: async () => false,
          // the report comes in while the removal drains (and its cleanup
          // pass terminates the pod)
          drain: async () => {
            await reportCompromisedLocal(
              {
                account_id: s.account_id,
                confirm_cocalc_only: true,
                fresh_auth_verified: true,
              },
              a.deps,
            ).catch(() => {});
          },
          drainMs: 0,
        },
      );
      expect(await removal).toEqual({
        revoked: false,
        warning: expect.stringContaining("reported compromised"),
      });
      const { rows } = await getPool().query(
        "SELECT state FROM gpu_key_fences WHERE credential_id = $1",
        [s.credential_id],
      );
      expect(rows[0].state).toBe("compromised");
      const { rows: cred } = await getPool().query(
        "SELECT revoked IS NULL AS active FROM external_credentials WHERE id = $1",
        [s.credential_id],
      );
      expect(cred[0].active).toBe(true);
    });

    it("refuses if the key changed before the report took the fence", async () => {
      const s = setup();
      await s.stored;
      await getPool().query(
        "INSERT INTO accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [s.account_id],
      );
      const a = account(s);
      const stale = { ...a.cleanup, credential_id: randomUUID() };
      await expect(
        reportCompromisedLocal(
          {
            account_id: s.account_id,
            confirm_cocalc_only: true,
            fresh_auth_verified: true,
          },
          { ...a.deps, getCleanup: async () => stale as any },
        ),
      ).rejects.toThrow("changed while this was being reported");
    });

    it("finishes a cleanup that revoked its key but didn't close its fence", async () => {
      const s = setup();
      await s.launch();
      await getPool().query(
        "UPDATE gpu_key_fences SET state = 'compromised' WHERE credential_id = $1",
        [s.credential_id],
      );
      await getPool().query(
        "UPDATE external_credentials SET revoked = now(), encrypted_payload = NULL WHERE id = $1",
        [s.credential_id],
      );
      await getPool().query(
        "UPDATE gpu_pods SET state = 'terminated' WHERE credential_id = $1",
        [s.credential_id],
      );
      await continueCompromiseCleanups(async () => {});
      const { rows } = await getPool().query(
        "SELECT state FROM gpu_key_fences WHERE credential_id = $1",
        [s.credential_id],
      );
      expect(rows[0].state).toBe("closed");
    });
  });
});
