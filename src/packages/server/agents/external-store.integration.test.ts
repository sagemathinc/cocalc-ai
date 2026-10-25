import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EXTERNAL_AGENT_TOKEN_PREFIX } from "@cocalc/conat/agents/external";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { ExternalAgentStore, type ExternalEnrollment } from "./external-store";
import { AgentStore } from "./store";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("network-bound external agents", () => {
  const account = randomUUID();
  const network = randomUUID();
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
      agent_network_id: network,
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

  test("approval creates one finite credential bound to one network", async () => {
    const { options, token } = enrollment();
    const approved = await store.enroll(account, "human-session", options);

    expect(freshAuth).toHaveBeenCalledTimes(1);
    expect(freshAuth).toHaveBeenCalledWith(account, "human-session");
    expect(approved).toMatchObject({
      installation_id: options.installation_id,
      account_id: account,
      agent_network_id: network,
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
        agent_network_id: randomUUID(),
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

  test("enrollment status checks the secret before saying an installation is inactive", async () => {
    const { options } = enrollment();
    await store.enroll(account, "human-session", options);
    expect(
      await store.enrollmentStatus(
        account,
        options.installation_id,
        options.secret_hash,
      ),
    ).toMatchObject({ installation_id: options.installation_id });
    await store.revoke(account, options.installation_id);
    await expect(
      store.enrollmentStatus(account, options.installation_id, "b".repeat(64)),
    ).rejects.toThrow("external_approval_conflict");
    await expect(
      store.enrollmentStatus(
        account,
        options.installation_id,
        options.secret_hash,
      ),
    ).rejects.toThrow("external_credential_inactive");

    // Revoked by an account-wide sign-out: still only for the matching secret.
    const second = enrollment();
    await store.enroll(account, "human-session", second.options);
    // As accountSecurity does: only a credential issued before the revocation
    // is refused; the account itself is not disabled.
    security.mockImplementation(async (_account, issued_at) => {
      if (issued_at) throw new Error("external_credential_revoked");
    });
    await expect(
      store.enrollmentStatus(
        account,
        second.options.installation_id,
        "b".repeat(64),
      ),
    ).rejects.toThrow("external_approval_conflict");
    await expect(
      store.enrollmentStatus(
        account,
        second.options.installation_id,
        second.options.secret_hash,
      ),
    ).rejects.toThrow("external_credential_revoked");
  });

  test("bounded inbox is network-bound, idempotent, and acknowledged", async () => {
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
      agent_network_id: network,
      network_generation: generation,
      source,
      source_account_id: account,
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
        agent_network_id: randomUUID(),
      }),
    ).rejects.toThrow("external_network_mismatch");
    await expect(
      store.acknowledge(
        account,
        installation.installation_id,
        message.message_id,
      ),
    ).resolves.toEqual({
      acknowledged: true,
      message_id: message.message_id,
      // The acknowledgment returns the message, so it is never lost.
      message,
    });
    expect(await store.inbox(account, installation.installation_id)).toEqual(
      [],
    );
    // Acknowledged messages stay readable until they expire.
    const read = await store.inbox(account, installation.installation_id, 50, {
      includeAcknowledged: true,
    });
    expect(read).toEqual([
      {
        ...message,
        state: "acknowledged",
        acknowledged_at: expect.any(String),
      },
    ]);
  });

  test("the sender, and only the sender, learns whether its message was read", async () => {
    const { options } = enrollment();
    const installation = await store.enroll(account, "human-session", options);
    const sender = randomUUID();
    const source = {
      kind: "registered" as const,
      account_id: sender,
      project_id: randomUUID(),
      agent_id: randomUUID(),
      run_id: randomUUID(),
    };
    const input = {
      account_id: account,
      installation_id: installation.installation_id,
      attempt_id: randomUUID(),
      agent_network_id: network,
      network_generation: generation,
      source,
      source_account_id: sender,
      body: "Did you read this?",
    };
    const message = await store.enqueue(input);
    // A retry by another account cannot claim the attempt.
    await expect(
      store.enqueue({ ...input, source_account_id: randomUUID() }),
    ).rejects.toThrow("external_inbox_idempotency_conflict");
    const delivery = (
      over: Partial<{
        installation: string;
        attempt_id: string;
        network: string;
        source: typeof source;
        source_account_id: string;
      }> = {},
    ) =>
      store.delivery(
        account,
        over.installation ?? installation.installation_id,
        over.attempt_id ?? input.attempt_id,
        over.network ?? network,
        over.source ?? source,
        over.source_account_id ?? sender,
      );
    expect(await delivery()).toMatchObject({ state: "pending" });
    expect((await delivery())?.acknowledged_at).toBeUndefined();
    await store.acknowledge(
      account,
      installation.installation_id,
      message.message_id,
    );
    const read = await delivery();
    expect(read).toMatchObject({ state: "acknowledged" });
    expect(read?.acknowledged_at).toEqual(expect.any(String));
    // UUIDs are compared as UUIDs, whatever their case.
    expect(
      await delivery({
        installation: installation.installation_id.toUpperCase(),
        network: network.toUpperCase(),
        source_account_id: sender.toUpperCase(),
      }),
    ).toMatchObject({ state: "acknowledged" });
    // Another sender, another account presenting the same source, another
    // inbox or another attempt learns nothing.
    expect(
      await delivery({ source: { ...source, agent_id: randomUUID() } }),
    ).toBeNull();
    expect(await delivery({ source_account_id: randomUUID() })).toBeNull();
    expect(await delivery({ installation: randomUUID() })).toBeNull();
    expect(await delivery({ attempt_id: randomUUID() })).toBeNull();
    expect(await delivery({ network: randomUUID() })).toBeNull();
    // Nor does anyone once the message has expired.
    await db.query(
      "UPDATE agent_external_inbox SET expires_at=now()-interval '1 second' WHERE message_id=$1",
      [message.message_id],
    );
    expect(await delivery()).toBeNull();
  });

  test("a message from a bay that predates the sender's account is delivered, but never inspectable", async () => {
    const { options } = enrollment();
    const installation = await store.enroll(account, "human-session", options);
    const sender = randomUUID();
    const source = {
      kind: "registered" as const,
      account_id: sender,
      project_id: randomUUID(),
      agent_id: randomUUID(),
      run_id: randomUUID(),
    };
    // An older bay sends no source_account_id.
    const legacy = {
      account_id: account,
      installation_id: installation.installation_id,
      attempt_id: randomUUID(),
      agent_network_id: network,
      network_generation: generation,
      source,
      body: "From an older bay.",
    };
    const message = await store.enqueue(legacy);
    expect(await store.inbox(account, installation.installation_id)).toEqual([
      message,
    ]);
    // A retry from an upgraded bay is the same message, still NULL.
    expect(
      await store.enqueue({ ...legacy, source_account_id: sender }),
    ).toEqual(message);
    expect(
      await store.delivery(
        account,
        installation.installation_id,
        legacy.attempt_id,
        network,
        source,
        sender,
      ),
    ).toBeNull();
  });
});
