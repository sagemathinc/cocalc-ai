/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const upsertMock = jest.fn();
const listMock = jest.fn();
const localGetMock = jest.fn();
const revokeMock = jest.fn();
const membershipMock = jest.fn();
const clearHostkeysMock = jest.fn();
const admitMock = jest.fn();

// Everything runs on the home bay, against its local store. The broker reads
// what localGetMock holds; its claim and audit rows have their own tests
// (key-use.test.ts), as does the admission (mocked here).
jest.mock("@cocalc/server/external-credentials/store", () => ({
  GpuKeyGone: class GpuKeyGone extends Error {},
  upsertExternalCredential: (...args: any[]) => upsertMock(...args),
  listExternalCredentials: (...args: any[]) => listMock(...args),
  revokeExternalCredential: (...args: any[]) => revokeMock(...args),
  withAuditedGpuKey: async (
    _id: string,
    _credential_id: string,
    fn: (key: string) => Promise<unknown>,
  ) => {
    const record = await localGetMock();
    if (!record) throw Error("the GPU provider key is no longer stored");
    return await fn(record.payload);
  },
}));
jest.mock("@cocalc/server/gpu/key-use", () => ({
  ...jest.requireActual("@cocalc/server/gpu/key-use"),
  admitDecrypt: (...args: any[]) => admitMock(...args),
}));

jest.mock("@cocalc/server/gpu/hostkey-clear", () => ({
  clearHostkeysForCredential: (...args: any[]) => clearHostkeysMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
const resolveAccountHomeBay = jest.fn(async () => ({ home_bay_id: "bay-0" }));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args: any[]) => resolveAccountHomeBay(...args),
}));

// unfinished GPU pods for the account (gpu_pods), per test
let unfinished = 0;
// the key's unfinished managed pods, as removal sees them (pods.ts)
let podsLeft: { id: string; handle: string }[] = [];
jest.mock("@cocalc/server/gpu/pods", () => ({
  unfinishedCredentialPods: async () => podsLeft,
  markCredentialPodsToTerminate: async () => podsLeft.length,
  markCredentialPodsUnmanaged: async () => podsLeft.map((p) => p.handle),
  resolvePendingForAccount: async () => ({ full: false }),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => {
    // the unfinished-pod count (and an account row for the fence); no fence
    // or budget rows
    const query = async (sql: string) => ({
      rows: /gpu_key_fences|gpu_budget_layers/.test(sql)
        ? []
        : [{ n: unfinished }],
    });
    return { query, connect: async () => ({ query, release: () => {} }) };
  },
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: (...args: any[]) => membershipMock(...args),
}));

import {
  KEY_HOME_BAY_TIMEOUT_MS,
  KEY_RPC_TIMEOUT_MS,
  SET_KEY_HOME_BAY_TIMEOUT_MS,
  VERIFY_RPC_TIMEOUT_MS,
} from "@cocalc/util/gpu/provider-keys";
import {
  CONNECT_INVENTORY_CALL_MS,
  CONNECT_INVENTORY_MS,
  deleteGpuProviderKey,
  deleteGpuProviderKeyLocal,
  getGpuProviderKeyStatusLocal,
  setGpuProviderKeyLocal,
  withRunpodCleanup,
  withRunpodLaunchAccess,
  getGpuProviderKeyStatus,
  isGpuProviderKeysEntitled,
  setGpuProviderKey,
} from "./provider-keys";
import { testKeyUse } from "./key-use-testing";

const ACCOUNT = "00000000-1000-4000-8000-000000000001";
const KEY = "rpa_SYNTHETICKEY0123456789abcdefghijklmnopqrstuv";

const PERSONAL_ORG_403 = {
  status: 403,
  body: {
    title: "Forbidden",
    status: 403,
    detail: "Organizations are not enabled for this user",
  },
};
const MYSELF = { body: { data: { myself: { id: "user_1" } } } };
const NO_PODS = { body: { pods: [], pagination: { hasNextPage: false } } };
// Measured 10-27: a key that may change pods can create (and delete) a
// private template.
const TEMPLATE_CREATED = { status: 201, body: { id: "tpl_1" } };
const TEMPLATE_DELETED = { status: 204, body: "" };

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return new Response(
      next.status === 204 ? null : JSON.stringify(next.body),
      {
        status: next.status ?? 200,
      },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, urls };
}

const entitled = async () => true;

function storedRecord(metadata: Record<string, any>) {
  return {
    id: "cred-1",
    provider: "runpod",
    kind: "gpu-provider-api-key",
    scope: "account",
    owner_account_id: ACCOUNT,
    payload: KEY,
    metadata,
    created: new Date("2026-10-27T20:00:00Z"),
    updated: new Date("2026-10-27T20:00:00Z"),
    revoked: null,
    last_used: null,
  };
}

function summary(metadata: Record<string, any>) {
  const { payload: _payload, ...rest } = storedRecord(metadata);
  return rest;
}

const home = { isHomeBay: async () => true };

beforeEach(() => {
  unfinished = 0;
  podsLeft = [];
  upsertMock.mockReset().mockResolvedValue({ id: "cred-1", created: true });
  listMock.mockReset().mockResolvedValue([]);
  localGetMock.mockReset().mockResolvedValue(undefined);
  revokeMock.mockReset().mockResolvedValue(true);
  clearHostkeysMock.mockReset().mockResolvedValue(0);
  membershipMock.mockReset();
  admitMock.mockReset().mockResolvedValue("decrypt-1");
});

// a stored key, as both the metadata and the broker see it
function storeKey() {
  listMock.mockResolvedValue([summary({})]);
  localGetMock.mockResolvedValue(storedRecord({}));
}

describe("GPU provider keys", () => {
  it("follows the tier's gpu_provider_keys feature", async () => {
    membershipMock.mockResolvedValueOnce({
      entitlements: { features: { gpu_provider_keys: true } },
    });
    expect(await isGpuProviderKeysEntitled(ACCOUNT)).toBe(true);
    membershipMock.mockResolvedValueOnce({
      entitlements: { features: { create_hosts: true } },
    });
    expect(await isGpuProviderKeysEntitled(ACCOUNT)).toBe(false);
  });

  it("verifies a key with RunPod, then stores it with the account identity", async () => {
    const { fetch, urls } = fakeFetch([
      PERSONAL_ORG_403,
      MYSELF,
      NO_PODS,
      TEMPLATE_CREATED,
      TEMPLATE_DELETED,
    ]);
    const status = await setGpuProviderKey(
      {
        key_use: testKeyUse("verify"),
        account_id: ACCOUNT,
        provider: "runpod",
        api_key: ` ${KEY}\n`,
      },
      { fetch, isEntitled: entitled },
    );
    expect(urls).toEqual([
      "https://api.runpod.io/v2/organization",
      "https://api.runpod.io/graphql",
      "https://api.runpod.io/v2/pods",
      "https://api.runpod.io/v2/templates",
      "https://api.runpod.io/v2/templates/tpl_1",
    ]);
    const stored = upsertMock.mock.calls[0][0];
    expect(stored.selector).toEqual({
      provider: "runpod",
      kind: "gpu-provider-api-key",
      scope: "account",
      owner_account_id: ACCOUNT,
    });
    expect(stored.payload).toBe(KEY);
    expect(stored.metadata).toMatchObject({
      provider_account_kind: "personal",
      provider_account_id: "user_1",
    });
    expect(status).toEqual({
      provider: "runpod",
      entitled: true,
      connected: true,
      provider_account: { kind: "personal", id: "user_1" },
      connected_at: stored.metadata.verified_at,
      // its first inventory pass (no answer from this fake): not yet
      inventory: "checking",
    });
    // Reads before the write (is a key being replaced, before and again
    // under the fence; removals since the check started), none after it:
    // the status comes from what was stored.
    expect(listMock).toHaveBeenCalledTimes(3);
    expect(listMock.mock.invocationCallOrder[2]).toBeLessThan(
      upsertMock.mock.invocationCallOrder[0],
    );
    // The key is never part of what comes back.
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it("checks the new key's RunPod account once, counted from the start of the connect", async () => {
    const { fetch } = fakeFetch([
      PERSONAL_ORG_403,
      MYSELF,
      NO_PODS,
      TEMPLATE_CREATED,
      TEMPLATE_DELETED,
    ]);
    const before = Date.now();
    const connectInventory = jest.fn(async () => true);
    const status = await setGpuProviderKey(
      {
        key_use: testKeyUse("verify"),
        account_id: ACCOUNT,
        provider: "runpod",
        api_key: KEY,
      },
      { fetch, isEntitled: entitled, connectInventory },
    );
    expect(status.inventory).toBe("complete");
    expect(connectInventory).toHaveBeenCalledTimes(1);
    const arg = (connectInventory.mock.calls[0] as any)[0];
    expect(arg).toEqual(
      expect.objectContaining({ account_id: ACCOUNT, credential_id: "cred-1" }),
    );
    // the deadline counts from before the identity probe, not after it
    expect(arg.deadline).toBeGreaterThanOrEqual(before + CONNECT_INVENTORY_MS);
    expect(arg.deadline).toBeLessThanOrEqual(Date.now() + CONNECT_INVENTORY_MS);
    // its time and the probe's stay well inside the forwarded request's
    expect(CONNECT_INVENTORY_MS + CONNECT_INVENTORY_CALL_MS).toBeLessThan(
      SET_KEY_HOME_BAY_TIMEOUT_MS / 2,
    );
  });

  it("a connect whose inventory pass fails still stands, as checking", async () => {
    const { fetch } = fakeFetch([
      PERSONAL_ORG_403,
      MYSELF,
      NO_PODS,
      TEMPLATE_CREATED,
      TEMPLATE_DELETED,
    ]);
    const status = await setGpuProviderKey(
      {
        key_use: testKeyUse("verify"),
        account_id: ACCOUNT,
        provider: "runpod",
        api_key: KEY,
      },
      {
        fetch,
        isEntitled: entitled,
        connectInventory: async () => {
          throw Error("the database went away");
        },
      },
    );
    expect(status).toEqual(
      expect.objectContaining({ connected: true, inventory: "checking" }),
    );
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("records an organization's name", async () => {
    const { fetch } = fakeFetch([
      { body: { id: "org_9", name: "Physics 101" } },
      NO_PODS,
      TEMPLATE_CREATED,
      TEMPLATE_DELETED,
    ]);
    await setGpuProviderKey(
      {
        key_use: testKeyUse("verify"),
        account_id: ACCOUNT,
        provider: "runpod",
        api_key: KEY,
      },
      { fetch, isEntitled: entitled },
    );
    expect(upsertMock.mock.calls[0][0].metadata).toMatchObject({
      provider_account_kind: "organization",
      provider_account_id: "org_9",
      provider_account_name: "Physics 101",
    });
  });

  it("refuses accounts whose membership doesn't include it, before calling RunPod", async () => {
    const { fetch, urls } = fakeFetch([]);
    await expect(
      setGpuProviderKey(
        {
          key_use: testKeyUse("verify"),
          account_id: ACCOUNT,
          provider: "runpod",
          api_key: KEY,
        },
        { fetch, isEntitled: async () => false },
      ),
    ).rejects.toThrow("membership");
    expect(urls).toEqual([]);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a rejected key", { status: 401, body: { detail: KEY } }, "rejected"],
    [
      "a key without read access",
      { status: 403, body: { detail: "Forbidden" } },
      "can't manage",
    ],
    ["RunPod being down", { status: 503, body: { detail: KEY } }, "reached"],
  ])(
    "stores nothing for %s, and never echoes RunPod's text",
    async (_, response, message) => {
      const { fetch } = fakeFetch([response]);
      const err = await setGpuProviderKey(
        {
          key_use: testKeyUse("verify"),
          account_id: ACCOUNT,
          provider: "runpod",
          api_key: KEY,
        },
        { fetch, isEntitled: entitled },
      ).catch((e) => e);
      expect(err.message).toContain(message);
      expect(err.message).not.toContain(KEY);
      expect(upsertMock).not.toHaveBeenCalled();
    },
  );

  it("requires the key to see the account's pods", async () => {
    const { fetch } = fakeFetch([
      PERSONAL_ORG_403,
      MYSELF,
      { status: 403, body: { detail: "Forbidden" } },
    ]);
    await expect(
      setGpuProviderKey(
        {
          key_use: testKeyUse("verify"),
          account_id: ACCOUNT,
          provider: "runpod",
          api_key: KEY,
        },
        { fetch, isEntitled: entitled },
      ),
    ).rejects.toThrow("can't manage pods");
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("rejects malformed keys and unknown providers without calling anyone", async () => {
    const { fetch, urls } = fakeFetch([]);
    for (const api_key of ["", "short", `${KEY} ${KEY}`]) {
      await expect(
        setGpuProviderKey(
          {
            key_use: testKeyUse("verify"),
            account_id: ACCOUNT,
            provider: "runpod",
            api_key,
          },
          { fetch, isEntitled: entitled },
        ),
      ).rejects.toThrow("valid RunPod API key");
    }
    await expect(
      setGpuProviderKey(
        {
          key_use: testKeyUse("verify"),
          account_id: ACCOUNT,
          provider: "aws",
          api_key: KEY,
        },
        { fetch, isEntitled: entitled },
      ),
    ).rejects.toThrow("unknown GPU provider");
    expect(urls).toEqual([]);
  });

  it("reports status from summaries, ignoring revoked rows", async () => {
    listMock.mockResolvedValue([
      { ...summary({}), revoked: new Date("2026-10-27T21:00:00Z") },
    ]);
    expect(
      await getGpuProviderKeyStatus(
        { account_id: ACCOUNT, provider: "runpod" },
        { isEntitled: async () => false },
      ),
    ).toEqual({ provider: "runpod", entitled: false, connected: false });
    expect(listMock).toHaveBeenCalledWith({
      owner_account_id: ACCOUNT,
      provider: "runpod",
      kind: "gpu-provider-api-key",
      scope: "account",
    });
    expect(localGetMock).not.toHaveBeenCalled();
  });

  it("removes the account's key, and reports when there was none", async () => {
    expect(
      await deleteGpuProviderKey({
        key_use: testKeyUse("removal"),
        account_id: ACCOUNT,
        provider: "runpod",
      }),
    ).toEqual({ revoked: false });
    expect(revokeMock).not.toHaveBeenCalled();
    expect(clearHostkeysMock).not.toHaveBeenCalled();
    listMock.mockResolvedValue([summary({})]);
    expect(
      await deleteGpuProviderKey({
        key_use: testKeyUse("removal"),
        account_id: ACCOUNT,
        provider: "runpod",
      }),
    ).toEqual({ revoked: true });
    expect(localGetMock).not.toHaveBeenCalled();
    expect(revokeMock).toHaveBeenCalledWith({
      id: "cred-1",
      owner_account_id: ACCOUNT,
      alsoOnRevoke: expect.any(Function),
    });
    // its pods' registration tokens and host keys are cleared in the
    // revoking transaction
    expect(clearHostkeysMock).not.toHaveBeenCalled();
    const client = { query: jest.fn() };
    await revokeMock.mock.calls[0][0].alsoOnRevoke(client);
    expect(clearHostkeysMock).toHaveBeenCalledWith(
      { account_id: ACCOUNT, credential_id: "cred-1" },
      client,
    );
  });

  it("builds a RunPod client from the local store, or nothing without a key", async () => {
    const deps = { ...home, isEntitled: entitled };
    expect(
      await withRunpodLaunchAccess(ACCOUNT, undefined, deps, async (a) => a),
    ).toBeUndefined();
    // no key: nothing was admitted, nothing decrypted
    expect(admitMock).not.toHaveBeenCalled();
    storeKey();
    let kept: any;
    await withRunpodLaunchAccess(ACCOUNT, undefined, deps, async (a) => {
      expect(a?.credential_id).toBe("cred-1");
      expect(JSON.stringify(a)).not.toContain(KEY);
      kept = a!.client;
    });
    // admitted for exactly this owner's stored key, before it was read
    expect(admitMock).toHaveBeenCalledWith(undefined, {
      account_id: ACCOUNT,
      credential_id: "cred-1",
    });
    // the client is usable only inside the callback
    expect(() => kept.listPods).toThrow("ended");
  });

  it("never reads the key away from the owner's home bay", async () => {
    storeKey();
    const away = { isHomeBay: async () => false, isEntitled: entitled };
    await expect(
      withRunpodLaunchAccess(ACCOUNT, undefined, away, async (a) => a),
    ).rejects.toThrow("home bay");
    await expect(
      withRunpodCleanup(ACCOUNT, undefined, away, async (c) => c),
    ).rejects.toThrow("home bay");
    expect(admitMock).not.toHaveBeenCalled();
  });

  it("requires the live entitlement for full access, but not for cleanup", async () => {
    storeKey();
    const lapsed = { ...home, isEntitled: async () => false };
    await expect(
      withRunpodLaunchAccess(ACCOUNT, undefined, lapsed, async (a) => a),
    ).rejects.toThrow("membership");
    expect(admitMock).not.toHaveBeenCalled();
    expect(
      await withRunpodCleanup(ACCOUNT, undefined, lapsed, async (c) => !!c),
    ).toBe(true);
  });

  it("refuses to read the key when the admission refuses", async () => {
    storeKey();
    admitMock.mockRejectedValue(Error("this capability doesn't allow it"));
    const fn = jest.fn();
    await expect(
      withRunpodCleanup(ACCOUNT, undefined, home, fn),
    ).rejects.toThrow("capability");
    expect(fn).not.toHaveBeenCalled();
  });

  it("gives cleanup only inventory, billing and the account balance, with no client to reach through", async () => {
    storeKey();
    const { fetch, urls } = fakeFetch([NO_PODS]);
    let kept: any;
    await withRunpodCleanup(
      ACCOUNT,
      undefined,
      { ...home, fetch },
      async (c) => {
        const cleanup = c!;
        kept = cleanup;
        // Nothing that creates or starts anything.
        expect(Object.keys(cleanup).sort()).toEqual([
          "credential_id",
          "findPodsByName",
          "getAccountBalance",
          "getPod",
          "getProviderIdentity",
          "listPodBilling",
          "listPods",
          "terminatePod",
        ]);
        expect(Object.isFrozen(cleanup)).toBe(true);
        expect(cleanup.credential_id).toBe("cred-1");
        expect(cleanup).not.toBeInstanceOf(
          (await import("@cocalc/cloud/runpod/client")).RunpodClient,
        );
        expect(await cleanup.listPods()).toEqual([]);
        expect(urls).toEqual([
          "https://api.runpod.io/v2/pods?includeClusterPods=true",
        ]);
        expect(JSON.stringify(cleanup)).not.toContain(KEY);
      },
    );
    // and nothing once the callback returned
    await expect(async () => await kept.listPods()).rejects.toThrow("ended");
  });

  it("checks pod access with one request, however many pages there are", async () => {
    const MORE = {
      body: { pods: [], pagination: { hasNextPage: true, nextCursor: "c2" } },
    };
    const { fetch, urls } = fakeFetch([
      PERSONAL_ORG_403,
      MYSELF,
      MORE,
      TEMPLATE_CREATED,
      TEMPLATE_DELETED,
    ]);
    await setGpuProviderKey(
      {
        key_use: testKeyUse("verify"),
        account_id: ACCOUNT,
        provider: "runpod",
        api_key: KEY,
      },
      { fetch, isEntitled: entitled },
    );
    expect(urls.filter((u) => u.endsWith("/v2/pods"))).toHaveLength(1);
    expect(upsertMock).toHaveBeenCalled();
  });

  it("stores nothing when verification finishes past its deadline", async () => {
    const slow = (async (url: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return url.endsWith("/v2/organization")
        ? new Response(JSON.stringify(PERSONAL_ORG_403.body), { status: 403 })
        : url.endsWith("/graphql")
          ? new Response(JSON.stringify(MYSELF.body))
          : url.endsWith("/v2/pods")
            ? new Response(JSON.stringify(NO_PODS.body))
            : url.endsWith("/v2/templates")
              ? new Response(JSON.stringify(TEMPLATE_CREATED.body), {
                  status: 201,
                })
              : new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;
    await expect(
      setGpuProviderKey(
        {
          key_use: testKeyUse("verify"),
          account_id: ACCOUNT,
          provider: "runpod",
          api_key: KEY,
        },
        { fetch: slow, isEntitled: entitled, verifyDeadlineMs: 10 },
      ),
    ).rejects.toThrow("too long");
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("stores nothing for a Read Only key: one that can't change pods", async () => {
    const { fetch } = fakeFetch([
      PERSONAL_ORG_403,
      MYSELF,
      NO_PODS,
      { status: 403, body: { detail: "Forbidden" } },
    ]);
    await expect(
      setGpuProviderKey(
        {
          key_use: testKeyUse("verify"),
          account_id: ACCOUNT,
          provider: "runpod",
          api_key: KEY,
        },
        { fetch, isEntitled: entitled },
      ),
    ).rejects.toThrow("can't manage pods");
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("doesn't save a key if the key was removed while it was being checked", async () => {
    const { fetch } = fakeFetch([
      PERSONAL_ORG_403,
      MYSELF,
      NO_PODS,
      TEMPLATE_CREATED,
      TEMPLATE_DELETED,
    ]);
    // Another tab removes the old key during verification (strictly after
    // the save started, even when the fake RunPod answers within the same
    // millisecond).
    listMock.mockImplementation(async ({ includeRevoked }) =>
      includeRevoked
        ? [{ ...summary({}), revoked: new Date(Date.now() + 5) }]
        : [],
    );
    await expect(
      setGpuProviderKey(
        {
          key_use: testKeyUse("verify"),
          account_id: ACCOUNT,
          provider: "runpod",
          api_key: KEY,
        },
        { fetch, isEntitled: entitled },
      ),
    ).rejects.toThrow("removed while this one was being checked");
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("an older removal doesn't block a new save", async () => {
    const { fetch } = fakeFetch([
      PERSONAL_ORG_403,
      MYSELF,
      NO_PODS,
      TEMPLATE_CREATED,
      TEMPLATE_DELETED,
    ]);
    listMock.mockResolvedValue([
      { ...summary({}), revoked: new Date(Date.now() - 60_000) },
    ]);
    await setGpuProviderKey(
      {
        key_use: testKeyUse("verify"),
        account_id: ACCOUNT,
        provider: "runpod",
        api_key: KEY,
      },
      { fetch, isEntitled: entitled },
    );
    expect(upsertMock).toHaveBeenCalled();
  });

  it("a removal just before the save started doesn't block it", async () => {
    const { fetch } = fakeFetch([
      PERSONAL_ORG_403,
      MYSELF,
      NO_PODS,
      TEMPLATE_CREATED,
      TEMPLATE_DELETED,
    ]);
    listMock.mockResolvedValue([
      { ...summary({}), revoked: new Date(Date.now() - 200) },
    ]);
    await setGpuProviderKey(
      {
        key_use: testKeyUse("verify"),
        account_id: ACCOUNT,
        provider: "runpod",
        api_key: KEY,
      },
      { fetch, isEntitled: entitled },
    );
    expect(upsertMock).toHaveBeenCalled();
  });

  it("forwards each operation whole to the home bay, never touching this bay's store", async () => {
    const status = {
      provider: "runpod",
      entitled: true,
      connected: true,
    } as const;
    const remote = {
      gpuKeyStatus: jest.fn(async () => status),
      gpuKeySet: jest.fn(async () => status),
      gpuKeyDelete: jest.fn(async () => ({ revoked: true })),
    };
    const timeouts: number[] = [];
    const homeClient = jest.fn(async (_account_id: string, timeout: number) => {
      timeouts.push(timeout);
      return remote as any;
    });
    const isEntitled = jest.fn(async () => true);
    const fetch = jest.fn();
    const deps = { homeClient, isEntitled, fetch: fetch as any };
    const op = { account_id: ACCOUNT, provider: "runpod" };
    expect(await getGpuProviderKeyStatus(op, deps)).toEqual(status);
    expect(
      await setGpuProviderKey(
        { key_use: testKeyUse("verify"), ...op, api_key: KEY },
        deps,
      ),
    ).toEqual(status);
    expect(
      await deleteGpuProviderKey(
        { ...op, key_use: testKeyUse("removal") },
        deps,
      ),
    ).toEqual({ revoked: true });
    expect(remote.gpuKeyStatus).toHaveBeenCalledWith(op);
    expect(remote.gpuKeySet).toHaveBeenCalledWith({ ...op, api_key: KEY });
    expect(remote.gpuKeyDelete).toHaveBeenCalledWith({ ...op, force: false });
    expect(timeouts).toEqual([
      KEY_HOME_BAY_TIMEOUT_MS,
      SET_KEY_HOME_BAY_TIMEOUT_MS,
      KEY_HOME_BAY_TIMEOUT_MS,
    ]);
    // The home bay checks the entitlement and talks to RunPod.
    expect(isEntitled).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    for (const m of [listMock, upsertMock, revokeMock, localGetMock]) {
      expect(m).not.toHaveBeenCalled();
    }
  });

  it("the browser waits longer than a forwarded call may take", () => {
    expect(VERIFY_RPC_TIMEOUT_MS).toBeGreaterThan(SET_KEY_HOME_BAY_TIMEOUT_MS);
    expect(KEY_RPC_TIMEOUT_MS).toBeGreaterThan(KEY_HOME_BAY_TIMEOUT_MS);
  });

  it("forwards nothing for an account homed here", async () => {
    const homeClient = jest.fn(async () => undefined);
    await getGpuProviderKeyStatus(
      { account_id: ACCOUNT, provider: "runpod" },
      { homeClient, isEntitled: entitled },
    );
    expect(homeClient).toHaveBeenCalled();
    expect(listMock).toHaveBeenCalled();
  });

  it("rejects an unknown provider before forwarding", async () => {
    const homeClient = jest.fn();
    await expect(
      deleteGpuProviderKey(
        {
          key_use: testKeyUse("removal"),
          account_id: ACCOUNT,
          provider: "other",
        },
        { homeClient },
      ),
    ).rejects.toThrow("unknown GPU provider");
    expect(homeClient).not.toHaveBeenCalled();
  });

  it("runs the home bay's part only on the home bay", async () => {
    const away = { isHomeBay: async () => false, isEntitled: entitled };
    const op = { account_id: ACCOUNT, provider: "runpod" };
    await expect(getGpuProviderKeyStatusLocal(op, away)).rejects.toThrow(
      "home bay",
    );
    await expect(
      setGpuProviderKeyLocal(
        { key_use: testKeyUse("verify"), ...op, api_key: KEY },
        away,
      ),
    ).rejects.toThrow("home bay");
    await expect(
      deleteGpuProviderKeyLocal(
        { ...op, key_use: testKeyUse("removal") },
        away,
      ),
    ).rejects.toThrow("home bay");
    for (const m of [listMock, upsertMock, revokeMock, localGetMock]) {
      expect(m).not.toHaveBeenCalled();
    }
  });

  it("refuses to replace a key with unfinished pods; removing it drains them and keeps the key until they're gone", async () => {
    listMock.mockResolvedValue([summary({})]);
    unfinished = 2;
    const { fetch, urls } = fakeFetch([]);
    await expect(
      setGpuProviderKeyLocal(
        {
          key_use: testKeyUse("verify"),
          account_id: ACCOUNT,
          provider: "runpod",
          api_key: KEY,
        },
        { ...home, fetch, isEntitled: entitled },
      ),
    ).rejects.toThrow("can't be replaced yet");
    expect(urls).toEqual([]); // refused before RunPod is asked
    // removal: RunPod doesn't confirm in time, so the key stays
    podsLeft = [
      { id: "p1", handle: "cc-aaaaaaaaaaaaaaaa" },
      { id: "p2", handle: "cc-bbbbbbbbbbbbbbbb" },
    ];
    const drained = {
      ...home,
      drainMs: 0,
      storedKeyRejected: async () => false,
    };
    expect(
      await deleteGpuProviderKeyLocal(
        {
          key_use: testKeyUse("removal"),
          account_id: ACCOUNT,
          provider: "runpod",
        },
        drained,
      ),
    ).toEqual({
      revoked: false,
      remaining: ["cc-aaaaaaaaaaaaaaaa", "cc-bbbbbbbbbbbbbbbb"],
    });
    expect(upsertMock).not.toHaveBeenCalled();
    expect(revokeMock).not.toHaveBeenCalled();
    // once they're gone, removal finishes
    podsLeft = [];
    expect(
      await deleteGpuProviderKeyLocal(
        {
          key_use: testKeyUse("removal"),
          account_id: ACCOUNT,
          provider: "runpod",
        },
        drained,
      ),
    ).toEqual({ revoked: true });
    expect(revokeMock).toHaveBeenCalled();
  });

  it("forces a removal on request: what is left becomes unmanaged, with a warning", async () => {
    listMock.mockResolvedValue([summary({})]);
    podsLeft = [{ id: "p1", handle: "cc-aaaaaaaaaaaaaaaa" }];
    const result = await deleteGpuProviderKeyLocal(
      {
        key_use: testKeyUse("removal"),
        account_id: ACCOUNT,
        provider: "runpod",
        force: true,
      },
      { ...home, drainMs: 0, storedKeyRejected: async () => false },
    );
    expect(result).toEqual({
      revoked: true,
      unmanaged: ["cc-aaaaaaaaaaaaaaaa"],
      warning: expect.stringMatching(
        /may still be running and billing at RunPod/,
      ),
    });
    expect(revokeMock).toHaveBeenCalled();
  });

  it("doesn't block connecting a first key", async () => {
    unfinished = 1; // e.g. pods from a key removed at RunPod's side
    const { fetch } = fakeFetch([
      PERSONAL_ORG_403,
      MYSELF,
      NO_PODS,
      TEMPLATE_CREATED,
      TEMPLATE_DELETED,
    ]);
    await setGpuProviderKeyLocal(
      {
        key_use: testKeyUse("verify"),
        account_id: ACCOUNT,
        provider: "runpod",
        api_key: KEY,
      },
      { ...home, fetch, isEntitled: entitled },
    );
    expect(upsertMock).toHaveBeenCalled();
  });

  it("removes a key RunPod already rejects at once, leaving its pods unmanaged", async () => {
    listMock.mockResolvedValue([summary({})]);
    podsLeft = [{ id: "p1", handle: "cc-aaaaaaaaaaaaaaaa" }];
    localGetMock.mockResolvedValue(storedRecord({}));
    // RunPod answers 401 for the stored key (deleted at RunPod)
    const { fetch } = fakeFetch([{ status: 401, body: { detail: "nope" } }]);
    expect(
      await deleteGpuProviderKeyLocal(
        {
          key_use: testKeyUse("removal"),
          account_id: ACCOUNT,
          provider: "runpod",
        },
        { ...home, fetch },
      ),
    ).toEqual(
      expect.objectContaining({
        revoked: true,
        unmanaged: ["cc-aaaaaaaaaaaaaaaa"],
      }),
    );
  });

  it("doesn't treat a RunPod it can't ask as a rejection: the key stays while its pods drain", async () => {
    listMock.mockResolvedValue([summary({})]);
    podsLeft = [{ id: "p1", handle: "cc-aaaaaaaaaaaaaaaa" }];
    localGetMock.mockResolvedValue(storedRecord({}));
    const { fetch } = fakeFetch([{ status: 503, body: {} }]);
    expect(
      await deleteGpuProviderKeyLocal(
        {
          key_use: testKeyUse("removal"),
          account_id: ACCOUNT,
          provider: "runpod",
        },
        { ...home, fetch, drainMs: 0 },
      ),
    ).toEqual({ revoked: false, remaining: ["cc-aaaaaaaaaaaaaaaa"] });
    expect(revokeMock).not.toHaveBeenCalled();
  });

  describe("replacing a key with unfinished pods (5c: every connect is a new credential)", () => {
    const verify = () =>
      fakeFetch([
        PERSONAL_ORG_403,
        MYSELF, // the new key acts for personal account user_1
        NO_PODS,
        TEMPLATE_CREATED,
        TEMPLATE_DELETED,
      ]);
    const rejected = { storedKeyRejected: async () => true };

    it.each([
      [{ provider_account_kind: "personal", provider_account_id: "user_1" }],
      [
        {
          provider_account_kind: "personal",
          provider_account_id: "user_other",
        },
      ],
      [{}],
    ])(
      "refuses it even when RunPod rejects the old key, for any account (%j)",
      async (metadata) => {
        unfinished = 1;
        listMock.mockResolvedValue([summary(metadata)]);
        const { fetch, urls } = verify();
        await expect(
          setGpuProviderKeyLocal(
            {
              key_use: testKeyUse("verify"),
              account_id: ACCOUNT,
              provider: "runpod",
              api_key: KEY,
            },
            { ...home, ...rejected, fetch, isEntitled: entitled },
          ),
        ).rejects.toThrow("can't be replaced yet");
        expect(urls).toEqual([]); // refused before RunPod is asked
        expect(upsertMock).not.toHaveBeenCalled();
        expect(revokeMock).not.toHaveBeenCalled();
      },
    );

    it("still allows removing it", async () => {
      unfinished = 1;
      listMock.mockResolvedValue([
        summary({ provider_account_id: "user_other" }),
      ]);
      expect(
        await deleteGpuProviderKeyLocal(
          {
            key_use: testKeyUse("removal"),
            account_id: ACCOUNT,
            provider: "runpod",
          },
          { ...home, ...rejected },
        ),
      ).toEqual({ revoked: true });
    });
  });

  it("replaces a key with no unfinished pods by revoking it and storing a new credential", async () => {
    listMock.mockResolvedValue([summary({})]);
    const { fetch } = fakeFetch([
      PERSONAL_ORG_403,
      MYSELF,
      NO_PODS,
      TEMPLATE_CREATED,
      TEMPLATE_DELETED,
    ]);
    await setGpuProviderKeyLocal(
      {
        key_use: testKeyUse("verify"),
        account_id: ACCOUNT,
        provider: "runpod",
        api_key: KEY,
      },
      { ...home, fetch, isEntitled: entitled },
    );
    // one store transaction: the old key revoked, a new row (a new id), and
    // the old fence closed and the new budget made inside it
    expect(revokeMock).not.toHaveBeenCalled();
    const call = upsertMock.mock.calls[0][0];
    expect(call.newIdentity).toBe(true);
    const client = { query: jest.fn(async () => ({ rows: [] })) };
    await call.alsoInTransaction(client, {
      id: "cred-2",
      previous: ["cred-1"],
    });
    expect(clearHostkeysMock).toHaveBeenCalledWith(
      { account_id: ACCOUNT, credential_id: "cred-1" },
      client,
    );
    const sql = client.query.mock.calls.map((c: any) => c[0]).join("\n");
    expect(sql).toMatch(/UPDATE gpu_key_fences SET state = 'closed'/);
    expect(sql).toMatch(/INSERT INTO gpu_budget_layers/);
  });
});
