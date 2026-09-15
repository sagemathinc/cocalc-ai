import { createHash, randomBytes, randomUUID } from "node:crypto";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { EXTERNAL_AGENT_TOKEN_PREFIX } from "@cocalc/conat/agents/external";
import { AgentStore } from "./store";
import { ExternalAgentStore, type ExternalEnrollment } from "./external-store";
import { PersonalAgentStore } from "./personal-store";
import { assertNoPersonalStateForRehome } from "./personal-rehome";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("external sender approved credential lifecycle", () => {
  const db = new AgentStore();
  const account = randomUUID(),
    other = randomUUID();
  const target = { project_id: randomUUID(), agent_id: randomUUID() };
  const unapproved = { project_id: randomUUID(), agent_id: randomUUID() };
  const validateTarget = jest.fn(async () => {});
  const freshAuth = jest.fn(async () => {});
  const authority = jest.fn(async () => {});
  const security = jest.fn(async () => {});
  const store = new ExternalAgentStore(db, validateTarget, {
    assertAuthority: authority,
    accountSecurity: security,
    freshAuth,
  });
  const personal = new PersonalAgentStore(db, jest.fn(), jest.fn(), authority);
  const tables = [
    "agent_external_installations",
    "agent_external_identities",
    "agent_personal_controls",
    "agent_personal_requests",
  ];
  const request = (principal = account) => {
    const secret = randomBytes(32).toString("hex");
    const options: ExternalEnrollment = {
      installation_id: randomUUID(),
      label: "SOC-2 agent on another computer",
      secret_hash: createHash("sha256").update(secret).digest("hex"),
      targets: [target],
      ttl_seconds: 3600,
    };
    return {
      options,
      token: `${EXTERNAL_AGENT_TOKEN_PREFIX}${principal}.${options.installation_id}.${secret}`,
    };
  };
  const active = async () => {
    const enrolled = request();
    const approved = await store.enroll(
      account,
      "test-human-session",
      enrolled.options,
    );
    return { ...enrolled, approved };
  };
  beforeAll(async () => {
    await syncSchema(
      Object.fromEntries(tables.map((name) => [name, SCHEMA[name]])),
    );
  });
  beforeEach(async () => {
    for (const table of tables) await db.query(`DELETE FROM ${table}`);
    for (const fn of [validateTarget, freshAuth, authority, security])
      fn.mockReset().mockResolvedValue(undefined);
  });

  test("fresh human approval binds only explicit destinations to a new external identity", async () => {
    const { token, approved } = await active();
    expect(freshAuth).toHaveBeenCalledWith(account, "test-human-session");
    expect(await store.authenticate(token)).toEqual(approved);
    expect(
      await store.check(account, approved.installation_id, target),
    ).toMatchObject({
      source: {
        kind: "external",
        account_id: account,
        agent_id: approved.agent_id,
        installation_id: approved.installation_id,
      },
      destination: { target, link_id: approved.destinations[0].link_id },
    });
    await expect(
      store.check(account, approved.installation_id, unapproved),
    ).rejects.toThrow("not_approved");
    expect(
      (await db.query("SELECT * FROM agent_external_identities")).rows,
    ).toHaveLength(1);
  });

  test("credential is hashed at rest and absent from public metadata", async () => {
    const { token, approved, options } = await active();
    const rows = (await db.query("SELECT * FROM agent_external_installations"))
      .rows;
    expect(rows[0].secret_hash).toBe(options.secret_hash);
    expect(JSON.stringify(rows)).not.toContain(token.split(".").at(-1));
    expect(approved).not.toHaveProperty("secret_hash");
    expect(await store.list(account)).toEqual([approved]);
    expect(validateTarget).toHaveBeenCalledTimes(1);
  });

  test("wrong account or secret and ordinary native credentials cannot authenticate", async () => {
    const { token, approved } = await active();
    await expect(
      store.authenticate(token.replace(account, other)),
    ).rejects.toThrow();
    const invalid = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    await expect(store.authenticate(invalid)).rejects.toThrow(
      "invalid external",
    );
    await expect(store.revoke(other, approved.installation_id)).rejects.toThrow(
      "not_found",
    );
    await expect(
      store.authenticate("cocalc_agent_v1.not-an-external-token"),
    ).rejects.toThrow();
    expect(await store.list(other)).toEqual([]);
    expect(await store.authenticate(token)).toEqual(approved);
  });

  test("no approval means no identity, installation, or usable credential", async () => {
    const { token, options } = request();
    await expect(store.authenticate(token)).rejects.toThrow("not_found");
    freshAuth.mockRejectedValueOnce(new Error("fresh_auth_required"));
    await expect(store.enroll(account, "session", options)).rejects.toThrow(
      "fresh_auth_required",
    );
    expect(validateTarget).not.toHaveBeenCalled();
    validateTarget.mockRejectedValueOnce(
      new Error("target membership removed"),
    );
    await expect(store.enroll(account, "session", options)).rejects.toThrow(
      "membership",
    );
    for (const table of tables.slice(0, 2))
      expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
  });

  test("duplicate browser approval is idempotent, cannot widen or extend authority", async () => {
    const { approved, options } = await active();
    expect(await store.enroll(account, "session", options)).toEqual(approved);
    for (const patch of [
      { ttl_seconds: 7200 },
      { targets: [unapproved] },
      { secret_hash: "0".repeat(64) },
    ])
      await expect(
        store.enroll(account, "session", { ...options, ...patch }),
      ).rejects.toThrow("conflict");
    await expect(store.enroll(other, "session", options)).rejects.toThrow(
      "conflict",
    );
    await store.revoke(account, approved.installation_id);
    await expect(store.enroll(account, "session", options)).rejects.toThrow(
      "inactive",
    );
    expect(
      (await db.query("SELECT * FROM agent_external_identities")).rows,
    ).toHaveLength(1);
  });

  test("installations may share an external identity but revocation is independent", async () => {
    const first = await active();
    const second = request();
    await store.enroll(account, "session", {
      ...second.options,
      agent_id: first.approved.agent_id,
    });
    await store.revoke(account, first.approved.installation_id);
    await expect(store.authenticate(first.token)).rejects.toThrow("inactive");
    expect(await store.authenticate(second.token)).toMatchObject({
      agent_id: first.approved.agent_id,
    });
    await store.disable(account, first.approved.agent_id);
    await expect(store.authenticate(second.token)).rejects.toThrow(
      "identity_unavailable",
    );
    expect(
      (await db.query("SELECT * FROM agent_external_identities")).rows,
    ).toHaveLength(1);
    expect(await store.list(account)).toHaveLength(2);
  });

  test("enrollment cannot impersonate a native identity or another human's external identity", async () => {
    const { options } = request();
    await expect(
      store.enroll(account, "session", {
        ...options,
        agent_id: target.agent_id,
      }),
    ).rejects.toThrow("identity_unavailable");
    const theirs = request(other);
    const approved = await store.enroll(other, "their-session", theirs.options);
    await expect(
      store.enroll(account, "session", {
        ...options,
        agent_id: approved.agent_id,
      }),
    ).rejects.toThrow("identity_unavailable");
  });

  test("expiry and account-wide controls fail closed without automatic renewal", async () => {
    const enrolled = await active();
    await personal.setControls(account, { action: "pause" });
    await expect(store.authenticate(enrolled.token)).rejects.toThrow("paused");
    await expect(
      store.enroll(account, "session", request().options),
    ).rejects.toThrow("paused");
    await personal.setControls(account, { action: "resume" });
    expect(await store.authenticate(enrolled.token)).toEqual(enrolled.approved);
    await personal.setControls(account, { action: "revoke_all" });
    await expect(store.authenticate(enrolled.token)).rejects.toThrow("revoked");
    const newer = await active();
    await db.query(
      "UPDATE agent_external_installations SET expires_at=now()-interval '1 second' WHERE installation_id=$1",
      [newer.approved.installation_id],
    );
    await expect(store.authenticate(newer.token)).rejects.toThrow("inactive");
    await expect(
      store.enroll(account, "session", newer.options),
    ).rejects.toThrow("inactive");
  });

  test("revocation during remote permission validation is rechecked before returning authority", async () => {
    const { approved } = await active();
    validateTarget.mockImplementationOnce(async () => {
      await store.revoke(account, approved.installation_id);
    });
    await expect(
      store.check(account, approved.installation_id, target),
    ).rejects.toThrow("inactive");
  });

  test("home fence and account-security failures prevent enrollment and authority", async () => {
    authority.mockRejectedValueOnce(new Error("stale account home"));
    await expect(
      store.enroll(account, "session", request().options),
    ).rejects.toThrow("stale account home");
    expect(
      (await db.query("SELECT * FROM agent_external_installations")).rows,
    ).toHaveLength(0);
    const { token } = await active();
    security.mockRejectedValueOnce(new Error("account_disabled"));
    await expect(store.authenticate(token)).rejects.toThrow("account_disabled");
    authority.mockRejectedValueOnce(new Error("account rehome in progress"));
    await expect(store.authenticate(token)).rejects.toThrow("account rehome");
  });

  test("fresh auth expiring during remote validation prevents enrollment", async () => {
    freshAuth
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("fresh_auth_required"));
    await expect(
      store.enroll(account, "session", request().options),
    ).rejects.toThrow("fresh_auth_required");
    expect(validateTarget).toHaveBeenCalledTimes(1);
    expect(
      (await db.query("SELECT * FROM agent_external_installations")).rows,
    ).toHaveLength(0);
    expect(
      (await db.query("SELECT * FROM agent_external_identities")).rows,
    ).toHaveLength(0);
  });

  test("history alone blocks account rehome rather than losing identity attribution", async () => {
    const { approved } = await active();
    await store.revoke(account, approved.installation_id);
    await db.query("DELETE FROM agent_personal_controls");
    await expect(assertNoPersonalStateForRehome(db, account)).rejects.toThrow(
      "portability",
    );
    await db.query("DELETE FROM agent_external_installations");
    await expect(assertNoPersonalStateForRehome(db, account)).rejects.toThrow(
      "portability",
    );
    await expect(
      assertNoPersonalStateForRehome(db, other),
    ).resolves.toBeUndefined();
  });

  test("recipient counts and credential lifetime are bounded before approval", async () => {
    const { options } = request();
    for (const patch of [
      { targets: [] },
      { targets: [target, target] },
      {
        targets: Array.from({ length: 33 }, () => ({
          project_id: randomUUID(),
          agent_id: randomUUID(),
        })),
      },
      { ttl_seconds: 0 },
      { ttl_seconds: 31 * 86400 },
    ])
      await expect(
        store.enroll(account, "session", { ...options, ...patch }),
      ).rejects.toThrow();
    expect(freshAuth).not.toHaveBeenCalled();
  });
});
