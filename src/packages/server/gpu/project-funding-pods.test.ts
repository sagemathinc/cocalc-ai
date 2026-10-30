/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// A project's funded pods (PROJECT_FUNDING.md §7) against a real (PGlite)
// database: the approval's pod locator moving with its pods and reconciled,
// the binding check, the funder's read and terminate endpoints (only this
// project's pods, only its approvals), and the project's bay's fan-out
// (active or live routes, paging, an unreachable funder marked incomplete).

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { GPU_LAUNCH_IMAGES } from "@cocalc/util/gpu/launch-spec";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { lockGpuAccountFence } from "./account-fence";
import { launchGpuPodLocal, terminateGpuPodLocal } from "./pods";
import {
  approveProjectFundingLocal,
  checkProjectFundingBindings,
  deliverProjectFundingOutbox,
  projectPodsAtFunderLocal,
  projectTerminateAtFunderLocal,
  reconcileProjectFundingLocators,
  revokeProjectFundingLocal,
  type ProjectFundingDeps,
} from "./project-funding";
import {
  deliverProjectFundingMessageLocal,
  listProjectPodsLocal,
  projectFundingStatusLocal,
  reserveProjectFundingSlotLocal,
  terminateProjectPodLocal,
} from "./project-funding-routes";
import { freshInventoryForTests } from "./test-inventory";
import { testKeyUse } from "./key-use-testing";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const LIST_PRICE = 0.5;
const SPEC = {
  gpu_type_id: "NVIDIA GeForce RTX 4090",
  image: GPU_LAUNCH_IMAGES[0],
  max_runtime_minutes: 60,
};
const TERMS = {
  provider: "runpod",
  authorized_usd: "15",
  days: 7,
  agents_allowed: true,
};

function fakeRunpod() {
  const pods = new Map<string, any>();
  const client = {
    createPod: jest.fn(async (body: any) => {
      const pod = {
        id: `pod_${randomUUID().slice(0, 8)}`,
        name: body.name,
        status: "PROVISIONING",
        cost: LIST_PRICE,
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
    getPod: jest.fn(async (id: string) => pods.get(id)),
  };
  return { client, pods };
}

const fence = async (db: any, id: string, action: string) => {
  await db.query(
    "INSERT INTO accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [id],
  );
  await lockGpuAccountFence(db, id, action);
};

interface Setup {
  funder: string;
  student: string;
  project_id: string;
  credential_id: string;
  podDeps: any;
  fundDeps: ProjectFundingDeps;
  rp: ReturnType<typeof fakeRunpod>;
}

async function setup(): Promise<Setup> {
  const funder = randomUUID();
  const student = randomUUID();
  const project_id = randomUUID();
  const credential_id = randomUUID();
  const rp = fakeRunpod();
  await getPool().query(
    `INSERT INTO external_credentials (id, provider, kind, scope, owner_account_id,
       encrypted_payload, metadata, created, updated)
     VALUES ($1, 'runpod', 'gpu-provider-api-key', 'account', $2, 'x', '{}', now(), now())`,
    [credential_id, funder],
  );
  await getPool().query(
    `INSERT INTO projects (project_id, owning_bay_id, deleted, users) VALUES ($1, $2, false, $3)`,
    [
      project_id,
      getConfiguredBayId(),
      JSON.stringify({
        [funder]: { group: "owner" },
        [student]: { group: "collaborator" },
      }),
    ],
  );
  const routeDeps = { accountHomeBay: async () => getConfiguredBayId() };
  const fundDeps: ProjectFundingDeps = {
    credentialId: async () => credential_id,
    accountWriteFence: fence,
    projectBay: async () => ({
      reserve: (req) => reserveProjectFundingSlotLocal(req, routeDeps),
      deliver: (req) => deliverProjectFundingMessageLocal(req, routeDeps),
      status: (req) => projectFundingStatusLocal(req, routeDeps),
    }),
    assertSentByProjectBay: async () => {},
    funderName: async () => "Prof",
    routeDeps,
  };
  const podDeps = {
    isHomeBay: async () => true,
    isProjectCollaborator: async () => true,
    getLaunchAccess: async () => ({ client: rp.client as any, credential_id }),
    getCleanup: async () => ({ ...rp.client, credential_id }) as any,
    listPrice: async () => LIST_PRICE,
    accountWriteFence: fence,
    siteUrl: async () => "https://cocalc.test",
  };
  return {
    funder,
    student,
    project_id,
    credential_id,
    podDeps,
    fundDeps,
    rp,
  } as Setup;
}

async function approve(s: Setup, terms: Record<string, unknown> = {}) {
  return await approveProjectFundingLocal(
    {
      account_id: s.funder,
      project_id: s.project_id,
      terms: { ...TERMS, ...terms },
      operation_id: randomUUID(),
      fresh_auth_verified: true,
      raise_key_budget_to: "100",
    },
    s.fundDeps,
  );
}

function funded(
  s: Setup,
  a: { approval_id: string; layer_id: string },
  actor: {
    kind: "project" | "user" | "agent";
    account_id?: string;
    agent_id?: string;
    run_id?: string;
    operation_id?: string;
  } = {
    kind: "project",
  },
  spec: Record<string, unknown> = SPEC,
) {
  return launchGpuPodLocal(
    {
      account_id: s.funder,
      project_id: s.project_id,
      spec,
      key_use: testKeyUse("launch"),
      funding: {
        approval_id: a.approval_id,
        layer_id: a.layer_id,
        actor_kind: actor.kind,
        actor_account_id: actor.account_id,
        agent_id:
          actor.kind === "agent" ? (actor.agent_id ?? "agent:a1") : undefined,
        run_id: actor.kind === "agent" ? (actor.run_id ?? "run-1") : undefined,
        operation_id: actor.operation_id,
      },
    },
    s.podDeps,
  );
}

async function reservedOn(pod_id: string) {
  const { rows } = await getPool().query(
    `SELECT l.scope_kind FROM gpu_pod_reservations r JOIN gpu_budget_layers l ON l.id = r.layer_id
      WHERE r.pod_id = $1 ORDER BY l.scope_kind`,
    [pod_id],
  );
  return rows.map((r) => r.scope_kind);
}

async function pod(id: string) {
  return (await getPool().query("SELECT * FROM gpu_pods WHERE id = $1", [id]))
    .rows[0];
}

async function layerOf(approval_id: string) {
  return (
    await getPool().query(
      "SELECT * FROM gpu_budget_layers WHERE approval_id = $1",
      [approval_id],
    )
  ).rows[0];
}

async function routeOf(approval_id: string) {
  return (
    await getPool().query(
      "SELECT * FROM project_compute_approvals WHERE approval_id = $1",
      [approval_id],
    )
  ).rows[0];
}

async function deliver(s: Setup, approval_id: string) {
  await getPool().query(
    `UPDATE project_funding_outbox SET next_attempt_at = now() - interval '1 second'
      WHERE approval_id = $1`,
    [approval_id],
  );
  await deliverProjectFundingOutbox({ approval_id }, s.fundDeps);
}

const local = (s: Setup) => ({
  accountHomeBay: async () => getConfiguredBayId(),
  funderPods: async () => ({
    pods: (req: any) =>
      projectPodsAtFunderLocal(req, { assertSentByProjectBay: async () => {} }),
    terminate: (req: any) =>
      projectTerminateAtFunderLocal(req, {
        assertSentByProjectBay: async () => {},
      }),
  }),
});

describeDb("a project's funded pods", () => {
  beforeAll(async () => {
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS accounts (account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN)",
    );
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS projects (project_id UUID PRIMARY KEY, owning_bay_id TEXT, deleted BOOLEAN, users JSONB)",
    );
    await syncSchema({
      external_credentials: SCHEMA.external_credentials,
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
      gpu_agent_requests: SCHEMA.gpu_agent_requests,
      gpu_agent_grants: SCHEMA.gpu_agent_grants,
      gpu_key_uses: SCHEMA.gpu_key_uses,
      gpu_key_use_outcomes: SCHEMA.gpu_key_use_outcomes,
      gpu_key_decrypts: SCHEMA.gpu_key_decrypts,
      security_event_outbox: SCHEMA.security_event_outbox,
      project_compute_approvals: SCHEMA.project_compute_approvals,
      project_funding_outbox: SCHEMA.project_funding_outbox,
      project_rehome_imports: SCHEMA.project_rehome_imports,
    });
    await getPool().query(
      "INSERT INTO gpu_worker_leases (name, last_completed_at) VALUES ('reaper', now() + interval '10 years') ON CONFLICT (name) DO UPDATE SET last_completed_at = EXCLUDED.last_completed_at",
    );
    await freshInventoryForTests();
  });

  beforeEach(async () => {
    await freshInventoryForTests();
  });

  it("counts an approval's live pods from intent to end, and tells the project's bay", async () => {
    const s = await setup();
    const a = await approve(s);
    const pod = await funded(s, a);
    expect(await layerOf(a.approval_id)).toMatchObject({
      live_pods: 1,
      pods_version: 1,
    });
    await deliver(s, a.approval_id);
    expect(await routeOf(a.approval_id)).toMatchObject({
      live_pods: 1,
      pods_version: 1,
    });
    await terminateGpuPodLocal(
      {
        account_id: s.funder,
        pod_id: pod.id,
        key_use: testKeyUse("terminate"),
      },
      s.podDeps,
    );
    expect(await layerOf(a.approval_id)).toMatchObject({
      live_pods: 0,
      pods_version: 2,
    });
    await deliver(s, a.approval_id);
    expect(await routeOf(a.approval_id)).toMatchObject({
      live_pods: 0,
      pods_version: 2,
    });
  });

  it("reconciles a wrong count, including an ended approval recorded as zero with a live pod", async () => {
    const s = await setup();
    const a = await approve(s);
    await funded(s, a);
    await revokeProjectFundingLocal(
      { account_id: s.funder, approval_id: a.approval_id },
      s.fundDeps,
    );
    // an old bug left the ended approval at zero though its pod lives
    await getPool().query(
      "UPDATE gpu_budget_layers SET live_pods = 0 WHERE approval_id = $1",
      [a.approval_id],
    );
    expect(await reconcileProjectFundingLocators()).toBeGreaterThanOrEqual(1);
    const layer = await layerOf(a.approval_id);
    expect(layer.live_pods).toBe(1);
    await deliver(s, a.approval_id);
    const route = await routeOf(a.approval_id);
    expect(route).toMatchObject({ state: "ended", live_pods: 1 });
  });

  it("ends an approval whose funder left the project, or whose project was deleted", async () => {
    for (const lost of ["funder_left_project", "project_deleted"] as const) {
      const s = await setup();
      const a = await approve(s);
      await getPool().query(
        lost === "project_deleted"
          ? "UPDATE projects SET deleted = true WHERE project_id = $1"
          : "UPDATE projects SET users = users - $2 WHERE project_id = $1",
        lost === "project_deleted" ? [s.project_id] : [s.project_id, s.funder],
      );
      await checkProjectFundingBindings(s.fundDeps);
      expect(await layerOf(a.approval_id)).toMatchObject({
        state: "revoked",
        revoked_reason: lost,
      });
    }
    // a binding that holds is left alone
    const ok = await setup();
    const b = await approve(ok);
    await checkProjectFundingBindings(ok.fundDeps);
    expect((await layerOf(b.approval_id)).state).toBe("active");
  });

  it("serves only this project's pods of the named approvals, and terminates through the reaper", async () => {
    const s = await setup();
    const a = await approve(s);
    const mine = await funded(s, a);
    const other = await setup();
    const b = await approve(other);
    const theirs = await funded(other, b);
    const req = {
      source_bay_id: getConfiguredBayId(),
      project_id: s.project_id,
    };
    const ok = { assertSentByProjectBay: async () => {} };
    // another project's approval id doesn't reach its pod
    expect(
      (
        await projectPodsAtFunderLocal(
          { ...req, approval_ids: [a.approval_id, b.approval_id] },
          ok,
        )
      ).map((p) => p.id),
    ).toEqual([mine.id]);
    expect(
      await projectTerminateAtFunderLocal(
        {
          ...req,
          approval_ids: [a.approval_id, b.approval_id],
          pod_id: theirs.id,
          actor: { kind: "project" },
        },
        ok,
      ),
    ).toEqual({ found: false });
    const r = await projectTerminateAtFunderLocal(
      {
        ...req,
        approval_ids: [a.approval_id],
        pod_id: mine.id,
        actor: { kind: "user", account_id: s.student },
      },
      ok,
    );
    expect(r.found).toBe(true);
    const row = (
      await getPool().query("SELECT * FROM gpu_pods WHERE id = $1", [mine.id])
    ).rows[0];
    expect(row.desired_state).toBe("terminated");
    const ev = (
      await getPool().query(
        "SELECT actor_kind, actor_account_id FROM gpu_pod_events WHERE pod_id = $1 AND action = 'terminate'",
        [mine.id],
      )
    ).rows[0];
    expect(ev).toEqual({ actor_kind: "user", actor_account_id: s.student });
    // only the project's owning bay may ask
    await expect(
      projectPodsAtFunderLocal(
        { ...req, approval_ids: [a.approval_id] },
        {
          assertSentByProjectBay: async () => {
            throw Error("must come from its owning bay");
          },
        },
      ),
    ).rejects.toThrow(/owning bay/);
  });

  it("lists through every route that may still pay for a pod; an unreachable funder is incomplete, never hidden", async () => {
    const s = await setup();
    const a = await approve(s);
    await funded(s, a);
    await deliver(s, a.approval_id);
    // the approval ends while its pod lives: still listed
    await revokeProjectFundingLocal(
      { account_id: s.funder, approval_id: a.approval_id },
      s.fundDeps,
    );
    await deliver(s, a.approval_id);
    const page = await listProjectPodsLocal(
      { project_id: s.project_id, actor: { kind: "project" } },
      local(s),
    );
    expect(page.pods).toHaveLength(1);
    expect(page.incomplete).toEqual([]);
    const down = await listProjectPodsLocal(
      { project_id: s.project_id, actor: { kind: "project" } },
      {
        ...local(s),
        funderPods: async () => {
          throw Error("funder's bay is down");
        },
      },
    );
    expect(down.pods).toEqual([]);
    expect(down.incomplete).toEqual([
      { approval_id: a.approval_id, error: expect.stringContaining("down") },
    ]);
    // a non-collaborator sees nothing
    await expect(
      listProjectPodsLocal(
        {
          project_id: s.project_id,
          actor: { kind: "user", account_id: randomUUID() },
        },
        local(s),
      ),
    ).rejects.toThrow(/access denied/);
  });

  it("pages through many approvals", async () => {
    const s = await setup();
    // twelve ended approvals that still have a live pod each (by hand)
    for (let i = 0; i < 12; i++) {
      await getPool().query(
        `INSERT INTO project_compute_approvals
           (id, kind, project_id, provider, state, approval_id, funder_account_id,
            funder_bay_id, layer_id, version, ended_reason, ended_at, live_pods, pods_version)
         VALUES ($1, 'approval', $2, 'runpod', 'ended', $3, $4, 'bay-h', $5, 3,
                 'revoked', now(), 1, 1)`,
        [randomUUID(), s.project_id, randomUUID(), s.funder, randomUUID()],
      );
    }
    const asked: string[][] = [];
    const deps = {
      accountHomeBay: async () => getConfiguredBayId(),
      funderPods: async () => ({
        pods: async (req: any) => {
          asked.push(req.approval_ids);
          return [];
        },
        terminate: async () => ({ found: false }),
      }),
    };
    const first = await listProjectPodsLocal(
      { project_id: s.project_id, actor: { kind: "project" } },
      deps,
    );
    expect(first.next_cursor).toBe("10");
    const second = await listProjectPodsLocal(
      {
        project_id: s.project_id,
        actor: { kind: "project" },
        cursor: first.next_cursor,
      },
      deps,
    );
    expect(second.next_cursor).toBeUndefined();
    expect(asked.flat()).toHaveLength(12);
    expect(new Set(asked.flat()).size).toBe(12);
  });

  it("terminates from the project through whichever funder has the pod", async () => {
    const s = await setup();
    const a = await approve(s);
    const pod = await funded(s, a);
    await deliver(s, a.approval_id);
    expect(
      await terminateProjectPodLocal(
        {
          project_id: s.project_id,
          actor: { kind: "project" },
          pod_id: pod.id,
        },
        local(s),
      ),
    ).toMatchObject({ found: true });
    expect(
      await terminateProjectPodLocal(
        {
          project_id: s.project_id,
          actor: { kind: "project" },
          pod_id: "cc-aaaaaaaaaaaaaaaa",
        },
        local(s),
      ),
    ).toEqual({ found: false });
  });
});
