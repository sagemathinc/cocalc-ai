/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const upsertMock = jest.fn();
const getMock = jest.fn();
const revokeMock = jest.fn();
const membershipMock = jest.fn();

jest.mock("@cocalc/server/external-credentials/routing", () => ({
  upsertExternalCredentialRouted: (...args: any[]) => upsertMock(...args),
  getExternalCredentialRouted: (...args: any[]) => getMock(...args),
  revokeAccountExternalCredentialRouted: (...args: any[]) =>
    revokeMock(...args),
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: (...args: any[]) => membershipMock(...args),
}));

import {
  deleteGpuProviderKey,
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

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
    });
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

beforeEach(() => {
  upsertMock.mockReset().mockResolvedValue({ id: "cred-1", created: true });
  getMock.mockReset().mockResolvedValue(undefined);
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
    const { fetch, urls } = fakeFetch([PERSONAL_ORG_403, MYSELF, NO_PODS]);
    getMock.mockImplementation(async () =>
      storedRecord(upsertMock.mock.calls[0][0].metadata),
    );
    const status = await setGpuProviderKey(
      { account_id: ACCOUNT, provider: "runpod", api_key: ` ${KEY}\n` },
      { fetch, isEntitled: entitled },
    );
    expect(urls).toEqual([
      "https://api.runpod.io/v2/organization",
      "https://api.runpod.io/graphql",
      "https://api.runpod.io/v2/pods",
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
      connected_at: "2026-10-27T20:00:00.000Z",
    });
    // The key is never part of what comes back.
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it("records an organization's name", async () => {
    const { fetch } = fakeFetch([
      { body: { id: "org_9", name: "Physics 101" } },
      NO_PODS,
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
      "can't read",
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
    ).rejects.toThrow("can't read the account and its pods");
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

  it("reports status without the key, and without touching last use", async () => {
    expect(
      await getGpuProviderKeyStatus(
        { account_id: ACCOUNT, provider: "runpod" },
        { isEntitled: async () => false },
      ),
    ).toEqual({ provider: "runpod", entitled: false, connected: false });
    expect(getMock).toHaveBeenCalledWith(
      expect.objectContaining({ touchLastUsed: false }),
    );
  });

  it("removes the account's key, and reports when there was none", async () => {
    expect(
      await deleteGpuProviderKey({ account_id: ACCOUNT, provider: "runpod" }),
    ).toEqual({ revoked: false });
    expect(revokeMock).not.toHaveBeenCalled();
    getMock.mockResolvedValue(storedRecord({}));
    expect(
      await deleteGpuProviderKey({ account_id: ACCOUNT, provider: "runpod" }),
    ).toEqual({ revoked: true });
    expect(revokeMock).toHaveBeenCalledWith({
      id: "cred-1",
      owner_account_id: ACCOUNT,
    });
  });

  it("builds a RunPod client from the stored key, or nothing without one", async () => {
    expect(await getRunpodClientForAccount(ACCOUNT)).toBeUndefined();
    getMock.mockResolvedValue(storedRecord({}));
    const client = await getRunpodClientForAccount(ACCOUNT);
    expect(client).toBeDefined();
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(getMock).toHaveBeenCalledWith({
      selector: expect.objectContaining({ owner_account_id: ACCOUNT }),
    });
  });
});
