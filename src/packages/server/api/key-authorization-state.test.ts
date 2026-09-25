export {};

const accountId = "11111111-1111-4111-8111-111111111111";
let queryMock: jest.Mock;
const getClusterAccountByIdMock = jest.fn();
const remoteReadMock = jest.fn();
const isAccountBannedCachedMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: (...args: any[]) => queryMock(...args) })),
}));
jest.mock("./manage", () => ({
  ensureApiKeysV2Schema: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: jest.fn(async () => undefined),
  isAccountBannedCached: (...args: any[]) => isAccountBannedCachedMock(...args),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args: any[]) => getClusterAccountByIdMock(...args),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: jest.fn(() => "fabric"),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-1"),
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: jest.fn(() => ({
    getApiKeyAuthorizationState: (...args: any[]) => remoteReadMock(...args),
  })),
}));

describe("account-home API key authorization state", () => {
  beforeEach(() => {
    queryMock = jest.fn(async () => ({
      rows: [
        {
          scope: {
            version: 1,
            account: [],
            projects: [
              {
                project_id: "00000000-0000-4000-8000-000000000001",
                capabilities: ["project:exec"],
              },
            ],
          },
          scope_revision: 4,
          expire: new Date(Date.now() + 60_000),
        },
      ],
    }));
    getClusterAccountByIdMock.mockReset();
    getClusterAccountByIdMock.mockResolvedValue({ home_bay_id: "bay-1" });
    remoteReadMock.mockReset();
    isAccountBannedCachedMock.mockReset();
    isAccountBannedCachedMock.mockReturnValue(false);
  });

  it("reads live key scope from the home row without returning a secret", async () => {
    const { getApiKeyAuthorizationStateLocal } =
      await import("./key-authorization-state");
    const state = await getApiKeyAuthorizationStateLocal({
      account_id: accountId,
      key_id: "key-id-123",
    });
    expect(state).toMatchObject({
      scope_revision: 4,
      scope: { version: 1 },
    });
    expect(state).not.toHaveProperty("hash");
    expect(queryMock.mock.calls[0][0]).toContain(
      "FROM api_keys WHERE account_id=$1 AND key_id=$2",
    );
    expect(queryMock.mock.calls[0][1]).toEqual([accountId, "key-id-123"]);
  });

  it("fails closed on expiry, deletion, ban, and malformed scope", async () => {
    const { getApiKeyAuthorizationStateLocal } =
      await import("./key-authorization-state");
    const opts = { account_id: accountId, key_id: "key-id-123" };
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(getApiKeyAuthorizationStateLocal(opts)).resolves.toBeNull();
    queryMock.mockResolvedValueOnce({
      rows: [{ scope_revision: 4, expire: new Date(0) }],
    });
    await expect(getApiKeyAuthorizationStateLocal(opts)).resolves.toBeNull();
    queryMock.mockResolvedValueOnce({
      rows: [{ scope_revision: 4, scope: { version: 999 } }],
    });
    await expect(getApiKeyAuthorizationStateLocal(opts)).resolves.toBeNull();
    isAccountBannedCachedMock.mockReturnValue(true);
    await expect(getApiKeyAuthorizationStateLocal(opts)).resolves.toBeNull();
  });

  it("routes to the account home rather than using local directory authority", async () => {
    const { getApiKeyAuthorizationState } =
      await import("./key-authorization-state");
    getClusterAccountByIdMock.mockResolvedValue({ home_bay_id: "bay-2" });
    remoteReadMock.mockResolvedValue({ scope_revision: 4 });
    const opts = { account_id: accountId, key_id: "key-id-123" };
    await expect(getApiKeyAuthorizationState(opts)).resolves.toEqual({
      scope_revision: 4,
    });
    expect(remoteReadMock).toHaveBeenCalledWith(opts);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
