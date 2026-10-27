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
  eraseRevokedExternalCredentialPayloads,
  getExternalCredential,
  hasExternalCredential,
  listExternalCredentials,
  parseStrictIsoUtc,
  revokeExternalCredential,
  touchExternalCredential,
  updateExternalCredentialById,
  updateExternalCredentialPayloadLocked,
} from "./store";
import { createHash } from "node:crypto";
import { EXTERNAL_CREDENTIAL_CONFLICT } from "@cocalc/util/external-credential-conflict";

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

describeDb("conditional external credential update", () => {
  const selector = {
    provider: "anthropic",
    kind: "claude-subscription",
    scope: "account" as const,
    owner_account_id: randomUUID(),
  };
  const sha256 = (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex");

  beforeAll(async () => {
    await syncSchema({ external_credentials: SCHEMA.external_credentials });
  });

  test("updates only while the stored payload is the expected one", async () => {
    const { id } = await createExternalCredential({
      selector,
      payload: "bundle-1",
    });
    await expect(
      updateExternalCredentialById({
        id,
        selector,
        payload: "bundle-2",
        metadata: {},
        expectedPayloadSha256: sha256("bundle-1"),
      }),
    ).resolves.toBe(true);
    // A writer that read bundle-1 must not overwrite bundle-2.
    await expect(
      updateExternalCredentialById({
        id,
        selector,
        payload: "stale",
        metadata: {},
        expectedPayloadSha256: sha256("bundle-1"),
      }),
    ).rejects.toThrow(EXTERNAL_CREDENTIAL_CONFLICT);
    expect((await getExternalCredential({ selector }))?.payload).toBe(
      "bundle-2",
    );
    await expect(
      updateExternalCredentialById({
        id,
        selector,
        payload: "x",
        metadata: {},
        expectedPayloadSha256: "not-a-hash",
      }),
    ).rejects.toThrow("invalid expected payload hash");
    // Without an expectation the update is unconditional, as before.
    await expect(
      updateExternalCredentialById({
        id,
        selector,
        payload: "bundle-3",
        metadata: {},
      }),
    ).resolves.toBe(true);
  });
});

describeDb("revoking deletes CoCalc's copy of the credential", () => {
  const accountId = randomUUID();
  const selector = {
    provider: "anthropic",
    kind: "api-key",
    scope: "account" as const,
    owner_account_id: accountId,
  };
  const stored = async (id: string) =>
    (
      await getPool().query(
        "SELECT encrypted_payload, revoked FROM external_credentials WHERE id=$1",
        [id],
      )
    ).rows[0];

  beforeAll(async () => {
    await syncSchema({ external_credentials: SCHEMA.external_credentials });
  });

  test("revoke nulls the encrypted payload in the same update", async () => {
    const { id } = await createExternalCredential({
      selector,
      payload: "sk-ant-REMOVE-ME",
    });
    expect((await stored(id)).encrypted_payload).toBe("sk-ant-REMOVE-ME");
    expect(
      await revokeExternalCredential({ id, owner_account_id: accountId }),
    ).toBe(true);
    const row = await stored(id);
    expect(row.revoked).not.toBeNull();
    expect(row.encrypted_payload).toBeNull();
    expect(await getExternalCredential({ selector })).toBeUndefined();
  });

  test("a revoked row can still be revived with a new payload", async () => {
    const { id } = await createExternalCredential({ selector, payload: "old" });
    await revokeExternalCredential({ id, owner_account_id: accountId });
    await expect(
      updateExternalCredentialById({
        id,
        selector,
        payload: "new",
        metadata: {},
        revive: true,
      }),
    ).resolves.toBe(true);
    expect((await stored(id)).encrypted_payload).toBe("new");
  });

  test("a conditional revive can't match the erased payload", async () => {
    const { id } = await createExternalCredential({ selector, payload: "old" });
    await revokeExternalCredential({ id, owner_account_id: accountId });
    await expect(
      updateExternalCredentialById({
        id,
        selector,
        payload: "new",
        metadata: {},
        revive: true,
        expectedPayloadSha256: createHash("sha256")
          .update("old", "utf8")
          .digest("hex"),
      }),
    ).rejects.toThrow(EXTERNAL_CREDENTIAL_CONFLICT);
  });

  test("the migration erases payloads of rows revoked before this rule", async () => {
    const legacy = randomUUID();
    const legacy2 = randomUUID();
    const active = randomUUID();
    for (const [id, revoked] of [
      [legacy, true],
      [legacy2, true],
      [active, false],
    ] as const) {
      await getPool().query(
        `INSERT INTO external_credentials
           (id, provider, kind, scope, owner_account_id, encrypted_payload,
            metadata, created, updated, revoked)
         VALUES ($1, 'openai', 'api-key', 'account', $2, $3, '{}'::jsonb,
                 NOW(), NOW(), CASE WHEN $4 THEN NOW() ELSE NULL END)`,
        [id, randomUUID(), `payload-${id}`, revoked],
      );
    }
    expect(await eraseRevokedExternalCredentialPayloads({ batchSize: 1 })).toBe(
      2,
    );
    expect((await stored(legacy)).encrypted_payload).toBeNull();
    expect((await stored(legacy2)).encrypted_payload).toBeNull();
    expect((await stored(active)).encrypted_payload).toBe(`payload-${active}`);
    // idempotent
    expect(await eraseRevokedExternalCredentialPayloads()).toBe(0);
  });
});

describeDb("create limit", () => {
  const accountId = randomUUID();
  const selector = {
    provider: "anthropic",
    kind: "claude-subscription-home-v1",
    scope: "account" as const,
    owner_account_id: accountId,
  };
  const create = (metadata: Record<string, any> = {}) =>
    createExternalCredential({
      selector,
      payload: randomUUID(),
      metadata,
      maxActive: 2,
    });

  beforeAll(async () => {
    await syncSchema({ external_credentials: SCHEMA.external_credentials });
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM external_credentials");
  });

  test("refuses past the limit", async () => {
    await create();
    await create({
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await expect(create()).rejects.toThrow(
      "at most 2 active credentials are allowed",
    );
  });

  test("an expired Claude token stays listed but frees its slot", async () => {
    const expired = await create({
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    await create();
    await expect(create()).resolves.toMatchObject({ created: true });
    expect(
      (
        await listExternalCredentials({
          owner_account_id: accountId,
          provider: selector.provider,
          kind: selector.kind,
          scope: selector.scope,
        })
      ).map(({ id }) => id),
    ).toContain(expired.id);
  });

  test("an unparseable expiry still counts", async () => {
    // Shaped like a timestamp but impossible: must not abort the transaction.
    await create({ expires_at: "2026-99-99T00:00:00Z" });
    await expect(create({ expires_at: "soon" })).resolves.toMatchObject({
      created: true,
    });
    await expect(create()).rejects.toThrow("at most 2");
  });

  test("an impossible past date still counts (no calendar normalization)", async () => {
    // Review on #1113: Date.parse turns 2020-02-31 into 2020-03-02, a past
    // instant, which would have freed the slot.
    await create({ expires_at: "2020-02-31T00:00:00Z" });
    await create({ expires_at: "2021-02-29T00:00:00Z" });
    await expect(create()).rejects.toThrow("at most 2");
  });

  test("a non-string expiry still counts", async () => {
    await create({ expires_at: 12345 });
    await create();
    await expect(create()).rejects.toThrow("at most 2");
  });
});

test("strict ISO UTC parsing rejects calendar-normalized values", () => {
  expect(parseStrictIsoUtc("2026-10-16T17:30:00.000Z")).toBe(
    Date.UTC(2026, 9, 16, 17, 30),
  );
  expect(parseStrictIsoUtc("2024-02-29T00:00:00Z")).toBe(Date.UTC(2024, 1, 29));
  for (const value of [
    "2026-02-31T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-10-16T24:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-99-99T00:00:00Z",
    "2026-10-16T17:30:00+02:00",
    "soon",
    12345,
    undefined,
  ])
    expect(parseStrictIsoUtc(value)).toBeUndefined();
});
