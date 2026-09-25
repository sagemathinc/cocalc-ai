import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentNetwork } from "@cocalc/conat/agents/personal";
import { AgentNetworkDetailsModal } from "./agent-network-details-modal";

const mockApi = {
  listAgentNetworkActivity: jest.fn(),
  updateAgentNetwork: jest.fn(),
};
const mockRunFreshAuthAction = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: mockRunFreshAuthAction,
    freshAuthModalProps: {},
  }),
}));
jest.mock("./api", () => ({
  personalAgentApi: () => mockApi,
}));

const network: AgentNetwork = {
  agent_network_id: "11111111-1111-4111-8111-111111111111",
  account_id: "account",
  title: "Release",
  state: "active",
  delivery_mode: "queued",
  generation: "generation",
  created_by: "account",
  created_at: "2026-09-20T00:00:00.000Z",
  updated_at: "2026-09-20T00:00:00.000Z",
  members: [
    {
      kind: "registered",
      member_id: "source",
      endpoint: { project_id: "project", agent_id: "source-agent" },
      name: "builder",
      project_title: "CoCalc",
      available: true,
      added_at: "2026-09-20T00:00:00.000Z",
    },
    {
      kind: "registered",
      member_id: "target",
      endpoint: { project_id: "project", agent_id: "target-agent" },
      name: "reviewer",
      project_title: "CoCalc",
      available: true,
      added_at: "2026-09-20T00:00:00.000Z",
    },
  ],
};

beforeEach(() => {
  jest.resetAllMocks();
  mockApi.listAgentNetworkActivity.mockResolvedValue([
    {
      attempt_id: "attempt",
      agent_network_id: network.agent_network_id,
      network_generation: network.generation,
      source_member_id: "source",
      target_member_id: "target",
      configured_delivery: "queued",
      effective_delivery: "queued",
      outcome: "accepted",
      observed_at: "2026-09-20T01:00:00.000Z",
    },
  ]);
  mockApi.updateAgentNetwork.mockResolvedValue({});
  mockRunFreshAuthAction.mockImplementation(async (action) => {
    await action();
    return true;
  });
});

test("details modal loads activity and can pause the network", async () => {
  const user = userEvent.setup();
  const onChanged = jest.fn();
  render(
    <AgentNetworkDetailsModal
      network={network}
      onClose={jest.fn()}
      onChanged={onChanged}
    />,
  );

  expect(
    await screen.findByRole("dialog", { name: "Agent Network details" }),
  ).toBeInTheDocument();
  expect(await screen.findByRole("listitem")).toHaveTextContent(
    "@builder to @reviewer: accepted via queued",
  );

  await user.click(screen.getByRole("button", { name: "Pause network" }));
  await waitFor(() =>
    expect(mockApi.updateAgentNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_network_id: network.agent_network_id,
        action: "pause",
      }),
    ),
  );
  expect(onChanged).toHaveBeenCalledTimes(1);
});

test("network selector switches details to any existing network", async () => {
  const other = {
    ...network,
    agent_network_id: "22222222-2222-4222-8222-222222222222",
    title: "Support",
    members: [],
  };
  const onSelectNetwork = jest.fn();
  render(
    <AgentNetworkDetailsModal
      network={network}
      networks={[network, other]}
      onSelectNetwork={onSelectNetwork}
      onClose={jest.fn()}
    />,
  );
  const user = userEvent.setup();
  const selector = screen.getByRole("combobox", {
    name: "Select Agent Network",
  });
  await user.click(selector);
  expect(
    await screen.findByRole("option", { name: "Support" }),
  ).toBeInTheDocument();
  await user.click(screen.getByText("Support"));
  await waitFor(() => expect(onSelectNetwork).toHaveBeenCalledWith(other));
});

test("closing a network requires explicit confirmation", async () => {
  render(<AgentNetworkDetailsModal network={network} onClose={jest.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Close network" }));
  expect(
    (await screen.findAllByText("Close this Agent Network?")).length,
  ).toBeGreaterThan(0);
  expect(mockApi.updateAgentNetwork).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mockApi.updateAgentNetwork).not.toHaveBeenCalled();
});
