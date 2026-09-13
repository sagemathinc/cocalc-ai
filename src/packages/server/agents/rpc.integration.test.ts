import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { agentStore } from "./store";
import {
  agentRpcControl,
  grantRpcLink,
  revokeRpcLink,
  acceptAgentRpc,
  authorizeRpcAdmission,
} from "./rpc";
import { agentMessagingSubject } from "@cocalc/conat/agents/protocol";
import { rpcOutcome } from "@cocalc/conat/agents/rpc";
import { getIdentityLocal } from "./api";

const context = new AsyncLocalStorage<string>();
const owners = new Map<string, string>();
const fresh = jest.fn();
const collab = jest.fn();
const admitted = jest.fn();
const routedCalls: any[] = [];
let hostId: string;
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => context.getStore() ?? "home",
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: async (project) => ({
    bay_id: owners.get(project),
    epoch: 1,
  }),
  resolveHostBayAcrossCluster: async () => ({
    bay_id: context.getStore(),
    epoch: 1,
  }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/agent-rpc", () => ({
  createAgentRpcControlClient: (_client, bay) =>
    new Proxy(
      {},
      {
        get: (_obj, method) => async (opts) => {
          routedCalls.push({ bay, method, opts });
          return context.run(bay, () => agentRpcControl[method](opts));
        },
      },
    ),
}));
jest.mock("@cocalc/conat/inter-bay/agent-identities", () => ({
  createInterBayAgentIdentityClient: ({ bay_id: bay }) => ({
    get: (opts) => context.run(bay, () => getIdentityLocal(opts)),
  }),
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (opts) => fresh(opts),
}));
jest.mock("@cocalc/server/conat/api/util", () => ({
  assertCollab: (opts) => collab(opts),
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: async () => {},
  isAccountBannedCached: () => false,
  getAccountRevokedBeforeCached: () => undefined,
}));
jest.mock("@cocalc/server/conat/api/project-host-token-auth", () => ({
  assertProjectHostAgentTokenAccess: async (opts) => {
    if (opts.host_id !== hostId) throw new Error("wrong host");
  },
}));
jest.mock("@cocalc/server/conat/route-client", () => ({
  getExplicitHostControlClient: async () => ({}),
}));
jest.mock("@cocalc/conat/project-host/api", () => ({
  createHostControlClient: (opts) => ({
    submitAgentRpc: async (e) => {
      expect(opts.noRetry).toBe(true);
      await authorizeRpcAdmission({
        account_id: e.account_id,
        host_id: hostId,
        envelope: e,
      });
      await admitted(e);
      return rpcOutcome(e, "accepted");
    },
    inspectAgentRpc: async ({ request }) => rpcOutcome(request, "unknown"),
  }),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("RPC owner routing and authorization with PostgreSQL grants", () => {
  const account = randomUUID(),
    sourceProject = randomUUID(),
    targetProject = randomUUID();
  const source = { project_id: sourceProject, agent_id: randomUUID() };
  const target = { project_id: targetProject, agent_id: randomUUID() };
  const run = randomUUID();
  beforeAll(async () => {
    process.env.COCALC_AGENT_MESSAGING_ENABLED = "1";
    process.env.COCALC_AGENT_MESSAGING_RPC_ENABLED = "1";
    hostId = randomUUID();
    owners.set(sourceProject, "source-bay");
    owners.set(targetProject, "target-bay");
    const db = getPool();
    await db.query(
      "CREATE TABLE IF NOT EXISTS projects(project_id uuid PRIMARY KEY, host_id uuid, state jsonb, deleted boolean)",
    );
    await syncSchema(
      Object.fromEntries(
        ["agent_identities", "agent_identity_runs", "agent_rpc_links"].map(
          (name) => [name, SCHEMA[name]],
        ),
      ),
    );
    for (const endpoint of [source, target]) {
      await db.query(
        'INSERT INTO projects(project_id,host_id,state) VALUES($1,$2,\'{"state":"running"}\')',
        [endpoint.project_id, hostId],
      );
      await db.query(
        `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by)
        VALUES($1,$2,'/home/user/test.chat',$3,'test',$4)`,
        [endpoint.agent_id, endpoint.project_id, randomUUID(), account],
      );
      await db.query(
        `INSERT INTO agent_identity_runs(agent_id,run_id,account_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '1 hour')`,
        [endpoint.agent_id, run, account, randomUUID()],
      );
    }
  });
  beforeEach(async () => {
    fresh.mockReset().mockResolvedValue(undefined);
    collab.mockReset().mockResolvedValue(undefined);
    admitted.mockReset().mockResolvedValue(undefined);
    routedCalls.length = 0;
    await agentStore().query("DELETE FROM agent_rpc_links");
  });
  const approve = (from = source, to = target) =>
    grantRpcLink({
      account_id: account,
      session_hash: "human-home-session",
      source: from,
      target: to,
      link_id: randomUUID(),
      reason: "review",
      ttl_seconds: 3600,
    });
  const send = (from = source, to = target) =>
    context.run(owners.get(from.project_id)!, () =>
      acceptAgentRpc(agentMessagingSubject(from.agent_id, run), {
        version: 2,
        action: "send",
        attempt_id: randomUUID(),
        target: to,
        body: "request-or-correlated-reply",
      }),
    );

  test("home human approval, scoped discovery and explicit cross-owner reverse reply", async () => {
    await approve();
    const links = await context.run("source-bay", () =>
      acceptAgentRpc(agentMessagingSubject(source.agent_id, run), {
        version: 2,
        action: "destinations",
      }),
    );
    expect(links).toEqual([expect.objectContaining({ source, target })]);
    expect(await send()).toMatchObject({ outcome: "accepted" });
    expect(await send(target, source)).toMatchObject({ outcome: "rejected" });
    await approve(target, source);
    expect(await send(target, source)).toMatchObject({ outcome: "accepted" });
    expect(admitted).toHaveBeenCalledTimes(2);
    expect(admitted.mock.calls[0][0]).toMatchObject({
      account_id: account,
      source,
      target,
    });
    expect(
      routedCalls.some(
        (call) => call.bay === "target-bay" && call.method === "submit",
      ),
    ).toBe(true);
    expect(JSON.stringify(routedCalls)).not.toContain("human-home-session");
  });
  test("fresh auth failure creates no permission", async () => {
    fresh.mockRejectedValue(new Error("fresh auth required"));
    await expect(approve()).rejects.toThrow("fresh auth");
    expect(
      (await agentStore().query("SELECT * FROM agent_rpc_links")).rows,
    ).toHaveLength(0);
  });
  test("stopped targets route to their host for authorized startup", async () => {
    await approve();
    await agentStore().query(
      "UPDATE projects SET state='{}' WHERE project_id=$1",
      [targetProject],
    );
    try {
      expect(await send()).toMatchObject({ outcome: "accepted" });
      expect(admitted).toHaveBeenCalledTimes(1);
    } finally {
      await agentStore().query(
        `UPDATE projects SET state='{"state":"running"}' WHERE project_id=$1`,
        [targetProject],
      );
    }
  });
  test("revocation and expiry stop new admissions", async () => {
    const link = await approve();
    await revokeRpcLink({
      account_id: account,
      session_hash: "human-home-session",
      source,
      link_id: link.link_id,
    });
    expect(await send()).toMatchObject({ outcome: "rejected" });
    await approve();
    await agentStore().query(
      "UPDATE agent_rpc_links SET expires_at=now()-interval '1 second'",
    );
    expect(await send()).toMatchObject({ outcome: "rejected" });
    expect(admitted).not.toHaveBeenCalled();
  });
  test("lost host acknowledgment is unknown; read-only inspection does not resend", async () => {
    await approve();
    admitted.mockRejectedValue(new Error("ack lost"));
    expect(await send()).toMatchObject({ outcome: "unknown" });
    await context.run("source-bay", () =>
      acceptAgentRpc(agentMessagingSubject(source.agent_id, run), {
        version: 2,
        action: "inspect",
        attempt_id: randomUUID(),
        target,
      }),
    );
    expect(admitted).toHaveBeenCalledTimes(1);
  });
});
