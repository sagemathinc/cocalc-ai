/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import {
  CODEX_SUBSCRIPTION_DEFAULT_METADATA_KEY,
  CODEX_SUBSCRIPTION_KIND,
  createExternalCredential,
  ensureDefaultExternalCredential,
  getExternalCredential,
  hasExternalCredential,
  listExternalCredentials,
  revokeExternalCredential,
  touchExternalCredential,
  updateExternalCredentialPayloadLocked,
} from "./store";

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  encryptSecretStorageValue: async (_name: string, value: string) => value,
  decryptSecretStorageValue: async (_name: string, value: string) => ({
    value,
  }),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("account Codex subscription default identity", () => {
  const accountId = randomUUID();
  const selector = {
    provider: "openai",
    kind: CODEX_SUBSCRIPTION_KIND,
    scope: "account" as const,
    owner_account_id: accountId,
  };
  const create = (payload: string, establishDefault = false) =>
    createExternalCredential({
      selector,
      payload,
      defaultMetadataKey: establishDefault
        ? CODEX_SUBSCRIPTION_DEFAULT_METADATA_KEY
        : undefined,
    });

  beforeAll(async () => {
    await syncSchema({ external_credentials: SCHEMA.external_credentials });
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM external_credentials");
  });

  test("adding B migrates legacy A and keeps A as the designated default", async () => {
    const a = await create("A");
    const b = await create("B", true);
    expect(
      (
        await ensureDefaultExternalCredential({
          selector,
          metadataKey: CODEX_SUBSCRIPTION_DEFAULT_METADATA_KEY,
        })
      )?.id,
    ).toBe(a.id);
    expect((await getExternalCredential({ selector }))?.payload).toBe("A");
    expect(b.id).not.toBe(a.id);
  });

  test("legacy migration preserves the newest active effective credential", async () => {
    const a = await create("A");
    const b = await create("B");
    await getPool().query(
      `UPDATE external_credentials
       SET updated = CASE WHEN id=$1 THEN NOW() - INTERVAL '1 hour' ELSE NOW() END
       WHERE id IN ($1, $2)`,
      [a.id, b.id],
    );

    const designated = await ensureDefaultExternalCredential({
      selector,
      metadataKey: CODEX_SUBSCRIPTION_DEFAULT_METADATA_KEY,
    });
    expect(designated?.id).toBe(b.id);
  });

  test("a revoked default remains a tombstone when B is added", async () => {
    const a = await create("A", true);
    await revokeExternalCredential({ id: a.id, owner_account_id: accountId });
    const b = await create("B", true);
    const update = jest.fn(async () => ({ payload: "changed" }));

    const designated = await ensureDefaultExternalCredential({
      selector,
      metadataKey: CODEX_SUBSCRIPTION_DEFAULT_METADATA_KEY,
    });
    expect(designated).toMatchObject({ id: a.id });
    expect(designated?.revoked).not.toBeNull();
    expect(await getExternalCredential({ selector })).toBeUndefined();
    expect(await hasExternalCredential({ selector })).toBe(false);
    expect(await touchExternalCredential({ selector })).toBe(false);
    expect(
      await updateExternalCredentialPayloadLocked({ selector, update }),
    ).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(
      (
        await listExternalCredentials({
          owner_account_id: accountId,
          provider: "openai",
          kind: CODEX_SUBSCRIPTION_KIND,
        })
      ).find(({ id }) => id === b.id)?.revoked,
    ).toBeNull();
  });

  test("concurrent migration, Add and revoke retain A as the sole designation", async () => {
    const a = await create("A");
    await Promise.all([
      create("B", true),
      revokeExternalCredential({ id: a.id, owner_account_id: accountId }),
    ]);

    const rows = (
      await getPool().query(
        `SELECT id, metadata, revoked FROM external_credentials
         WHERE owner_account_id=$1`,
        [accountId],
      )
    ).rows;
    expect(
      rows.filter(
        ({ metadata }) =>
          metadata?.[CODEX_SUBSCRIPTION_DEFAULT_METADATA_KEY] === true,
      ),
    ).toHaveLength(1);
    expect(rows.find(({ id }) => id === a.id)).toMatchObject({
      metadata: { [CODEX_SUBSCRIPTION_DEFAULT_METADATA_KEY]: true },
    });
    expect(
      (
        await ensureDefaultExternalCredential({
          selector,
          metadataKey: CODEX_SUBSCRIPTION_DEFAULT_METADATA_KEY,
        })
      )?.id,
    ).toBe(a.id);
  });
});
