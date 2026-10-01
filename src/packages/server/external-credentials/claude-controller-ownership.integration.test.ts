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
  };
  const b = {
    holder: randomUUID(),
    host_id: randomUUID(),
    project_id: randomUUID(),
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
    await syncSchema({ external_credentials: SCHEMA.external_credentials });
  });
  beforeEach(async () => {
    await getPool().query("DELETE FROM external_credentials");
    id = (await createExternalCredential({ selector, payload: "rotation-1" }))
      .id;
  });
  test("two hosts cannot acquire simultaneously; acquisition and release acknowledgements are idempotent", async () => {
    const results = await Promise.all([manage(a), manage(b)]);
    expect([...results].sort()).toEqual(["acquired", "busy"]);
    // Test a known owner independently of the ordering of database promises.
    const row = (
      await getPool().query(
        "SELECT controller_ownership FROM external_credentials WHERE id=$1",
        [id],
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
      "UPDATE external_credentials SET controller_ownership=jsonb_set(controller_ownership, '{acquired_at}', '\"2000-01-01T00:00:00Z\"') WHERE id=$1",
      [id],
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
  test("a different credential remains independently usable", async () => {
    await manage();
    const other = await createExternalCredential({
      selector,
      payload: "other-subscription",
    });
    expect(await manage(b, "acquire", other.id)).toBe("acquired");
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
