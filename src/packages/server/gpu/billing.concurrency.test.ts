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

  it("two hubs projecting admin alert emails at once send each alert once", async () => {
    const { raiseAdminAlert, projectAdminAlertEmails } =
      await import("./admin-alerts");
    const key = randomUUID();
    await raiseAdminAlert({
      kind: "billing_inconsistent",
      severity: "critical",
      dedupe_key: key,
    });
    const sends: string[] = [];
    const project = () =>
      projectAdminAlertEmails({
        recipients: async () => [
          { account_id: "a1", email_address: "a1@example.com" },
        ],
        send: async (a: { id: string }) => {
          sends.push(a.id);
          await new Promise((r) => setTimeout(r, 100));
        },
      });
    await Promise.all([project(), project(), project()]);
    const { rows } = await getPool().query(
      "SELECT id, emailed_at FROM gpu_admin_alerts WHERE dedupe_key = $1",
      [key],
    );
    expect(sends.filter((id) => id === rows[0].id).length).toBe(1);
    expect(rows[0].emailed_at).not.toBeNull();
  });

  it("an escalation revokes a lower alert's claim: the stale sender can't mark it emailed", async () => {
    const { raiseAdminAlert, projectAdminAlertEmails } =
      await import("./admin-alerts");
    const key = randomUUID();
    const raise = (severity: "warning" | "critical") =>
      raiseAdminAlert({
        kind: "billing_inconsistent",
        severity,
        dedupe_key: key,
      });
    await raise("warning");
    const { rows: ids } = await getPool().query(
      "SELECT id FROM gpu_admin_alerts WHERE dedupe_key = $1",
      [key],
    );
    const id = ids[0].id;
    const recipients = async () => [
      { account_id: "a1", email_address: "a1@example.com" },
    ];
    const sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sending!: () => void;
    const started = new Promise<void>((r) => (sending = r));
    const old = projectAdminAlertEmails({
      recipients,
      send: async (a: any) => {
        if (a.id !== id) return;
        sent.push(a.severity);
        sending();
        await gate;
      },
    });
    await started;
    await raise("critical");
    release();
    await old;
    const state = async () =>
      (
        await getPool().query(
          "SELECT severity, emailed_at, emailed_to, email_claim FROM gpu_admin_alerts WHERE id = $1",
          [id],
        )
      ).rows[0];
    // the old claim's writes matched nothing; the hub moved on, claimed
    // the critical alert afresh and sent it
    expect(sent).toEqual(["warning", "critical"]);
    expect(await state()).toMatchObject({
      severity: "critical",
      emailed_to: ["a1"],
      email_claim: null,
    });
    expect((await state()).emailed_at).not.toBeNull();
    // and it is done: nothing more to send
    await projectAdminAlertEmails({
      recipients,
      send: async (a: any) => {
        if (a.id === id) sent.push(a.severity);
      },
    });
    expect(sent).toEqual(["warning", "critical"]);
  });

  it("a slow but healthy sender keeps its claim; a hung send is cut off; an expired claim is taken over", async () => {
    const { raiseAdminAlert, projectAdminAlertEmails } =
      await import("./admin-alerts");
    const key = randomUUID();
    await raiseAdminAlert({
      kind: "billing_inconsistent",
      severity: "critical",
      dedupe_key: key,
    });
    const { rows: ids } = await getPool().query(
      "SELECT id FROM gpu_admin_alerts WHERE dedupe_key = $1",
      [key],
    );
    const id = ids[0].id;
    const state = async () =>
      (
        await getPool().query(
          "SELECT emailed_at, email_attempts, emailed_to, email_claim FROM gpu_admin_alerts WHERE id = $1",
          [id],
        )
      ).rows[0];
    const admins = ["a1", "a2", "a3"].map((a) => ({
      account_id: a,
      email_address: `${a}@example.com`,
    }));
    const claimMs = 1000;
    // a hung send: cut off inside the claim, a failed attempt, claim freed
    const hung = await projectAdminAlertEmails({
      recipients: async () => admins.slice(0, 1),
      claimMs,
      send: async (a: any) => {
        if (a.id === id) await new Promise(() => {});
      },
    });
    expect(hung.failed).toBeGreaterThanOrEqual(1);
    expect(await state()).toMatchObject({
      emailed_at: null,
      email_attempts: 1,
      email_claim: null,
    });
    // a claim left by a dead hub is taken over once it expires
    await getPool().query(
      `UPDATE gpu_admin_alerts SET email_attempts = 0, email_claim = $2,
              email_claimed_until = now() + interval '1 hour' WHERE id = $1`,
      [id, randomUUID()],
    );
    const sent: string[] = [];
    const send = async (a: any, to: string) => {
      if (a.id !== id) return;
      sent.push(to);
      await new Promise((r) => setTimeout(r, 400));
    };
    await projectAdminAlertEmails({
      recipients: async () => admins,
      claimMs,
      send,
    });
    expect(sent).toEqual([]);
    await getPool().query(
      "UPDATE gpu_admin_alerts SET email_claimed_until = now() - interval '1 second' WHERE id = $1",
      [id],
    );
    // three sends of 400 ms outlast the 1 s claim; it is renewed before
    // each, so a second hub polling all along never duplicates one
    let done = false;
    const first = projectAdminAlertEmails({
      recipients: async () => admins,
      claimMs,
      send,
    }).finally(() => (done = true));
    while (!done) {
      await projectAdminAlertEmails({
        recipients: async () => admins,
        claimMs,
        send,
      });
      await new Promise((r) => setTimeout(r, 100));
    }
    await first;
    expect(sent.sort()).toEqual(admins.map((a) => a.email_address));
    expect((await state()).emailed_at).not.toBeNull();
  });
});
