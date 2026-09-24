import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AgentNetwork,
  AgentNetworkDirectory,
  NamedAgent,
} from "@cocalc/conat/agents/personal";
import { AgentNetworkTagsEditor } from "./agent-network-tags-editor";
import { duplicateNetworkTitle } from "./agent-network-utils";

const mockApi = {
  createAgentNetwork: jest.fn(),
  updateAgentNetwork: jest.fn(),
};
const mockRefresh = jest.fn();
const mockFresh = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: mockFresh,
    freshAuthModalProps: {},
  }),
}));
jest.mock("./api", () => ({
  personalAgentApi: () => mockApi,
  refreshAgentNetworks: () => mockRefresh(),
  sameEndpoint: (
    a: { project_id: string; agent_id: string },
    b: { project_id: string; agent_id: string },
  ) => a.project_id === b.project_id && a.agent_id === b.agent_id,
}));

const agent: NamedAgent = {
  account_id: "account",
  name: "builder",
  endpoint: { project_id: "other-project", agent_id: "builder-id" },
  path: "/agents.chat",
  thread_id: "thread",
  available: true,
  updated_at: "2026-09-24T00:00:00.000Z",
};
const peer: NamedAgent = {
  ...agent,
  name: "reviewer",
  endpoint: { project_id: "project", agent_id: "reviewer-id" },
};
const network: AgentNetwork = {
  agent_network_id: "11111111-1111-4111-8111-111111111111",
  account_id: "account",
  title: "Release",
  state: "active",
  delivery_mode: "live",
  generation: "generation",
  created_by: "account",
  created_at: "2026-09-24T00:00:00.000Z",
  updated_at: "2026-09-24T00:00:00.000Z",
  members: [
    {
      kind: "registered",
      member_id: "reviewer-id",
      endpoint: peer.endpoint,
      name: "reviewer",
      available: true,
      added_at: "2026-09-24T00:00:00.000Z",
    },
    {
      kind: "registered",
      member_id: "writer-id",
      endpoint: { project_id: "project", agent_id: "writer-id" },
      name: "writer",
      available: true,
      added_at: "2026-09-24T00:00:00.000Z",
    },
  ],
};
const directory: AgentNetworkDirectory = {
  enabled: true,
  networks: [network],
  usage: { active_networks: 1, network_limit: 10, member_limit: 10 },
  controls: { paused: false, generation: 1 },
};

beforeEach(() => {
  jest.resetAllMocks();
  mockApi.createAgentNetwork.mockResolvedValue({});
  mockApi.updateAgentNetwork.mockResolvedValue({});
  mockFresh.mockImplementation(async (action) => {
    await action();
    return true;
  });
});

test("network tag titles compare case-insensitively but retain distinct IDs", () => {
  expect(duplicateNetworkTitle([network], " release ")).toBe(true);
  expect(
    duplicateNetworkTitle([network], "release", network.agent_network_id),
  ).toBe(false);
});

test("editor explains permissions, warns on duplicate titles, and adds with fresh auth", async () => {
  const user = userEvent.setup();
  render(
    <AgentNetworkTagsEditor
      agent={agent}
      agents={[agent, peer]}
      directory={directory}
      onClose={jest.fn()}
    />,
  );

  expect(
    screen.getByRole("dialog", { name: "Network tags for @builder" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Network tags are permissions, not just labels."),
  ).toBeInTheDocument();
  await user.type(
    screen.getByRole("textbox", { name: "Tag name" }),
    " release ",
  );
  expect(
    screen.getByText(/already exists\. Choose a distinct name/),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Create network tag" }),
  ).toBeDisabled();

  const addButton = screen.getByRole("button", {
    name: "Add @builder to Release network tag",
  });
  addButton.focus();
  expect(addButton).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(mockApi.updateAgentNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_network_id: network.agent_network_id,
        action: "add-member",
        member: { kind: "registered", endpoint: agent.endpoint },
      }),
    ),
  );
  expect(mockFresh).toHaveBeenCalledTimes(1);
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});

test("editor does not offer removal when only two members remain", () => {
  render(
    <AgentNetworkTagsEditor
      agent={peer}
      agents={[agent, peer]}
      directory={directory}
      onClose={jest.fn()}
    />,
  );
  expect(
    screen.getByRole("button", {
      name: "Remove @reviewer from Release network tag",
    }),
  ).toBeDisabled();
});

test("creating a network tag explicitly requests live delivery", async () => {
  const user = userEvent.setup();
  render(
    <AgentNetworkTagsEditor
      agent={agent}
      agents={[agent, peer]}
      directory={directory}
      onClose={jest.fn()}
    />,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Tag name" }),
    "Planning",
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Second agent" }),
    peer.endpoint.agent_id,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Create network tag" }),
    ).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Create network tag" }));
  await waitFor(() =>
    expect(mockApi.createAgentNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Planning",
        delivery_mode: "live",
        members: [
          { kind: "registered", endpoint: agent.endpoint },
          { kind: "registered", endpoint: peer.endpoint },
        ],
      }),
    ),
  );
});
