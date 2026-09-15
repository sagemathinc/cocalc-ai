import { personalControl } from "./personal";

const mockConnections = jest.fn();
const mockSetConnection = jest.fn();
const mockAssertHome = jest.fn();
let mockHome = "home";
jest.mock("./store", () => ({
  AgentStore: jest.fn(),
  agentStore: () => {
    throw new Error("master switch off");
  },
  agentMessagingEnabled: () => false,
}));
jest.mock("./personal-store", () => ({
  PersonalAgentStore: jest.fn().mockImplementation(() => ({
    assertHome: mockAssertHome,
    connections: mockConnections,
    controls: async () => ({ paused: false, generation: 0 }),
    setConnection: mockSetConnection,
  })),
}));
jest.mock("./api", () => ({ getIdentity: jest.fn() }));
jest.mock("./rpc", () => ({ agentRpcControl: {} }));
jest.mock("./personal-rehome", () => ({
  assertPersonalAccountAuthority: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({ home_bay_id: mockHome }),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: jest.fn(),
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: jest.fn(),
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: async () => {},
  isAccountBannedCached: () => false,
}));

const account_id = "11111111-1111-4111-8111-111111111111";
const previous = process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED;
beforeEach(() => {
  process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "0";
  mockHome = "home";
  jest.clearAllMocks();
  mockAssertHome.mockResolvedValue(undefined);
  mockConnections.mockResolvedValue([]);
});
afterAll(() => {
  if (previous === undefined)
    delete process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED;
  else process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = previous;
});

test("site-off inspection still passes the account-home fence", async () => {
  await expect(
    personalControl({
      account_id,
      home_bay_id: "home",
      request: { action: "listPersonalConnections", options: {} },
    }),
  ).resolves.toMatchObject({ enabled: false, connections: [] });
  expect(mockAssertHome).toHaveBeenCalledWith(account_id);
  expect(mockConnections).toHaveBeenCalledWith(account_id);
});

test("site-off revocation remains available without fresh elevation", async () => {
  const options = { direction_group_id: "group", state: "revoked" as const };
  await personalControl({
    account_id,
    home_bay_id: "home",
    request: { action: "setPersonalConnectionState", options },
  });
  expect(mockSetConnection).toHaveBeenCalledWith(account_id, options);
});

test("site-off resume stays denied even with a fresh attestation", async () => {
  await expect(
    personalControl({
      account_id,
      home_bay_id: "home",
      fresh_auth_at: Date.now(),
      request: {
        action: "setPersonalConnectionState",
        options: { direction_group_id: "group", state: "active" },
      },
    }),
  ).rejects.toThrow("not enabled");
  expect(mockSetConnection).not.toHaveBeenCalled();
});

test("site-off inspection rejects a stale home route", async () => {
  mockHome = "other";
  await expect(
    personalControl({
      account_id,
      home_bay_id: "home",
      request: { action: "listPersonalConnections", options: {} },
    }),
  ).rejects.toThrow("stale personal account home route");
  expect(mockConnections).not.toHaveBeenCalled();
});
