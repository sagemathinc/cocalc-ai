/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The reaper against a real (PGlite) database and a fake RunPod, with a
// fake clock: the lease, each reason a pod must go, the full layer that must
// not terminate anything, backoff, the completed watermark, and the
// fail-closed launch check with its admin override.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { RunpodApiError } from "@cocalc/cloud/runpod/client";
import { GPU_LAUNCH_IMAGES } from "@cocalc/util/gpu/launch-spec";
import { lockGpuAccountFence } from "./account-fence";
import { launchGpuPodLocal, listManagedGpuPodsLocal } from "./pods";
import {
  LAPSE_GRACE_MS,
  acquireWorkerLease,
  every,
  runCompromiseSweep,
  runGpuReaperSweep,
} from "./reaper";
import { allowStaleWorkers, allowStaleWorkersLocal } from "./admin";
import { freshInventoryForTests } from "./test-inventory";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const PROJECT = "00000000-1000-4000-8000-0000000000aa";
const SPEC = {
  gpu_type_id: "NVIDIA GeForce RTX 4090",
  image: GPU_LAUNCH_IMAGES[0],
  max_runtime_minutes: 60,
};
const HOUR = 3_600_000;

function setup() {
  const account_id = randomUUID();
  const credential_id = randomUUID();
  const pods = new Map<string, any>();
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
  let entitled = true;
  let clock = Date.now();
  const deps = {
    isHomeBay: async () => true,
    isProjectCollaborator: async () => true,
    getLaunchAccess: async () => ({ client: client as any, credential_id }),
    getCleanup: async () => ({ ...client, credential_id }) as any,
    listPrice: async () => 0.5,
    siteUrl: async () => "https://cocalc.test",
    // the real fence, on the account row it needs (same transaction)
    accountWriteFence: async (db: any, id: string, action: string) => {
      await db.query(
        "INSERT INTO accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [id],
      );
      await lockGpuAccountFence(db, id, action);
    },
    isEntitled: async () => entitled,
    now: () => clock,
    holder: "hub-test",
  };
  return {
    account_id,
    credential_id,
    client,
    pods,
    deps,
    setEntitled: (v: boolean) => (entitled = v),
    advance: (ms: number) => (clock += ms),
    launch: () =>
      launchGpuPodLocal({ account_id, project_id: PROJECT, spec: SPEC }, deps),
  };
}

// the real fence, on the account row it needs (same transaction)
async function fenceWithAccount(db: any, id: string, action: string) {
  await db.query(
    "INSERT INTO accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [id],
  );
  await lockGpuAccountFence(db, id, action);
}

async function row(id: string) {
  const { rows } = await getPool().query(
    "SELECT * FROM gpu_pods WHERE id = $1",
    [id],
  );
  return rows[0];
}

async function events(pod_id: string) {
  const { rows } = await getPool().query(
    "SELECT actor_kind, action, details FROM gpu_pod_events WHERE pod_id = $1 ORDER BY at",
    [pod_id],
  );
  return rows;
}

async function freshReaper() {
  await getPool().query(
    "INSERT INTO gpu_worker_leases (name, holder, expires_at, last_completed_at) VALUES ('reaper', NULL, NULL, now() + interval '10 years') ON CONFLICT (name) DO UPDATE SET holder = NULL, expires_at = NULL, last_completed_at = EXCLUDED.last_completed_at",
  );
  // and every key has a recent complete inventory (likewise)
  await freshInventoryForTests();
}

describeDb("GPU reaper", () => {
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
  });
  beforeEach(freshReaper);

  it("runs one sweep at a time, and takes over an expired lease", async () => {
    const now = new Date();
    expect(await acquireWorkerLease("reaper", "hub-a:run1", now)).toBe(true);
    expect(await acquireWorkerLease("reaper", "hub-b:run1", now)).toBe(false);
    // not even another sweep of the same hub
    expect(await acquireWorkerLease("reaper", "hub-a:run2", now)).toBe(false);
    expect(
      await acquireWorkerLease(
        "reaper",
        "hub-b",
        new Date(now.getTime() + HOUR),
      ),
    ).toBe(true);
  });

  it("terminates a pod at its deadline and moves the watermark", async () => {
    const s = setup();
    const pod = await s.launch();
    s.advance(30 * 60_000);
    await runGpuReaperSweep(s.deps);
    expect((await row(pod.id)).state).toBe("running");
    s.advance(31 * 60_000);
    const result = await runGpuReaperSweep(s.deps);
    expect(result).toEqual(expect.objectContaining({ ran: true, marked: 1 }));
    const r = await row(pod.id);
    expect(r.state).toBe("terminated");
    expect(r.reason).toBe("Reached its maximum runtime.");
    expect(s.pods.size).toBe(0);
    expect(await events(pod.id)).toContainEqual(
      expect.objectContaining({
        actor_kind: "reaper",
        action: "terminate",
        details: { cause: "deadline" },
      }),
    );
    const { rows } = await getPool().query(
      "SELECT last_completed_at FROM gpu_worker_leases WHERE name = 'reaper'",
    );
    expect(new Date(rows[0].last_completed_at).getTime()).toBe(s.deps.now());
  });

  it("terminates pods under a revoked or ended budget, never under a merely full one", async () => {
    const s = setup();
    const a = await s.launch();
    // full: spent + reserved = authorized blocks new launches only
    await getPool().query(
      "UPDATE gpu_budget_layers SET authorized_usd = reserved_usd + spent_usd WHERE credential_id = $1",
      [s.credential_id],
    );
    await runGpuReaperSweep(s.deps);
    expect((await row(a.id)).state).toBe("running");
    await expect(s.launch()).rejects.toThrow("left");
    // revoked: its pods go
    await getPool().query(
      "UPDATE gpu_budget_layers SET state = 'revoked', revoked_reason = 'owner' WHERE credential_id = $1",
      [s.credential_id],
    );
    await runGpuReaperSweep(s.deps);
    const r = await row(a.id);
    expect(r.state).toBe("terminated");
    expect(r.reason).toMatch(/suspended, revoked or ended/);
    expect(await events(a.id)).toContainEqual(
      expect.objectContaining({
        action: "budget_stop",
        details: { cause: "layer_ended" },
      }),
    );
  });

  it("gives a lapsed key owner 7 days, then terminates their pods", async () => {
    const s = setup();
    const pod = await s.launch();
    // a long deadline, so only the lapse matters here
    await getPool().query(
      "UPDATE gpu_pods SET deadline = now() + interval '30 days' WHERE id = $1",
      [pod.id],
    );
    s.setEntitled(false);
    await runGpuReaperSweep(s.deps);
    const { rows } = await getPool().query(
      "SELECT entitlement_lapsed_at FROM gpu_key_fences WHERE credential_id = $1",
      [s.credential_id],
    );
    expect(rows[0].entitlement_lapsed_at).not.toBeNull();
    expect((await row(pod.id)).state).toBe("running");
    s.advance(LAPSE_GRACE_MS + 60_000);
    // the reservation would also be used up by now; check the lapse alone
    await getPool().query(
      "UPDATE gpu_pods SET running_since = NULL WHERE id = $1",
      [pod.id],
    );
    await runGpuReaperSweep(s.deps);
    expect(await events(pod.id)).toContainEqual(
      expect.objectContaining({
        action: "budget_stop",
        details: { cause: "lapsed" },
      }),
    );
    expect((await row(pod.id)).state).toBe("terminated");
  });

  it("clears the lapse clock when the entitlement returns", async () => {
    const s = setup();
    await s.launch();
    s.setEntitled(false);
    await runGpuReaperSweep(s.deps);
    s.setEntitled(true);
    await runGpuReaperSweep(s.deps);
    const { rows } = await getPool().query(
      "SELECT entitlement_lapsed_at FROM gpu_key_fences WHERE credential_id = $1",
      [s.credential_id],
    );
    expect(rows[0].entitlement_lapsed_at).toBeNull();
  });

  it("backs off a pod RunPod won't terminate, then retries", async () => {
    const s = setup();
    const pod = await s.launch();
    s.advance(61 * 60_000);
    s.client.terminatePod.mockRejectedValueOnce(
      new RunpodApiError("provider", 503),
    );
    await runGpuReaperSweep(s.deps);
    let r = await row(pod.id);
    expect(r.state).toBe("terminating");
    expect(r.reap_attempts).toBe(1);
    expect(new Date(r.reap_after).getTime()).toBe(s.deps.now() + 60_000);
    // before the backoff ends: not retried
    s.advance(30_000);
    await runGpuReaperSweep(s.deps);
    expect(s.client.terminatePod).toHaveBeenCalledTimes(1);
    // after: retried and done
    s.advance(60_000);
    await runGpuReaperSweep(s.deps);
    r = await row(pod.id);
    expect(r.state).toBe("terminated");
    expect(s.pods.size).toBe(0);
  });

  it("fails launches closed while the reaper is stale, unless an admin allowed it", async () => {
    const s = setup();
    await getPool().query(
      "UPDATE gpu_worker_leases SET last_completed_at = now() - interval '1 hour' WHERE name = 'reaper'",
    );
    await expect(s.launch()).rejects.toThrow("cleanup worker");
    expect(s.client.createPod).not.toHaveBeenCalled();
    const admin = randomUUID();
    const override = await allowStaleWorkers(
      {
        account_id: admin,
        browser_id: "b",
        target_account_id: s.account_id,
        hours: 2,
        reason: "reaper outage during the 10-28 deploy",
      },
      {
        isAdmin: async () => true,
        freshAuth: async () => ({}) as any,
        homeClient: async () => undefined,
        accountWriteFence: fenceWithAccount,
      },
    );
    expect(override.account_id).toBe(s.account_id);
    // the override bypasses staleness only: the budget still applies
    expect((await s.launch()).state).toBe("running");
    await getPool().query(
      "UPDATE gpu_budget_layers SET authorized_usd = 0.6 WHERE credential_id = $1",
      [s.credential_id],
    );
    await expect(s.launch()).rejects.toThrow("left");
    // and only for that account
    const other = setup();
    await expect(other.launch()).rejects.toThrow("cleanup worker");
  });

  it("refuses overrides from non-admins, without fresh auth, or beyond 24 h", async () => {
    const target = randomUUID();
    const base = {
      account_id: randomUUID(),
      browser_id: "b",
      target_account_id: target,
      hours: 1,
      reason: "a good enough reason",
    };
    const ok = {
      isAdmin: async () => true,
      freshAuth: async () => ({}) as any,
      homeClient: async () => undefined,
      accountWriteFence: fenceWithAccount,
    };
    await expect(
      allowStaleWorkers(base, { ...ok, isAdmin: async () => false }),
    ).rejects.toThrow("Only an admin");
    await expect(
      allowStaleWorkers(base, {
        ...ok,
        freshAuth: async () => {
          throw Error("fresh authentication required");
        },
      }),
    ).rejects.toThrow("fresh authentication required");
    await expect(allowStaleWorkers({ ...base, hours: 25 }, ok)).rejects.toThrow(
      "at most 24",
    );
    await expect(
      allowStaleWorkers({ ...base, reason: "x" }, ok),
    ).rejects.toThrow("reason");
    // the database enforces the window too
    await expect(
      getPool().query(
        "INSERT INTO gpu_worker_overrides (id, key_owner_account_id, admin_account_id, reason, created, expires_at) VALUES ($1, $2, $2, 'a good enough reason', now(), now() + interval '2 days')",
        [randomUUID(), target],
      ),
    ).rejects.toThrow();
    expect(
      (
        await allowStaleWorkersLocal(
          {
            admin_account_id: base.account_id,
            account_id: target,
            hours: 24,
            reason: base.reason,
          },
          { accountWriteFence: fenceWithAccount },
        )
      ).account_id,
    ).toBe(target);
  });

  it("writes an override only on the account's home bay, under its fence", async () => {
    const target = randomUUID();
    await getPool().query(
      "INSERT INTO accounts (account_id, home_bay_id) VALUES ($1, 'bay-elsewhere')",
      [target],
    );
    await expect(
      allowStaleWorkersLocal({
        admin_account_id: randomUUID(),
        account_id: target,
        hours: 1,
        reason: "a good enough reason",
      }),
    ).rejects.toThrow(/homed on bay-elsewhere/);
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM gpu_worker_overrides WHERE key_owner_account_id = $1",
      [target],
    );
    expect(rows[0].n).toBe(0);
  });

  it("terminates a Community kernel pod that never got a public SSH port", async () => {
    const s = setup();
    const key =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl t";
    const live = await launchGpuPodLocal(
      {
        account_id: s.account_id,
        project_id: PROJECT,
        spec: { ...SPEC, cloud: "COMMUNITY", ssh_public_key: key },
      },
      s.deps,
    );
    // a public IP but no SSH endpoint: not usable
    const getPod = jest.fn(async (id: string) => ({
      id,
      publicIp: "203.0.113.9",
    }));
    const deps = {
      ...s.deps,
      getCleanup: async () =>
        ({ ...s.client, getPod, credential_id: s.credential_id }) as any,
    };
    s.advance(5 * 60_000);
    await runGpuReaperSweep(deps);
    expect(getPod).not.toHaveBeenCalled();
    s.advance(6 * 60_000);
    await runGpuReaperSweep(deps);
    expect(getPod).toHaveBeenCalledWith(live.provider_pod_id);
    const r = await row(live.id);
    expect(r.state).toBe("terminated");
    expect(r.reason).toMatch(/try Secure Cloud/);
  });

  it("keeps a Community pod once its public SSH port shows up", async () => {
    const s = setup();
    const key =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl t";
    const live = await launchGpuPodLocal(
      {
        account_id: s.account_id,
        project_id: PROJECT,
        spec: { ...SPEC, cloud: "COMMUNITY", ssh_public_key: key },
      },
      s.deps,
    );
    const deps = {
      ...s.deps,
      getCleanup: async () =>
        ({
          ...s.client,
          getPod: async (id: string) => ({
            id,
            sshDirect: { host: "203.0.113.5", port: 40022, username: "root" },
          }),
          credential_id: s.credential_id,
        }) as any,
    };
    s.advance(11 * 60_000);
    await runGpuReaperSweep(deps);
    const r = await row(live.id);
    expect([r.state, r.public_ip]).toEqual(["running", "203.0.113.5"]);
  });

  it("resolves crash-left records for every key owner", async () => {
    const s = setup();
    const pod = await s.launch();
    s.pods.clear();
    s.pods.set("pod_crash9", { id: "pod_crash9", name: pod.handle });
    await getPool().query(
      "UPDATE gpu_pods SET state = 'creating', provider_pod_id = NULL, updated = now() - interval '1 hour' WHERE id = $1",
      [pod.id],
    );
    await runGpuReaperSweep(s.deps);
    const r = await row(pod.id);
    expect([r.state, r.provider_pod_id]).toEqual(["running", "pod_crash9"]);
    expect(
      (await listManagedGpuPodsLocal({ account_id: s.account_id }, s.deps))
        .length,
    ).toBe(1);
  });

  it("never starts a second sweep while one runs, even from the same hub", async () => {
    const s = setup();
    await s.launch();
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let calls = 0;
    const deps = {
      ...s.deps,
      isEntitled: async () => {
        if (++calls === 1) {
          reached();
          await gate;
        }
        return true;
      },
    };
    const first = runGpuReaperSweep(deps);
    await atGate;
    expect(await runGpuReaperSweep(deps)).toEqual({ ran: false });
    open();
    expect(await first).toEqual(expect.objectContaining({ ran: true }));
  });

  it("records the time a sweep finished as its watermark", async () => {
    const s = setup();
    await s.launch();
    let calls = 0;
    const deps = {
      ...s.deps,
      // the sweep takes four minutes
      isEntitled: async () => {
        if (++calls === 1) s.advance(4 * 60_000);
        return true;
      },
    };
    await runGpuReaperSweep(deps);
    const { rows } = await getPool().query(
      "SELECT last_completed_at, holder FROM gpu_worker_leases WHERE name = 'reaper'",
    );
    expect(new Date(rows[0].last_completed_at).getTime()).toBe(s.deps.now());
    expect(rows[0].holder).toBeNull();
  });

  // synthetic records, many owners at once
  async function bulkPods({
    n,
    state,
    extra = "",
  }: {
    n: number;
    state: string;
    extra?: string;
  }): Promise<string[]> {
    const { rows } = await getPool().query(
      `INSERT INTO gpu_pods (id, handle, key_owner_account_id, credential_id, provider,
         beneficiary_account_id, spec, gpu_type_id, gpu_count, cloud, state, desired_state,
         max_runtime_minutes, deadline, created, updated, reap_after)
       SELECT gen_random_uuid(), 'cc-' || substr(translate(md5(random()::text), '0189', 'abcd'), 1, 16),
         o, gen_random_uuid(), 'runpod', o, '{}', 'NVIDIA RTX A4000', 1, 'SECURE', $2, 'running',
         60, now() + interval '30 days', now() - interval '1 hour', now() - interval '1 hour',
         ${extra || "NULL"}
         FROM (SELECT gen_random_uuid() AS o FROM generate_series(1, $1)) owners
       RETURNING key_owner_account_id`,
      [n, state],
    );
    return rows.map((r) => r.key_owner_account_id);
  }

  it("drains more than a batch of owners, past backed-off work", async () => {
    const s = setup();
    // 100 owners whose pending work is backed off far into the future...
    const delayed = await bulkPods({
      n: 100,
      state: "ambiguous",
      extra: "now() + interval '1 day'",
    });
    // ...and 150 owners with crash-left intents, ready now
    const ready = await bulkPods({ n: 150, state: "intent" });
    const result = await runGpuReaperSweep(s.deps);
    expect(result).toEqual(
      expect.objectContaining({ ran: true, complete: true }),
    );
    const { rows } = await getPool().query(
      "SELECT state, count(*)::int AS n FROM gpu_pods WHERE key_owner_account_id = ANY($1) GROUP BY state",
      [[...delayed, ...ready]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.state, r.n]))).toEqual({
      ambiguous: 100,
      failed: 150,
    });
    await getPool().query(
      "UPDATE gpu_pods SET state = 'failed', desired_state = 'terminated' WHERE key_owner_account_id = ANY($1)",
      [delayed],
    );
  });

  it("checks the entitlement of more than a batch of keys", async () => {
    const s = setup();
    const owners = await bulkPods({ n: 150, state: "running" });
    await getPool().query(
      `INSERT INTO gpu_key_fences (credential_id, key_owner_account_id, state, created, updated)
       SELECT credential_id, key_owner_account_id, 'active', now(), now()
         FROM gpu_pods WHERE key_owner_account_id = ANY($1)`,
      [owners],
    );
    await runGpuReaperSweep({ ...s.deps, isEntitled: async () => false });
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM gpu_key_fences
        WHERE key_owner_account_id = ANY($1) AND entitlement_lapsed_at IS NOT NULL`,
      [owners],
    );
    expect(rows[0].n).toBe(150);
    await getPool().query(
      "UPDATE gpu_pods SET state = 'terminated', desired_state = 'terminated' WHERE key_owner_account_id = ANY($1)",
      [owners],
    );
  });

  it("stops a sweep that lost its lease, and writes no watermark", async () => {
    const s = setup();
    await s.launch();
    const before = (
      await getPool().query(
        "SELECT last_completed_at FROM gpu_worker_leases WHERE name = 'reaper'",
      )
    ).rows[0].last_completed_at;
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let calls = 0;
    const deps = {
      ...s.deps,
      isEntitled: async () => {
        if (++calls === 1) {
          reached();
          await gate;
        }
        return true;
      },
    };
    const first = runGpuReaperSweep(deps);
    await atGate;
    // the first sweep stalls past its lease; another hub takes over
    s.advance(6 * 60_000);
    expect(
      await acquireWorkerLease(
        "reaper",
        "hub-other:run",
        new Date(s.deps.now()),
      ),
    ).toBe(true);
    open();
    await expect(first).rejects.toThrow("lease was lost");
    const { rows } = await getPool().query(
      "SELECT last_completed_at, holder FROM gpu_worker_leases WHERE name = 'reaper'",
    );
    expect(rows[0].holder).toBe("hub-other:run");
    expect(new Date(rows[0].last_completed_at).getTime()).toBe(
      new Date(before).getTime(),
    );
  });

  it("backs off ready work it can't act on, instead of holding every launch", async () => {
    const s = setup();
    const pod = await s.launch();
    await getPool().query(
      "UPDATE gpu_pods SET desired_state = 'terminated', state = 'terminating' WHERE id = $1",
      [pod.id],
    );
    // the key is gone: nothing can reach RunPod for this owner now
    const result = await runGpuReaperSweep({
      ...s.deps,
      getCleanup: async () => undefined,
    });
    expect(result).toEqual(
      expect.objectContaining({ ran: true, complete: true }),
    );
    const r = await row(pod.id);
    expect(r.state).toBe("terminating");
    expect(r.reap_attempts).toBe(1);
    expect(new Date(r.reap_after).getTime()).toBeGreaterThan(s.deps.now());
  });

  it("stops before the next record once its lease is lost mid-pass", async () => {
    const s = setup();
    const a = await s.launch();
    const b = await s.launch();
    // both must go, and RunPod is slow: the first terminate outlasts the lease
    await getPool().query(
      "UPDATE gpu_pods SET desired_state = 'terminated', state = 'terminating' WHERE id = ANY($1)",
      [[a.id, b.id]],
    );
    s.client.terminatePod.mockImplementationOnce(async (id: string) => {
      s.advance(6 * 60_000);
      expect(
        await acquireWorkerLease(
          "reaper",
          "hub-other:run",
          new Date(s.deps.now()),
        ),
      ).toBe(true);
      s.pods.delete(id);
    });
    await expect(runGpuReaperSweep(s.deps)).rejects.toThrow("lease was lost");
    // the second record was never acted on
    expect(s.client.terminatePod).toHaveBeenCalledTimes(1);
    const { rows } = await getPool().query(
      "SELECT holder FROM gpu_worker_leases WHERE name = 'reaper'",
    );
    expect(rows[0].holder).toBe("hub-other:run");
  });

  it("backs off unactionable work after many attempts without overflowing", async () => {
    const s = setup();
    const pod = await s.launch();
    await getPool().query(
      "UPDATE gpu_pods SET desired_state = 'terminated', state = 'terminating', reap_attempts = 31 WHERE id = $1",
      [pod.id],
    );
    const result = await runGpuReaperSweep({
      ...s.deps,
      getCleanup: async () => undefined,
    });
    expect(result).toEqual(expect.objectContaining({ complete: true }));
    const r = await row(pod.id);
    expect(r.reap_attempts).toBe(32);
    expect(new Date(r.reap_after).getTime()).toBe(s.deps.now() + 30 * 60_000);
  });

  it("keeps its lease through one long ambiguous lookup, by a heartbeat", async () => {
    const s = setup();
    const pod = await s.launch();
    await getPool().query(
      "UPDATE gpu_pods SET state = 'ambiguous', provider_pod_id = NULL WHERE id = $1",
      [pod.id],
    );
    // RunPod's pod list pages slowly: the lookup outlasts the 5-minute lease
    // (the fake clock moves 3 minutes per real 20 ms; the heartbeat runs
    // every 5 real ms)
    let other: boolean | undefined;
    s.client.findPodsByName.mockImplementationOnce(async (name: string) => {
      for (let page = 0; page < 4; page++) {
        s.advance(3 * 60_000);
        await new Promise((r) => setTimeout(r, 20));
      }
      other = await acquireWorkerLease(
        "reaper",
        "hub-other:run",
        new Date(s.deps.now()),
      );
      return [...s.pods.values()].filter((p) => p.name === name);
    });
    const result = await runGpuReaperSweep({ ...s.deps, heartbeatMs: 5 });
    expect(other).toBe(false);
    expect(result).toEqual(expect.objectContaining({ ran: true }));
    expect((await row(pod.id)).state).toBe("running");
  });

  it("backs off an ambiguous create whose RunPod lookup fails", async () => {
    const s = setup();
    const pod = await s.launch();
    await getPool().query(
      "UPDATE gpu_pods SET state = 'ambiguous', provider_pod_id = NULL WHERE id = $1",
      [pod.id],
    );
    s.client.findPodsByName.mockRejectedValue(
      new RunpodApiError("provider", 503),
    );
    const result = await runGpuReaperSweep(s.deps);
    expect(result).toEqual(expect.objectContaining({ complete: true }));
    // one lookup, then backed off: not repeated pass after pass
    expect(s.client.findPodsByName).toHaveBeenCalledTimes(1);
    const r = await row(pod.id);
    expect(r.state).toBe("ambiguous");
    expect(r.reap_attempts).toBe(1);
    expect(new Date(r.reap_after).getTime()).toBe(s.deps.now() + 60_000);
  });

  it("doesn't act on a past lapse while the entitlement can't be checked", async () => {
    const s = setup();
    const pod = await s.launch();
    await getPool().query(
      "UPDATE gpu_pods SET deadline = now() + interval '30 days', running_since = NULL WHERE id = $1",
      [pod.id],
    );
    // lapsed more than 7 days ago, but the membership has since returned...
    await getPool().query(
      "UPDATE gpu_key_fences SET entitlement_lapsed_at = $2 WHERE credential_id = $1",
      [s.credential_id, new Date(s.deps.now() - LAPSE_GRACE_MS - HOUR)],
    );
    // ...and this sweep can't look it up
    await runGpuReaperSweep({
      ...s.deps,
      isEntitled: async () => {
        throw Error("membership service unavailable");
      },
    });
    expect((await row(pod.id)).desired_state).toBe("running");
    // the next sweep sees the entitlement and clears the lapse
    await runGpuReaperSweep(s.deps);
    expect((await row(pod.id)).desired_state).toBe("running");
    const { rows } = await getPool().query(
      "SELECT entitlement_lapsed_at FROM gpu_key_fences WHERE credential_id = $1",
      [s.credential_id],
    );
    expect(rows[0].entitlement_lapsed_at).toBeNull();
  });

  it("runs compromise cleanups under their own lease, never touching the sweep's watermark", async () => {
    const s = setup();
    const before = (
      await getPool().query(
        "SELECT last_completed_at FROM gpu_worker_leases WHERE name = 'reaper'",
      )
    ).rows[0].last_completed_at;
    expect(await runCompromiseSweep(s.deps)).toEqual(
      expect.objectContaining({ ran: true }),
    );
    // one at a time per bay
    expect(
      await acquireWorkerLease("compromise", "hub-other:run", new Date()),
    ).toBe(true);
    expect(await runCompromiseSweep(s.deps)).toEqual({ ran: false });
    const after = (
      await getPool().query(
        "SELECT last_completed_at FROM gpu_worker_leases WHERE name = 'reaper'",
      )
    ).rows[0].last_completed_at;
    expect(new Date(after).getTime()).toBe(new Date(before).getTime());
  });
});

it("a stuck reaper sweep doesn't hold up the compromise worker: each has its own timer", async () => {
  // the reaper's first sweep never finishes
  const reaper = jest.fn(() => new Promise<void>(() => {}));
  const compromise = jest.fn(async () => {});
  const timers = [
    every("reaper", reaper, 20),
    every("compromise", compromise, 20),
  ];
  try {
    await new Promise((r) => setTimeout(r, 110));
  } finally {
    timers.forEach(clearInterval);
  }
  // one reaper pass at a time (still the first), while compromise passes go on
  expect(reaper).toHaveBeenCalledTimes(1);
  expect(compromise.mock.calls.length).toBeGreaterThanOrEqual(3);
});
