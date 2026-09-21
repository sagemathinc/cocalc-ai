/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NetworkApproval } from "./network-approval";
import { refreshAgentNetworks, useAgentNetworks } from "./api";

const source = { project_id: "source-project", agent_id: "agent-1" };
const target = { project_id: "target-project", agent_id: "agent-2" };
let mockMembers: any[];
const mockApi = {
  listAgentNetworks: jest.fn(async () => ({
    enabled: true,
    controls: { paused: false, generation: 0 },
    usage: { active_networks: 1, network_limit: 10, member_limit: 10 },
    networks: [
      {
        agent_network_id: "target-network",
        title: "Target network",
        state: "active",
        generation: "1",
        delivery_mode: "queued",
        members: mockMembers,
      },
    ],
  })),
  updateAgentNetwork: jest.fn(async () => {
    mockMembers = [
      ...mockMembers,
      { kind: "registered", endpoint: source, name: "agent-1" },
    ];
  }),
};
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        get agent() {
          return mockApi;
        },
      },
    },
  },
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "account",
  redux: { getActions: () => ({}), getStore: () => ({ get: () => "account" }) },
}));
jest.mock("./source-agent-name", () => ({
  useSourceAgentName: () => ({
    canApprove: true,
    ensureNamed: async () => {},
    known: { name: "agent-1" },
  }),
}));
jest.mock("./name-context", () => ({ cachedAgentNameContext: () => ({}) }));
jest.mock("./agent-network-summary", () => ({
  AgentNetworkSummary: () => null,
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction: async (action) => {
      await action();
      return true;
    },
  }),
}));

function MembershipView() {
  const { directory } = useAgentNetworks();
  return (
    <output aria-label="Network membership">
      {directory?.networks[0].members
        .map((member: any) => member.name)
        .join(", ")}
    </output>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  refreshAgentNetworks();
  mockMembers = [{ kind: "registered", endpoint: target, name: "agent-2" }];
});

beforeAll(() => {
  const original = window.getComputedStyle;
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => original(element));
});
afterAll(() => jest.restoreAllMocks());

it("refreshes mounted membership views after approving a cross-project join", async () => {
  const onClose = jest.fn();
  render(
    <>
      <MembershipView />
      <NetworkApproval
        value={{
          source,
          target,
          sourceLabel: "agent-1",
          targetLabel: "agent-2",
        }}
        onClose={onClose}
      />
    </>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "Network membership" }).textContent,
    ).toBe("agent-2"),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Join network" }),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
  expect(mockApi.updateAgentNetwork).toHaveBeenCalledWith(
    expect.objectContaining({
      agent_network_id: "target-network",
      action: "add-member",
      member: { kind: "registered", endpoint: source },
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "Network membership" }).textContent,
    ).toBe("agent-2, agent-1"),
  );
});
