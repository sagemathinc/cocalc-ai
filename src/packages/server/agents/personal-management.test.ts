import { personalControl } from "./personal";

const mockNetworks = jest.fn();
const mockUpdateNetwork = jest.fn();
const mockAssertHome = jest.fn();
const mockNames = jest.fn();
const mockRetire = jest.fn();
let mockHome = "home";
jest.mock("./store", () => ({
  AgentStore: jest.fn(),
  agentStore: () => {
    throw new Error("ordinary store unavailable");
  },
}));
jest.mock("./personal-store", () => ({
  PersonalAgentStore: jest.fn().mockImplementation(() => ({
    assertHome: mockAssertHome,
    networks: mockNetworks,
    controls: async () => ({ paused: false, generation: 0 }),
    updateNetwork: mockUpdateNetwork,
    names: mockNames,
    retire: mockRetire,
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
jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: async () => ({
    effective_limits: {
      max_named_agents: 15,
      max_agent_network_members: 8,
    },
  }),
}));

const account_id = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  mockHome = "home";
  jest.clearAllMocks();
  mockAssertHome.mockResolvedValue(undefined);
  mockNetworks.mockResolvedValue({ networks: [], active_count: 0 });
  mockNames.mockResolvedValue([]);
});

test("network inspection passes the account-home fence", async () => {
  await expect(
    personalControl({
      account_id,
      home_bay_id: "home",
      request: { action: "listAgentNetworks", options: {} },
    }),
  ).resolves.toMatchObject({
    enabled: true,
    networks: [],
    usage: { active_networks: 0, member_limit: 8 },
  });
  expect(mockAssertHome).toHaveBeenCalledWith(account_id);
});

test("restrictive network pause remains available", async () => {
  const options = {
    request_id: "22222222-2222-4222-8222-222222222222",
    agent_network_id: "33333333-3333-4333-8333-333333333333",
    action: "pause" as const,
  };
  mockUpdateNetwork.mockResolvedValue({
    agent_network_id: options.agent_network_id,
  });
  await personalControl({
    account_id,
    home_bay_id: "home",
    request: { action: "updateAgentNetwork", options },
  });
  expect(mockUpdateNetwork).toHaveBeenCalledWith(account_id, options, 8, false);
});

test("named-agent directory reports membership usage", async () => {
  mockNames.mockResolvedValue([{ name: "reviewer" }, { name: "builder" }]);
  await expect(
    personalControl({
      account_id,
      home_bay_id: "home",
      request: { action: "listNamedAgents", options: {} },
    }),
  ).resolves.toMatchObject({ usage: { active: 2, limit: 15 } });
});

test("inspection rejects a stale home route", async () => {
  mockHome = "other";
  await expect(
    personalControl({
      account_id,
      home_bay_id: "home",
      request: { action: "listAgentNetworks", options: {} },
    }),
  ).rejects.toThrow("stale personal account home route");
  expect(mockNetworks).not.toHaveBeenCalled();
});
