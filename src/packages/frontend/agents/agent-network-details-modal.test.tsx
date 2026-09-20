import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentNetwork } from "@cocalc/conat/agents/personal";
import {
  AgentNetworkDetailsModal,
  AgentNetworkFilterBar,
} from "./agent-network-details-modal";

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

test("filter bar makes details and clearing explicit", async () => {
  const user = userEvent.setup();
  const onOpen = jest.fn();
  const onClear = jest.fn();
  render(
    <AgentNetworkFilterBar
      network={network}
      onOpen={onOpen}
      onClear={onClear}
    />,
  );

  expect(
    screen.getByRole("region", { name: "Filtered to Release network" }),
  ).toHaveTextContent("Showing Release · 2 agents");
  await user.click(screen.getByRole("button", { name: "Details" }));
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onClear).toHaveBeenCalledTimes(1);
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
