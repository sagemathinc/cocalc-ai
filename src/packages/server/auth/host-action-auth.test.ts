const mockHome = jest.fn();
const mockFresh = jest.fn();
const mockImpersonation = jest.fn();
const mockRemote = jest.fn();
const mockClient = jest.fn(() => ({ validateHostActionAuth: mockRemote }));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args) => mockHome(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-1",
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "fabric",
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: (...args) => (mockClient as any)(...args),
}));
jest.mock("./auth-sessions", () => ({
  requireFreshAuthForSessionHash: (...args) => mockFresh(...args),
}));
jest.mock("./impersonation", () => ({
  getImpersonationSessionBySessionHash: (...args) => mockImpersonation(...args),
}));
import {
  validateHostActionAuth,
  validateHostActionAuthLocal,
} from "./host-action-auth";

const request = { account_id: "human", session_hash: "session-reference" };
beforeEach(() => {
  jest.resetAllMocks();
  mockClient.mockReturnValue({ validateHostActionAuth: mockRemote });
  mockHome.mockResolvedValue({ home_bay_id: "bay-1" });
});

test("remote host bay validates at the human's home, with no local session lookup", async () => {
  mockHome.mockResolvedValue({ home_bay_id: "bay-0" });
  mockRemote.mockResolvedValue({ allow_second_factor_override: false });
  expect(await validateHostActionAuth(request)).toEqual({
    allow_second_factor_override: false,
  });
  expect(mockClient).toHaveBeenCalledWith({
    client: "fabric",
    dest_bay: "bay-0",
  });
  expect(mockRemote).toHaveBeenCalledWith(request);
  expect(mockFresh).not.toHaveBeenCalled();
});

test("home validates the exact account/session and returns no session data", async () => {
  mockFresh.mockResolvedValue({ sensitive: "not returned" });
  expect(await validateHostActionAuth(request)).toEqual({
    allow_second_factor_override: false,
  });
  expect(mockFresh).toHaveBeenCalledWith({
    ...request,
    allow_actor_impersonation: true,
  });
  mockImpersonation.mockResolvedValue({ actor_account_id: "admin" });
  expect(await validateHostActionAuthLocal(request)).toEqual({
    allow_second_factor_override: true,
  });
});

test.each(["expired", "revoked", "wrong account"])(
  "home rejection (%s) propagates",
  async (reason) => {
    mockFresh.mockRejectedValue(new Error(reason));
    await expect(validateHostActionAuthLocal(request)).rejects.toThrow(reason);
    expect(mockImpersonation).not.toHaveBeenCalled();
  },
);

test("unavailable home and stale routes fail closed without fallback", async () => {
  mockHome.mockResolvedValue({});
  await expect(validateHostActionAuth(request)).rejects.toThrow(
    "home unavailable",
  );
  mockHome.mockResolvedValue({ home_bay_id: "bay-0" });
  await expect(validateHostActionAuthLocal(request)).rejects.toThrow(
    "non-home bay",
  );
  mockRemote.mockRejectedValue(new Error("offline"));
  await expect(validateHostActionAuth(request)).rejects.toThrow("offline");
  expect(mockFresh).not.toHaveBeenCalled();
});
