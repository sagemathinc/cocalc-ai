/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { ProjectRehomeInProgressError } from "@cocalc/database/postgres/project-rehome-fence";
import {
  registerCollaborationSource,
  ingestCollaborationSnapshot,
} from "@cocalc/database/postgres/collaborators/collaborators-owner";
import {
  ensureProjectCollaborationRehomeSchema,
  freezeProjectCollaborationExport,
} from "../projects/collaboration-project-rehome";
import {
  registerIdentityLocal,
  recoverIdentityLocal,
  startFreshConversationLocal,
  disableIdentity,
} from "./api";
import { agentStore } from "./store";

// Model a request that already passed ordinary authorization and live-chat
// validation. The SQL transaction must independently fence a later cutover.
jest.mock("./access", () => ({
  assertActor: async () => {},
  assertLocalAgentProject: async () => {},
  assertAgent: async () => {},
}));
jest.mock("./chat", () => ({
  withAgentChat: async (_agent, fn) => fn({}, { name: "Registered agent" }),
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: async () => {},
}));
jest.mock("@cocalc/server/conat/route-client", () => ({
  conatWithProjectRoutingForAccount: () => ({}),
}));
const successor = randomUUID();
jest.mock("@cocalc/conat/ai/acp/client", () => ({
  controlAcp: async () => ({ ok: true, successor_thread_id: successor }),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" &&
  process.env.COCALC_DB === "pglite" &&
  process.env.COCALC_PGLITE_DATA_DIR === "memory://"
    ? describe
    : describe.skip;
const sourceBay = "identity-rehome-source",
  destBay = "identity-rehome-destination";
const originalBay = process.env.COCALC_BAY_ID;
const mutations = ["register", "recover", "fresh", "disable"] as const;
type Mutation = (typeof mutations)[number];

describeDb("agent identity project-rehome mutation fencing", () => {
  beforeAll(async () => {
    process.env.COCALC_BAY_ID = sourceBay;
    await initEphemeralDatabase();
    await getPool().query(`CREATE TABLE project_rehome_operations (
      op_id UUID PRIMARY KEY,project_id UUID,source_bay_id TEXT,dest_bay_id TEXT,
      status TEXT,stage TEXT,created_at TIMESTAMPTZ DEFAULT now())`);
    await ensureProjectCollaborationRehomeSchema();
  }, 60_000);
  afterAll(async () => {
    if (originalBay === undefined) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = originalBay;
    await getPool().end();
  });

  async function fixture(mutation: Mutation) {
    const project_id = randomUUID(),
      account_id = randomUUID(),
      host_id = randomUUID(),
      agent_id = randomUUID();
    const path = "/home/user/agent.chat",
      thread_id = "thread";
    const op = {
      op_id: randomUUID(),
      project_id,
      source_bay_id: sourceBay,
      dest_bay_id: destBay,
    };
    await getPool().query("INSERT INTO accounts(account_id) VALUES($1)", [
      account_id,
    ]);
    await getPool().query(
      "INSERT INTO projects(project_id,owning_bay_id,host_id,users) VALUES($1,$2,$3,$4::jsonb)",
      [
        project_id,
        sourceBay,
        host_id,
        JSON.stringify({ [account_id]: { group: "owner" } }),
      ],
    );
    const source = { project_id, chat_path: path };
    const authority = { owning_bay_id: sourceBay, host_id };
    const epoch = await registerCollaborationSource(
      source,
      authority,
      null,
      randomUUID(),
    );
    await ingestCollaborationSnapshot(
      {
        ...source,
        epoch,
        sequence: 1,
        resources: [
          {
            ...source,
            kind: "conversation",
            resource_id: "human-thread",
            thread_id: "human-thread",
            title: "Discussion",
            activity: 1,
            participant_ids: [account_id],
            created_at: 1,
            updated_at: 1,
          },
        ],
      },
      authority,
    );
    if (mutation !== "register") {
      await getPool().query(
        `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by,disabled_at)
        VALUES($1,$2,$3,$4,'Agent',$5,$6)`,
        [
          agent_id,
          project_id,
          path,
          thread_id,
          account_id,
          mutation === "recover" ? new Date() : null,
        ],
      );
      await getPool().query(
        `INSERT INTO agent_identity_runs(agent_id,run_id,account_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '1 hour')`,
        [agent_id, randomUUID(), account_id, randomUUID()],
      );
    }
    return { op, project_id, account_id, agent_id, path, thread_id };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function invoke(f: Fixture, mutation: Mutation) {
    switch (mutation) {
      case "register":
        return registerIdentityLocal(f);
      case "recover":
        return recoverIdentityLocal(f);
      case "fresh":
        return startFreshConversationLocal({
          ...f,
          expected_thread_id: f.thread_id,
        });
      case "disable":
        return disableIdentity(f);
    }
  }
  async function start(f: Fixture) {
    await getPool().query(
      `INSERT INTO project_rehome_operations(op_id,project_id,source_bay_id,dest_bay_id,status,stage)
      VALUES($1,$2,$3,$4,'running','requested')`,
      [f.op.op_id, f.project_id, sourceBay, destBay],
    );
  }
  async function snapshot(f: Fixture) {
    const identities = (
      await getPool().query(
        "SELECT * FROM agent_identities WHERE project_id=$1 ORDER BY agent_id",
        [f.project_id],
      )
    ).rows;
    const runs = (
      await getPool().query(
        `SELECT r.* FROM agent_identity_runs r JOIN agent_identities a USING(agent_id)
      WHERE a.project_id=$1 ORDER BY r.agent_id,r.run_id`,
        [f.project_id],
      )
    ).rows;
    return { identities, runs };
  }
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  async function delayedMutation(
    f: Fixture,
    mutation: Mutation,
    interleave: () => Promise<void>,
  ) {
    const entered = deferred(),
      resume = deferred();
    const store = agentStore(),
      transaction = store.transaction.bind(store);
    const spy = jest
      .spyOn(store, "transaction")
      .mockImplementationOnce(async (fn) => {
        entered.resolve();
        await resume.promise;
        return transaction(fn);
      });
    const result = invoke(f, mutation).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        entered.promise,
        result.then(() => {
          throw Error("request never reached mutation transaction");
        }),
      ]);
      await interleave();
    } finally {
      resume.resolve();
      spy.mockRestore();
    }
    return result;
  }

  test.each(mutations)(
    "%s rejects a rehome begun after ordinary authorization",
    async (mutation) => {
      const f = await fixture(mutation),
        before = await snapshot(f);
      const error = await delayedMutation(f, mutation, () => start(f));
      expect(error).toBeInstanceOf(ProjectRehomeInProgressError);
      expect(await snapshot(f)).toEqual(before);
    },
  );
  test.each(["register", "recover"] as const)(
    "%s cannot create authority after a failed export remains frozen",
    async (mutation) => {
      const f = await fixture(mutation),
        before = await snapshot(f);
      const error = await delayedMutation(f, mutation, async () => {
        await start(f);
        expect(await freezeProjectCollaborationExport(f.op)).toBeDefined();
        await getPool().query(
          "UPDATE project_rehome_operations SET status='failed' WHERE op_id=$1",
          [f.op.op_id],
        );
      });
      expect(error).toBeInstanceOf(ProjectRehomeInProgressError);
      expect((error as Error).message).toContain("is frozen");
      expect(await snapshot(f)).toEqual(before);
    },
  );
  test.each(mutations)(
    "%s rechecks owner after completed cutover, not only running fences",
    async (mutation) => {
      const f = await fixture(mutation),
        before = await snapshot(f);
      const error = await delayedMutation(f, mutation, async () => {
        await start(f);
        await getPool().query(
          "UPDATE projects SET owning_bay_id=$2 WHERE project_id=$1",
          [f.project_id, destBay],
        );
        await getPool().query(
          "UPDATE project_rehome_operations SET status='completed' WHERE op_id=$1",
          [f.op.op_id],
        );
      });
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("no longer owned by this bay");
      expect(await snapshot(f)).toEqual(before);
    },
  );
  test("registration committed before freeze makes an unindexed dependency fail preflight", async () => {
    const f = await fixture("register");
    const identity = await registerIdentityLocal(f);
    await start(f);
    await expect(freezeProjectCollaborationExport(f.op)).rejects.toThrow(
      "nonportable agent_identities",
    );
    expect((await snapshot(f)).identities[0].agent_id).toBe(identity.agent_id);
    expect(
      (
        await getPool().query(
          "SELECT 1 FROM project_collaboration_rehome_transfers WHERE op_id=$1",
          [f.op.op_id],
        )
      ).rows,
    ).toEqual([]);
  });
  test("legacy NULL ownership still allows a local registration", async () => {
    const f = await fixture("register");
    await getPool().query(
      "UPDATE projects SET owning_bay_id=NULL WHERE project_id=$1",
      [f.project_id],
    );
    await expect(registerIdentityLocal(f)).resolves.toMatchObject({
      project_id: f.project_id,
      created_by: f.account_id,
    });
  });
  test("a project deleted after authorization cannot acquire a new identity", async () => {
    const f = await fixture("register");
    const error = await delayedMutation(f, "register", async () => {
      await getPool().query(
        "UPDATE projects SET deleted=true WHERE project_id=$1",
        [f.project_id],
      );
    });
    expect((error as Error).message).toContain("no longer owned by this bay");
    expect((await snapshot(f)).identities).toEqual([]);
  });
});
