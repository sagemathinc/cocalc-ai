import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";

const assertActor = jest.fn(async () => {});
const withPersonalHome = jest.fn(async () => undefined);
const assertHost = jest.fn(async () => {});

jest.mock("./access", () => ({
  assertActor: (...args) => assertActor(...args),
  assertAgent: async () => {},
  assertLocalAgentProject: async () => {},
}));
jest.mock("./identity-routing", () => ({
  withAgentIdentityOwner: async ({ local }) => local(),
}));
jest.mock("./personal", () => ({
  withPersonalHome: (...args) => withPersonalHome(...args),
}));
jest.mock("@cocalc/server/conat/api/project-host-token-auth", () => ({
  assertProjectHostAgentTokenAccess: (...args) => assertHost(...args),
}));

import { notifyIdentityWatchers, watchIdentity } from "./identity-watchers";
import { reportRuntime } from "./api";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describeDb("agent identity watchers", () => {
  const project_id = randomUUID();
  const agent_id = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();

  beforeAll(async () => {
    const db = getPool();
    await db.query(
      "CREATE TABLE IF NOT EXISTS projects(project_id uuid PRIMARY KEY, users jsonb)",
    );
    await syncSchema({
      agent_identities: SCHEMA.agent_identities,
      agent_identity_watchers: SCHEMA.agent_identity_watchers,
    });
    await db.query("INSERT INTO projects(project_id,users) VALUES($1,'{}')", [
      project_id,
    ]);
    await db.query(
      `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by)
       VALUES($1,$2,'/home/user/a.chat','t1','builder',$3)`,
      [agent_id, project_id, alice],
    );
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM agent_identity_watchers");
    withPersonalHome.mockClear();
    assertActor.mockReset().mockResolvedValue(undefined);
  });

  test("identity changes reach exactly the accounts that named the agent", async () => {
    await watchIdentity({
      account_id: alice,
      project_id,
      agent_id,
      watching: true,
    });
    await watchIdentity({
      account_id: bob,
      project_id,
      agent_id,
      watching: true,
    });
    await watchIdentity({
      account_id: bob,
      project_id,
      agent_id,
      watching: false,
    });
    await notifyIdentityWatchers(agent_id);
    expect(withPersonalHome).toHaveBeenCalledTimes(1);
    expect(withPersonalHome).toHaveBeenCalledWith(alice, {
      action: "identityChanged",
      options: {
        endpoint: { project_id, agent_id },
        snapshot: expect.objectContaining({
          path: "/home/user/a.chat",
          thread_id: "t1",
          available: true,
        }),
      },
    });
  });

  test("watching requires project access", async () => {
    assertActor.mockRejectedValueOnce(new Error("not a collaborator"));
    await expect(
      watchIdentity({ account_id: bob, project_id, agent_id, watching: true }),
    ).rejects.toThrow("not a collaborator");
    await notifyIdentityWatchers(agent_id);
    expect(withPersonalHome).not.toHaveBeenCalled();
  });

  test("the host's runtime report fills in the runtime and notifies once", async () => {
    await watchIdentity({
      account_id: alice,
      project_id,
      agent_id,
      watching: true,
    });
    const report = {
      host_id: randomUUID(),
      account_id: alice,
      project_id,
      path: "/home/user/a.chat",
      thread_id: "t1",
      runtime: { kind: "claude-code" as const },
    };
    await reportRuntime(report);
    await settle();
    expect(withPersonalHome).toHaveBeenCalledTimes(1);
    expect(
      (
        await getPool().query(
          "SELECT runtime FROM agent_identities WHERE agent_id=$1",
          [agent_id],
        )
      ).rows[0].runtime,
    ).toEqual({ kind: "claude-code" });
    // Unchanged: no write, no notification.
    await reportRuntime(report);
    await settle();
    expect(withPersonalHome).toHaveBeenCalledTimes(1);
    await expect(
      reportRuntime({ ...report, runtime: { kind: "bogus" } as any }),
    ).rejects.toThrow("invalid agent runtime");
  });
});
