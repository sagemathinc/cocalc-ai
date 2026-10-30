/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// A launch under a project funding approval, on the funder's home bay
// (PROJECT_FUNDING.md §3, §5), against a real (PGlite) database and a fake
// RunPod: exact-layer admission, agents and the window, payer and actor
// attribution, the key use bound to one approval, decrypt admission's
// recheck of that layer, and the decrypt audit's rule.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { GPU_LAUNCH_IMAGES } from "@cocalc/util/gpu/launch-spec";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { lockGpuAccountFence } from "./account-fence";
import { judgeDecrypt, type DecryptFacts } from "./decrypt-audit";
import {
  admitDecrypt,
  admitProjectKeyUse,
  KeyUseRefused,
  requireKeyUse,
} from "./key-use";
import { launchGpuPodLocal } from "./pods";
import {
  approveProjectFundingLocal,
  revokeProjectFundingLocal,
  verifyProjectFundedLaunch,
  type ProjectFundingDeps,
} from "./project-funding";
import {
  deliverProjectFundingMessageLocal,
  projectFundingStatusLocal,
  reserveProjectFundingSlotLocal,
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
        run_id: actor.kind === "agent" ? "run-1" : undefined,
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

describeDb("launches under a project funding approval", () => {
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

  it("reserves on the key layer and exactly its approval's layer; the pod records payer and actor apart", async () => {
    const s = await setup();
    const a = await approve(s);
    const launched = await funded(s, a);
    expect(await reservedOn(launched.id)).toEqual(["key", "project"]);
    expect(await pod(launched.id)).toMatchObject({
      key_owner_account_id: s.funder,
      beneficiary_account_id: s.funder,
      approval_id: a.approval_id,
      actor_kind: "project",
      actor_account_id: null,
      actor_project_id: s.project_id,
    });
    // a collaborator's launch: they are the beneficiary and the actor
    const theirs = await funded(s, a, { kind: "user", account_id: s.student });
    expect(await pod(theirs.id)).toMatchObject({
      key_owner_account_id: s.funder,
      beneficiary_account_id: s.student,
      actor_kind: "user",
      actor_account_id: s.student,
    });
  });

  it("is not blocked by an ended earlier approval of the same project", async () => {
    const s = await setup();
    const first = await approve(s);
    await revokeProjectFundingLocal(
      { account_id: s.funder, approval_id: first.approval_id },
      s.fundDeps,
    );
    const second = await approve(s);
    const launched = await funded(s, second);
    expect(await reservedOn(launched.id)).toEqual(["key", "project"]);
    await expect(funded(s, first)).rejects.toThrow(/revoked|no longer valid/);
  });

  it("refuses a forged or mismatched approval: unknown ids, another project's layer, a crossed pair", async () => {
    const s = await setup();
    const a = await approve(s);
    const other = await setup();
    // the other world's approval is another project's layer on another key
    const b = await approve(other);
    for (const bad of [
      { approval_id: randomUUID(), layer_id: a.layer_id },
      { approval_id: a.approval_id, layer_id: randomUUID() },
      { approval_id: b.approval_id, layer_id: b.layer_id },
    ]) {
      await expect(funded(s, bad)).rejects.toThrow(/no longer valid/);
    }
  });

  it("refuses agents when the approval doesn't allow them", async () => {
    const s = await setup();
    const a = await approve(s, { agents_allowed: false });
    await expect(
      funded(s, a, { kind: "agent", account_id: s.student }),
    ).rejects.toThrow(/doesn't allow agents/);
    await expect(funded(s, a, { kind: "project" })).resolves.toBeTruthy();
  });

  it("clips runtime to the approval's end", async () => {
    const s = await setup();
    const a = await approve(s);
    await getPool().query(
      `UPDATE gpu_budget_layers SET ends_at = now() + interval '30 minutes' WHERE approval_id = $1`,
      [a.approval_id],
    );
    await expect(funded(s, a)).rejects.toThrow(/must end by then/);
    await expect(
      funded(s, a, { kind: "project" }, { ...SPEC, max_runtime_minutes: 20 }),
    ).resolves.toBeTruthy();
  });

  it("holds the approval's amount: a launch that doesn't fit is refused", async () => {
    const s = await setup();
    const a = await approve(s, { authorized_usd: "0.75" });
    // $0.50/h for 60 min reserves $0.50: one fits, a second doesn't
    await funded(s, a);
    await expect(funded(s, a)).rejects.toThrow(/funding approval has/);
  });

  it("never applies a project layer to an own-key launch", async () => {
    const s = await setup();
    await approve(s);
    const own = await launchGpuPodLocal(
      {
        account_id: s.funder,
        project_id: s.project_id,
        spec: SPEC,
        key_use: testKeyUse("launch"),
      },
      s.podDeps,
    );
    expect(await reservedOn(own.id)).toEqual(["key"]);
    expect((await pod(own.id)).approval_id).toBeNull();
  });

  it("makes one pod per funded operation: a retry gets it back, never a second paid pod", async () => {
    const s = await setup();
    const a = await approve(s);
    await getPool().query(
      `UPDATE gpu_budget_layers SET max_concurrent_pods = 10
        WHERE credential_id = $1 AND scope_kind = 'key'`,
      [s.credential_id],
    );
    const agent = {
      kind: "agent" as const,
      account_id: s.student,
      operation_id: "op-1",
    };
    const first = await funded(s, a, agent);
    // the answer was lost; the agent retries the same operation
    const again = await funded(s, a, agent);
    expect(again.id).toBe(first.id);
    expect(s.rp.client.createPod).toHaveBeenCalledTimes(1);
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM gpu_pod_reservations WHERE pod_id = $1",
      [first.id],
    );
    expect(rows[0].n).toBe(2);
    const { rows: pods } = await getPool().query(
      "SELECT count(*)::int AS n FROM gpu_pods WHERE approval_id = $1",
      [a.approval_id],
    );
    expect(pods[0].n).toBe(1);
    // the same id for a different launch is refused
    await expect(
      funded(s, a, agent, { ...SPEC, max_runtime_minutes: 30 }),
    ).rejects.toThrow(/already used for a different launch/);
    // another agent's (or person's) same id is its own operation
    const other = await funded(s, a, { ...agent, agent_id: "agent:a2" });
    expect(other.id).not.toBe(first.id);
    const person = await funded(s, a, {
      kind: "user",
      account_id: s.student,
      operation_id: "op-1",
    });
    expect(person.id).not.toBe(first.id);
    expect(s.rp.client.createPod).toHaveBeenCalledTimes(3);
  });

  it("refuses a funded agent launch without an operation id at the boundary", async () => {
    await expect(
      verifyProjectFundedLaunch(
        {
          source_bay_id: "bay-p",
          project_id: randomUUID(),
          approval_id: randomUUID(),
          layer_id: randomUUID(),
          funder_account_id: randomUUID(),
          actor: {
            kind: "agent",
            account_id: randomUUID(),
            agent_id: "agent:a1",
          },
          spec: SPEC,
        },
        { assertSentByProjectBay: async () => {} },
      ),
    ).rejects.toThrow(/operation id/);
  });

  it("binds the key use to exactly one approval", async () => {
    const s = await setup();
    const a = await approve(s);
    const cap = await admitProjectKeyUse({
      key_owner_account_id: s.funder,
      purpose: "launch",
      binding: {
        project_id: s.project_id,
        approval_id: a.approval_id,
        layer_id: a.layer_id,
        source_bay_id: getConfiguredBayId(),
        actor_kind: "project",
      },
    });
    const same = {
      project_id: s.project_id,
      approval_id: a.approval_id,
      layer_id: a.layer_id,
      actor_kind: "project" as const,
    };
    expect(requireKeyUse(cap, ["launch"], s.funder, same)).toBe(cap);
    // another approval, an own-key call, another purpose: refused
    expect(() =>
      requireKeyUse(cap, ["launch"], s.funder, {
        ...same,
        approval_id: randomUUID(),
      }),
    ).toThrow(KeyUseRefused);
    expect(() => requireKeyUse(cap, ["launch"], s.funder)).toThrow(
      KeyUseRefused,
    );
    expect(() => requireKeyUse(cap, ["terminate"], s.funder, same)).toThrow(
      KeyUseRefused,
    );
  });

  it("binds the key use to exactly who acts: kind, account, agent and run", async () => {
    const s = await setup();
    const a = await approve(s);
    const base = {
      project_id: s.project_id,
      approval_id: a.approval_id,
      layer_id: a.layer_id,
    };
    const agent = {
      ...base,
      actor_kind: "agent" as const,
      actor_account_id: s.student,
      agent_id: "agent:a1",
      run_id: "run-1",
    };
    const cap = await admitProjectKeyUse({
      key_owner_account_id: s.funder,
      purpose: "launch",
      binding: { ...agent, source_bay_id: getConfiguredBayId() },
    });
    expect(requireKeyUse(cap, ["launch"], s.funder, agent)).toBe(cap);
    for (const other of [
      {
        ...agent,
        actor_kind: "user" as const,
        agent_id: undefined,
        run_id: undefined,
      },
      { ...agent, actor_account_id: s.funder },
      { ...agent, agent_id: "agent:a2" },
      { ...agent, run_id: "run-2" },
      { ...agent, run_id: undefined },
      { ...base, actor_kind: "project" as const },
    ]) {
      expect(() => requireKeyUse(cap, ["launch"], s.funder, other)).toThrow(
        KeyUseRefused,
      );
    }
    // a binding whose fields don't fit its kind is never made
    for (const bad of [
      { actor_kind: "project" as const, actor_account_id: s.student },
      { actor_kind: "user" as const },
      {
        actor_kind: "user" as const,
        actor_account_id: s.student,
        agent_id: "x",
      },
      { actor_kind: "agent" as const, actor_account_id: s.student },
    ]) {
      await expect(
        admitProjectKeyUse({
          key_owner_account_id: s.funder,
          purpose: "launch",
          binding: { ...base, source_bay_id: "bay-p", ...bad },
        }),
      ).rejects.toThrow(KeyUseRefused);
    }
    // the agent is recorded on the use, and is the decrypt's principal
    const { rows } = await getPool().query(
      "SELECT agent_id, agent_run_id, agent_project_id, principal_account_id FROM gpu_key_uses WHERE id = $1",
      [cap.id],
    );
    expect(rows[0]).toEqual({
      agent_id: "agent:a1",
      agent_run_id: "run-1",
      agent_project_id: s.project_id,
      principal_account_id: s.student,
    });
    const read = await admitProjectKeyUse({
      key_owner_account_id: s.funder,
      purpose: "pod_read",
      binding: { ...agent, source_bay_id: getConfiguredBayId() },
    });
    const id = await admitDecrypt(read, {
      account_id: s.funder,
      credential_id: s.credential_id,
    });
    const { rows: d } = await getPool().query(
      "SELECT principal FROM gpu_key_decrypts WHERE id = $1",
      [id],
    );
    expect(d[0].principal).toBe(`agent:${s.student}:agent:a1`);
  });

  it("applies a beneficiary layer only for a verified acting account, never the payer's for the project itself", async () => {
    const s = await setup();
    const a = await approve(s);
    // a beneficiary layer with nothing left, for the payer and for the student
    for (const who of [s.funder, s.student]) {
      await getPool().query(
        `INSERT INTO gpu_budget_layers (id, credential_id, key_owner_account_id, scope_kind,
           parent_id, parent_scope_kind, beneficiary_account_id, authorized_usd, state,
           starts_at, ends_at, created, updated)
         SELECT $1, credential_id, key_owner_account_id, 'beneficiary', id, 'key', $2, 0,
                'active', starts_at, ends_at, now(), now()
           FROM gpu_budget_layers WHERE credential_id = $3 AND scope_kind = 'key'`,
        [randomUUID(), who, s.credential_id],
      );
    }
    const theirs = await funded(s, a, { kind: "project" });
    expect(await reservedOn(theirs.id)).toEqual(["key", "project"]);
    expect((await pod(theirs.id)).beneficiary_account_id).toBe(s.funder);
    await expect(
      funded(s, a, { kind: "user", account_id: s.student }),
    ).rejects.toThrow(/beneficiary GPU budget has/);
  });

  it("admits a decrypt only while the exact layer is valid: a revoke in between refuses it", async () => {
    const s = await setup();
    const a = await approve(s);
    const binding = {
      project_id: s.project_id,
      approval_id: a.approval_id,
      layer_id: a.layer_id,
      source_bay_id: getConfiguredBayId(),
      actor_kind: "project" as const,
    };
    const key = { account_id: s.funder, credential_id: s.credential_id };
    const ok = await admitProjectKeyUse({
      key_owner_account_id: s.funder,
      purpose: "pod_read",
      binding,
    });
    const id = await admitDecrypt(ok, key);
    const { rows } = await getPool().query(
      "SELECT principal FROM gpu_key_decrypts WHERE id = $1",
      [id],
    );
    expect(rows[0].principal).toBe(`project:${s.project_id}`);
    const late = await admitProjectKeyUse({
      key_owner_account_id: s.funder,
      purpose: "pod_read",
      binding,
    });
    await revokeProjectFundingLocal(
      { account_id: s.funder, approval_id: a.approval_id },
      s.fundDeps,
    );
    await expect(admitDecrypt(late, key)).rejects.toThrow(KeyUseRefused);
    // a record for another approval's layer never admits
    const wrong = await admitProjectKeyUse({
      key_owner_account_id: s.funder,
      purpose: "pod_read",
      binding: { ...binding, layer_id: randomUUID() },
    });
    await expect(admitDecrypt(wrong, key)).rejects.toThrow(KeyUseRefused);
  });

  it("verifies the sender owns the project and the actor is well formed", async () => {
    const base = {
      source_bay_id: "bay-p",
      project_id: randomUUID(),
      approval_id: randomUUID(),
      layer_id: randomUUID(),
      funder_account_id: randomUUID(),
      spec: SPEC,
    };
    await expect(
      verifyProjectFundedLaunch(
        { ...base, actor: { kind: "project" } },
        {
          assertSentByProjectBay: async () => {
            throw Error("must come from its owning bay");
          },
        },
      ),
    ).rejects.toThrow(/owning bay/);
    const ok = { assertSentByProjectBay: async () => {} };
    for (const actor of [
      { kind: "owner" },
      { kind: "user" },
      { kind: "agent", account_id: randomUUID() },
    ]) {
      await expect(
        verifyProjectFundedLaunch({ ...base, actor: actor as any }, ok),
      ).rejects.toThrow();
    }
    const v = await verifyProjectFundedLaunch(
      { ...base, actor: { kind: "user", account_id: base.funder_account_id } },
      ok,
    );
    expect(v.binding).toMatchObject({
      approval_id: base.approval_id,
      layer_id: base.layer_id,
      source_bay_id: "bay-p",
      actor_kind: "user",
    });
  });
});

describe("the decrypt audit's rule for project uses", () => {
  const T0 = Date.parse("2026-11-01T12:00:00Z");
  const OWNER = "00000000-1000-4000-8000-000000000001";
  const CRED = "00000000-1000-4000-8000-000000000002";
  const PROJECT = "00000000-1000-4000-8000-000000000003";
  const APPROVAL = "00000000-1000-4000-8000-000000000004";
  const LAYER = "00000000-1000-4000-8000-000000000005";

  function facts(
    startedOffsetMs: number,
    layer: Partial<
      NonNullable<NonNullable<DecryptFacts["use"]>["project"]>["layer"]
    > = {},
  ): DecryptFacts {
    const started = new Date(T0 + startedOffsetMs);
    return {
      id: randomUUID(),
      purpose: "pod_read",
      key_owner_account_id: OWNER,
      credential_id: CRED,
      principal: `project:${PROJECT}`,
      bay_id: "bay-h",
      started,
      claimed_at: started,
      finished: started,
      key_use_id: "use",
      worker_run_id: null,
      worker_name: null,
      use: {
        key_owner_account_id: OWNER,
        credential_id: CRED,
        principal_account_id: OWNER,
        agent_id: null,
        purpose: "pod_read",
        authorized: true,
        bay_id: "bay-h",
        created: new Date(started.getTime() - 1),
        expires: new Date(started.getTime() + 30_000),
        max_decrypts: 3,
        decrypt_rows: 1,
        outcome: null,
        rule: "project",
        project: {
          project_id: PROJECT,
          approval_id: APPROVAL,
          layer_id: LAYER,
          actor_kind: "project",
          layer: {
            scope_kind: "project",
            approval_id: APPROVAL,
            project_id: PROJECT,
            key_owner_account_id: OWNER,
            credential_id: CRED,
            starts_at: new Date(T0),
            ends_at: new Date(T0 + 3600_000),
            ended_at: null,
            ...layer,
          },
        },
      },
      run: null,
    };
  }
  const later = {
    now: T0 + 7 * 24 * 3600_000,
    thisBay: "bay-h",
    homeBay: "bay-h",
  };

  it("explains a decrypt inside the approval, even when audited long after it ended", () => {
    expect(
      judgeDecrypt(facts(60_000, { ended_at: new Date(T0 + 120_000) }), later),
    ).toMatchObject({ mature: true, verdict: "explained" });
  });

  it("doesn't explain one at or after the end, nor after a recorded revoke", () => {
    expect(judgeDecrypt(facts(3600_000), later)).toMatchObject({
      verdict: "unexplained",
    });
    expect(
      judgeDecrypt(facts(60_000, { ended_at: new Date(T0 + 60_000) }), later),
    ).toMatchObject({ verdict: "unexplained" });
    expect(
      judgeDecrypt(facts(90_000, { ended_at: new Date(T0 + 60_000) }), later),
    ).toMatchObject({ verdict: "unexplained" });
  });

  it("doesn't explain one before the approval started, or bound to another layer", () => {
    expect(judgeDecrypt(facts(-1), later)).toMatchObject({
      verdict: "unexplained",
    });
    expect(
      judgeDecrypt(facts(60_000, { approval_id: LAYER }), later),
    ).toMatchObject({ verdict: "unexplained" });
    expect(
      judgeDecrypt(facts(60_000, { project_id: OWNER }), later),
    ).toMatchObject({ verdict: "unexplained" });
    const missing = facts(60_000);
    missing.use!.project!.layer = null;
    expect(judgeDecrypt(missing, later)).toMatchObject({
      verdict: "unexplained",
    });
  });

  it("explains an agent's project use under the agent's principal only", () => {
    const f = facts(60_000);
    f.use!.project!.actor_kind = "agent";
    f.use!.agent_id = "agent:a1";
    f.principal = `agent:${OWNER}:agent:a1`;
    expect(judgeDecrypt(f, later)).toMatchObject({ verdict: "explained" });
    f.principal = `project:${PROJECT}`;
    expect(judgeDecrypt(f, later)).toMatchObject({ verdict: "unexplained" });
  });

  it("doesn't explain a project use claiming another principal", () => {
    const f = facts(60_000);
    f.principal = OWNER;
    expect(judgeDecrypt(f, later)).toMatchObject({ verdict: "unexplained" });
  });
});
