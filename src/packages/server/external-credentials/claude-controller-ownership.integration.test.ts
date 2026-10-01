/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID, createHash } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { CLAUDE_SUBSCRIPTION_KIND } from "@cocalc/util/ai/external-credential-profiles";
import { EXTERNAL_CREDENTIAL_CONFLICT } from "@cocalc/util/external-credential-conflict";
import { manageClaudeControllerOwnership } from "./claude-controller-ownership";
import {
  createExternalCredential,
  getExternalCredential,
  getExternalCredentialById,
  listExternalCredentials,
  revokeExternalCredential,
  updateExternalCredentialById,
  updateExternalCredentialPayloadLocked,
  upsertExternalCredential,
} from "./store";

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  encryptSecretStorageValue: async (_name: string, value: string) => value,
  decryptSecretStorageValue: async (_name: string, value: string) => ({
    value,
  }),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("account-home Claude refresh ownership", () => {
  const account = randomUUID();
  const selector = {
    provider: "anthropic",
    kind: CLAUDE_SUBSCRIPTION_KIND,
    scope: "account" as const,
    owner_account_id: account,
  };
  let id: string;
  const a = {
    holder: randomUUID(),
    host_id: randomUUID(),
    project_id: randomUUID(),
    runtime_id: `100:${randomUUID()}:1`,
  };
  const b = {
    holder: randomUUID(),
    host_id: randomUUID(),
    project_id: randomUUID(),
    runtime_id: `200:${randomUUID()}:2`,
  };
  const manage = (
    owner = a,
    operation: "acquire" | "release" = "acquire",
    credential_id = id,
  ) =>
    manageClaudeControllerOwnership({
      ...owner,
      operation,
      credential_id,
      owner_account_id: account,
    });
  const write = (
    controllerOwner?: typeof a,
    payload = "rotation-2",
    expectedPayloadSha256?: string,
  ) =>
    updateExternalCredentialById({
      id,
      selector,
      payload,
      metadata: {},
      controllerOwner,
      expectedPayloadSha256,
    });
  beforeAll(async () => {
    await syncSchema({
      external_credentials: SCHEMA.external_credentials,
      claude_controller_ownership: SCHEMA.claude_controller_ownership,
    });
  });
  beforeEach(async () => {
    await getPool().query("DELETE FROM external_credentials");
    await getPool().query("DELETE FROM claude_controller_ownership");
    id = (await createExternalCredential({ selector, payload: "rotation-1" }))
      .id;
  });
  test("two hosts cannot acquire simultaneously; acquisition and release acknowledgements are idempotent", async () => {
    const results = await Promise.all([manage(a), manage(b)]);
    expect([...results].sort()).toEqual(["acquired", "busy"]);
    // Test a known owner independently of the ordering of database promises.
    const row = (
      await getPool().query(
        "SELECT ownership AS controller_ownership FROM claude_controller_ownership WHERE account_id=$1",
        [account],
      )
    ).rows[0];
    const winner = row.controller_ownership.holder === a.holder ? a : b;
    expect(await manage(winner)).toBe("acquired");
    expect(await manage(winner, "release")).toBe("released");
    expect(await manage(winner, "release")).toBe("released");
    expect(await manage(winner)).toBe("released");
    expect(await manage(winner === a ? b : a)).toBe("acquired");
  });
  test("age alone never permits another host to refresh", async () => {
    await manage();
    await getPool().query(
      "UPDATE claude_controller_ownership SET ownership=jsonb_set(ownership, '{acquired_at}', '\"2000-01-01T00:00:00Z\"') WHERE account_id=$1",
      [account],
    );
    expect(await manage(b)).toBe("busy");
  });
  test("release before a delayed acquisition retires that holder, without releasing a different live controller", async () => {
    await manage(a, "release");
    expect(await manage(b)).toBe("acquired");
    expect(await manage(a)).toBe("released");
    expect(await manage(a, "release")).toBe("released");
    expect(await manage(b)).toBe("acquired");
  });
  test("writer is fenced by holder, host and project; legacy writers and active reconnect are blocked", async () => {
    await manage();
    await expect(
      updateExternalCredentialPayloadLocked({
        selector,
        id,
        update: async () => ({ payload: "unfenced" }),
      }),
    ).rejects.toThrow("CLAUDE_CONTROLLER_FENCED");
    for (const owner of [
      undefined,
      b,
      { ...a, host_id: b.host_id },
      { ...a, project_id: b.project_id },
      { ...a, runtime_id: b.runtime_id },
    ])
      await expect(write(owner)).rejects.toThrow("CLAUDE_CONTROLLER_FENCED");
    expect(await write(a)).toBe(true);
    await manage(a, "release");
    await expect(write(a)).rejects.toThrow("CLAUDE_CONTROLLER_FENCED");
    await expect(
      write(
        undefined,
        "stale",
        createHash("sha256").update("rotation-2").digest("hex"),
      ),
    ).rejects.toThrow("CLAUDE_CONTROLLER_FENCED");
    expect(await write(undefined, "explicit-reconnect")).toBe(true);
  });
  test("CAS still rejects a stale owned payload and the next host sees the published revision", async () => {
    await manage();
    await write(a);
    await expect(
      write(
        a,
        "stale",
        createHash("sha256").update("rotation-1").digest("hex"),
      ),
    ).rejects.toThrow(EXTERNAL_CREDENTIAL_CONFLICT);
    await manage(a, "release");
    await manage(b);
    expect((await getExternalCredentialById({ id, selector }))?.payload).toBe(
      "rotation-2",
    );
  });
  test("deduplicated sign-in and implicit upsert cannot bypass ownership", async () => {
    await getPool().query(
      "UPDATE external_credentials SET metadata=$2 WHERE id=$1",
      [id, { identity: "synthetic-account" }],
    );
    await manage();
    await expect(
      createExternalCredential({
        selector,
        payload: "clobber",
        deduplicateMetadata: { key: "identity", value: "synthetic-account" },
      }),
    ).rejects.toThrow("CLAUDE_CONTROLLER_FENCED");
    await expect(
      upsertExternalCredential({ selector, payload: "clobber" }),
    ).rejects.toThrow("explicit credential");
  });
  test("revocation blocks new acquisition, while its stopped owner can release; ownership stays private", async () => {
    await manage();
    const publicRows = await listExternalCredentials({
      owner_account_id: account,
    });
    expect(JSON.stringify(publicRows)).not.toContain(a.holder);
    await revokeExternalCredential({ id, owner_account_id: account });
    await expect(manage(b)).rejects.toThrow("revoked");
    await expect(write(a)).resolves.toBe(false);
    expect(await manage(a, "release")).toBe("released");
  });
  test("a different account remains independently usable", async () => {
    await manage();
    const otherAccount = randomUUID();
    const other = await createExternalCredential({
      selector: { ...selector, owner_account_id: otherAccount },
      payload: "other-subscription",
    });
    expect(
      await manageClaudeControllerOwnership({
        ...b,
        owner_account_id: otherAccount,
        credential_id: other.id,
        operation: "acquire",
      }),
    ).toBe("acquired");
  });
  test("creation cannot override the one-subscription backend limit", async () => {
    await expect(
      createExternalCredential({ selector, payload: "other", maxActive: 3 }),
    ).rejects.toThrow("at most 1");
  });
  test("pre-existing rows share a fence and explicit bindings are preserved", async () => {
    const other = randomUUID();
    await getPool().query(
      `INSERT INTO external_credentials(id, provider, kind, scope, owner_account_id, encrypted_payload)
      VALUES($1,'anthropic',$2,'account',$3,'synthetic-other')`,
      [other, CLAUDE_SUBSCRIPTION_KIND, account],
    );
    await manage(a);
    await expect(getExternalCredential({ selector })).rejects.toThrow(
      "Choose an explicit Claude subscription",
    );
    expect((await getExternalCredentialById({ selector, id: other }))?.id).toBe(
      other,
    );
    expect(await manage(b, "acquire", other)).toBe("busy");
    await manage(a, "release");
    expect(await manage(b, "acquire", other)).toBe("acquired");
    await expect(write(a)).rejects.toThrow("CLAUDE_CONTROLLER_FENCED");
  });
  test("revocation does not permit replacement or first sign-in while the old owner lives", async () => {
    await manage();
    await revokeExternalCredential({ id, owner_account_id: account });
    expect(
      await manageClaudeControllerOwnership({
        ...b,
        owner_account_id: account,
        operation: "acquire",
      }),
    ).toBe("busy");
    await expect(
      createExternalCredential({ selector, payload: "replacement" }),
    ).rejects.toThrow("CLAUDE_CONTROLLER_FENCED");
    await manage(a, "release");
    const replacement = await createExternalCredential({
      selector,
      payload: "replacement",
    });
    expect(await manage(b, "acquire", replacement.id)).toBe("acquired");
    expect(await manage(a, "release")).toBe("released");
    expect(await manage(b, "acquire", replacement.id)).toBe("acquired");
  });
  test("first sign-in reserves account authority before any credential exists", async () => {
    await getPool().query("DELETE FROM external_credentials");
    const login = (owner = a, operation: "acquire" | "release" = "acquire") =>
      manageClaudeControllerOwnership({
        ...owner,
        owner_account_id: account,
        operation,
      });
    expect(await login()).toBe("acquired");
    expect(await login(b)).toBe("busy");
    await expect(
      createExternalCredential({ selector, payload: "unreserved" }),
    ).rejects.toThrow("CLAUDE_CONTROLLER_FENCED");
    const created = await createExternalCredential({
      selector,
      payload: "sign-in",
      controllerOwner: a,
    });
    expect(await manage(b, "acquire", created.id)).toBe("busy");
    expect(await login(a, "release")).toBe("released");
    expect(await login()).toBe("released");
    expect(await manage(b, "acquire", created.id)).toBe("acquired");
  });
  test("ownership binds host incarnation and advances its generation only after stopped release", async () => {
    expect(await manage()).toBe("acquired");
    expect(await manage({ ...a, runtime_id: b.runtime_id })).toBe("busy");
    const read = async () =>
      (
        await getPool().query(
          "SELECT ownership FROM claude_controller_ownership WHERE account_id=$1",
          [account],
        )
      ).rows[0].ownership;
    const first = await read();
    expect(first).toMatchObject({
      runtime_id: a.runtime_id,
      state: "active",
      purpose: "controller",
      generation: 1,
    });
    await manage(a, "release");
    expect((await read()).state).toBe("released");
    await manage(b);
    expect((await read()).generation).toBe(2);
    await manage(a, "release");
    expect(await read()).toMatchObject({
      holder: b.holder,
      state: "active",
      generation: 2,
    });
  });
  test("legacy row ownership remains a fence even after revocation", async () => {
    await getPool().query(
      "UPDATE external_credentials SET controller_ownership=$2, revoked=NOW() WHERE id=$1",
      [id, { ...a, acquired_at: new Date().toISOString() }],
    );
    await expect(
      createExternalCredential({ selector, payload: "replacement" }),
    ).rejects.toThrow("CLAUDE_CONTROLLER_FENCED");
    expect(
      await manageClaudeControllerOwnership({
        ...b,
        owner_account_id: account,
        operation: "acquire",
      }),
    ).toBe("busy");
    await manage(a, "release");
    expect(
      await manageClaudeControllerOwnership({
        ...b,
        owner_account_id: account,
        operation: "acquire",
      }),
    ).toBe("acquired");
  });
  test("account ownership is checked even with a valid credential UUID", async () => {
    await expect(
      manageClaudeControllerOwnership({
        ...a,
        owner_account_id: randomUUID(),
        credential_id: id,
        operation: "acquire",
      }),
    ).rejects.toThrow("unavailable");
  });
});
