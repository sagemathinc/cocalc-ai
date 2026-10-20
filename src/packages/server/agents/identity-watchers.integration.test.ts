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
const listCredentials = jest.fn();
jest.mock("@cocalc/server/external-credentials/routing", () => ({
  listAccountExternalCredentialsRouted: (...args) => listCredentials(...args),
}));
jest.mock("@cocalc/server/conat/api/project-host-token-auth", () => ({
  assertProjectHostAgentTokenAccess: (...args) => assertHost(...args),
}));

import {
  dropProjectIdentityWatchers,
  notifyIdentityWatchers,
  watchIdentity,
} from "./identity-watchers";
import { credentialUpdatedAt, reportRuntime } from "./api";

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

  test("credentialUpdatedAt: when the account signed in again, nothing else", async () => {
    const at = (iso: string) => new Date(iso);
    const credential = (id: string, extra = {}) => ({
      id,
      provider: "anthropic",
      kind: "claude-subscription",
      scope: "account",
      owner_account_id: alice,
      metadata: { label: "Max A", secret_hint: "should not leave" },
      created: at("2026-10-01T00:00:00Z"),
      updated: at("2026-10-20T01:00:00Z"),
      revoked: null,
      last_used: null,
      ...extra,
    });
    const id = randomUUID();
    const replacement = randomUUID();
    listCredentials.mockResolvedValue([
      credential(id, { revoked: at("2026-10-20T02:00:00Z") }),
      credential(replacement, { updated: at("2026-10-20T03:00:00Z") }),
      // Another kind or provider does not count.
      credential(randomUUID(), {
        kind: "anthropic-api-key",
        updated: at("2026-10-20T05:00:00Z"),
      }),
      credential(randomUUID(), {
        revoked: at("2026-10-20T04:00:00Z"),
        updated: at("2026-10-20T04:00:00Z"),
      }),
    ]);
    const answer = await credentialUpdatedAt({
      host_id: randomUUID(),
      account_id: alice,
      project_id,
      credential_id: id,
      provider: "anthropic",
    });
    expect(answer).toEqual({
      updated_at: Date.parse("2026-10-20T01:00:00Z"),
      revoked: true,
      newest_updated_at: Date.parse("2026-10-20T03:00:00Z"),
      // Its id, so the held turn runs with it (William approved: the id
      // only, never the secret or its label).
      newest_credential_id: replacement,
    });
    expect(JSON.stringify(answer)).not.toMatch(/Max A|secret/);
    expect(listCredentials).toHaveBeenCalledWith({
      owner_account_id: alice,
      includeRevoked: true,
      provider: "anthropic",
    });
    expect(assertHost).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: alice, project_id }),
    );
    await expect(
      credentialUpdatedAt({
        host_id: randomUUID(),
        account_id: alice,
        project_id,
        credential_id: "not-a-uuid",
      }),
    ).rejects.toThrow();
  });
});
