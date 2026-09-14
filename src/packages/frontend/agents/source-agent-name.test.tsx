import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionApproval } from "./connection-approval";
import { NameAgent } from "./name-agent";
import { AgentMessagingRequests } from "./messaging-requests";
import { agentNameProblem } from "./agent-name-input";
import type { NamedAgent } from "@cocalc/conat/agents/personal";

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
  grantPersonalConnection: jest.fn(),
  listPersonalConnectionRequests: jest.fn(),
  resolvePersonalConnectionRequest: jest.fn(),
};
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "11111111-1111-4111-8111-111111111111",
  redux: {
    getStore: () => ({ get: () => "11111111-1111-4111-8111-111111111111" }),
    getActions: () => ({ set_active_key_handler: jest.fn() }),
  },
}));
jest.mock("./api", () => ({
  personalAgentApi: () => mockApi,
  refreshNamedAgents: jest.fn(),
  sameEndpoint: (a, b) =>
    a.project_id === b.project_id && a.agent_id === b.agent_id,
  useNamedAgents: () => ({
    directory: { enabled: true, agents: mockAgents },
    loading: false,
  }),
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction: async (fn) => {
      await fn();
      return true;
    },
  }),
}));
beforeEach(() => {
  jest.resetAllMocks();
  mockAgents = [reviewer];
  mockApi.nameAgent.mockImplementation(async ({ name, endpoint }) => ({
    ...reviewer,
    name,
    endpoint,
  }));
  mockApi.grantPersonalConnection.mockResolvedValue([]);
  mockApi.listPersonalConnectionRequests.mockResolvedValue({
    enabled: true,
    requests: [],
  });
});
const approval = {
  source,
  target,
  sourceLabel: "This agent",
  targetLabel: "@reviewer",
};

test("unnamed source requires a valid unused name with immediate feedback before approval", async () => {
  const user = userEvent.setup();
  render(<ConnectionApproval value={approval} onClose={jest.fn()} />);
  const approve = screen.getByRole("button", { name: "Approve connection" });
  expect(approve).toBeDisabled();
  const input = screen.getByRole("textbox", { name: "Source agent name" });
  await user.type(input, "reviewer");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("status")).toHaveTextContent("already used");
  expect(approve).toBeDisabled();
  expect(mockApi.nameAgent).not.toHaveBeenCalled();
  await user.clear(input);
  await user.type(input, "builder");
  expect(approve).toBeEnabled();
  await user.click(
    screen.getByRole("checkbox", {
      name: "Allow communication in both directions",
    }),
  );
  await user.click(approve);
  await waitFor(() =>
    expect(mockApi.grantPersonalConnection).toHaveBeenCalled(),
  );
  expect(mockApi.nameAgent).toHaveBeenCalledWith({
    endpoint: source,
    name: "builder",
  });
  expect(mockApi.nameAgent.mock.invocationCallOrder[0]).toBeLessThan(
    mockApi.grantPersonalConnection.mock.invocationCallOrder[0],
  );
  expect(mockApi.grantPersonalConnection).toHaveBeenCalledWith(
    expect.objectContaining({
      source,
      target,
      both_directions: true,
      ttl_seconds: 86400,
    }),
  );
});

test("server-side name conflict prevents the grant and retains the user's name", async () => {
  mockApi.nameAgent.mockRejectedValue(new Error("name already taken"));
  const user = userEvent.setup();
  render(<ConnectionApproval value={approval} onClose={jest.fn()} />);
  const input = screen.getByRole("textbox", { name: "Source agent name" });
  await user.type(input, "builder");
  await user.click(screen.getByRole("button", { name: "Approve connection" }));
  expect(await screen.findByText("Error: name already taken")).toBeVisible();
  expect(input).toHaveValue("builder");
  expect(mockApi.grantPersonalConnection).not.toHaveBeenCalled();
});

test("canceling does not name the source or create permission", async () => {
  const close = jest.fn();
  const user = userEvent.setup();
  render(<ConnectionApproval value={approval} onClose={close} />);
  await user.type(
    screen.getByRole("textbox", { name: "Source agent name" }),
    "builder",
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledWith(false);
  expect(mockApi.nameAgent).not.toHaveBeenCalled();
  expect(mockApi.grantPersonalConnection).not.toHaveBeenCalled();
});

test("an already named source needs no extra naming step", async () => {
  mockAgents.push({ ...reviewer, name: "builder", endpoint: source });
  const user = userEvent.setup();
  render(<ConnectionApproval value={approval} onClose={jest.fn()} />);
  expect(
    screen.queryByRole("textbox", { name: "Source agent name" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Approve connection" }));
  await waitFor(() =>
    expect(mockApi.grantPersonalConnection).toHaveBeenCalledTimes(1),
  );
  expect(mockApi.nameAgent).not.toHaveBeenCalled();
});

test("rename dialog checks other current names without submitting", async () => {
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
  expect(screen.getByRole("button", { name: "Save agent name" })).toBeEnabled();
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
  await user.keyboard("{Enter}");
  expect(mockApi.nameAgent).not.toHaveBeenCalled();
});

async function openUnnamedRequest(keyboard = false) {
  mockApi.listPersonalConnectionRequests.mockResolvedValue({
    enabled: true,
    requests: [
      {
        source,
        target,
        account_id: account,
        request_id: "request",
        run_id: "run",
        reason: "Review",
        state: "pending",
        expires_at: "2099-01-01T00:00:00Z",
        ttl_seconds: 3600,
      },
    ],
  });
  const user = userEvent.setup();
  render(<AgentMessagingRequests />);
  const review = await screen.findByRole("button", {
    name: /^Review messaging request:/,
  });
  if (keyboard) {
    await user.tab();
    expect(review).toHaveFocus();
    await user.keyboard("{Enter}");
  } else await user.click(review);
  expect(
    screen.getByRole("button", { name: "Approve requested connection" }),
  ).toBeDisabled();
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Source agent name" }),
    ).toBeVisible(),
  );
  return user;
}

test("request review uses a compact button with full accessible context and keyboard focus return", async () => {
  const user = await openUnnamedRequest(true);
  const review = screen.getByRole("button", {
    name: /^Review messaging request:/,
  });
  expect(review).toHaveTextContent(/^Review messaging request$/);
  expect(review).toHaveAccessibleName(expect.stringContaining("@reviewer"));
  expect(review).toHaveAccessibleName(expect.stringContaining(source.agent_id));
  expect(review).toHaveStyle({ maxWidth: "100%", whiteSpace: "normal" });
  expect(
    screen.getByRole("region", { name: "Agent messaging approvals" }),
  ).toHaveStyle({ overflowWrap: "anywhere" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(review).toHaveFocus());
  expect(mockApi.resolvePersonalConnectionRequest).not.toHaveBeenCalled();
});

test("typed in-turn request requires a source name to approve but can still be denied", async () => {
  const user = await openUnnamedRequest();
  await user.click(screen.getByRole("button", { name: "Deny request" }));
  await waitFor(() =>
    expect(mockApi.resolvePersonalConnectionRequest).toHaveBeenCalledWith({
      request_id: "request",
      decision: "deny",
    }),
  );
  expect(mockApi.nameAgent).not.toHaveBeenCalled();
});

test("typed request names the source before approving its exact request", async () => {
  const user = await openUnnamedRequest();
  await user.type(
    screen.getByRole("textbox", { name: "Source agent name" }),
    "builder",
  );
  await user.click(
    screen.getByRole("button", { name: "Approve requested connection" }),
  );
  await waitFor(() =>
    expect(mockApi.resolvePersonalConnectionRequest).toHaveBeenCalledWith({
      request_id: "request",
      decision: "approve",
    }),
  );
  expect(mockApi.nameAgent).toHaveBeenCalledWith({
    endpoint: source,
    name: "builder",
  });
  expect(mockApi.nameAgent.mock.invocationCallOrder[0]).toBeLessThan(
    mockApi.resolvePersonalConnectionRequest.mock.invocationCallOrder[0],
  );
});

test("typed request shows a naming failure inside its modal and never grants", async () => {
  const intervals = jest.spyOn(global, "setInterval");
  const user = await openUnnamedRequest();
  mockApi.nameAgent.mockRejectedValue(new Error("name already taken"));
  await user.type(
    screen.getByRole("textbox", { name: "Source agent name" }),
    "builder",
  );
  await user.click(
    screen.getByRole("button", { name: "Approve requested connection" }),
  );
  expect(await screen.findByText("Error: name already taken")).toBeVisible();
  expect(mockApi.resolvePersonalConnectionRequest).not.toHaveBeenCalled();
  const refresh = intervals.mock.calls.find(([, ms]) => ms === 15000)?.[0];
  expect(typeof refresh).toBe("function");
  await act(async () => {
    (refresh as () => void)();
  });
  expect(screen.getByText("Error: name already taken")).toBeVisible();
  expect(
    screen.getByRole("textbox", { name: "Source agent name" }),
  ).toHaveValue("builder");
  expect(mockApi.nameAgent).toHaveBeenCalledTimes(1);
  expect(mockApi.resolvePersonalConnectionRequest).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Later" }));
  await user.click(
    screen.getByRole("button", { name: /^Review messaging request:/ }),
  );
  expect(screen.queryByText("Error: name already taken")).toBeNull();
  intervals.mockRestore();
});

test("validation normalizes names, permits the same endpoint, and checks syntax", () => {
  expect(agentNameProblem(" REVIEWER ", [reviewer], target)).toBeUndefined();
  expect(agentNameProblem("reviewer", [reviewer], source)).toMatch(
    /already used/,
  );
  expect(agentNameProblem("-bad", [reviewer])).toBeTruthy();
  expect(agentNameProblem("", [reviewer])).toBeTruthy();
});
