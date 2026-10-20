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

import {
  dropProjectIdentityWatchers,
  notifyIdentityWatchers,
  watchIdentity,
} from "./identity-watchers";
import { reportRuntime, reportStatus } from "./api";

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

  const watchers = async () =>
    (
      await getPool().query(
        "SELECT account_id FROM agent_identity_watchers WHERE agent_id=$1 ORDER BY account_id",
        [agent_id],
      )
    ).rows.map((row) => row.account_id);

  test("someone removed from the project stops receiving the agent's changes", async () => {
    for (const account_id of [alice, bob])
      await watchIdentity({ account_id, project_id, agent_id, watching: true });
    // Bob is removed from the project after naming the agent.
    assertActor.mockImplementation(async (account_id) => {
      if (account_id === bob)
        throw new Error("user must be a collaborator on project");
    });
    await notifyIdentityWatchers(agent_id);
    expect(withPersonalHome).toHaveBeenCalledTimes(1);
    expect(withPersonalHome).toHaveBeenCalledWith(alice, expect.anything());
    expect(await watchers()).toEqual([alice]);
  });

  test("a transient access failure skips one push but keeps the watch", async () => {
    await watchIdentity({
      account_id: bob,
      project_id,
      agent_id,
      watching: true,
    });
    assertActor.mockRejectedValueOnce(new Error("timeout"));
    await notifyIdentityWatchers(agent_id);
    expect(withPersonalHome).not.toHaveBeenCalled();
    expect(await watchers()).toEqual([bob]);
  });

  test("removing a collaborator drops their watches on the project's agents", async () => {
    for (const account_id of [alice, bob])
      await watchIdentity({ account_id, project_id, agent_id, watching: true });
    await dropProjectIdentityWatchers({ project_id, account_id: bob });
    expect(await watchers()).toEqual([alice]);
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

  test("the host's status report reaches watchers, only when it changes, never a credential", async () => {
    await watchIdentity({
      account_id: alice,
      project_id,
      agent_id,
      watching: true,
    });
    const status = {
      version: 1 as const,
      running: 0,
      queued: 1,
      unavailable: { reason: "limit" as const, until: Date.now() + 3_600_000 },
      at: Date.now(),
    };
    const report = {
      host_id: randomUUID(),
      account_id: alice,
      project_id,
      path: "/home/user/a.chat",
      thread_id: "t1",
      // A credential id smuggled in is dropped, never stored.
      status: { ...status, credential_id: randomUUID() } as any,
    };
    await expect(reportStatus(report)).resolves.toEqual({ registered: true });
    await settle();
    expect(withPersonalHome).toHaveBeenCalledTimes(1);
    expect(withPersonalHome).toHaveBeenCalledWith(alice, {
      action: "identityChanged",
      options: {
        endpoint: { project_id, agent_id },
        snapshot: expect.objectContaining({ status }),
      },
    });
    const stored = (
      await getPool().query(
        "SELECT turn_status FROM agent_identities WHERE agent_id=$1",
        [agent_id],
      )
    ).rows[0].turn_status;
    expect(stored).toEqual(status);
    // The same status computed later: no write, no notification.
    await reportStatus({
      ...report,
      status: { ...status, at: Date.now() + 5 },
    });
    await settle();
    expect(withPersonalHome).toHaveBeenCalledTimes(1);
    // The host's refresh, hours later: stored and passed on, so it never
    // outlives its TTL while still true.
    const refreshed = { ...status, at: status.at + 6 * 60 * 60_000 };
    await reportStatus({ ...report, status: refreshed });
    await settle();
    expect(withPersonalHome).toHaveBeenCalledTimes(2);
    expect(
      (
        await getPool().query(
          "SELECT turn_status FROM agent_identities WHERE agent_id=$1",
          [agent_id],
        )
      ).rows[0].turn_status,
    ).toEqual(refreshed);
    // A conversation that isn't a registered agent.
    await expect(
      reportStatus({ ...report, thread_id: "not-an-agent" }),
    ).resolves.toEqual({ registered: false });
    await expect(
      reportStatus({ ...report, status: { version: 1, running: -1 } as any }),
    ).rejects.toThrow("invalid agent status");
  });

  test("each watcher sees only its own account's limit or sign-in", async () => {
    for (const account_id of [alice, bob])
      await watchIdentity({ account_id, project_id, agent_id, watching: true });
    const at = Date.now() + 60 * 60_000;
    await reportStatus({
      host_id: randomUUID(),
      account_id: alice,
      project_id,
      path: "/home/user/a.chat",
      thread_id: "t1",
      status: {
        version: 1,
        running: 0,
        queued: 0,
        by_account: { [alice]: { reason: "sign-in" } },
        at,
      },
    });
    await settle();
    const snapshotFor = (account: string) =>
      (withPersonalHome.mock.calls as any[]).find(
        ([who]) => who === account,
      )?.[1].options.snapshot;
    expect(snapshotFor(alice).status).toEqual({
      version: 1,
      running: 0,
      queued: 0,
      unavailable: { reason: "sign-in" },
      at,
    });
    // Bob's credentials may work: no warning, and no one else's account.
    expect(snapshotFor(bob).status).toEqual({
      version: 1,
      running: 0,
      queued: 0,
      at,
    });
    expect(JSON.stringify(withPersonalHome.mock.calls)).not.toMatch(
      /by_account/,
    );
  });
});
