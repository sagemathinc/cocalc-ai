import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { agentStore, hashIdentityToken } from "./store";
import {
  acceptAgentMessage,
  dispatchAgentMessage,
  startAgentMessaging,
} from "./messaging";
import { registerIdentity, grantMessaging, revokeMessaging } from "./api";
import {
  agentMessagingSubject,
  agentInboxPrefix,
} from "@cocalc/conat/agents/protocol";
import { connect } from "@cocalc/conat/core/client";
import {
  createServer,
  after as closeTestConat,
} from "@cocalc/backend/conat/test/setup";
import { checkDelivery } from "./access";

const collab = jest.fn();
const fresh = jest.fn();
const submit = jest.fn();
const bay = jest.fn();
jest.mock("@cocalc/server/conat/api/util", () => ({
  assertCollab: (opts) => collab(opts),
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (opts) => fresh(opts),
}));
jest.mock("@cocalc/server/conat/api/project-host-token-auth", () => ({
  assertProjectHostAgentTokenAccess: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "test-bay",
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (id) => bay(id),
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: jest.fn(),
  isAccountBannedCached: () => false,
  getAccountRevokedBeforeCached: () => undefined,
  startAccountSecurityStateSyncLoop: jest.fn(),
}));
jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  hasProjectCollaboratorAccessAllowRemote: async () => {
    await collab();
    return true;
  },
}));
jest.mock("./chat", () => ({
  withAgentChat: async (a, fn) =>
    fn(
      {},
      {
        event: "chat-thread-config",
        thread_id: a.thread_id,
        agent_kind: "acp",
        name: "Agent",
      },
      [],
      {},
    ),
}));
jest.mock("@cocalc/chat/send", () => ({
  ...jest.requireActual("@cocalc/chat/send"),
  submitChatSend: (opts) => submit(opts),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("agent messaging PostgreSQL contract", () => {
  const account = randomUUID(),
    p1 = randomUUID(),
    p2 = randomUUID();
  let source: any, target: any, credential: any, grant: any;
  const old = process.env.COCALC_AGENT_MESSAGING_ENABLED;
  beforeAll(async () => {
    process.env.COCALC_AGENT_MESSAGING_ENABLED = "1";
    const pool = getPool();
    await pool.query(
      "CREATE TABLE IF NOT EXISTS accounts(account_id uuid PRIMARY KEY)",
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS projects(project_id uuid PRIMARY KEY)",
    );
    await pool.query("INSERT INTO accounts(account_id) VALUES($1)", [account]);
    await pool.query("INSERT INTO projects(project_id) VALUES($1),($2)", [
      p1,
      p2,
    ]);
  });
  beforeEach(async () => {
    await agentStore().query("DELETE FROM agent_message_inbox");
    collab.mockReset().mockResolvedValue(undefined);
    fresh.mockReset().mockResolvedValue(undefined);
    submit.mockReset().mockResolvedValue({ state: "accepted" });
    bay.mockReset().mockResolvedValue({ bay_id: "test-bay" });
    source = await registerIdentity({
      account_id: account,
      session_hash: "verified",
      project_id: p1,
      path: "a.chat",
      thread_id: randomUUID(),
    });
    target = await registerIdentity({
      account_id: account,
      session_hash: "verified",
      project_id: p2,
      path: "b.chat",
      thread_id: randomUUID(),
    });
    credential = await agentStore().issue(source, randomUUID(), account);
    grant = await grantMessaging({
      account_id: account,
      session_hash: "verified",
      source_agent_id: source.agent_id,
      target_agent_id: target.agent_id,
      ttl_seconds: 3600,
      reason: "review requested",
    });
  });
  afterAll(async () => {
    await closeTestConat();
    const { closePglite } = await import("@cocalc/database/pglite");
    await closePglite();
    if (old === undefined) delete process.env.COCALC_AGENT_MESSAGING_ENABLED;
    else process.env.COCALC_AGENT_MESSAGING_ENABLED = old;
  });
  const send = (patch: any = {}) =>
    acceptAgentMessage(
      agentMessagingSubject(source.agent_id, credential.run_id),
      {
        action: "send",
        request_id: randomUUID(),
        body: "Please review this change.",
        target_agent_id: target.agent_id,
        ...patch,
      },
    );
  test("stores only hashed credentials; rotation, expiry and end are enforced", async () => {
    const db = agentStore();
    const row = await db.authenticate(credential.token);
    expect(row.token_hash).toBe(hashIdentityToken(credential.token));
    expect(row).not.toHaveProperty("token");
    const next = await db.issue(source, credential.run_id, account);
    await expect(db.authenticate(credential.token)).rejects.toThrow();
    await expect(db.authenticate(next.token)).resolves.toMatchObject({
      agent_id: source.agent_id,
    });
    await db.query(
      "UPDATE agent_identity_runs SET expires_at=now()-interval '1 second' WHERE agent_id=$1",
      [source.agent_id],
    );
    await expect(db.authenticate(next.token)).rejects.toThrow();
    await expect(
      db.issue(source, credential.run_id, account),
    ).rejects.toThrow();
  });
  test("requires fresh human approval and rejects cross-bay or removed collaborators", async () => {
    expect(fresh).toHaveBeenCalledWith(
      expect.objectContaining({
        session_hash: "verified",
        allow_actor_impersonation: false,
      }),
    );
    fresh.mockRejectedValue(new Error("fresh auth required"));
    await expect(
      grantMessaging({
        account_id: account,
        source_agent_id: source.agent_id,
        target_agent_id: target.agent_id,
        ttl_seconds: 3600,
        reason: "x",
      }),
    ).rejects.toThrow("fresh auth");
    bay.mockResolvedValue({ bay_id: "different-bay" });
    await expect(send()).rejects.toThrow("this bay");
    bay.mockResolvedValue({ bay_id: "test-bay" });
    collab.mockRejectedValue(new Error("not a collaborator"));
    await expect(send()).rejects.toThrow("collaborator");
  });
  test("claiming is durable and stale dispatch is not automatically replayed", async () => {
    const first = await send();
    const db = agentStore();
    const claimed = await db.claim();
    expect(claimed).toMatchObject({
      message_id: first.message_id,
      state: "dispatching",
    });
    expect(await db.claim()).toBeUndefined();
    await db.query(
      "UPDATE agent_message_inbox SET updated_at=now()-interval '6 minutes' WHERE message_id=$1",
      [first.message_id],
    );
    expect(await db.claim()).toBeUndefined();
    expect(
      (
        await db.query(
          "SELECT state FROM agent_message_inbox WHERE message_id=$1",
          [first.message_id],
        )
      ).rows[0].state,
    ).toBe("unconfirmed");
  });
  test("expiry blocks pending dispatch and ended runtime credentials cannot be reused", async () => {
    await send();
    const db = agentStore();
    const claimed = (await db.claim())!;
    await db.query(
      "UPDATE agent_message_grants SET expires_at=now()-interval '1 second' WHERE grant_id=$1",
      [grant.grant_id],
    );
    await expect(send()).rejects.toThrow("no active grant");
    await dispatchAgentMessage(claimed);
    expect(submit).not.toHaveBeenCalled();
    await db.query(
      "UPDATE agent_identity_runs SET ended_at=now() WHERE agent_id=$1",
      [source.agent_id],
    );
    await expect(db.authenticate(credential.token)).rejects.toThrow();
    await expect(
      db.issue(source, credential.run_id, account),
    ).rejects.toThrow();
  });
  test("deduplicates retries and rejects reuse with a changed body", async () => {
    const request_id = randomUUID();
    const first = await send({ request_id });
    expect(first.state).toBe("pending");
    expect(await send({ request_id })).toEqual(first);
    await expect(send({ request_id, body: "other" })).rejects.toThrow(
      "different message",
    );
    const other = await agentStore().issue(target, randomUUID(), account);
    await expect(
      acceptAgentMessage(agentMessagingSubject(target.agent_id, other.run_id), {
        action: "receipt",
        request_id,
      }),
    ).rejects.toThrow("not found");
  });
  test("guidance is separate permission and grants expire/revoke", async () => {
    await expect(send({ guidance: true })).rejects.toThrow("no active grant");
    await agentStore().query(
      "UPDATE agent_message_grants SET allow_guidance=true WHERE grant_id=$1",
      [grant.grant_id],
    );
    await expect(send({ guidance: true })).resolves.toMatchObject({
      state: "pending",
    });
    await revokeMessaging({
      account_id: account,
      session_hash: "verified",
      grant_id: grant.grant_id,
    });
    await expect(send()).rejects.toThrow("no active grant");
  });
  test("dispatch is attributed and queues normal work; lost acknowledgement is not retried", async () => {
    const first = await send();
    const db = agentStore();
    // Other tests may leave pending messages; explicitly select this one.
    await db.query(
      "UPDATE agent_message_inbox SET state='dispatching' WHERE message_id=$1",
      [first.message_id],
    );
    const row = (
      await db.query("SELECT * FROM agent_message_inbox WHERE message_id=$1", [
        first.message_id,
      ])
    ).rows[0];
    submit.mockRejectedValueOnce(new Error("connection lost"));
    await dispatchAgentMessage(row);
    expect(submit).toHaveBeenCalledTimes(1);
    const prepared = submit.mock.calls[0][0].prepared;
    expect(prepared.request.chat.agent_delivery_id).toBe(first.message_id);
    expect(prepared.request.chat.send_mode).not.toBe("immediate");
    expect(prepared.request.prompt).toContain(source.agent_id);
    expect(
      (
        await db.query(
          "SELECT state FROM agent_message_inbox WHERE message_id=$1",
          [first.message_id],
        )
      ).rows[0].state,
    ).toBe("unconfirmed");
  });
  test("revocation blocks queued execution and dispatch before any model call", async () => {
    const first = await send();
    const db = agentStore();
    await db.query(
      "UPDATE agent_message_inbox SET state='dispatching' WHERE message_id=$1",
      [first.message_id],
    );
    await expect(checkDelivery(first.message_id)).resolves.toMatchObject({
      target: { agent_id: target.agent_id },
    });
    await revokeMessaging({
      account_id: account,
      session_hash: "verified",
      grant_id: grant.grant_id,
    });
    await expect(checkDelivery(first.message_id)).rejects.toThrow("revoked");
    const row = (
      await db.query("SELECT * FROM agent_message_inbox WHERE message_id=$1", [
        first.message_id,
      ])
    ).rows[0];
    await dispatchAgentMessage(row);
    expect(submit).not.toHaveBeenCalled();
    expect(
      (
        await db.query(
          "SELECT state FROM agent_message_inbox WHERE message_id=$1",
          [first.message_id],
        )
      ).rows[0].state,
    ).toBe("rejected");
  });
  test("real WebSocket identity connection can send and read receipts, but cannot reach project APIs", async () => {
    const { getUser, isAllowed } =
      await import("@cocalc/server/conat/socketio/auth");
    const testHubSecret = randomUUID();
    const server = await createServer({
      getUser: (socket, systemAccounts) =>
        socket.handshake.auth.testHubSecret === testHubSecret
          ? { hub_id: "test-hub" }
          : getUser(socket, systemAccounts),
      isAllowed,
    });
    const hub = connect({
      address: server.address(),
      auth: { testHubSecret },
      noCache: true,
    });
    let stop: (() => Promise<void>) | undefined;
    const client = connect({
      address: server.address(),
      auth: { bearer: credential.token },
      inboxPrefix: agentInboxPrefix(source.agent_id, credential.run_id),
      noCache: true,
    });
    try {
      stop = await startAgentMessaging(hub);
      const subject = agentMessagingSubject(source.agent_id, credential.run_id);
      const request_id = randomUUID();
      const response = await client.request(
        subject,
        {
          action: "send",
          request_id,
          target_agent_id: target.agent_id,
          body: "network smoke",
        },
        { timeout: 5000 },
      );
      expect(response.data).toMatchObject({
        result: { state: "pending", request_id },
      });
      const replay = await client.request(
        subject,
        { action: "receipt", request_id },
        { timeout: 5000 },
      );
      expect(replay.data.result.message_id).toBe(
        response.data.result.message_id,
      );
      await expect(
        client.request(`project.${p2}.api`, {}, { timeout: 1000 }),
      ).rejects.toThrow();
      await expect(
        client.subscribe(`_INBOX.account-${account}.>`),
      ).rejects.toThrow();
      await agentStore().query(
        "UPDATE agent_identities SET disabled_at=now() WHERE agent_id=$1",
        [source.agent_id],
      );
      await expect(
        client.request(
          subject,
          { action: "receipt", request_id },
          { timeout: 1000 },
        ),
      ).rejects.toThrow();
    } finally {
      client.close();
      await stop?.();
      hub.close();
      await server.close();
    }
  }, 20000);
});
