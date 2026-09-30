/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { AGENT_IDENTITY_TOKEN_PREFIX } from "@cocalc/conat/agents/protocol";
import { agentStore, hashIdentityToken } from "./store";
import { PersonalAgentStore } from "./personal-store";
import { assertActor } from "./access";
import { agentRpcControl, authorizeRpcExecution } from "./rpc";

const account = randomUUID();
const source = { project_id: randomUUID(), agent_id: randomUUID() };
const target = { project_id: randomUUID(), agent_id: randomUUID() };
const runId = randomUUID();
const host = randomUUID();
const token = AGENT_IDENTITY_TOKEN_PREFIX + randomUUID();
const bay = "test-bay";
let banned = false;
let revoked: Date | undefined;
let deniedProject: string | undefined;
const hostAccess = jest.fn(async () => {});
const checkNetwork = jest.fn();

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => bay,
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: async () => ({ bay_id: bay, epoch: 1 }),
}));
jest.mock("@cocalc/server/conat/api/util", () => ({
  assertCollab: async ({ project_id }) => {
    if (project_id === deniedProject) throw Error("not a collaborator");
  },
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: async () => {},
  isAccountBannedCached: () => banned,
  getAccountRevokedBeforeCached: () => revoked,
}));
jest.mock("@cocalc/server/conat/api/project-host-token-auth", () => ({
  assertProjectHostAgentTokenAccess: (...args) => hostAccess(...args),
}));
jest.mock("./personal", () => ({
  withPersonalHome: (...args) => checkNetwork(...args),
  personalControl: jest.fn(),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("accepted queued work outlives the sending run", () => {
  const db = agentStore();
  const principal =
    (method: "principal" | "executionPrincipal") => async (source, run_id) =>
      (
        await agentRpcControl[method]({
          source,
          run_id,
          project_id: source.project_id,
          route: { bay_id: bay, epoch: 1 },
        })
      ).account_id;
  const store = new PersonalAgentStore(
    db,
    async (account_id, endpoint) => {
      await assertActor(account_id, endpoint.project_id);
      return db.get(endpoint.agent_id);
    },
    principal("principal"),
    async () => {},
    async () => false,
    principal("executionPrincipal"),
  );
  const tables = [
    "agent_identities",
    "agent_identity_runs",
    "agent_personal_controls",
    "agent_personal_names",
    "agent_networks",
    "agent_network_members",
    "agent_network_mutations",
    "agent_network_activity",
    "agent_external_identities",
    "agent_external_installations",
  ];
  let authorization: Parameters<
    typeof authorizeRpcExecution
  >[0]["authorization"];
  const execute = () =>
    authorizeRpcExecution({
      account_id: account,
      host_id: host,
      authorization,
    });

  beforeAll(async () => {
    await db.query(
      "CREATE TABLE IF NOT EXISTS projects(project_id uuid PRIMARY KEY, users jsonb)",
    );
    await syncSchema(
      Object.fromEntries(tables.map((name) => [name, SCHEMA[name]])),
    );
  });
  beforeEach(async () => {
    banned = false;
    revoked = undefined;
    deniedProject = undefined;
    hostAccess.mockReset().mockResolvedValue(undefined);
    for (const table of [...tables].reverse())
      await db.query(`DELETE FROM ${table}`);
    for (const endpoint of [source, target]) {
      await db.query(
        "INSERT INTO projects(project_id,users) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [endpoint.project_id, { [account]: { group: "owner" } }],
      );
      await db.query(
        `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by)
        VALUES($1,$2,$3,$4,'agent',$5)`,
        [
          endpoint.agent_id,
          endpoint.project_id,
          `/home/user/${endpoint.agent_id}.chat`,
          endpoint.agent_id,
          account,
        ],
      );
      await store.name(account, {
        endpoint,
        name: endpoint === source ? "sender" : "recipient",
      });
    }
    await db.query(
      `INSERT INTO agent_identity_runs(agent_id,run_id,account_id,token_hash,expires_at)
      VALUES($1,$2,$3,$4,now()+interval '10 minutes')`,
      [source.agent_id, runId, account, hashIdentityToken(token)],
    );
    const network = await store.createNetwork(
      account,
      {
        request_id: randomUUID(),
        title: "Queue",
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: target },
        ],
      },
      8,
      true,
    );
    // Admission authenticates the sender's live run and snapshots network state.
    const proof = await store.checkNetwork(
      account,
      network.agent_network_id,
      source,
      runId,
      target,
    );
    authorization = {
      version: 3,
      source,
      source_run_id: runId,
      target,
      target_path: `/home/user/${target.agent_id}.chat`,
      target_thread_id: target.agent_id,
      agent_network_id: network.agent_network_id,
      network_generation: proof.network_generation,
      account_generation: proof.account_generation,
      configured_delivery: proof.delivery_mode,
      principal_account_id: account,
      guidance: false,
    };
    checkNetwork.mockReset().mockImplementation(async (account_id, request) => {
      const o = request.options;
      return store.checkNetwork(
        account_id,
        o.agent_network_id,
        o.source,
        o.run_id,
        o.target,
        request.action === "checkExecutionNetwork",
      );
    });
  });

  test.each(["ended", "expired"])(
    "%s sender cannot send again but accepted work executes",
    async (state) => {
      await execute();
      await expect(db.authenticate(token)).resolves.toMatchObject({
        run_id: runId,
      });
      await db.query(
        state === "ended"
          ? "UPDATE agent_identity_runs SET ended_at=now() WHERE run_id=$1"
          : "UPDATE agent_identity_runs SET expires_at=now()-interval '1 second' WHERE run_id=$1",
        [runId],
      );
      await expect(db.activeRun(source.agent_id, runId)).rejects.toThrow(
        "expired, revoked, or invalid",
      );
      await expect(
        store.checkNetwork(
          account,
          authorization.agent_network_id,
          source,
          runId,
          target,
        ),
      ).rejects.toThrow("expired, revoked, or invalid");
      await expect(execute()).resolves.toBeUndefined();
      await expect(db.authenticate(token)).rejects.toThrow(
        "expired, revoked, or invalid",
      );
      // Revalidation is read-only and leaves the sender credential unusable.
      await expect(db.activeRun(source.agent_id, runId)).rejects.toThrow(
        "expired, revoked, or invalid",
      );
    },
  );

  test.each([source, target])(
    "disabled agent still prevents execution: $agent_id",
    async (endpoint) => {
      await db.query(
        "UPDATE agent_identities SET disabled_at=now() WHERE agent_id=$1",
        [endpoint.agent_id],
      );
      await expect(execute()).rejects.toThrow(/disabled|unavailable/);
    },
  );
  test.each([source, target])(
    "lost collaborator access still prevents execution: $project_id",
    async (endpoint) => {
      deniedProject = endpoint.project_id;
      await expect(execute()).rejects.toThrow("not a collaborator");
    },
  );
  test("account session revocation still rejects an ended sender run", async () => {
    await db.query(
      "UPDATE agent_identity_runs SET ended_at=now() WHERE run_id=$1",
      [runId],
    );
    revoked = new Date(Date.now() + 1000);
    await expect(execute()).rejects.toThrow("agent session was revoked");
  });
  test("banned account cannot execute accepted work", async () => {
    banned = true;
    await expect(execute()).rejects.toThrow("account is disabled");
  });
  test("a host without destination access is rejected before provenance lookup", async () => {
    hostAccess.mockRejectedValueOnce(Error("wrong host"));
    await expect(execute()).rejects.toThrow("wrong host");
    expect(checkNetwork).not.toHaveBeenCalled();
  });
  test("unknown or pruned source run is not treated as accepted provenance", async () => {
    authorization.source_run_id = randomUUID();
    await expect(execute()).rejects.toThrow(
      "accepted agent run is unavailable",
    );
  });
  test("recorded source principal cannot be substituted", async () => {
    await db.query(
      "UPDATE agent_identity_runs SET account_id=$1 WHERE run_id=$2",
      [randomUUID(), runId],
    );
    await expect(execute()).rejects.toThrow("principal_mismatch");
  });
  test.each(["network", "account"])(
    "changed %s generation rejects accepted work",
    async (kind) => {
      if (kind === "network")
        await db.query(
          "UPDATE agent_networks SET generation=$1 WHERE agent_network_id=$2",
          [randomUUID(), authorization.agent_network_id],
        );
      else
        await db.query(
          "UPDATE agent_personal_controls SET generation=generation+1 WHERE account_id=$1",
          [account],
        );
      await expect(execute()).rejects.toThrow("network_stale");
    },
  );
  test("removing source membership retracts accepted work", async () => {
    await db.query(
      "UPDATE agent_network_members SET removed_at=now() WHERE registered_agent_id=$1",
      [source.agent_id],
    );
    await expect(execute()).rejects.toThrow("not_a_member");
  });
  test("replacing target conversation retracts accepted work", async () => {
    await db.query(
      "UPDATE agent_identities SET thread_id=$1 WHERE agent_id=$2",
      [randomUUID(), target.agent_id],
    );
    await expect(execute()).rejects.toThrow("target identity changed");
  });
});
