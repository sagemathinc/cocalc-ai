/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Agent launches race their grant's revoke, its expiry, each other and the
// human's retried approvals. All serialize on the account fence and then the
// grant row: in either order a one-launch grant admits at most one pod, a
// revoke leaves no pod launched without its (revoked) layer, and expiry only
// closes admission. Needs concurrent transactions, hence a real PostgreSQL;
// skips itself without the server binaries.

import { randomUUID } from "node:crypto";
import {
  postgresBinDir,
  startRealPostgres,
  waitForLockWaiters,
  type RealPostgres,
} from "@cocalc/server/test/real-postgres";

const describeRealPostgres = postgresBinDir() ? describe : describe.skip;

const PROJECT = "00000000-1000-4000-8000-0000000000aa";
const SPEC = {
  gpu_type_id: "NVIDIA GeForce RTX 4090",
  image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
  max_runtime_minutes: 60,
};

describeRealPostgres("agent GPU grants under concurrency", () => {
  let pg: RealPostgres;
  let getPool: any;
  let pods: typeof import("./pods");
  let api: typeof import("./agent-api");
  let grants: typeof import("./agent-grants");
  let lockGpuAccountFence: typeof import("./account-fence").lockGpuAccountFence;

  beforeAll(async () => {
    pg = startRealPostgres("gpu_agent_grants_test");
    getPool = (await import("@cocalc/database/pool")).default;
    const { SCHEMA } = await import("@cocalc/util/db-schema");
    const { syncSchema } =
      await import("@cocalc/database/postgres/schema/sync");
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
      gpu_agent_requests: SCHEMA.gpu_agent_requests,
      gpu_agent_grants: SCHEMA.gpu_agent_grants,
    });
    await getPool().query(
      "INSERT INTO gpu_worker_leases (name, last_completed_at) VALUES ('reaper', now() + interval '10 years') ON CONFLICT (name) DO UPDATE SET last_completed_at = EXCLUDED.last_completed_at",
    );
    pods = await import("./pods");
    api = await import("./agent-api");
    grants = await import("./agent-grants");
    lockGpuAccountFence = (await import("./account-fence")).lockGpuAccountFence;
  }, 120_000);

  afterAll(async () => {
    try {
      await getPool?.().end();
    } finally {
      pg?.stop();
    }
  });

  const gate = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };
  const query = (sql: string, values?: unknown[]) =>
    getPool().query(sql, values);

  // An approved one-launch grant for a chat session, and a fake RunPod.
  async function setup() {
    const account_id = randomUUID();
    const credential_id = randomUUID();
    await query("INSERT INTO accounts (account_id) VALUES ($1)", [account_id]);
    const created: string[] = [];
    const client = {
      createPod: jest.fn(async (body: any) => {
        const id = `pod_${randomUUID().slice(0, 8)}`;
        created.push(id);
        return { id, name: body.name, status: "PROVISIONING", cost: 0.5 };
      }),
      terminatePod: jest.fn(async () => {}),
      findPodsByName: jest.fn(async () => []),
      getPod: jest.fn(async () => undefined),
    };
    const key = `session:${"a".repeat(64)}`;
    const agent = {
      principal: {
        account_id,
        project_id: PROJECT,
        agent_id: key,
        run_id: key,
        expires_at: new Date(Date.now() + 10 * 60_000),
      },
      operation_id: "op-1",
    };
    // pauses a launch under the account fence, holding its grant row: the
    // key is read there a second time (the first prices the launch)
    let pause:
      | { underFence: () => void; until: Promise<void>; reads: number }
      | undefined;
    const deps = {
      isHomeBay: async () => true,
      isProjectCollaborator: async () => true,
      getLaunchAccess: async () => {
        if (pause && ++pause.reads === 2) {
          const p = pause;
          pause = undefined;
          p.underFence();
          await p.until;
        }
        return { client: client as any, credential_id };
      },
      listPrice: async () => 0.5,
    };
    const launch = () =>
      pods.launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC, agent },
        deps,
      );
    const ask = await launch().then(
      () => {
        throw Error("launched without approval");
      },
      (err) => {
        if (!(err instanceof grants.GpuAgentApprovalRequired)) throw err;
        return err;
      },
    );
    const approve = () =>
      api.approveAgentRequestLocal(
        {
          account_id,
          request_id: ask.request_id,
          expected_hash: ask.payload_hash,
          fresh_auth_verified: true,
        },
        { credentialId: async () => credential_id },
      );
    const grant = await approve();
    return {
      account_id,
      grant,
      created,
      launch,
      approve,
      pauseNextLaunch: () => {
        const held = gate();
        const go = gate();
        pause = { underFence: held.open, until: go.p, reads: 0 };
        return { held: held.p, go: go.open };
      },
    };
  }

  // a fence that, once taken, holds until opened
  function heldFence() {
    const held = gate();
    const go = gate();
    const accountWriteFence = (async (db: any, id: string, action: string) => {
      await lockGpuAccountFence(db, id, action);
      held.open();
      await go.p;
    }) as typeof lockGpuAccountFence;
    return { accountWriteFence, held: held.p, go: go.open };
  }

  const approvalRequired = (p: Promise<unknown>) =>
    expect(p).rejects.toBeInstanceOf(grants.GpuAgentApprovalRequired);

  async function layerOf(grant_id: string) {
    return (
      await query(
        "SELECT id, state, admission_closed_at FROM gpu_budget_layers WHERE grant_id = $1",
        [grant_id],
      )
    ).rows[0];
  }

  it("admits exactly one of several concurrent launches on a one-launch grant", async () => {
    const s = await setup();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => s.launch()),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(grants.GpuAgentApprovalRequired);
      }
    }
    expect(s.created).toHaveLength(1);
    const { rows } = await query(
      "SELECT launches_used FROM gpu_agent_grants WHERE grant_id = $1",
      [s.grant.grant_id],
    );
    expect(rows[0].launches_used).toBe(1);
  });

  it("launch first: the revoke waits, then revokes the layer the pod is reserved on", async () => {
    const s = await setup();
    const { held, go } = s.pauseNextLaunch();
    const launching = s.launch();
    await held;
    const revoking = api.revokeAgentGrantLocal({
      account_id: s.account_id,
      grant_id: s.grant.grant_id,
    });
    await waitForLockWaiters(query, 1);
    go();
    const pod = await launching;
    expect((await revoking).state).toBe("revoked");
    const layer = await layerOf(s.grant.grant_id);
    expect(layer.state).toBe("revoked");
    // the pod is the reaper's: it holds a reservation on the revoked layer
    const { rows } = await query(
      "SELECT 1 FROM gpu_pod_reservations WHERE pod_id = $1 AND layer_id = $2",
      [pod.id, layer.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("revoke first: the launch waits, then is refused and nothing reaches RunPod", async () => {
    const s = await setup();
    const fence = heldFence();
    const revoking = api.revokeAgentGrantLocal(
      { account_id: s.account_id, grant_id: s.grant.grant_id },
      { accountWriteFence: fence.accountWriteFence },
    );
    await fence.held;
    const launching = s.launch();
    await waitForLockWaiters(query, 1);
    fence.go();
    await revoking;
    await approvalRequired(launching);
    expect(s.created).toEqual([]);
  });

  it("launch first: expiry waits, then only closes admission; the layer stays active", async () => {
    const s = await setup();
    const { held, go } = s.pauseNextLaunch();
    const launching = s.launch();
    await held;
    const later = () => new Date(Date.now() + 24 * 3600_000);
    const closing = pods.inTransaction((db) =>
      grants.closeExpiredAgentGrant(
        db,
        { account_id: s.account_id, grant_id: s.grant.grant_id },
        { now: later },
      ),
    );
    await waitForLockWaiters(query, 1);
    go();
    await launching;
    expect(await closing).toBe(true);
    const layer = await layerOf(s.grant.grant_id);
    expect(layer.state).toBe("active");
    expect(layer.admission_closed_at).not.toBeNull();
    expect(s.created).toHaveLength(1);
  });

  it("expiry first: the launch waits, then is refused", async () => {
    const s = await setup();
    const fence = heldFence();
    const closing = pods.inTransaction((db) =>
      grants.closeExpiredAgentGrant(
        db,
        { account_id: s.account_id, grant_id: s.grant.grant_id },
        {
          accountWriteFence: fence.accountWriteFence,
          now: () => new Date(Date.now() + 24 * 3600_000),
        },
      ),
    );
    await fence.held;
    const launching = s.launch();
    await waitForLockWaiters(query, 1);
    fence.go();
    expect(await closing).toBe(true);
    await approvalRequired(launching);
    expect(s.created).toEqual([]);
  });

  it("retried approvals of one request make one grant and one layer", async () => {
    const s = await setup();
    const again = await Promise.all([s.approve(), s.approve(), s.approve()]);
    for (const g of again) expect(g.grant_id).toBe(s.grant.grant_id);
    const { rows } = await query(
      "SELECT count(*)::int AS n FROM gpu_budget_layers WHERE scope_kind = 'agent' AND grant_id = $1",
      [s.grant.grant_id],
    );
    expect(rows[0].n).toBe(1);
  });
});
