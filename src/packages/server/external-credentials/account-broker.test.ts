/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  AccountCredentialBroker,
  accountCredentialBrokerMetadataKeys,
  type AccountCredentialBrokerStore,
  type AccountCredentialProviderAdapter,
} from "./account-broker";
import type { ExternalCredentialRecord } from "./store";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";

function record(
  overrides: Partial<ExternalCredentialRecord> = {},
): ExternalCredentialRecord {
  return {
    id: CREDENTIAL_ID,
    provider: "test-provider",
    kind: "test-kind",
    scope: "account",
    owner_account_id: ACCOUNT_ID,
    payload: "old-secret",
    metadata: {
      [accountCredentialBrokerMetadataKeys.profile]: "test-profile",
      [accountCredentialBrokerMetadataKeys.identity]: "provider-user-1",
    },
    created: new Date("2026-09-01T00:00:00Z"),
    updated: new Date("2026-09-01T00:00:00Z"),
    revoked: null,
    last_used: null,
    ...overrides,
  };
}

function fixture() {
  let current: ExternalCredentialRecord | undefined = record();
  const order: string[] = [];
  const store: AccountCredentialBrokerStore = {
    runExclusive: jest.fn(async ({ callback }) => {
      order.push("lease:start");
      try {
        return await callback();
      } finally {
        order.push("lease:end");
      }
    }),
    create: jest.fn(async () => {
      order.push("store:create");
      return { id: CREDENTIAL_ID, created: true };
    }),
    getById: jest.fn(async () => current),
    updateById: jest.fn(async ({ payload, metadata }) => {
      order.push("store:update");
      if (!current) return false;
      current = { ...current, payload, metadata };
      return true;
    }),
    revoke: jest.fn(async () => {
      order.push("store:revoke");
      if (!current) return false;
      current = undefined;
      return true;
    }),
  };
  const verify = jest.fn(async (input: string) => {
    order.push("provider:verify");
    return {
      payload: input,
      identity: "provider-user-1",
      metadata: { plan: "test" },
    };
  });
  const adapter: AccountCredentialProviderAdapter<string> = {
    profileId: "test-profile",
    provider: "test-provider",
    kind: "test-kind",
    maxActive: 3,
    defaultMetadataKey: "test_default",
    verify,
  };
  return {
    broker: new AccountCredentialBroker(adapter, store),
    store,
    verify,
    order,
    setCurrent: (value?: ExternalCredentialRecord) => {
      current = value;
    },
  };
}

test("verifies before publishing a new credential under the account lease", async () => {
  const { broker, store, verify, order } = fixture();
  await expect(
    broker.create({ accountId: ACCOUNT_ID, input: "new-secret" }),
  ).resolves.toEqual({ id: CREDENTIAL_ID, created: true });

  expect(order).toEqual([
    "lease:start",
    "provider:verify",
    "store:create",
    "lease:end",
  ]);
  expect(verify).toHaveBeenCalledWith("new-secret", {
    operation: "create",
    accountId: ACCOUNT_ID,
  });
  expect(store.create).toHaveBeenCalledWith(
    expect.objectContaining({
      selector: {
        provider: "test-provider",
        kind: "test-kind",
        scope: "account",
        owner_account_id: ACCOUNT_ID,
      },
      payload: "new-secret",
      metadata: {
        plan: "test",
        [accountCredentialBrokerMetadataKeys.profile]: "test-profile",
        [accountCredentialBrokerMetadataKeys.identity]: "provider-user-1",
      },
      maxActive: 3,
      defaultMetadataKey: "test_default",
      deduplicateMetadata: {
        key: accountCredentialBrokerMetadataKeys.identity,
        value: "provider-user-1",
      },
    }),
  );
});

test("a failed provider verification cannot mutate the store", async () => {
  const { broker, store, verify } = fixture();
  verify.mockRejectedValueOnce(new Error("provider rejected credential"));
  await expect(
    broker.create({ accountId: ACCOUNT_ID, input: "bad-secret" }),
  ).rejects.toThrow("provider rejected credential");
  expect(store.create).not.toHaveBeenCalled();
});

test("reconnect targets one credential and preserves provider identity", async () => {
  const { broker, store, verify, order } = fixture();
  await broker.reconnect({
    accountId: ACCOUNT_ID,
    credentialId: CREDENTIAL_ID,
    input: "replacement-secret",
  });
  expect(order).toEqual([
    "lease:start",
    "provider:verify",
    "store:update",
    "lease:end",
  ]);
  expect(verify).toHaveBeenCalledWith(
    "replacement-secret",
    expect.objectContaining({
      operation: "reconnect",
      current: expect.objectContaining({
        id: CREDENTIAL_ID,
        identity: "provider-user-1",
      }),
    }),
  );
  expect(store.updateById).toHaveBeenCalledWith(
    expect.objectContaining({ id: CREDENTIAL_ID }),
  );
});

test("reconnect rejects a different provider identity before publication", async () => {
  const { broker, store, verify } = fixture();
  verify.mockResolvedValueOnce({
    payload: "other-secret",
    identity: "provider-user-2",
  });
  await expect(
    broker.reconnect({
      accountId: ACCOUNT_ID,
      credentialId: CREDENTIAL_ID,
      input: "other-secret",
    }),
  ).rejects.toThrow("different provider identity");
  expect(store.updateById).not.toHaveBeenCalled();
});

test("exact reads fail closed on malformed IDs and never select a default", async () => {
  const { broker, store } = fixture();
  await expect(
    broker.readExact({ accountId: ACCOUNT_ID, credentialId: ".." }),
  ).rejects.toThrow("invalid external credential id");
  expect(store.getById).not.toHaveBeenCalled();

  await broker.readExact({
    accountId: ACCOUNT_ID,
    credentialId: CREDENTIAL_ID,
    touchLastUsed: false,
  });
  expect(store.getById).toHaveBeenCalledWith({
    id: CREDENTIAL_ID,
    selector: {
      provider: "test-provider",
      kind: "test-kind",
      scope: "account",
      owner_account_id: ACCOUNT_ID,
    },
    touchLastUsed: false,
  });
});

test("revoke verifies profile ownership before deleting an exact ID", async () => {
  const { broker, store, setCurrent } = fixture();
  setCurrent(
    record({
      metadata: {
        [accountCredentialBrokerMetadataKeys.profile]: "another-profile",
        [accountCredentialBrokerMetadataKeys.identity]: "provider-user-1",
      },
    }),
  );
  await expect(
    broker.revoke({ accountId: ACCOUNT_ID, credentialId: CREDENTIAL_ID }),
  ).rejects.toThrow("not managed by this provider profile");
  expect(store.revoke).not.toHaveBeenCalled();
});

test("provider metadata cannot overwrite broker identity fields", async () => {
  const { broker, store, verify } = fixture();
  verify.mockResolvedValueOnce({
    payload: "new-secret",
    identity: "provider-user-1",
    metadata: {
      [accountCredentialBrokerMetadataKeys.identity]: "attacker-choice",
    },
  });
  await expect(
    broker.create({ accountId: ACCOUNT_ID, input: "new-secret" }),
  ).rejects.toThrow("is reserved");
  expect(store.create).not.toHaveBeenCalled();
});
