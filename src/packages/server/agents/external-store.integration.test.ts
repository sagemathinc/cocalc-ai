import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EXTERNAL_AGENT_TOKEN_PREFIX } from "@cocalc/conat/agents/external";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import {
  EXTERNAL_INBOX_DB_BYTES,
  ExternalAgentStore,
  type ExternalEnrollment,
} from "./external-store";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { AgentStore } from "./store";
import { setExternalInboxObjectsForTesting } from "./external-inbox-objects";

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
    "agent_external_inbox_attachments",
    "agent_external_inbox_reservations",
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
    // Files stay in Postgres unless a test says otherwise.
    setExternalInboxObjectsForTesting(null);
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
    // An expired message cannot be read back, not even by acknowledging it.
    await expect(
      store.acknowledge(
        account,
        installation.installation_id,
        message.message_id,
      ),
    ).rejects.toThrow("external_inbox_message_not_found");
    expect(
      await store.inbox(account, installation.installation_id, 50, {
        includeAcknowledged: true,
      }),
    ).toEqual([]);
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

  function file(name: string, text: string) {
    const data = new TextEncoder().encode(text);
    return {
      name,
      size: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
      data,
    };
  }

  const sender = randomUUID();

  function manifestOf(files: ReturnType<typeof file>[]) {
    return files.map(({ name, size, sha256 }) => ({ name, size, sha256 }));
  }

  // A message for a new installation, and (with files) the reservation that
  // preparing them makes.
  async function sent(
    attachments?: ReturnType<typeof file>[],
    { reserve = true }: { reserve?: boolean } = {},
  ) {
    const { options } = enrollment();
    const installation = await store.enroll(account, "human-session", options);
    const source = {
      kind: "registered" as const,
      account_id: sender,
      project_id: randomUUID(),
      agent_id: randomUUID(),
      run_id: randomUUID(),
    };
    const base = {
      account_id: account,
      installation_id: installation.installation_id,
      attempt_id: randomUUID(),
      agent_network_id: network,
      network_generation: generation,
      source,
      source_account_id: sender,
    };
    const reservation =
      attachments && reserve
        ? await store.reserve({ ...base, manifest: manifestOf(attachments) })
        : undefined;
    const input = {
      ...base,
      body: "Report attached.",
      ...(attachments ? { attachments } : {}),
      ...(reservation ? { reservation_id: reservation.reservation_id } : {}),
    };
    return { installation, source, base, input, reservation };
  }

  // As if the inbox already held this much: one stored file says so (the size
  // check is set aside just for this).
  async function pretendHeld(
    bytes: number,
    { otherAccount = false }: { otherAccount?: boolean } = {},
  ) {
    const { input } = await sent([file("held.txt", "x")]);
    await store.enqueue(input);
    await db.query(
      "ALTER TABLE agent_external_inbox_attachments DROP CONSTRAINT agent_external_inbox_attachments_size_check",
    );
    await db.query(
      "UPDATE agent_external_inbox_attachments SET size=$2, account_id=$3 WHERE installation_id=$1",
      [input.installation_id, bytes, otherAccount ? randomUUID() : account],
    );
  }

  async function restoreSizeCheck() {
    await db.query("DELETE FROM agent_external_inbox_attachments");
    await db.query(
      `ALTER TABLE agent_external_inbox_attachments ADD CONSTRAINT agent_external_inbox_attachments_size_check
       CHECK (size BETWEEN 0 AND 33554432 AND (data IS NULL OR octet_length(data)=size))`,
    );
  }

  test("attachments are kept with the message and read back by the installation", async () => {
    const files = [
      file("report.md", "# Report\n"),
      file("data.csv", "a,b\n1,2\n"),
    ];
    const { installation, input } = await sent(files);
    const message = await store.enqueue(input);
    expect(message.attachments).toEqual(manifestOf(files));
    expect(await store.inbox(account, installation.installation_id)).toEqual([
      message,
    ]);
    const second = await store.attachment(
      account,
      installation.installation_id,
      message.message_id,
      1,
    );
    expect(second).toMatchObject({ name: "data.csv", index: 1, count: 2 });
    expect(new TextDecoder().decode(second.data)).toBe("a,b\n1,2\n");
    // The send consumed its reservation.
    expect(
      (await db.query("SELECT * FROM agent_external_inbox_reservations")).rows,
    ).toEqual([]);
    // A retry is the same message (its reservation is spent, and not
    // needed); changed files are a conflict.
    expect(await store.enqueue(input)).toEqual(message);
    await expect(
      store.enqueue({ ...input, attachments: [files[0]] }),
    ).rejects.toThrow("external_inbox_idempotency_conflict");
    // Still readable once the message is read.
    await store.acknowledge(
      account,
      installation.installation_id,
      message.message_id,
    );
    await expect(
      store.attachment(
        account,
        installation.installation_id,
        message.message_id,
        0,
      ),
    ).resolves.toMatchObject({ name: "report.md" });
    await expect(
      store.attachment(
        account,
        installation.installation_id,
        message.message_id,
        2,
      ),
    ).rejects.toThrow("external_inbox_attachment_not_found");
    // Another installation of the account cannot read them.
    const other = await sent();
    await expect(
      store.attachment(
        account,
        other.installation.installation_id,
        message.message_id,
        0,
      ),
    ).rejects.toThrow("external_inbox_attachment_not_found");
  });

  test("content must match the manifest", async () => {
    const bad = { ...file("x.txt", "hello"), sha256: "0".repeat(64) };
    const { input } = await sent([bad]);
    await expect(store.enqueue(input)).rejects.toThrow(
      "external_inbox_attachment_mismatch",
    );
  });

  test("files travel only with the reservation made for exactly them", async () => {
    const files = [file("a.txt", "a")];
    const unreserved = await sent(files, { reserve: false });
    await expect(store.enqueue(unreserved.input)).rejects.toThrow(
      "external_inbox_attachment_unreserved",
    );
    const { base, input, reservation } = await sent(files);
    // Preparing the same files again is the same reservation; anything else
    // for the attempt is a conflict.
    expect(
      await store.reserve({ ...base, manifest: manifestOf(files) }),
    ).toEqual(reservation);
    await expect(
      store.reserve({ ...base, manifest: manifestOf([file("b.txt", "b")]) }),
    ).rejects.toThrow("external_inbox_idempotency_conflict");
    // Not another attempt's, sender's or file's.
    for (const wrong of [
      { ...input, attempt_id: randomUUID() },
      { ...input, source_account_id: randomUUID() },
      { ...input, source: { ...input.source, agent_id: randomUUID() } },
      { ...input, attachments: [file("a.txt", "A")] },
      { ...input, reservation_id: randomUUID() },
    ])
      await expect(store.enqueue(wrong)).rejects.toThrow(
        /external_inbox_attachment_unreserved|external_inbox_attachment_mismatch/,
      );
    // Not once it has lapsed.
    await db.query(
      "UPDATE agent_external_inbox_reservations SET expires_at=now()-interval '1 second'",
    );
    await expect(store.enqueue(input)).rejects.toThrow(
      "external_inbox_attachment_unreserved",
    );
  });

  test("released room is free again, and only its sender releases it", async () => {
    const files = [file("a.txt", "a")];
    const { base, reservation } = await sent(files);
    const release = {
      ...base,
      reservation_id: reservation!.reservation_id,
    };
    expect(
      await store.release({ ...release, source_account_id: randomUUID() }),
    ).toBe(false);
    expect(await store.release(release)).toBe(true);
    expect(await store.release(release)).toBe(false);
    const again = await store.reserve({ ...base, manifest: manifestOf(files) });
    expect(again.reservation_id).not.toBe(reservation!.reservation_id);
  });

  test("an account's inboxes hold a bounded amount, counting reservations, across installations", async () => {
    await pretendHeld(256 * 1024 * 1024 - 2);
    try {
      // Another installation of the same account: the same room.
      const first = await sent([file("a.txt", "x")]);
      expect(first.reservation).toBeDefined();
      // The first reservation took the last free byte but one.
      await expect(sent([file("b.txt", "yy")])).rejects.toThrow(
        "external_inbox_attachment_capacity",
      );
      // Without files, messages still arrive.
      const plain = await sent();
      await expect(store.enqueue(plain.input)).resolves.toMatchObject({
        body: "Report attached.",
      });
    } finally {
      await restoreSizeCheck();
    }
  });

  test("files kept in this bay's database are bounded for every account together", async () => {
    await pretendHeld(EXTERNAL_INBOX_DB_BYTES, { otherAccount: true });
    try {
      await expect(sent([file("a.txt", "x")])).rejects.toThrow(
        "external_inbox_attachment_capacity",
      );
      // With R2 the database does not hold them, so they fit.
      setExternalInboxObjectsForTesting(objectStore());
      await expect(sent([file("a.txt", "x")])).resolves.toBeDefined();
    } finally {
      setExternalInboxObjectsForTesting(null);
      await restoreSizeCheck();
    }
  });

  // R2 configured: an in-memory stand-in for the private objects.
  function objectStore() {
    const objects = new Map<string, Buffer>();
    return {
      objects,
      put: jest.fn(async (key: string, data: Buffer) => {
        objects.set(key, Buffer.from(data));
      }),
      get: jest.fn(async (key: string) => objects.get(key)),
      list: jest.fn(async (prefix: string, limit: number) =>
        [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort()
          .slice(0, limit),
      ),
      delete: jest.fn(async (keys: string[]) => {
        for (const key of keys) objects.delete(key);
      }),
    };
  }

  test("with R2, files are private objects and the rows say only where", async () => {
    const objects = objectStore();
    setExternalInboxObjectsForTesting(objects);
    try {
      const files = [file("report.md", "# Report\n"), file("x.bin", "\u0001")];
      const { installation, input } = await sent(files);
      const message = await store.enqueue(input);
      const rows = (
        await db.query(
          `SELECT idx,data,r2_key FROM agent_external_inbox_attachments
           WHERE message_id=$1 ORDER BY idx`,
          [message.message_id],
        )
      ).rows;
      expect(rows.map((row) => row.data)).toEqual([null, null]);
      const day = new Date(Date.now() + 8 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      expect(rows.map((row) => row.r2_key)).toEqual(
        files.map(
          (f, idx) =>
            `agent-external-inbox/v1/${getConfiguredBayId()}/${day}/${account}/${input.attempt_id}/${idx}-${f.sha256}`,
        ),
      );
      expect(objects.objects.get(rows[0].r2_key)?.toString()).toBe(
        "# Report\n",
      );
      const read = await store.attachment(
        account,
        installation.installation_id,
        message.message_id,
        0,
      );
      expect(Buffer.from(read.data).toString()).toBe("# Report\n");
      // A retry uploads nothing again, and removes nothing.
      await store.enqueue(input);
      expect(objects.put).toHaveBeenCalledTimes(2);
      expect(objects.delete).not.toHaveBeenCalled();
      // An object that is not what the row says is never handed out.
      objects.objects.set(rows[1].r2_key, Buffer.from("tampered"));
      await expect(
        store.attachment(
          account,
          installation.installation_id,
          message.message_id,
          1,
        ),
      ).rejects.toThrow("external_inbox_attachment_unavailable");
      objects.objects.delete(rows[1].r2_key);
      await expect(
        store.attachment(
          account,
          installation.installation_id,
          message.message_id,
          1,
        ),
      ).rejects.toThrow("external_inbox_attachment_unavailable");
    } finally {
      setExternalInboxObjectsForTesting(null);
    }
  });

  test("with R2, nothing is uploaded without the reservation, or for a conflicting retry", async () => {
    const objects = objectStore();
    setExternalInboxObjectsForTesting(objects);
    try {
      const files = [file("a.txt", "a")];
      const unreserved = await sent(files, { reserve: false });
      await expect(store.enqueue(unreserved.input)).rejects.toThrow(
        "external_inbox_attachment_unreserved",
      );
      const { input } = await sent(files);
      await store.enqueue(input);
      expect(objects.put).toHaveBeenCalledTimes(1);
      await expect(
        store.enqueue({ ...input, attachments: [file("a.txt", "changed")] }),
      ).rejects.toThrow("external_inbox_idempotency_conflict");
      expect(objects.put).toHaveBeenCalledTimes(1);
    } finally {
      setExternalInboxObjectsForTesting(null);
    }
  });

  test("a send holds its reservation while it uploads: counted, and not sent or released twice", async () => {
    const objects = objectStore();
    setExternalInboxObjectsForTesting(objects);
    try {
      const files = [file("a.txt", "a")];
      const { base, input, reservation } = await sent(files);
      const during: any[] = [];
      objects.put.mockImplementationOnce(async (key: string, data: Buffer) => {
        const row = (
          await db.query("SELECT * FROM agent_external_inbox_reservations")
        ).rows[0];
        during.push(row);
        // The same send again uploads nothing; the sender cannot release it.
        await expect(store.enqueue(input)).rejects.toThrow(
          "external_inbox_attachment_in_progress",
        );
        expect(
          await store.release({
            ...base,
            reservation_id: reservation!.reservation_id,
          }),
        ).toBe(false);
        objects.objects.set(key, Buffer.from(data));
      });
      await store.enqueue(input);
      expect(objects.put).toHaveBeenCalledTimes(1);
      // Claimed, with a lease that keeps it counted well past the upload.
      expect(during[0].claim_id).toBeTruthy();
      expect(new Date(during[0].expires_at).getTime()).toBeGreaterThan(
        Date.now() + 5 * 60_000,
      );
      expect(
        (await db.query("SELECT * FROM agent_external_inbox_reservations"))
          .rows,
      ).toEqual([]);
    } finally {
      setExternalInboxObjectsForTesting(null);
    }
  });

  test("a lease that lapses during the upload stores nothing", async () => {
    const objects = objectStore();
    setExternalInboxObjectsForTesting(objects);
    try {
      const { installation, input } = await sent([file("a.txt", "a")]);
      objects.put.mockImplementationOnce(async () => {
        // No longer counted: storing the files now would exceed the bounds.
        await db.query(
          "UPDATE agent_external_inbox_reservations SET expires_at=now()-interval '1 second'",
        );
      });
      await expect(store.enqueue(input)).rejects.toThrow(
        "external_inbox_attachment_unreserved",
      );
      expect(await store.inbox(account, installation.installation_id)).toEqual(
        [],
      );
    } finally {
      setExternalInboxObjectsForTesting(null);
    }
  });

  test("a failed upload gives up its claim, so the send can be retried", async () => {
    const objects = objectStore();
    setExternalInboxObjectsForTesting(objects);
    try {
      const { input } = await sent([file("a.txt", "a")]);
      objects.put.mockRejectedValueOnce(new Error("R2 unavailable"));
      await expect(store.enqueue(input)).rejects.toThrow("R2 unavailable");
      expect(
        (
          await db.query(
            "SELECT claim_id FROM agent_external_inbox_reservations",
          )
        ).rows,
      ).toEqual([{ claim_id: null }]);
      await expect(store.enqueue(input)).resolves.toMatchObject({
        attachments: [expect.objectContaining({ name: "a.txt" })],
      });
    } finally {
      setExternalInboxObjectsForTesting(null);
    }
  });

  test("UUIDs spelled in uppercase are the same reservation and send", async () => {
    const files = [file("a.txt", "a")];
    const { base, input, reservation } = await sent(files);
    const upper = (value: string) => value.toUpperCase();
    expect(
      await store.reserve({
        ...base,
        installation_id: upper(base.installation_id),
        attempt_id: upper(base.attempt_id),
        manifest: manifestOf(files),
      }),
    ).toEqual(reservation);
    await expect(
      store.enqueue({
        ...input,
        attempt_id: upper(input.attempt_id),
        reservation_id: upper(input.reservation_id!),
      }),
    ).resolves.toMatchObject({ body: "Report attached." });
  });

  test("a row holds its content in exactly one place", async () => {
    const { input } = await sent([file("a.txt", "x")]);
    const message = await store.enqueue(input);
    await expect(
      db.query(
        "UPDATE agent_external_inbox_attachments SET r2_key='k' WHERE message_id=$1",
        [message.message_id],
      ),
    ).rejects.toThrow(/content_check/);
    await expect(
      db.query(
        "UPDATE agent_external_inbox_attachments SET data=NULL WHERE message_id=$1",
        [message.message_id],
      ),
    ).rejects.toThrow(/content_check/);
  });
});
