import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EXTERNAL_AGENT_TOKEN_PREFIX } from "@cocalc/conat/agents/external";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { ExternalAgentStore, type ExternalEnrollment } from "./external-store";
import { AgentStore } from "./store";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("session-bound external agents", () => {
  const account = randomUUID();
  const session = randomUUID();
  const generation = randomUUID();
  const db = new AgentStore();
  const freshAuth = jest.fn(async () => {});
  const authority = jest.fn(async () => {});
  const security = jest.fn(async () => {});
  const store = new ExternalAgentStore(db, {
    assertAuthority: authority,
    accountSecurity: security,
    freshAuth,
  });
  const tables = [
    "agent_personal_controls",
    "agent_external_identities",
    "agent_external_installations",
    "agent_external_inbox",
  ];

  function enrollment(): {
    options: ExternalEnrollment;
    token: string;
  } {
    const secret = randomBytes(32).toString("hex");
    const options: ExternalEnrollment = {
      installation_id: randomUUID(),
      label: "Remote reviewer",
      secret_hash: createHash("sha256").update(secret).digest("hex"),
      agent_session_id: session,
      ttl_seconds: 3600,
    };
    return {
      options,
      token: `${EXTERNAL_AGENT_TOKEN_PREFIX}${account}.${options.installation_id}.${secret}`,
    };
  }

  beforeAll(async () => {
    await syncSchema(
      Object.fromEntries(tables.map((name) => [name, SCHEMA[name]])),
    );
  });

  beforeEach(async () => {
    for (const table of tables.slice().reverse())
      await db.query(`DELETE FROM ${table}`);
    for (const hook of [freshAuth, authority, security])
      hook.mockReset().mockResolvedValue(undefined);
  });

  test("approval creates one finite credential bound to one session", async () => {
    const { options, token } = enrollment();
    const approved = await store.enroll(account, "human-session", options);

    expect(freshAuth).toHaveBeenCalledTimes(1);
    expect(freshAuth).toHaveBeenCalledWith(account, "human-session");
    expect(approved).toMatchObject({
      installation_id: options.installation_id,
      account_id: account,
      agent_session_id: session,
      state: "active",
    });
    expect(await store.authenticate(token)).toEqual(approved);
    expect(JSON.stringify(await store.list(account))).not.toContain(
      options.secret_hash,
    );
  });

  test("duplicate approval is idempotent but cannot widen or extend authority", async () => {
    const { options } = enrollment();
    const first = await store.enroll(account, "human-session", options);
    expect(await store.enroll(account, "human-session", options)).toEqual(
      first,
    );
    await expect(
      store.enroll(account, "human-session", {
        ...options,
        agent_session_id: randomUUID(),
      }),
    ).rejects.toThrow("external_approval_conflict");
    await expect(
      store.enroll(account, "human-session", {
        ...options,
        ttl_seconds: 7200,
      }),
    ).rejects.toThrow("external_approval_conflict");
  });

  test("wrong secrets, revocation, and account-wide revoke block use", async () => {
    const { options, token } = enrollment();
    await store.enroll(account, "human-session", options);
    const invalid = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    await expect(store.authenticate(invalid)).rejects.toThrow(
      "invalid external agent credential",
    );
    await store.revoke(account, options.installation_id);
    await expect(store.authenticate(token)).rejects.toThrow(
      "external_credential_inactive",
    );

    const second = enrollment();
    await store.enroll(account, "human-session", second.options);
    await db.query(
      "UPDATE agent_personal_controls SET generation=generation+1 WHERE account_id=$1",
      [account],
    );
    await expect(store.authenticate(second.token)).rejects.toThrow(
      "external_credential_revoked_or_paused",
    );
  });

  test("bounded inbox is session-bound, idempotent, and acknowledged", async () => {
    const { options } = enrollment();
    const installation = await store.enroll(account, "human-session", options);
    const attempt = randomUUID();
    const source = {
      kind: "registered" as const,
      account_id: account,
      project_id: randomUUID(),
      agent_id: randomUUID(),
      run_id: randomUUID(),
    };
    const input = {
      account_id: account,
      installation_id: installation.installation_id,
      attempt_id: attempt,
      agent_session_id: session,
      session_generation: generation,
      source,
      body: "Please inspect this result.",
    };
    const message = await store.enqueue(input);
    expect(await store.inbox(account, installation.installation_id)).toEqual([
      message,
    ]);
    expect(await store.enqueue(input)).toEqual(message);
    await expect(
      store.enqueue({ ...input, body: "Changed body" }),
    ).rejects.toThrow("external_inbox_idempotency_conflict");
    await expect(
      store.enqueue({
        ...input,
        attempt_id: randomUUID(),
        agent_session_id: randomUUID(),
      }),
    ).rejects.toThrow("external_session_mismatch");
    await expect(
      store.acknowledge(
        account,
        installation.installation_id,
        message.message_id,
      ),
    ).resolves.toEqual({
      acknowledged: true,
      message_id: message.message_id,
    });
    expect(await store.inbox(account, installation.installation_id)).toEqual(
      [],
    );
  });
});
