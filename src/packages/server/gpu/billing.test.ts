/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Provider billing reconciliation (5d-2a) against a real (PGlite) database
// and a fake RunPod: the terminality proof, the per-pod claim and backoff,
// the correction on every layer (once), drift alerts and the pause, missing
// at 48 h, the layer invariant's admin alert, billedThrough, n/a; and the
// pieces 5d-2a adds for everyone: the state ledger, worker runs and the
// admin alerts' email projection.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { RunpodApiError } from "@cocalc/cloud/runpod/client";
import { GPU_LAUNCH_IMAGES } from "@cocalc/util/gpu/launch-spec";
import { lockGpuAccountFence } from "./account-fence";
import {
  launchGpuPodLocal,
  reconcileBindPod,
  releaseQuarantinedLocal,
  reviveEndedPod,
  terminateGpuPodLocal,
  transition,
} from "./pods";
import {
  BILLING_MISSING_AFTER_MS,
  billedThrough,
  proveBilling,
  reconcileKeyBilling,
  runBillingSweep,
} from "./billing";
import { acquireWorkerLease, finishWorkerLease } from "./reaper";
import {
  listAdminAlertsLocal,
  projectAdminAlertEmails,
  raiseAdminAlert,
} from "./admin-alerts";
import { freshInventoryForTests } from "./test-inventory";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const PROJECT = "00000000-1000-4000-8000-0000000000ac";
const SPEC = {
  gpu_type_id: "NVIDIA GeForce RTX 4090",
  image: GPU_LAUNCH_IMAGES[0],
  max_runtime_minutes: 60,
};
const HOUR = 3_600_000;

// one whole-hour record per hour of [from, to], each `amount`
function records(podId: string, from: Date, to: Date, amount: number) {
  const out: any[] = [];
  const start = Math.floor(from.getTime() / HOUR) * HOUR;
  const end = Math.max(Math.ceil(to.getTime() / HOUR) * HOUR, start + HOUR);
  for (let h = start; h < end; h += HOUR) {
    out.push({
      podId,
      startTime: new Date(h).toISOString(),
      endTime: new Date(h + HOUR).toISOString(),
      totalAmount: amount,
    });
  }
  return out;
}

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
      await lockGpuAccountFence(db, id, action);
    },
  };
  let billing: any[] = [];
  const billingCap = {
    credential_id,
    listPodBilling: jest.fn(async () => billing),
  };
  // a pod that ran and ended (settled at its estimate)
  const endedPod = async () => {
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      deps,
    );
    await terminateGpuPodLocal({ account_id, pod_id: pod.id }, deps);
    return await row(pod.id);
  };
  // the billing pass, at `hours` after the pod ended
  const pass = (pod: any, hours: number) => {
    const now = new Date(pod.terminated_at).getTime() + hours * HOUR;
    return reconcileKeyBilling(
      {
        credential_id,
        key_owner_account_id: account_id,
        deadline: now + 30_000,
      },
      { now: () => now, getBilling: async () => billingCap as any },
    );
  };
  return {
    account_id,
    credential_id,
    billingCap,
    setBilling: (r: any[]) => (billing = r),
    endedPod,
    pass,
    deps,
  };
}

async function row(id: string) {
  const { rows } = await getPool().query(
    "SELECT * FROM gpu_pods WHERE id = $1",
    [id],
  );
  return rows[0];
}

async function reservations(pod_id: string) {
  const { rows } = await getPool().query(
    `SELECT r.*, l.scope_kind FROM gpu_pod_reservations r
       JOIN gpu_budget_layers l ON l.id = r.layer_id WHERE r.pod_id = $1
      ORDER BY l.scope_kind`,
    [pod_id],
  );
  return rows;
}

async function keyLayer(credential_id: string) {
  const { rows } = await getPool().query(
    "SELECT * FROM gpu_budget_layers WHERE credential_id = $1 AND scope_kind = 'key'",
    [credential_id],
  );
  return rows[0];
}

async function alerts(credential_id: string) {
  const { rows } = await getPool().query(
    "SELECT kind, severity, dedupe_key, details FROM gpu_alerts WHERE credential_id = $1 ORDER BY opened",
    [credential_id],
  );
  return rows;
}

const n = (v: unknown) => Number(v ?? 0);

describeDb("GPU billing reconciliation", () => {
  beforeAll(async () => {
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS accounts (account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN, groups TEXT[], email_address TEXT)",
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
  });

  describe("the terminality proof", () => {
    const from = new Date("2026-10-28T10:20:00Z");
    const to = new Date("2026-10-28T12:10:00Z");
    const all = records("p1", from, to, 0.1);

    it("is complete only with exactly one whole-hour record per hour of the lifetime", () => {
      expect(all.length).toBe(3);
      expect(proveBilling(all, { podId: "p1", from, to })).toEqual({
        kind: "complete",
        billed_usd: expect.stringMatching(/^0\.3/),
      });
    });

    it("a missing first, middle (a stopped, disk-only hour) or last hour is not yet complete", () => {
      for (const i of [0, 1, 2]) {
        const partial = all.filter((_, j) => j !== i);
        expect(proveBilling(partial, { podId: "p1", from, to })).toEqual({
          kind: "incomplete",
          missing_hours: 1,
        });
      }
      expect(proveBilling([], { podId: "p1", from, to }).kind).toBe(
        "incomplete",
      );
    });

    it("duplicates, overlaps, misaligned, out-of-window or other pods' records are invalid", () => {
      const bad = [
        [...all, all[1]],
        [
          ...all.slice(1),
          {
            ...all[0],
            startTime: "2026-10-28T10:30:00.000Z",
            endTime: "2026-10-28T11:30:00.000Z",
          },
        ],
        [
          ...all,
          {
            ...all[0],
            startTime: "2026-10-28T14:00:00.000Z",
            endTime: "2026-10-28T15:00:00.000Z",
          },
        ],
        [...all.slice(1), { ...all[0], podId: "p2" }],
      ];
      for (const records of bad) {
        expect(proveBilling(records, { podId: "p1", from, to }).kind).toBe(
          "invalid",
        );
      }
    });
  });

  it("replaces the estimate with RunPod's bill on every layer, once, freeing what it didn't spend", async () => {
    const s = setup();
    const pod = await s.endedPod();
    expect(pod.billing_state).toBe("estimated");
    const [r0] = await reservations(pod.id);
    const before = await keyLayer(s.credential_id);
    const estimate = n(r0.spent_usd);
    const billed = estimate > 0 ? estimate / 2 : 0;
    s.setBilling(
      records(
        pod.provider_pod_id,
        new Date(pod.running_since),
        new Date(pod.terminated_at),
        0,
      ).map((r, i) => (i === 0 ? { ...r, totalAmount: billed } : r)),
    );
    // not yet past the horizon: nothing happens
    expect((await s.pass(pod, 0.5)).claimed).toBe(0);
    expect(await s.pass(pod, 3)).toEqual(
      expect.objectContaining({ claimed: 1, billed: 1 }),
    );
    const after = await row(pod.id);
    expect(after.billing_state).toBe("billed");
    expect(n(after.billed_usd)).toBeCloseTo(billed);
    for (const r of await reservations(pod.id)) {
      expect(n(r.spent_usd)).toBeCloseTo(billed);
    }
    const layer = await keyLayer(s.credential_id);
    expect(n(layer.spent_usd)).toBeCloseTo(
      n(before.spent_usd) - estimate + billed,
    );
    // a second pass changes nothing
    expect((await s.pass(pod, 4)).claimed).toBe(0);
    expect(n((await keyLayer(s.credential_id)).spent_usd)).toBeCloseTo(
      n(layer.spent_usd),
    );
    const { rows: ev } = await getPool().query(
      "SELECT details FROM gpu_pod_events WHERE pod_id = $1 AND action = 'billed'",
      [pod.id],
    );
    expect(ev).toEqual([
      {
        details: expect.objectContaining({
          estimate_usd: expect.any(String),
          billed_usd: expect.any(String),
        }),
      },
    ]);
  });

  it("billing well above the estimate warns; far above, alerts critically and pauses the key", async () => {
    const s = setup();
    const a = await s.endedPod();
    s.setBilling(
      records(
        a.provider_pod_id,
        new Date(a.running_since),
        new Date(a.terminated_at),
        0,
      ).map((r, i) => (i === 0 ? { ...r, totalAmount: 1 } : r)),
    );
    await s.pass(a, 3);
    expect(await alerts(s.credential_id)).toEqual([
      expect.objectContaining({ kind: "spend_drift", severity: "warning" }),
    ]);
    const b = await s.endedPod();
    s.setBilling(
      records(
        b.provider_pod_id,
        new Date(b.running_since),
        new Date(b.terminated_at),
        0,
      ).map((r, i) => (i === 0 ? { ...r, totalAmount: 50 } : r)),
    );
    await s.pass(b, 3);
    expect(await alerts(s.credential_id)).toContainEqual(
      expect.objectContaining({
        kind: "spend_drift",
        severity: "critical",
        dedupe_key: b.id,
      }),
    );
    const { rows: f } = await getPool().query(
      "SELECT paused_reason FROM gpu_key_fences WHERE credential_id = $1",
      [s.credential_id],
    );
    expect(f[0].paused_reason).toBe("spend_drift");
    // and the key layer is now over its authorization
    expect(await alerts(s.credential_id)).toContainEqual(
      expect.objectContaining({ kind: "over_budget" }),
    );
  });

  it("incomplete records back off (1, 2, 4 h), and 48 h after the end it's missing: the estimate stays", async () => {
    const s = setup();
    const pod = await s.endedPod();
    const spent = n((await reservations(pod.id))[0].spent_usd);
    s.setBilling([]);
    expect(await s.pass(pod, 3)).toEqual(
      expect.objectContaining({ claimed: 1, not_yet: 1 }),
    );
    let r = await row(pod.id);
    expect(r.billing_attempts).toBe(1);
    expect(new Date(r.billing_next_at).getTime()).toBe(
      new Date(pod.terminated_at).getTime() + 4 * HOUR,
    );
    // inside the backoff: not claimed
    expect((await s.pass(pod, 3.5)).claimed).toBe(0);
    expect((await s.pass(pod, 4)).not_yet).toBe(1);
    r = await row(pod.id);
    expect(new Date(r.billing_next_at).getTime()).toBe(
      new Date(pod.terminated_at).getTime() + 6 * HOUR,
    );
    // the provider failing outright is "not yet" too
    s.billingCap.listPodBilling.mockRejectedValueOnce(
      new RunpodApiError("protocol"),
    );
    expect((await s.pass(pod, 6)).not_yet).toBe(1);
    expect((await row(pod.id)).billing_state).toBe("estimated");
    expect(await s.pass(pod, BILLING_MISSING_AFTER_MS / HOUR + 1)).toEqual(
      expect.objectContaining({ missing: 1 }),
    );
    expect((await row(pod.id)).billing_state).toBe("missing");
    expect(n((await reservations(pod.id))[0].spent_usd)).toBeCloseTo(spent);
    expect(await alerts(s.credential_id)).toContainEqual(
      expect.objectContaining({ kind: "billing_missing", dedupe_key: "key" }),
    );
  });

  it("invalid records raise an admin warning and apply nothing", async () => {
    const s = setup();
    const pod = await s.endedPod();
    const all = records(
      pod.provider_pod_id,
      new Date(pod.running_since),
      new Date(pod.terminated_at),
      0.01,
    );
    s.setBilling([...all, all[0]]);
    expect((await s.pass(pod, 3)).invalid).toBe(1);
    expect((await row(pod.id)).billing_state).toBe("estimated");
    const { rows } = await getPool().query(
      "SELECT kind, severity FROM gpu_admin_alerts WHERE dedupe_key = $1",
      [pod.id],
    );
    expect(rows).toEqual([
      { kind: "billing_inconsistent", severity: "warning" },
    ]);
  });

  it("layers that disagree on a pod's spend: nothing applied, and the admin alert survives the rollback", async () => {
    const s = setup();
    const pod = await s.endedPod();
    // a second layer row for the pod, with a different spend
    const { rows: key } = await getPool().query(
      "SELECT * FROM gpu_budget_layers WHERE credential_id = $1 AND scope_kind = 'key'",
      [s.credential_id],
    );
    const projectLayer = randomUUID();
    await getPool().query(
      `INSERT INTO gpu_budget_layers (id, credential_id, key_owner_account_id, scope_kind, parent_id, parent_scope_kind, project_id, authorized_usd, state, starts_at, ends_at, created, updated)
       SELECT $1, credential_id, key_owner_account_id, 'project', id, 'key', $2, 50, state, starts_at, ends_at, now(), now()
         FROM gpu_budget_layers WHERE id = $3`,
      [projectLayer, PROJECT, key[0].id],
    );
    const [r] = await reservations(pod.id);
    await getPool().query(
      `INSERT INTO gpu_pod_reservations (id, pod_id, layer_id, state, reserved_usd, hourly_usd, gpu_count, pod_slots, spent_usd, settled_at, created, updated)
       VALUES ($1, $2, $3, 'settled', $4, $5, 1, 1, $6, now(), now(), now())`,
      [
        randomUUID(),
        pod.id,
        projectLayer,
        r.reserved_usd,
        r.hourly_usd,
        n(r.spent_usd) + 1,
      ],
    );
    s.setBilling(
      records(
        pod.provider_pod_id,
        new Date(pod.running_since),
        new Date(pod.terminated_at),
        0,
      ),
    );
    expect((await s.pass(pod, 3)).invalid).toBe(1);
    expect((await row(pod.id)).billing_state).toBe("estimated");
    const { rows } = await getPool().query(
      "SELECT kind, severity FROM gpu_admin_alerts WHERE dedupe_key = $1",
      [pod.id],
    );
    expect(rows).toEqual([
      { kind: "billing_inconsistent", severity: "critical" },
    ]);
  });

  it("a pod with no reservations is malformed: nothing applied, a critical admin alert", async () => {
    const s = setup();
    const pod = await s.endedPod();
    await getPool().query(
      "DELETE FROM gpu_pod_reservations WHERE pod_id = $1",
      [pod.id],
    );
    s.setBilling(
      records(
        pod.provider_pod_id,
        new Date(pod.running_since),
        new Date(pod.terminated_at),
        0.01,
      ),
    );
    expect((await s.pass(pod, 3)).invalid).toBe(1);
    expect((await row(pod.id)).billing_state).toBe("estimated");
    const { rows } = await getPool().query(
      "SELECT kind, severity FROM gpu_admin_alerts WHERE dedupe_key = $1",
      [pod.id],
    );
    expect(rows).toEqual([
      { kind: "billing_inconsistent", severity: "critical" },
    ]);
  });

  it("a zero estimate is still billed; a never-created pod is n/a", async () => {
    const s = setup();
    const pod = await s.endedPod();
    await getPool().query(
      "UPDATE gpu_pod_reservations SET spent_usd = 0 WHERE pod_id = $1",
      [pod.id],
    );
    s.setBilling(
      records(
        pod.provider_pod_id,
        new Date(pod.running_since),
        new Date(pod.terminated_at),
        0.002,
      ),
    );
    expect((await s.pass(pod, 3)).billed).toBe(1);
    expect((await row(pod.id)).billing_state).toBe("billed");
    // a create RunPod refused: released, nothing to bill
    const refused = setup();
    refused.deps.getLaunchAccess = async () =>
      ({
        client: {
          createPod: async () => {
            throw new RunpodApiError("invalid", 400);
          },
        } as any,
        credential_id: refused.credential_id,
      }) as any;
    await expect(
      launchGpuPodLocal(
        { account_id: refused.account_id, project_id: PROJECT, spec: SPEC },
        refused.deps,
      ),
    ).rejects.toThrow();
    const { rows } = await getPool().query(
      "SELECT billing_state FROM gpu_pods WHERE key_owner_account_id = $1",
      [refused.account_id],
    );
    expect(rows.map((r: any) => r.billing_state)).toEqual(["n/a"]);
  });

  it("a released quarantine RunPod later shows is bound back with billing reopened", async () => {
    const s = setup();
    let handle = "";
    s.deps.getLaunchAccess = async () =>
      ({
        client: {
          createPod: async (body: any) => {
            handle = body.name;
            throw new RunpodApiError("provider", 503);
          },
          findPodsByName: async () => [],
        } as any,
        credential_id: s.credential_id,
      }) as any;
    const p = await launchGpuPodLocal(
      { account_id: s.account_id, project_id: PROJECT, spec: SPEC },
      s.deps,
    );
    expect(p.state).toBe("ambiguous");
    await transition(
      p.id,
      { state: "failed", terminated_at: new Date() },
      "AND state = 'ambiguous'",
      undefined,
      { settle: "quarantine" },
    );
    // RunPod may have created it: still billing's to resolve, a sweep
    // leaves it alone
    expect((await row(p.id)).billing_state).toBe("estimated");
    await runBillingSweep({ getBilling: async () => undefined });
    expect((await row(p.id)).billing_state).toBe("estimated");
    await releaseQuarantinedLocal(
      { account_id: s.account_id, pod_id: p.id, fresh_auth_verified: true },
      s.deps,
    );
    expect((await row(p.id)).billing_state).toBe("n/a");
    await reconcileBindPod(
      await row(p.id),
      { id: "pod_bound1", name: handle, cost: 0.5 } as any,
      { kind: "reconciler" },
      new Date(),
    );
    const r = await row(p.id);
    expect(r).toEqual(
      expect.objectContaining({ state: "running", billing_state: "estimated" }),
    );
  });

  it("an owner alert's severity only goes up while it is open (a revived pod billed again critically)", async () => {
    const s = setup();
    const pod = await s.endedPod();
    const bill = (amount: number) =>
      s.setBilling(
        records(
          pod.provider_pod_id,
          new Date(pod.running_since),
          new Date(pod.terminated_at),
          0,
        ).map((r, i) => (i === 0 ? { ...r, totalAmount: amount } : r)),
      );
    bill(1);
    await s.pass(pod, 3);
    expect(
      (await alerts(s.credential_id)).find((a: any) => a.kind === "spend_drift")
        .severity,
    ).toBe("warning");
    // revived, ended again, and billed far above: the open alert escalates
    await reviveEndedPod(await row(pod.id), { kind: "reconciler" }, new Date());
    await transition(
      pod.id,
      { state: "terminated", terminated_at: new Date() },
      "",
      undefined,
      { settle: "actual" },
    );
    const again = await row(pod.id);
    s.setBilling(
      records(
        again.provider_pod_id,
        new Date(again.running_since),
        new Date(again.terminated_at),
        0,
      ).map((r, i) => (i === 0 ? { ...r, totalAmount: 60 } : r)),
    );
    await s.pass(again, 3);
    const drift = (await alerts(s.credential_id)).filter(
      (a: any) => a.kind === "spend_drift",
    );
    expect(drift.map((a: any) => a.severity)).toEqual(["critical"]);
  });

  it("a billed pod revived after its end has billing reopened", async () => {
    const s = setup();
    const pod = await s.endedPod();
    s.setBilling(
      records(
        pod.provider_pod_id,
        new Date(pod.running_since),
        new Date(pod.terminated_at),
        0.01,
      ),
    );
    await s.pass(pod, 3);
    expect((await row(pod.id)).billing_state).toBe("billed");
    await reviveEndedPod(await row(pod.id), { kind: "reconciler" }, new Date());
    expect(await row(pod.id)).toEqual(
      expect.objectContaining({
        state: "terminating",
        billing_state: "estimated",
        billed_usd: null,
        billing_attempts: 0,
      }),
    );
  });

  it("a pass that claimed an end before the pod was revived is a stale no-op", async () => {
    const s = setup();
    const pod = await s.endedPod();
    const all = records(
      pod.provider_pod_id,
      new Date(pod.running_since),
      new Date(pod.terminated_at),
      0.01,
    );
    // RunPod answers after the pod was revived (another pass saw it live)
    s.billingCap.listPodBilling.mockImplementationOnce(async () => {
      await reviveEndedPod(
        await row(pod.id),
        { kind: "reconciler" },
        new Date(),
      );
      return all;
    });
    expect(await s.pass(pod, 3)).toEqual(
      expect.objectContaining({ claimed: 1, billed: 0, invalid: 0 }),
    );
    const r = await row(pod.id);
    expect(r).toEqual(
      expect.objectContaining({
        state: "terminating",
        billing_state: "estimated",
      }),
    );
    const { rows } = await getPool().query(
      "SELECT 1 FROM gpu_admin_alerts WHERE dedupe_key = $1",
      [pod.id],
    );
    expect(rows).toEqual([]);
    // ...and 48 h later the same stale pass can't mark the live pod missing
    s.billingCap.listPodBilling.mockResolvedValueOnce([]);
    await s.pass(pod, BILLING_MISSING_AFTER_MS / HOUR + 1);
    expect((await row(pod.id)).billing_state).toBe("estimated");
  });

  it("billedThrough: the first settlement still at its estimate, or until", async () => {
    const s = setup();
    const a = await s.endedPod();
    const since = new Date(Date.now() - 24 * HOUR);
    const until = new Date(Date.now() + HOUR);
    const [ra] = await reservations(a.id);
    expect((await billedThrough(s.account_id, since, until)).getTime()).toBe(
      new Date(ra.settled_at).getTime(),
    );
    s.setBilling(
      records(
        a.provider_pod_id,
        new Date(a.running_since),
        new Date(a.terminated_at),
        0.01,
      ),
    );
    await s.pass(a, 3);
    expect((await billedThrough(s.account_id, since, until)).getTime()).toBe(
      until.getTime(),
    );
  });

  it("the sweep takes the due keys under its own lease and run", async () => {
    const s = setup();
    const pod = await s.endedPod();
    s.setBilling(
      records(
        pod.provider_pod_id,
        new Date(pod.running_since),
        new Date(pod.terminated_at),
        0.01,
      ),
    );
    const now = new Date(pod.terminated_at).getTime() + 3 * HOUR;
    const result = await runBillingSweep({
      now: () => now,
      getBilling: async (a: string) =>
        a === s.account_id ? (s.billingCap as any) : undefined,
    });
    expect(result.ran).toBe(true);
    expect((await row(pod.id)).billing_state).toBe("billed");
    const { rows } = await getPool().query(
      "SELECT outcome FROM gpu_worker_runs WHERE name = 'billing' ORDER BY started DESC LIMIT 1",
    );
    expect(rows[0].outcome).toBe("finished");
  });

  describe("the state ledger", () => {
    it("a launched and terminated pod has one interval per state, contiguous and in order", async () => {
      const s = setup();
      const pod = await s.endedPod();
      const { rows } = await getPool().query(
        "SELECT state, started, ended FROM gpu_pod_state_intervals WHERE pod_id = $1 ORDER BY started, ended NULLS LAST",
        [pod.id],
      );
      expect(rows.map((r: any) => r.state)).toEqual(
        expect.arrayContaining(["intent", "running", "terminated"]),
      );
      expect(rows.filter((r: any) => r.ended == null).length).toBe(1);
      for (let i = 1; i < rows.length; i++) {
        expect(new Date(rows[i].started).getTime()).toBe(
          new Date(rows[i - 1].ended).getTime(),
        );
      }
      // running starts at the bind's running_since, unless that is before
      // the open interval began (only clock skew between the app and the
      // database can do that): never earlier than the interval it closes
      const running = rows.find((r: any) => r.state === "running");
      const t = new Date(running.started).getTime();
      expect(t).toBeGreaterThanOrEqual(new Date(pod.running_since).getTime());
      expect(t).toBeLessThan(new Date(pod.running_since).getTime() + 1000);
    });

    it("a stale effective time never closes an interval before it began", async () => {
      const s = setup();
      const pod = await launchGpuPodLocal(
        { account_id: s.account_id, project_id: PROJECT, spec: SPEC },
        s.deps,
      );
      const { rows: open } = await getPool().query(
        "SELECT started FROM gpu_pod_state_intervals WHERE pod_id = $1 AND ended IS NULL",
        [pod.id],
      );
      await transition(pod.id, { state: "stopped" }, "", undefined, {
        effective_at: new Date(Date.now() - 365 * 24 * HOUR),
      });
      const { rows } = await getPool().query(
        "SELECT state, started, ended FROM gpu_pod_state_intervals WHERE pod_id = $1 ORDER BY started, ended NULLS LAST",
        [pod.id],
      );
      for (const r of rows) {
        if (r.ended) {
          expect(new Date(r.ended).getTime()).toBeGreaterThanOrEqual(
            new Date(r.started).getTime(),
          );
        }
      }
      const stopped = rows.find((r: any) => r.state === "stopped");
      expect(new Date(stopped.started).getTime()).toBeGreaterThanOrEqual(
        new Date(open[0].started).getTime(),
      );
    });
  });

  describe("worker runs and admin alerts", () => {
    it("a run opens with its lease and closes with it; a takeover marks the old one lost", async () => {
      const t0 = new Date(Date.now() + 1000 * HOUR);
      expect(await acquireWorkerLease("billing", "w1", t0)).toBe(true);
      const t1 = new Date(t0.getTime() + 2 * HOUR);
      expect(await acquireWorkerLease("billing", "w2", t1)).toBe(true);
      await finishWorkerLease("billing", "w2", t1);
      const { rows } = await getPool().query(
        "SELECT token, outcome FROM gpu_worker_runs WHERE token IN ('w1','w2') ORDER BY started",
      );
      expect(rows).toEqual([
        { token: "w1", outcome: "lost" },
        { token: "w2", outcome: "finished" },
      ]);
    });

    it("an admin alert's severity only goes up, and an escalation is emailed again", async () => {
      const key = randomUUID();
      await raiseAdminAlert({
        kind: "billing_inconsistent",
        severity: "warning",
        dedupe_key: key,
      });
      await getPool().query(
        "UPDATE gpu_admin_alerts SET emailed_at = now(), email_attempts = 2 WHERE dedupe_key = $1",
        [key],
      );
      await raiseAdminAlert({
        kind: "billing_inconsistent",
        severity: "critical",
        dedupe_key: key,
      });
      const { rows } = await getPool().query(
        "SELECT severity, emailed_at, email_attempts FROM gpu_admin_alerts WHERE dedupe_key = $1",
        [key],
      );
      expect(rows).toEqual([
        { severity: "critical", emailed_at: null, email_attempts: 0 },
      ]);
      // a later warning doesn't lower it (or re-email it)
      await getPool().query(
        "UPDATE gpu_admin_alerts SET emailed_at = now() WHERE dedupe_key = $1",
        [key],
      );
      await raiseAdminAlert({
        kind: "billing_inconsistent",
        severity: "warning",
        dedupe_key: key,
      });
      const { rows: after } = await getPool().query(
        "SELECT severity, emailed_at IS NOT NULL AS emailed FROM gpu_admin_alerts WHERE dedupe_key = $1",
        [key],
      );
      expect(after).toEqual([{ severity: "critical", emailed: true }]);
    });

    it("only an admin reads admin alerts", async () => {
      await expect(
        listAdminAlertsLocal(
          { account_id: randomUUID() },
          { isAdmin: async () => false },
        ),
      ).rejects.toThrow("Only an admin");
      const local = await listAdminAlertsLocal(
        { account_id: randomUUID() },
        { isAdmin: async () => true, bays: async () => ["bay-0"] },
      );
      expect(Array.isArray(local.alerts)).toBe(true);
      expect(local.errors).toEqual([]);
    });

    it("an admin reads every bay's alerts, or one bay's; a bay that can't answer is listed", async () => {
      const alert = (bay_id: string, opened: string) =>
        ({ bay_id, id: randomUUID(), opened, resolved_at: null }) as any;
      const deps = {
        isAdmin: async () => true,
        bays: async () => ["bay-0", "bay-1", "bay-2"],
        readBay: async (bay_id: string) => {
          if (bay_id === "bay-2") throw Error("unreachable");
          return [
            alert(bay_id, bay_id === "bay-0" ? "2026-10-01" : "2026-10-02"),
          ];
        },
      };
      const all = await listAdminAlertsLocal(
        { account_id: randomUUID() },
        deps,
      );
      expect(all.alerts.map((a) => a.bay_id)).toEqual(["bay-1", "bay-0"]);
      expect(all.errors).toEqual([
        { bay_id: "bay-2", error: "Error: unreachable" },
      ]);
      const one = await listAdminAlertsLocal(
        { account_id: randomUUID(), bay_id: "bay-1" },
        deps,
      );
      expect(one.alerts.map((a) => a.bay_id)).toEqual(["bay-1"]);
      await expect(
        listAdminAlertsLocal(
          { account_id: randomUUID(), bay_id: "bay-9" },
          deps,
        ),
      ).rejects.toThrow("unknown or unavailable bay");
    });

    it("a failed email waits its backoff from the failed attempt, however old the alert", async () => {
      const key = randomUUID();
      await raiseAdminAlert({
        kind: "billing_inconsistent",
        severity: "warning",
        dedupe_key: key,
      });
      const { rows } = await getPool().query(
        "UPDATE gpu_admin_alerts SET last_seen = now() - interval '1 day' WHERE dedupe_key = $1 RETURNING id",
        [key],
      );
      const id = rows[0].id;
      let attempts = 0;
      const failing = {
        recipients: async () => [
          { account_id: "a1", email_address: "a1@example.com" },
        ],
        send: async (a: any) => {
          if (a.id !== id) return;
          attempts += 1;
          throw Error("smtp down");
        },
      };
      await projectAdminAlertEmails(failing);
      expect(attempts).toBe(1);
      await projectAdminAlertEmails(failing);
      expect(attempts).toBe(1);
      const next = async () =>
        (
          await getPool().query(
            "SELECT email_attempts, email_next_at - now() > interval '4 minutes' AS later FROM gpu_admin_alerts WHERE id = $1",
            [id],
          )
        ).rows[0];
      expect(await next()).toEqual({ email_attempts: 1, later: true });
      // due once the delay has passed
      await getPool().query(
        "UPDATE gpu_admin_alerts SET email_next_at = now() - interval '1 second' WHERE id = $1",
        [id],
      );
      await projectAdminAlertEmails(failing);
      expect(attempts).toBe(2);
      // an escalation is due at once
      await raiseAdminAlert({
        kind: "billing_inconsistent",
        severity: "critical",
        dedupe_key: key,
      });
      await projectAdminAlertEmails(failing);
      expect(attempts).toBe(3);
    });

    it("admin alerts are deduped, and their email is retried until it goes out", async () => {
      const key = randomUUID();
      await raiseAdminAlert({
        kind: "billing_inconsistent",
        severity: "critical",
        dedupe_key: key,
      });
      await raiseAdminAlert({
        kind: "billing_inconsistent",
        severity: "critical",
        dedupe_key: key,
      });
      const { rows } = await getPool().query(
        "SELECT id FROM gpu_admin_alerts WHERE dedupe_key = $1",
        [key],
      );
      expect(rows.length).toBe(1);
      // two admins; the second's mail fails the first time
      const admins = [
        { account_id: "a1", email_address: "a1@example.com" },
        { account_id: "a2", email_address: "a2@example.com" },
      ];
      const sent: string[] = [];
      let failA2 = true;
      // (other tests' alerts share this database: count this one's)
      const send = async (alert: any, to: string) => {
        if (alert.id !== rows[0].id) return;
        if (to === "a2@example.com" && failA2) throw Error("smtp down");
        sent.push(to);
      };
      expect(
        (
          await projectAdminAlertEmails({
            recipients: async () => admins,
            send,
          })
        ).failed,
      ).toBeGreaterThan(0);
      const { rows: a } = await getPool().query(
        "SELECT emailed_at, email_attempts, emailed_to FROM gpu_admin_alerts WHERE dedupe_key = $1",
        [key],
      );
      expect(a[0]).toEqual({
        emailed_at: null,
        email_attempts: 1,
        emailed_to: ["a1"],
      });
      // backoff: retried once 5 min have passed, only to the admin who
      // didn't get it
      await getPool().query(
        "UPDATE gpu_admin_alerts SET email_next_at = now() - interval '1 second' WHERE dedupe_key = $1",
        [key],
      );
      failA2 = false;
      await projectAdminAlertEmails({ recipients: async () => admins, send });
      expect(sent.filter((x) => x === "a1@example.com").length).toBe(1);
      expect(sent.filter((x) => x === "a2@example.com").length).toBe(1);
      const { rows: b } = await getPool().query(
        "SELECT emailed_at FROM gpu_admin_alerts WHERE dedupe_key = $1",
        [key],
      );
      expect(b[0].emailed_at).not.toBeNull();
    });
  });
});
