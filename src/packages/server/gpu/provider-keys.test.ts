/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const upsertMock = jest.fn();
const listMock = jest.fn();
const localGetMock = jest.fn();
const revokeMock = jest.fn();
const membershipMock = jest.fn();

// Everything runs on the home bay, against its local store.
jest.mock("@cocalc/server/external-credentials/store", () => ({
  getExternalCredential: (...args: any[]) => localGetMock(...args),
  upsertExternalCredential: (...args: any[]) => upsertMock(...args),
  listExternalCredentials: (...args: any[]) => listMock(...args),
  revokeExternalCredential: (...args: any[]) => revokeMock(...args),
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
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => {
    const query = async () => ({ rows: [{ n: unfinished }] });
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
  deleteGpuProviderKey,
  deleteGpuProviderKeyLocal,
  getGpuProviderKeyStatusLocal,
  setGpuProviderKeyLocal,
  getRunpodCleanupForAccount,
  getRunpodClientForAccount,
  getGpuProviderKeyStatus,
  isGpuProviderKeysEntitled,
  setGpuProviderKey,
} from "./provider-keys";

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
  upsertMock.mockReset().mockResolvedValue({ id: "cred-1", created: true });
  listMock.mockReset().mockResolvedValue([]);
  localGetMock.mockReset().mockResolvedValue(undefined);
  revokeMock.mockReset().mockResolvedValue(true);
  membershipMock.mockReset();
});

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
      { account_id: ACCOUNT, provider: "runpod", api_key: ` ${KEY}\n` },
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

  it("records an organization's name", async () => {
    const { fetch } = fakeFetch([
      { body: { id: "org_9", name: "Physics 101" } },
      NO_PODS,
      TEMPLATE_CREATED,
      TEMPLATE_DELETED,
    ]);
    await setGpuProviderKey(
      { account_id: ACCOUNT, provider: "runpod", api_key: KEY },
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
        { account_id: ACCOUNT, provider: "runpod", api_key: KEY },
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
        { account_id: ACCOUNT, provider: "runpod", api_key: KEY },
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
        { account_id: ACCOUNT, provider: "runpod", api_key: KEY },
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
          { account_id: ACCOUNT, provider: "runpod", api_key },
          { fetch, isEntitled: entitled },
        ),
      ).rejects.toThrow("valid RunPod API key");
    }
    await expect(
      setGpuProviderKey(
        { account_id: ACCOUNT, provider: "aws", api_key: KEY },
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
      await deleteGpuProviderKey({ account_id: ACCOUNT, provider: "runpod" }),
    ).toEqual({ revoked: false });
    expect(revokeMock).not.toHaveBeenCalled();
    listMock.mockResolvedValue([summary({})]);
    expect(
      await deleteGpuProviderKey({ account_id: ACCOUNT, provider: "runpod" }),
    ).toEqual({ revoked: true });
    expect(localGetMock).not.toHaveBeenCalled();
    expect(revokeMock).toHaveBeenCalledWith({
      id: "cred-1",
      owner_account_id: ACCOUNT,
    });
  });

  it("builds a RunPod client from the local store, or nothing without a key", async () => {
    const deps = { ...home, isEntitled: entitled };
    expect(await getRunpodClientForAccount(ACCOUNT, deps)).toBeUndefined();
    localGetMock.mockResolvedValue(storedRecord({}));
    const client = await getRunpodClientForAccount(ACCOUNT, deps);
    expect(client).toBeDefined();
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(localGetMock).toHaveBeenCalledWith({
      selector: expect.objectContaining({ owner_account_id: ACCOUNT }),
    });
  });

  it("never reads the key away from the owner's home bay", async () => {
    localGetMock.mockResolvedValue(storedRecord({}));
    const away = { isHomeBay: async () => false, isEntitled: entitled };
    await expect(getRunpodClientForAccount(ACCOUNT, away)).rejects.toThrow(
      "home bay",
    );
    await expect(getRunpodCleanupForAccount(ACCOUNT, away)).rejects.toThrow(
      "home bay",
    );
    expect(localGetMock).not.toHaveBeenCalled();
  });

  it("requires the live entitlement for full access, but not for cleanup", async () => {
    localGetMock.mockResolvedValue(storedRecord({}));
    const lapsed = { ...home, isEntitled: async () => false };
    await expect(getRunpodClientForAccount(ACCOUNT, lapsed)).rejects.toThrow(
      "membership",
    );
    expect(localGetMock).not.toHaveBeenCalled();
    expect(await getRunpodCleanupForAccount(ACCOUNT, lapsed)).toBeDefined();
  });

  it("gives cleanup only inventory and billing, with no client to reach through", async () => {
    localGetMock.mockResolvedValue(storedRecord({}));
    const { fetch, urls } = fakeFetch([NO_PODS]);
    const cleanup = (await getRunpodCleanupForAccount(ACCOUNT, {
      ...home,
      fetch,
    }))!;
    // Nothing that creates or starts anything.
    expect(Object.keys(cleanup).sort()).toEqual([
      "credential_id",
      "findPodsByName",
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
      { account_id: ACCOUNT, provider: "runpod", api_key: KEY },
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
        { account_id: ACCOUNT, provider: "runpod", api_key: KEY },
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
        { account_id: ACCOUNT, provider: "runpod", api_key: KEY },
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
        { account_id: ACCOUNT, provider: "runpod", api_key: KEY },
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
      { account_id: ACCOUNT, provider: "runpod", api_key: KEY },
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
      { account_id: ACCOUNT, provider: "runpod", api_key: KEY },
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
    expect(await setGpuProviderKey({ ...op, api_key: KEY }, deps)).toEqual(
      status,
    );
    expect(await deleteGpuProviderKey(op, deps)).toEqual({ revoked: true });
    expect(remote.gpuKeyStatus).toHaveBeenCalledWith(op);
    expect(remote.gpuKeySet).toHaveBeenCalledWith({ ...op, api_key: KEY });
    expect(remote.gpuKeyDelete).toHaveBeenCalledWith(op);
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
        { account_id: ACCOUNT, provider: "other" },
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
      setGpuProviderKeyLocal({ ...op, api_key: KEY }, away),
    ).rejects.toThrow("home bay");
    await expect(deleteGpuProviderKeyLocal(op, away)).rejects.toThrow(
      "home bay",
    );
    for (const m of [listMock, upsertMock, revokeMock, localGetMock]) {
      expect(m).not.toHaveBeenCalled();
    }
  });

  it("refuses to replace or remove a key while pods launched with it aren't finished", async () => {
    listMock.mockResolvedValue([summary({})]);
    unfinished = 2;
    const { fetch, urls } = fakeFetch([]);
    await expect(
      setGpuProviderKeyLocal(
        { account_id: ACCOUNT, provider: "runpod", api_key: KEY },
        { ...home, fetch, isEntitled: entitled },
      ),
    ).rejects.toThrow("2 GPU pods were launched with your current RunPod key");
    expect(urls).toEqual([]); // refused before RunPod is asked
    await expect(
      deleteGpuProviderKeyLocal(
        { account_id: ACCOUNT, provider: "runpod" },
        home,
      ),
    ).rejects.toThrow("can't be removed yet");
    expect(upsertMock).not.toHaveBeenCalled();
    expect(revokeMock).not.toHaveBeenCalled();
    // once they're finished, removal works
    unfinished = 0;
    expect(
      await deleteGpuProviderKeyLocal(
        { account_id: ACCOUNT, provider: "runpod" },
        home,
      ),
    ).toEqual({ revoked: true });
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
      { account_id: ACCOUNT, provider: "runpod", api_key: KEY },
      { ...home, fetch, isEntitled: entitled },
    );
    expect(upsertMock).toHaveBeenCalled();
  });

  it("lets a key RunPod already rejects be removed or replaced, even with unfinished pods", async () => {
    listMock.mockResolvedValue([summary({})]);
    unfinished = 1;
    localGetMock.mockResolvedValue(storedRecord({}));
    // RunPod answers 401 for the stored key (deleted at RunPod)
    const { fetch } = fakeFetch([{ status: 401, body: { detail: "nope" } }]);
    expect(
      await deleteGpuProviderKeyLocal(
        { account_id: ACCOUNT, provider: "runpod" },
        { ...home, fetch },
      ),
    ).toEqual({ revoked: true });
  });

  it("keeps refusing when RunPod can't be asked about the stored key", async () => {
    listMock.mockResolvedValue([summary({})]);
    unfinished = 1;
    localGetMock.mockResolvedValue(storedRecord({}));
    const { fetch } = fakeFetch([{ status: 503, body: {} }]);
    await expect(
      deleteGpuProviderKeyLocal(
        { account_id: ACCOUNT, provider: "runpod" },
        { ...home, fetch },
      ),
    ).rejects.toThrow("can't be removed yet");
    expect(revokeMock).not.toHaveBeenCalled();
  });

  describe("replacing a key RunPod already rejects, with unfinished pods", () => {
    const verify = () =>
      fakeFetch([
        PERSONAL_ORG_403,
        MYSELF, // the new key acts for personal account user_1
        NO_PODS,
        TEMPLATE_CREATED,
        TEMPLATE_DELETED,
      ]);
    const rejected = { storedKeyRejected: async () => true };

    it("allows it for the same RunPod account (old pods stay reachable)", async () => {
      unfinished = 1;
      listMock.mockResolvedValue([
        summary({
          provider_account_kind: "personal",
          provider_account_id: "user_1",
        }),
      ]);
      const { fetch } = verify();
      await setGpuProviderKeyLocal(
        { account_id: ACCOUNT, provider: "runpod", api_key: KEY },
        { ...home, ...rejected, fetch, isEntitled: entitled },
      );
      expect(upsertMock).toHaveBeenCalled();
    });

    it.each([
      [
        {
          provider_account_kind: "personal",
          provider_account_id: "user_other",
        },
      ],
      [
        {
          provider_account_kind: "organization",
          provider_account_id: "user_1",
        },
      ],
      [{}],
    ])(
      "refuses it for another or unknown RunPod account (%j)",
      async (metadata) => {
        unfinished = 1;
        listMock.mockResolvedValue([summary(metadata)]);
        const { fetch } = verify();
        await expect(
          setGpuProviderKeyLocal(
            { account_id: ACCOUNT, provider: "runpod", api_key: KEY },
            { ...home, ...rejected, fetch, isEntitled: entitled },
          ),
        ).rejects.toThrow("different RunPod account");
        expect(upsertMock).not.toHaveBeenCalled();
      },
    );

    it("still allows removing it", async () => {
      unfinished = 1;
      listMock.mockResolvedValue([
        summary({ provider_account_id: "user_other" }),
      ]);
      expect(
        await deleteGpuProviderKeyLocal(
          { account_id: ACCOUNT, provider: "runpod" },
          { ...home, ...rejected },
        ),
      ).toEqual({ revoked: true });
    });
  });
});
