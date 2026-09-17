const mockHome = jest.fn();
const mockLocal = jest.fn();
const mockRemote = jest.fn();
const mockClient = jest.fn(() => ({ getMembership: mockRemote }));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args) => mockHome(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "project-bay",
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "fabric",
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: (...args) => (mockClient as any)(...args),
}));
jest.mock("./resolve", () => ({
  resolveMembershipForAccount: (...args) => mockLocal(...args),
}));
import { resolveRuntimeMembership } from "./runtime-resolution";

beforeEach(() => jest.clearAllMocks());
test("uses the account home, not the project bay, for runtime entitlements", async () => {
  mockHome.mockResolvedValue({ home_bay_id: "account-bay" });
  mockRemote.mockResolvedValue({
    effective_limits: { shared_compute_priority: 4 },
  });
  expect(await resolveRuntimeMembership("sponsor")).toEqual({
    effective_limits: { shared_compute_priority: 4 },
  });
  expect(mockHome).toHaveBeenCalledWith({
    account_id: "sponsor",
    user_account_id: "sponsor",
  });
  expect(mockClient).toHaveBeenCalledWith({
    client: "fabric",
    dest_bay: "account-bay",
  });
  expect(mockRemote).toHaveBeenCalledWith({ account_id: "sponsor" });
  expect(mockLocal).not.toHaveBeenCalled();
});
test("uses local resolution only for a locally owned account", async () => {
  mockHome.mockResolvedValue({ home_bay_id: "project-bay" });
  mockLocal.mockResolvedValue({ class: "free" });
  expect(await resolveRuntimeMembership("sponsor")).toEqual({ class: "free" });
  expect(mockClient).not.toHaveBeenCalled();
});
test("unavailable ownership or home does not downgrade to local free defaults", async () => {
  mockHome.mockResolvedValue({});
  await expect(resolveRuntimeMembership("sponsor")).rejects.toThrow(
    "home unavailable",
  );
  mockHome.mockResolvedValue({ home_bay_id: "account-bay" });
  mockRemote.mockRejectedValue(new Error("home offline"));
  await expect(resolveRuntimeMembership("sponsor")).rejects.toThrow(
    "home offline",
  );
  expect(mockLocal).not.toHaveBeenCalled();
});
