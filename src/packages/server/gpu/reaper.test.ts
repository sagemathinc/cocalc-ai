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
  runGpuReaperSweep,
} from "./reaper";
import { allowStaleWorkers, allowStaleWorkersLocal } from "./admin";

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
}

describeDb("GPU reaper", () => {
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
      gpu_worker_leases: SCHEMA.gpu_worker_leases,
      gpu_worker_overrides: SCHEMA.gpu_worker_overrides,
    });
  });
  beforeEach(freshReaper);

  it("runs on one hub at a time, and takes over an expired lease", async () => {
    const now = new Date();
    expect(await acquireWorkerLease("reaper", "hub-a", now)).toBe(true);
    expect(await acquireWorkerLease("reaper", "hub-b", now)).toBe(false);
    expect(await acquireWorkerLease("reaper", "hub-a", now)).toBe(true);
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
        await allowStaleWorkersLocal({
          admin_account_id: base.account_id,
          account_id: target,
          hours: 24,
          reason: base.reason,
        })
      ).account_id,
    ).toBe(target);
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
    const getPod = jest.fn(async (id: string) => ({ id }));
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
});
