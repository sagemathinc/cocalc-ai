/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Agent GPU launches (step 6b) against a real (PGlite) database and a fake
// RunPod: the contract in STEP6.md. Concurrency is in
// agent-grants.concurrency.test.ts (real PostgreSQL).

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { GPU_LAUNCH_IMAGES } from "@cocalc/util/gpu/launch-spec";
import { lockGpuAccountFence } from "./account-fence";
import {
  agentLaunchPayload,
  agentPayloadHash,
  GpuAgentApprovalRequired,
  type GpuAgentPrincipal,
} from "./agent-grants";
import {
  approveAgentRequestLocal,
  closeExpiredAgentGrants,
  listAgentRequestsLocal,
  revokeAgentGrantLocal,
} from "./agent-api";
import {
  killSwitchLocal,
  launchGpuPodLocal,
  listManagedGpuPodsLocal,
  terminateGpuPodLocal,
  whoGpuPodLocal,
} from "./pods";
import { gpuSshInfoLocal } from "./hostkey";
import { runGpuReaperSweep } from "./reaper";
import { resumeGpuLaunchesLocal } from "./budget-api";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const PROJECT = "00000000-1000-4000-8000-0000000000aa";
const OTHER_PROJECT = "00000000-1000-4000-8000-0000000000bb";
const LIST_PRICE = 0.5;
const SPEC = {
  gpu_type_id: "NVIDIA GeForce RTX 4090",
  image: GPU_LAUNCH_IMAGES[0],
  max_runtime_minutes: 60,
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

function setup(now = () => Date.now()) {
  const account_id = randomUUID();
  const credential_id = randomUUID();
  const rp = fakeRunpod();
  const deps = {
    isHomeBay: async () => true,
    isProjectCollaborator: async () => true,
    getLaunchAccess: async () => ({ client: rp.client as any, credential_id }),
    getCleanup: async () => ({ ...rp.client, credential_id }) as any,
    listPrice: async () => LIST_PRICE,
    accountWriteFence: fence,
    siteUrl: async () => "https://cocalc.test",
    now,
  };
  const approveDeps = {
    accountWriteFence: fence,
    credentialId: async () => credential_id,
    now: () => new Date(now()),
  };
  return { account_id, credential_id, rp, deps, approveDeps };
}

function principal(
  account_id: string,
  over: Partial<GpuAgentPrincipal> = {},
): GpuAgentPrincipal {
  const key = `session:${"a".repeat(64)}`;
  return {
    account_id,
    project_id: PROJECT,
    agent_id: key,
    run_id: key,
    expires_at: new Date(Date.now() + 10 * 60_000),
    ...over,
  };
}

async function askedFor(
  p: Promise<unknown>,
): Promise<GpuAgentApprovalRequired> {
  try {
    await p;
  } catch (err) {
    if (err instanceof GpuAgentApprovalRequired) return err;
    throw err;
  }
  throw Error("the launch was admitted without approval");
}

async function count(sql: string, values: unknown[]): Promise<number> {
  return (await getPool().query(sql, values)).rows[0].n;
}

describe("the approved payload", () => {
  it("is canonical: the same launch hashes the same, and the SSH key doesn't count", () => {
    const a = agentLaunchPayload({ ...SPEC, gpu_count: 1 } as any, 0.5);
    const b = agentLaunchPayload(
      {
        gpu_count: 1,
        max_runtime_minutes: 60,
        image: SPEC.image,
        gpu_type_id: SPEC.gpu_type_id,
        ssh_public_key:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
      } as any,
      0.5,
    );
    expect(b.payload_hash).toBe(a.payload_hash);
    expect(a.payload).toEqual({
      spec: { ...SPEC, gpu_count: 1 },
      hourly_usd: "0.5000000000",
      max_cost_usd: "0.50",
      max_pods: 1,
    });
    // anything else is a different launch
    expect(
      agentLaunchPayload({ ...SPEC, gpu_count: 2 } as any, 0.5).payload_hash,
    ).not.toBe(a.payload_hash);
    expect(agentPayloadHash(a.payload)).toBe(a.payload_hash);
  });
});

describeDb("agent GPU launches", () => {
  beforeAll(async () => {
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS accounts (account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN)",
    );
    await syncSchema({
      external_credentials: SCHEMA.external_credentials,
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
  });

  it("asks for approval, recording only an immutable request; the same ask reuses it", async () => {
    const { account_id, rp, deps } = setup();
    const agent = { principal: principal(account_id), operation_id: "op-1" };
    const ask = await askedFor(
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC, agent },
        deps,
      ),
    );
    expect(ask.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ask.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    // the message names the request, never a key
    expect(ask.message).toContain(ask.request_id);
    expect(ask.message).not.toContain("session:");
    expect(rp.client.createPod).not.toHaveBeenCalled();
    expect(
      await count(
        "SELECT count(*)::int AS n FROM gpu_pods WHERE key_owner_account_id = $1",
        [account_id],
      ),
    ).toBe(0);
    const again = await askedFor(
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC, agent },
        deps,
      ),
    );
    expect(again.request_id).toBe(ask.request_id);
    // what the human sees: exactly the stored payload and hash, and "this
    // chat session", never the derived key
    const [view] = await listAgentRequestsLocal({ account_id });
    expect(view).toMatchObject({
      request_id: ask.request_id,
      payload_hash: ask.payload_hash,
      principal_kind: "chat_session",
      state: "pending",
      operation_id: "op-1",
    });
    expect(view.payload).toEqual(ask.payload);
    expect(JSON.stringify(view)).not.toContain("session:");
  });

  it("supersedes the older request when the agent changes the launch", async () => {
    const { account_id, deps } = setup();
    const agent = { principal: principal(account_id), operation_id: "op-1" };
    const first = await askedFor(
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC, agent },
        deps,
      ),
    );
    const second = await askedFor(
      launchGpuPodLocal(
        {
          account_id,
          project_id: PROJECT,
          spec: { ...SPEC, max_runtime_minutes: 120 },
          agent,
        },
        deps,
      ),
    );
    expect(second.request_id).not.toBe(first.request_id);
    const states = await getPool().query(
      "SELECT request_id, state FROM gpu_agent_requests WHERE account_id = $1",
      [account_id],
    );
    expect(
      Object.fromEntries(states.rows.map((r: any) => [r.request_id, r.state])),
    ).toEqual({
      [first.request_id]: "superseded",
      [second.request_id]: "pending",
    });
  });

  it("ends a pending request past its expiry when the agent asks again", async () => {
    const { account_id, deps } = setup();
    const agent = { principal: principal(account_id), operation_id: "op-1" };
    const launch = () =>
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC, agent },
        deps,
      );
    const first = await askedFor(launch());
    await getPool().query(
      "UPDATE gpu_agent_requests SET expires_at = now() - interval '1 minute' WHERE request_id = $1",
      [first.request_id],
    );
    const second = await askedFor(launch());
    expect(second.request_id).not.toBe(first.request_id);
    const { rows } = await getPool().query(
      "SELECT request_id, state FROM gpu_agent_requests WHERE account_id = $1",
      [account_id],
    );
    expect(
      Object.fromEntries(rows.map((r: any) => [r.request_id, r.state])),
    ).toEqual({
      [first.request_id]: "expired",
      [second.request_id]: "pending",
    });
  });

  it("keeps at most one pending request per agent run and operation", async () => {
    const { account_id, deps } = setup();
    const p = principal(account_id);
    const ask = await askedFor(
      launchGpuPodLocal(
        {
          account_id,
          project_id: PROJECT,
          spec: SPEC,
          agent: { principal: p, operation_id: "op-1" },
        },
        deps,
      ),
    );
    await expect(
      getPool().query(
        `INSERT INTO gpu_agent_requests (request_id, account_id, project_id, agent_id, run_id,
           operation_id, payload, payload_hash, state, created, expires_at)
         SELECT $1, account_id, project_id, agent_id, run_id, operation_id, payload,
           payload_hash, 'pending', now(), expires_at FROM gpu_agent_requests WHERE request_id = $2`,
        [randomUUID(), ask.request_id],
      ),
    ).rejects.toThrow(/duplicate|unique/);
  });

  it("approves exactly the reviewed request, with fresh auth, idempotently", async () => {
    const { account_id, deps, approveDeps, credential_id } = setup();
    const agent = { principal: principal(account_id), operation_id: "op-1" };
    const ask = await askedFor(
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC, agent },
        deps,
      ),
    );
    const base = { account_id, request_id: ask.request_id };
    await expect(
      approveAgentRequestLocal(
        { ...base, expected_hash: ask.payload_hash },
        approveDeps,
      ),
    ).rejects.toThrow("sign in again");
    await expect(
      approveAgentRequestLocal(
        { ...base, expected_hash: "0".repeat(64), fresh_auth_verified: true },
        approveDeps,
      ),
    ).rejects.toThrow("isn't the one you reviewed");
    // another account can't approve it
    await expect(
      approveAgentRequestLocal(
        {
          account_id: randomUUID(),
          request_id: ask.request_id,
          expected_hash: ask.payload_hash,
          fresh_auth_verified: true,
        },
        approveDeps,
      ),
    ).rejects.toThrow("No such GPU request");
    const grant = await approveAgentRequestLocal(
      { ...base, expected_hash: ask.payload_hash, fresh_auth_verified: true },
      approveDeps,
    );
    expect(grant).toMatchObject({
      request_id: ask.request_id,
      state: "active",
    });
    // retried: the same grant, nothing new
    expect(
      await approveAgentRequestLocal(
        { ...base, expected_hash: ask.payload_hash, fresh_auth_verified: true },
        approveDeps,
      ),
    ).toEqual(grant);
    // its layer: exactly the approved launch
    const { rows } = await getPool().query(
      "SELECT * FROM gpu_budget_layers WHERE grant_id = $1",
      [grant.grant_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope_kind: "agent",
      credential_id,
      project_id: PROJECT,
      state: "active",
      max_concurrent_pods: 1,
      max_gpu_count: 1,
      max_runtime_minutes: 60,
      allowed_gpu_type_ids: [SPEC.gpu_type_id],
      cloud: "SECURE",
      admission_closed_at: null,
    });
    expect(Number(rows[0].authorized_usd)).toBe(
      Number(ask.payload.max_cost_usd),
    );
    expect(Number(rows[0].max_hourly_usd)).toBe(0.5);
  });

  it("launches once on the approved grant, recording the agent; then asks again", async () => {
    const { account_id, rp, deps, approveDeps } = setup();
    const p = principal(account_id);
    const agent = { principal: p, operation_id: "op-1" };
    const ask = await askedFor(
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC, agent },
        deps,
      ),
    );
    const grant = await approveAgentRequestLocal(
      {
        account_id,
        request_id: ask.request_id,
        expected_hash: ask.payload_hash,
        fresh_auth_verified: true,
      },
      approveDeps,
    );
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC, agent },
      deps,
    );
    expect(rp.client.createPod).toHaveBeenCalledTimes(1);
    const row = (
      await getPool().query(
        "SELECT agent_id, turn_id FROM gpu_pods WHERE id = $1",
        [pod.id],
      )
    ).rows[0];
    expect(row).toEqual({ agent_id: p.agent_id, turn_id: p.run_id });
    // reserved on the grant's layer and the key layer
    const kinds = await getPool().query(
      `SELECT l.scope_kind FROM gpu_pod_reservations r JOIN gpu_budget_layers l ON l.id = r.layer_id
        WHERE r.pod_id = $1 ORDER BY l.scope_kind`,
      [pod.id],
    );
    expect(kinds.rows.map((r: any) => r.scope_kind)).toEqual(["agent", "key"]);
    expect(
      await count(
        "SELECT launches_used AS n FROM gpu_agent_grants WHERE grant_id = $1",
        [grant.grant_id],
      ),
    ).toBe(1);
    // the grant is one launch: the same launch again needs a new approval
    const again = await askedFor(
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC, agent },
        deps,
      ),
    );
    expect(again.request_id).not.toBe(ask.request_id);
    expect(rp.client.createPod).toHaveBeenCalledTimes(1);
  });

  it("admits nothing for another session, project or account, or another launch", async () => {
    const { account_id, rp, deps, approveDeps } = setup();
    const p = principal(account_id);
    const agent = { principal: p, operation_id: "op-1" };
    const ask = await askedFor(
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC, agent },
        deps,
      ),
    );
    await approveAgentRequestLocal(
      {
        account_id,
        request_id: ask.request_id,
        expected_hash: ask.payload_hash,
        fresh_auth_verified: true,
      },
      approveDeps,
    );
    const otherSession = `session:${"b".repeat(64)}`;
    for (const [project_id, who] of [
      // a different chat session
      [
        PROJECT,
        principal(account_id, { agent_id: otherSession, run_id: otherSession }),
      ],
      // a registered agent can't use a session's grant, even with the same run key
      [
        PROJECT,
        principal(account_id, { agent_id: "agent:x", run_id: p.run_id }),
      ],
      // the same session key in another project
      [OTHER_PROJECT, principal(account_id, { project_id: OTHER_PROJECT })],
    ] as const) {
      await askedFor(
        launchGpuPodLocal(
          {
            account_id,
            project_id,
            spec: SPEC,
            agent: { principal: who, operation_id: "op-1" },
          },
          deps,
        ),
      );
    }
    // another operation, or another launch, of the same session
    await askedFor(
      launchGpuPodLocal(
        {
          account_id,
          project_id: PROJECT,
          spec: SPEC,
          agent: { principal: p, operation_id: "op-2" },
        },
        deps,
      ),
    );
    await askedFor(
      launchGpuPodLocal(
        {
          account_id,
          project_id: PROJECT,
          spec: { ...SPEC, gpu_count: 2 },
          agent,
        },
        deps,
      ),
    );
    // a principal of another account is refused outright
    await expect(
      launchGpuPodLocal(
        {
          account_id,
          project_id: PROJECT,
          spec: SPEC,
          agent: { principal: principal(randomUUID()), operation_id: "op-1" },
        },
        deps,
      ),
    ).rejects.toThrow("only in its own project");
    expect(rp.client.createPod).not.toHaveBeenCalled();
    // the same session (a refreshed token, same fingerprint) still can
    await launchGpuPodLocal(
      {
        account_id,
        project_id: PROJECT,
        spec: SPEC,
        agent: {
          principal: { ...p, expires_at: new Date(Date.now() + 20 * 60_000) },
          operation_id: "op-1",
        },
      },
      deps,
    );
    expect(rp.client.createPod).toHaveBeenCalledTimes(1);
  });

  it("never applies an agent layer to a human launch", async () => {
    const { account_id, deps, approveDeps } = setup();
    const agent = { principal: principal(account_id), operation_id: "op-1" };
    const ask = await askedFor(
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC, agent },
        deps,
      ),
    );
    await approveAgentRequestLocal(
      {
        account_id,
        request_id: ask.request_id,
        expected_hash: ask.payload_hash,
        fresh_auth_verified: true,
      },
      approveDeps,
    );
    const human = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      deps,
    );
    const kinds = await getPool().query(
      `SELECT l.scope_kind FROM gpu_pod_reservations r JOIN gpu_budget_layers l ON l.id = r.layer_id
        WHERE r.pod_id = $1`,
      [human.id],
    );
    expect(kinds.rows.map((r: any) => r.scope_kind)).toEqual(["key"]);
  });

  it("at expiry closes admission only; its pod keeps running", async () => {
    let t = Date.now();
    const { account_id, deps, approveDeps } = setup(() => t);
    const p = principal(account_id, { expires_at: new Date(t + 5 * 60_000) });
    const agent = { principal: p, operation_id: "op-1" };
    const ask = await askedFor(
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC, agent },
        deps,
      ),
    );
    const grant = await approveAgentRequestLocal(
      {
        account_id,
        request_id: ask.request_id,
        expected_hash: ask.payload_hash,
        fresh_auth_verified: true,
      },
      approveDeps,
    );
    // past the run's end: no launch, even before any cleanup runs
    t += 6 * 60_000;
    await askedFor(
      launchGpuPodLocal(
        {
          account_id,
          project_id: PROJECT,
          spec: SPEC,
          agent: {
            principal: { ...p, expires_at: new Date(t + 5 * 60_000) },
            operation_id: "op-1",
          },
        },
        deps,
      ),
    );
    await getPool().query(
      "UPDATE gpu_agent_grants SET expires_at = now() - interval '1 minute' WHERE grant_id = $1",
      [grant.grant_id],
    );
    expect(
      await closeExpiredAgentGrants({ accountWriteFence: fence }),
    ).toBeGreaterThanOrEqual(1);
    const layer = (
      await getPool().query(
        "SELECT state, admission_closed_at FROM gpu_budget_layers WHERE grant_id = $1",
        [grant.grant_id],
      )
    ).rows[0];
    expect(layer.state).toBe("active");
    expect(layer.admission_closed_at).not.toBeNull();
    expect(
      (
        await getPool().query(
          "SELECT state FROM gpu_agent_grants WHERE grant_id = $1",
          [grant.grant_id],
        )
      ).rows[0].state,
    ).toBe("expired");
  });

  it("an explicit revoke revokes the layer (its pods are the reaper's) and blocks launches", async () => {
    const { account_id, rp, deps, approveDeps } = setup();
    const agent = { principal: principal(account_id), operation_id: "op-1" };
    const ask = await askedFor(
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC, agent },
        deps,
      ),
    );
    const grant = await approveAgentRequestLocal(
      {
        account_id,
        request_id: ask.request_id,
        expected_hash: ask.payload_hash,
        fresh_auth_verified: true,
      },
      approveDeps,
    );
    // another account can't revoke it
    await expect(
      revokeAgentGrantLocal(
        { account_id: randomUUID(), grant_id: grant.grant_id },
        { accountWriteFence: fence },
      ),
    ).rejects.toThrow("No such agent GPU approval");
    const revoked = await revokeAgentGrantLocal(
      { account_id, grant_id: grant.grant_id },
      { accountWriteFence: fence },
    );
    expect(revoked.state).toBe("revoked");
    // idempotent
    expect(
      (
        await revokeAgentGrantLocal(
          { account_id, grant_id: grant.grant_id },
          { accountWriteFence: fence },
        )
      ).state,
    ).toBe("revoked");
    const layer = (
      await getPool().query(
        "SELECT state, revoked_reason FROM gpu_budget_layers WHERE grant_id = $1",
        [grant.grant_id],
      )
    ).rows[0];
    expect(layer).toEqual({ state: "revoked", revoked_reason: "owner" });
    await askedFor(
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC, agent },
        deps,
      ),
    );
    expect(rp.client.createPod).not.toHaveBeenCalled();
  });

  it("lets an agent see and terminate only the pods it launched in its project", async () => {
    const { account_id, deps, approveDeps } = setup();
    const p = principal(account_id);
    const agent = { principal: p, operation_id: "op-1" };
    const ask = await askedFor(
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC, agent },
        deps,
      ),
    );
    await approveAgentRequestLocal(
      {
        account_id,
        request_id: ask.request_id,
        expected_hash: ask.payload_hash,
        fresh_auth_verified: true,
      },
      approveDeps,
    );
    const mine = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC, agent },
      deps,
    );
    const human = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      deps,
    );
    const scope = {
      project_id: PROJECT,
      agent_id: p.agent_id,
      run_id: p.run_id,
    };
    const otherKey = `session:${"c".repeat(64)}`;
    const other = { project_id: PROJECT, agent_id: otherKey, run_id: otherKey };
    // the same agent in a later run is a different principal
    const laterRun = { ...scope, run_id: "a-later-run" };
    const listed = await listManagedGpuPodsLocal(
      { account_id, agent: scope },
      deps,
    );
    expect(listed.map((x) => x.handle)).toEqual([mine.handle]);
    // the session's key never leaves the server, to the agent or the human
    expect(listed[0].agent_id).toBe("chat-session");
    const seen = JSON.stringify([
      listed,
      await listManagedGpuPodsLocal({ account_id }, deps),
      await whoGpuPodLocal({ account_id, query: mine.handle }, deps),
    ]);
    expect(seen).not.toContain("session:");
    expect(seen).not.toContain("a".repeat(64));
    for (const nobody of [other, laterRun]) {
      expect(
        await listManagedGpuPodsLocal({ account_id, agent: nobody }, deps),
      ).toEqual([]);
      await expect(
        gpuSshInfoLocal(
          { account_id, pod_id: mine.handle, agent: nobody },
          deps,
        ),
      ).rejects.toThrow("No such GPU pod");
    }
    await expect(
      terminateGpuPodLocal(
        { account_id, pod_id: mine.handle, agent: laterRun },
        deps,
      ),
    ).rejects.toThrow("No such GPU pod");
    expect(
      await whoGpuPodLocal(
        { account_id, query: human.handle, agent: scope },
        deps,
      ),
    ).toEqual([]);
    await expect(
      gpuSshInfoLocal({ account_id, pod_id: human.handle, agent: scope }, deps),
    ).rejects.toThrow("No such GPU pod");
    // another session can't clean up this session's pod, nor the human's
    await expect(
      terminateGpuPodLocal(
        { account_id, pod_id: mine.handle, agent: other },
        deps,
      ),
    ).rejects.toThrow("No such GPU pod");
    await expect(
      terminateGpuPodLocal(
        { account_id, pod_id: human.handle, agent: scope },
        deps,
      ),
    ).rejects.toThrow("No such GPU pod");
    // the same session can, after its run (no grant needed)
    expect(
      (
        await terminateGpuPodLocal(
          { account_id, pod_id: mine.handle, agent: scope },
          deps,
        )
      ).state,
    ).toMatch(/terminat/);
  });

  it("the reaper terminates exactly a revoked grant's pod, and none at expiry", async () => {
    const { account_id, rp, deps, approveDeps, credential_id } = setup();
    // two chat sessions, each with an approved launch, and a human's pod
    const launched: { grant_id: string; pod_id: string }[] = [];
    for (const c of ["d", "e"]) {
      const key = `session:${c.repeat(64)}`;
      const agent = {
        principal: principal(account_id, { agent_id: key, run_id: key }),
        operation_id: "op-1",
      };
      const ask = await askedFor(
        launchGpuPodLocal(
          { account_id, project_id: PROJECT, spec: SPEC, agent },
          deps,
        ),
      );
      const grant = await approveAgentRequestLocal(
        {
          account_id,
          request_id: ask.request_id,
          expected_hash: ask.payload_hash,
          fresh_auth_verified: true,
        },
        approveDeps,
      );
      const pod = await launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC, agent },
        deps,
      );
      launched.push({ grant_id: grant.grant_id, pod_id: pod.id });
    }
    // room for a third pod at once (the key's default is two)
    await getPool().query(
      "UPDATE gpu_budget_layers SET max_concurrent_pods = 3 WHERE credential_id = $1 AND scope_kind = 'key'",
      [credential_id],
    );
    const human = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      deps,
    );
    const state = async (id: string) =>
      (await getPool().query("SELECT state FROM gpu_pods WHERE id = $1", [id]))
        .rows[0].state;
    const reap = () =>
      runGpuReaperSweep({ ...deps, isEntitled: async () => true });
    // the first session's run ends: admission closes, its pod keeps running
    await getPool().query(
      "UPDATE gpu_agent_grants SET expires_at = now() - interval '1 minute' WHERE grant_id = $1",
      [launched[0].grant_id],
    );
    await closeExpiredAgentGrants({ accountWriteFence: fence });
    await reap();
    expect(rp.client.terminatePod).not.toHaveBeenCalled();
    // the human revokes the second session's approval: only its pod goes
    await revokeAgentGrantLocal(
      { account_id, grant_id: launched[1].grant_id },
      { accountWriteFence: fence },
    );
    await reap();
    expect(await state(launched[1].pod_id)).toMatch(/terminat/);
    expect(await state(launched[0].pod_id)).not.toMatch(/terminat|failed/);
    expect(await state(human.id)).not.toMatch(/terminat|failed/);
    expect(rp.client.terminatePod).toHaveBeenCalledTimes(1);
  });

  // an approved grant for a chat session (its key connected, so the kill
  // switch pauses it), and one pending request in the same project
  async function killSetup(project_id = PROJECT) {
    const s = setup();
    await getPool().query(
      "INSERT INTO external_credentials (id, provider, kind, scope, owner_account_id, encrypted_payload, created, updated) VALUES ($1, 'runpod', 'gpu-provider-api-key', 'account', $2, 'x', now(), now())",
      [s.credential_id, s.account_id],
    );
    const ask = async (c: string, project: string) => {
      const key = `session:${c.repeat(64)}`;
      const agent = {
        principal: principal(s.account_id, {
          agent_id: key,
          run_id: key,
          project_id: project,
        }),
        operation_id: "op-1",
      };
      const req = await askedFor(
        launchGpuPodLocal(
          { account_id: s.account_id, project_id: project, spec: SPEC, agent },
          s.deps,
        ),
      );
      return { agent, req };
    };
    const approved = await ask("1", project_id);
    const grant = await approveAgentRequestLocal(
      {
        account_id: s.account_id,
        request_id: approved.req.request_id,
        expected_hash: approved.req.payload_hash,
        fresh_auth_verified: true,
      },
      s.approveDeps,
    );
    const pending = await ask("2", project_id);
    const launch = (agent = approved.agent) =>
      launchGpuPodLocal(
        {
          account_id: s.account_id,
          project_id: agent.principal.project_id,
          spec: SPEC,
          agent,
        },
        s.deps,
      );
    const approve = (req = pending.req) =>
      approveAgentRequestLocal(
        {
          account_id: s.account_id,
          request_id: req.request_id,
          expected_hash: req.payload_hash,
          fresh_auth_verified: true,
        },
        s.approveDeps,
      );
    const grantState = async (grant_id = grant.grant_id) =>
      (
        await getPool().query(
          "SELECT g.state, g.launches_used, l.state AS layer FROM gpu_agent_grants g JOIN gpu_budget_layers l ON l.id = g.layer_id WHERE g.grant_id = $1",
          [grant_id],
        )
      ).rows[0];
    return { ...s, ask, grant, pending, launch, approve, grantState };
  }

  it("the kill switch revokes an agent's grant, and its pause refuses even a new approval's launch", async () => {
    const k = await killSetup();
    expect(
      (await killSwitchLocal({ account_id: k.account_id }, k.deps)).paused,
    ).toBe(true);
    expect(await k.grantState()).toEqual({
      state: "revoked",
      launches_used: 0,
      layer: "revoked",
    });
    const { rows } = await getPool().query(
      "SELECT after FROM gpu_budget_events WHERE action = 'revoke' AND after->>'grant_id' = $1",
      [k.grant.grant_id],
    );
    expect(rows.map((r: any) => r.after.reason)).toEqual(["kill_switch"]);
    // the old grant is gone: the agent asks again
    const again = await askedFor(k.launch());
    // approved during the pause, the launch is still refused at the key's
    // fence, and the new grant stays unused
    const fresh = await k.approve(again);
    await expect(k.launch()).rejects.toThrow("paused by your kill switch");
    expect(k.rp.client.createPod).not.toHaveBeenCalled();
    expect((await k.grantState(fresh.grant_id)).launches_used).toBe(0);
  });

  it("after kill and resume, the old grant stays revoked: the human approves again", async () => {
    const k = await killSetup();
    await killSwitchLocal({ account_id: k.account_id }, k.deps);
    await resumeGpuLaunchesLocal(
      { account_id: k.account_id, fresh_auth_verified: true },
      { accountWriteFence: fence },
    );
    // the same launch asks again: a new request, nothing launched
    const again = await askedFor(k.launch());
    expect(again.request_id).not.toBe(k.grant.request_id);
    expect(k.rp.client.createPod).not.toHaveBeenCalled();
    expect((await k.grantState()).state).toBe("revoked");
    // and only a new approval launches it
    await k.approve(again);
    await k.launch();
    expect(k.rp.client.createPod).toHaveBeenCalledTimes(1);
  });

  it("a request pending at the kill can't be approved after it", async () => {
    const k = await killSetup();
    await killSwitchLocal({ account_id: k.account_id }, k.deps);
    await expect(k.approve()).rejects.toThrow("the agent has to ask again");
    const { rows } = await getPool().query(
      "SELECT state FROM gpu_agent_requests WHERE request_id = $1",
      [k.pending.req.request_id],
    );
    expect(rows[0].state).toBe("denied");
  });

  it("a project's kill switch revokes only that project's grants and requests", async () => {
    const k = await killSetup();
    // another project's approved grant and pending request
    const other = await k.ask("3", OTHER_PROJECT);
    const otherGrant = await k.approve(other.req);
    const otherPending = await k.ask("4", OTHER_PROJECT);
    const r = await killSwitchLocal(
      { account_id: k.account_id, project_id: PROJECT, pause: false },
      k.deps,
    );
    expect(r.paused).toBe(false);
    expect((await k.grantState()).state).toBe("revoked");
    await expect(k.approve()).rejects.toThrow("the agent has to ask again");
    expect((await k.grantState(otherGrant.grant_id)).state).toBe("active");
    await k.approve(otherPending.req);
    await k.launch(other.agent);
    expect(k.rp.client.createPod).toHaveBeenCalledTimes(1);
  });
});
