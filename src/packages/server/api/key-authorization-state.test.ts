export {};

const accountId = "11111111-1111-4111-8111-111111111111";
let queryMock: jest.Mock;
const getClusterAccountByIdMock = jest.fn();
const remoteReadMock = jest.fn();
const isAccountBannedCachedMock = jest.fn();
const remoteWatermarkMock = jest.fn();
const fenceMock = jest.fn();

jest.mock("@cocalc/database/postgres/account-rehome-fence", () => ({
  withAccountRehomeWriteFence: (...args: any[]) => fenceMock(...args),
}));

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
    getApiKeyIssuanceWatermark: (...args: any[]) =>
      remoteWatermarkMock(...args),
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
          issuance_sequence: "9007199254740993",
          hash: "stored-hash",
          expire: new Date(Date.now() + 60_000),
        },
      ],
    }));
    getClusterAccountByIdMock.mockReset();
    getClusterAccountByIdMock.mockResolvedValue({ home_bay_id: "bay-1" });
    remoteReadMock.mockReset();
    isAccountBannedCachedMock.mockReset();
    isAccountBannedCachedMock.mockReturnValue(false);
    remoteWatermarkMock.mockReset();
    fenceMock.mockReset();
    fenceMock.mockImplementation(
      async ({ fn }) => await fn({ query: (...args) => queryMock(...args) }),
    );
  });

  it("reads live key scope and verifier from the home row without returning a secret", async () => {
    const { getApiKeyAuthorizationStateLocal } =
      await import("./key-authorization-state");
    const state = await getApiKeyAuthorizationStateLocal({
      account_id: accountId,
      key_id: "key-id-123",
    });
    expect(state).toMatchObject({
      scope_revision: 4,
      issuance_sequence: "9007199254740993",
      hash: "stored-hash",
      scope: { version: 1 },
    });
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
  it("reads a watermark under the account-rehome and issuance locks", async () => {
    const { getApiKeyIssuanceWatermarkLocal } =
      await import("./key-authorization-state");
    queryMock.mockResolvedValue({ rows: [{ sequence: "9007199254740993" }] });
    await expect(
      getApiKeyIssuanceWatermarkLocal({ account_id: accountId }),
    ).resolves.toBe("9007199254740993");
    expect(fenceMock).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: accountId }),
    );
    expect(queryMock.mock.calls[0][0]).toContain("FOR UPDATE");
    fenceMock.mockRejectedValueOnce(Error("account rehome is frozen"));
    await expect(
      getApiKeyIssuanceWatermarkLocal({ account_id: accountId }),
    ).rejects.toThrow("frozen");
  });
  it("rejects a non-home watermark read without consulting the local row", async () => {
    const { getApiKeyIssuanceWatermarkLocal } =
      await import("./key-authorization-state");
    getClusterAccountByIdMock.mockResolvedValue({ home_bay_id: "bay-2" });
    await expect(
      getApiKeyIssuanceWatermarkLocal({ account_id: accountId }),
    ).rejects.toThrow("home changed");
    expect(queryMock).not.toHaveBeenCalled();
    expect(fenceMock).not.toHaveBeenCalled();
  });
  it("routes watermark reads and rejects malformed or unavailable remote authority", async () => {
    const { getApiKeyIssuanceWatermark } =
      await import("./key-authorization-state");
    getClusterAccountByIdMock.mockResolvedValue({ home_bay_id: "bay-2" });
    remoteWatermarkMock.mockResolvedValueOnce("9007199254740993");
    await expect(
      getApiKeyIssuanceWatermark({ account_id: accountId }),
    ).resolves.toBe("9007199254740993");
    expect(remoteWatermarkMock).toHaveBeenCalledWith({ account_id: accountId });
    remoteWatermarkMock.mockResolvedValueOnce(9007199254740992);
    await expect(
      getApiKeyIssuanceWatermark({ account_id: accountId }),
    ).rejects.toThrow();
    remoteWatermarkMock.mockRejectedValueOnce(Error("unavailable"));
    await expect(
      getApiKeyIssuanceWatermark({ account_id: accountId }),
    ).rejects.toThrow("unavailable");
    expect(queryMock).not.toHaveBeenCalled();
  });
});
