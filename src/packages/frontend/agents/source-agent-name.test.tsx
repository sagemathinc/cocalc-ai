import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { NameAgent } from "./name-agent";
import { NetworkApproval } from "./network-approval";
import { cachedAgentNameContext } from "./name-context";

jest.mock("./name-context", () => ({ cachedAgentNameContext: jest.fn() }));

const account = "11111111-1111-4111-8111-111111111111";
const source = {
  project_id: "22222222-2222-4222-8222-222222222222",
  agent_id: "33333333-3333-4333-8333-333333333333",
};
const target = {
  project_id: "44444444-4444-4444-8444-444444444444",
  agent_id: "55555555-5555-4555-8555-555555555555",
};
const reviewer = {
  name: "reviewer",
  endpoint: target,
  account_id: account,
  path: "/review.chat",
  thread_id: "review",
  available: true,
  updated_at: "2026-09-14T00:00:00Z",
} as NamedAgent;

let mockAgents: NamedAgent[];
const mockApi = {
  nameAgent: jest.fn(),
  getIdentity: jest.fn(),
  listAgentNetworks: jest.fn(),
  createAgentNetwork: jest.fn(),
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

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => account,
  redux: {
    getStore: () => ({ get: () => account }),
    getActions: () => ({ set_active_key_handler: jest.fn() }),
  },
}));
jest.mock("./api", () => ({
  personalAgentApi: () => mockApi,
  refreshNamedAgents: jest.fn(),
  refreshAgentNetworks: jest.fn(),
  sameEndpoint: (a, b) =>
    a.project_id === b.project_id && a.agent_id === b.agent_id,
  useNamedAgents: () => ({
    directory: { enabled: true, agents: mockAgents },
    loading: false,
  }),
}));

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(cachedAgentNameContext).mockReturnValue({});
  mockAgents = [reviewer];
  mockApi.getIdentity.mockResolvedValue({
    ...source,
    path: "/a.chat",
    thread_id: "a",
  });
  mockApi.nameAgent.mockImplementation(async ({ name, endpoint }) => ({
    ...reviewer,
    name,
    endpoint,
  }));
  mockApi.createAgentNetwork.mockResolvedValue({});
  mockApi.updateAgentNetwork.mockResolvedValue({});
  mockApi.listAgentNetworks.mockResolvedValue({
    enabled: true,
    controls: { paused: false, generation: 0 },
    usage: { active_networks: 0, network_limit: 100, member_limit: 8 },
    networks: [],
  });
  mockRunFreshAuthAction.mockImplementation(async (action) => {
    await action();
    return true;
  });
});

test("an unnamed source is named before its two-way network is created", async () => {
  const user = userEvent.setup();
  render(
    <NetworkApproval
      value={{
        source,
        target,
        sourceLabel: "This agent",
        targetLabel: "@reviewer",
        targetName: reviewer,
      }}
      onClose={jest.fn()}
    />,
  );
  const create = await screen.findByRole("button", { name: "Create network" });
  expect(create).toBeDisabled();
  const input = screen.getByRole("textbox", { name: "Source agent name" });
  await user.type(input, "reviewer");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(create).toBeDisabled();
  await user.clear(input);
  await user.type(input, "builder");
  await user.type(
    screen.getByRole("textbox", { name: "Network topic" }),
    "Review work",
  );
  await user.click(create);
  await waitFor(() => expect(mockApi.createAgentNetwork).toHaveBeenCalled());
  expect(mockApi.nameAgent).toHaveBeenCalledWith({
    endpoint: source,
    name: "builder",
  });
  expect(mockApi.nameAgent.mock.invocationCallOrder[0]).toBeLessThan(
    mockApi.createAgentNetwork.mock.invocationCallOrder[0],
  );
  expect(mockApi.createAgentNetwork).toHaveBeenCalledWith({
    request_id: expect.any(String),
    title: "Review work",
    delivery_mode: "queued",
    members: [
      { kind: "registered", endpoint: source },
      { kind: "registered", endpoint: target },
    ],
  });
});

test("network creation preserves cached source context while naming", async () => {
  jest.mocked(cachedAgentNameContext).mockReturnValue({
    project_title: "Build project",
    thread_title: "Current draft thread",
  });
  const user = userEvent.setup();
  render(
    <NetworkApproval
      value={{
        source,
        target,
        sourceLabel: "This agent",
        targetLabel: "@reviewer",
        targetName: reviewer,
        sourceContext: {
          project_id: source.project_id,
          path: "/a.chat",
          thread_id: "a",
          thread_title: "Current draft thread",
        },
      }}
      onClose={jest.fn()}
    />,
  );
  expect(
    screen.getByText(/Current draft thread \/ Build project/),
  ).toBeInTheDocument();
  await user.type(
    screen.getByRole("textbox", { name: "Source agent name" }),
    "builder",
  );
  await user.type(
    screen.getByRole("textbox", { name: "Network topic" }),
    "Build review",
  );
  await user.click(screen.getByRole("button", { name: "Create network" }));
  await waitFor(() => expect(mockApi.createAgentNetwork).toHaveBeenCalled());
  expect(mockApi.getIdentity).not.toHaveBeenCalled();
  expect(mockApi.nameAgent).toHaveBeenCalledWith({
    endpoint: source,
    name: "builder",
    thread_title: "Current draft thread",
    project_title: "Build project",
  });
});

test("an already named source creates a network without renaming", async () => {
  mockAgents.push({ ...reviewer, name: "builder", endpoint: source });
  const user = userEvent.setup();
  render(
    <NetworkApproval
      value={{
        source,
        target,
        sourceLabel: "@builder",
        targetLabel: "@reviewer",
        targetName: reviewer,
      }}
      onClose={jest.fn()}
    />,
  );
  expect(
    screen.queryByRole("textbox", { name: "Source agent name" }),
  ).toBeNull();
  await user.type(
    await screen.findByRole("textbox", { name: "Network topic" }),
    "Review work",
  );
  await user.click(screen.getByRole("button", { name: "Create network" }));
  await waitFor(() =>
    expect(mockApi.createAgentNetwork).toHaveBeenCalledTimes(1),
  );
  expect(mockApi.nameAgent).not.toHaveBeenCalled();
  expect(mockRunFreshAuthAction).toHaveBeenCalledTimes(1);
});

test("an agent joins a target's existing topic network", async () => {
  const builder = { ...reviewer, name: "builder", endpoint: source };
  const illustrator = {
    ...reviewer,
    name: "illustrator",
    endpoint: {
      project_id: target.project_id,
      agent_id: "66666666-6666-4666-8666-666666666666",
    },
  };
  mockAgents.push(builder, illustrator);
  mockApi.listAgentNetworks.mockResolvedValue({
    enabled: true,
    controls: { paused: false, generation: 0 },
    usage: { active_networks: 1, network_limit: 100, member_limit: 8 },
    networks: [
      {
        agent_network_id: "77777777-7777-4777-8777-777777777777",
        account_id: account,
        title: "Illustration work",
        state: "active",
        delivery_mode: "queued",
        generation: "3",
        created_by: account,
        created_at: "2026-09-19T00:00:00Z",
        updated_at: "2026-09-19T00:00:00Z",
        members: [
          {
            kind: "registered",
            member_id: "member-reviewer",
            endpoint: target,
            name: "reviewer",
            available: true,
            added_at: "2026-09-19T00:00:00Z",
          },
          {
            kind: "registered",
            member_id: "member-illustrator",
            endpoint: illustrator.endpoint,
            name: "illustrator",
            available: true,
            added_at: "2026-09-19T00:00:00Z",
          },
        ],
      },
    ],
  });
  const user = userEvent.setup();
  render(
    <NetworkApproval
      value={{
        source,
        target,
        sourceLabel: "@builder",
        targetLabel: "@reviewer",
        targetName: reviewer,
      }}
      onClose={jest.fn()}
    />,
  );

  expect(
    (await screen.findAllByText("Illustration work")).length,
  ).toBeGreaterThan(0);
  expect(screen.getByText("@illustrator")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Join network" }));

  await waitFor(() =>
    expect(mockApi.updateAgentNetwork).toHaveBeenCalledWith({
      request_id: expect.any(String),
      agent_network_id: "77777777-7777-4777-8777-777777777777",
      action: "add-member",
      member: { kind: "registered", endpoint: source },
    }),
  );
  expect(mockApi.createAgentNetwork).not.toHaveBeenCalled();
});

test("rename dialog checks current names without submitting", async () => {
  const builder = { ...reviewer, name: "builder", endpoint: source };
  mockAgents.push(builder);
  const user = userEvent.setup();
  render(
    <NameAgent
      agent={builder}
      projectId={source.project_id}
      path="/a.chat"
      threadId="a"
      initiallyOpen
    />,
  );
  const input = screen.getByRole("textbox", { name: "Agent name" });
  await user.clear(input);
  await user.type(input, "REVIEWER");
  expect(
    screen.getByRole("button", { name: "Save agent name" }),
  ).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "@reviewer is already used",
  );
  expect(mockApi.nameAgent).not.toHaveBeenCalled();
});
