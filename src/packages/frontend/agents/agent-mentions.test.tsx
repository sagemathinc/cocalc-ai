import React, { useRef } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { serializeAgentMention } from "@cocalc/util/agent-mentions";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";
import { NameAgent } from "./name-agent";
import { useAgentMentions } from "./use-agent-mentions";
import { AgentMessagingRequests } from "./messaging-requests";
import { MyAgentsPage } from "../account/my-agents-page";

let mockAccount = "11111111-1111-4111-8111-111111111111";
let mockFreshAction: (() => Promise<void>) | undefined;
let mockDeferAuth = false;
let mockCancelAuth = false;
const source = {
  project_id: "22222222-2222-4222-8222-222222222222",
  agent_id: "33333333-3333-4333-8333-333333333333",
};
const target = {
  project_id: "44444444-4444-4444-8444-444444444444",
  agent_id: "55555555-5555-4555-8555-555555555555",
};
const reference: AgentMentionReference = {
  version: 1,
  naming_account_id: mockAccount,
  target,
  name: "reviewer",
};
const namedAgent = {
  account_id: mockAccount,
  name: "reviewer",
  endpoint: target,
  path: "/review.chat",
  thread_id: "review",
  available: true,
  updated_at: "2026-09-14T00:00:00Z",
  project_title: "Review project",
  thread_title: "Code review",
};
const mockDirectory = { enabled: true, agents: [namedAgent] };
const activeConnection = {
  source,
  target,
  status: "active",
  expires_at: null,
  paused: false,
  link_id: "link",
  direction_group_id: "group",
};
const request = {
  account_id: mockAccount,
  request_id: "request-1",
  run_id: "run-1",
  source,
  target,
  reason: "Review the change",
  state: "pending",
  expires_at: "2099-01-01T00:00:00Z",
  ttl_seconds: 86400,
};
const mockApi = {
  resolveIdentity: jest.fn(),
  getIdentity: jest.fn(),
  registerIdentity: jest.fn(),
  nameAgent: jest.fn(),
  listPersonalConnections: jest.fn(),
  grantPersonalConnection: jest.fn(),
  listPersonalConnectionRequests: jest.fn(),
  resolvePersonalConnectionRequest: jest.fn(),
  setPersonalMessagingState: jest.fn(),
  setPersonalConnectionState: jest.fn(),
};
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => mockAccount,
  redux: {
    getStore: () => ({ get: () => mockAccount }),
    getActions: () => ({ set_active_key_handler: jest.fn() }),
  },
}));
jest.mock("./api", () => ({
  personalAgentApi: () => mockApi,
  refreshNamedAgents: jest.fn(),
  sameEndpoint: (a, b) =>
    a.project_id === b.project_id && a.agent_id === b.agent_id,
  useNamedAgents: () => ({ directory: mockDirectory, loading: false }),
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction: async (fn) => {
      if (mockCancelAuth) return false;
      if (mockDeferAuth)
        return await new Promise<boolean>((resolve, reject) => {
          mockFreshAction = async () => {
            try {
              await fn();
              resolve(true);
            } catch (err) {
              reject(err);
            }
          };
        });
      await fn();
      return true;
    },
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockAccount = reference.naming_account_id;
  mockDeferAuth = false;
  mockCancelAuth = false;
  mockFreshAction = undefined;
  mockApi.resolveIdentity.mockResolvedValue({
    ...source,
    path: "/source.chat",
    thread_id: "source",
  });
  mockApi.getIdentity.mockResolvedValue({
    ...target,
    path: "/review.chat",
    thread_id: "review",
  });
  mockApi.registerIdentity.mockResolvedValue(source);
  mockApi.listPersonalConnections.mockResolvedValue({
    enabled: true,
    connections: [],
  });
  mockApi.listPersonalConnectionRequests.mockResolvedValue({
    enabled: true,
    requests: [],
  });
  mockApi.grantPersonalConnection.mockImplementation(async () => {
    mockApi.listPersonalConnections.mockResolvedValue({
      enabled: true,
      connections: [activeConnection],
    });
    return [activeConnection];
  });
});

function Composer({
  onSend,
  mention = reference,
}: {
  onSend: () => void;
  mention?: AgentMentionReference;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const draft = `Private draft: contact ${serializeAgentMention(mention)} when done.`;
  const flow = useAgentMentions({
    projectId: source.project_id,
    path: "/source.chat",
    threadId: "source",
    runnable: true,
    restoreFocus: () => input.current?.focus(),
  });
  return (
    <>
      <textarea aria-label="Private draft" ref={input} value={draft} readOnly />
      <button onClick={() => flow.context.onSelect(mention)}>
        Select reviewer
      </button>
      <button onClick={() => void flow.preflight(draft, onSend)}>Send</button>
      {flow.ui}
    </>
  );
}

test("Name agent opens by keyboard and Escape restores focus without registration", async () => {
  const user = userEvent.setup();
  render(
    <NameAgent
      projectId={source.project_id}
      path="/source.chat"
      threadId="source"
    />,
  );
  await user.tab();
  const trigger = screen.getByRole("button", { name: "Name agent" });
  expect(trigger).toHaveFocus();
  await user.keyboard("{Enter}");
  const name = await screen.findByRole("textbox", { name: "Agent name" });
  expect(
    screen.getByRole("textbox", { name: "Description (optional)" }),
  ).toHaveAttribute("maxLength", "500");
  name.focus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(mockApi.registerIdentity).not.toHaveBeenCalled();
});

test("canceling selection approval preserves bound draft and restores editor focus", async () => {
  const user = userEvent.setup();
  const send = jest.fn();
  render(<Composer onSend={send} />);
  const before = (
    screen.getByRole("textbox", {
      name: "Private draft",
    }) as HTMLTextAreaElement
  ).value;
  screen.getByRole("button", { name: "Select reviewer" }).focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: "Approve agent communication" });
  expect(
    screen.getByRole("checkbox", {
      name: "Allow communication in both directions",
    }),
  ).not.toBeChecked();
  screen.getByRole("combobox", { name: "Connection duration" }).focus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const input = screen.getByRole("textbox", { name: "Private draft" });
  await waitFor(() => expect(input).toHaveFocus());
  expect(input).toHaveValue(before);
  expect(send).not.toHaveBeenCalled();
  expect(mockApi.grantPersonalConnection).not.toHaveBeenCalled();
});

test("Send preflight approves once and submits exactly once despite repeated Send", async () => {
  const user = userEvent.setup();
  const send = jest.fn();
  render(<Composer onSend={send} />);
  await user.dblClick(screen.getByRole("button", { name: "Send" }));
  await screen.findByRole("dialog");
  await user.click(screen.getByRole("button", { name: "Approve connection" }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(mockApi.grantPersonalConnection).toHaveBeenCalledTimes(1);
  expect(mockApi.grantPersonalConnection).toHaveBeenCalledWith(
    expect.objectContaining({
      source,
      target,
      ttl_seconds: 86400,
      both_directions: false,
    }),
  );
});

test("fresh-auth cancellation does not send or erase draft", async () => {
  mockCancelAuth = true;
  const user = userEvent.setup();
  const send = jest.fn();
  render(<Composer onSend={send} />);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByRole("dialog");
  await user.click(screen.getByRole("button", { name: "Approve connection" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(send).not.toHaveBeenCalled();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain(
    "Private draft",
  );
});

test("paused communication never triggers a renewal dialog", async () => {
  mockApi.listPersonalConnections.mockResolvedValue({
    enabled: true,
    controls: { paused: true },
    connections: [],
  });
  const user = userEvent.setup();
  const send = jest.fn();
  render(<Composer onSend={send} />);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText(/Your agent communication is paused/);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

test("foreign naming context retains endpoint and asks this human for their own grant", async () => {
  const foreign = {
    ...reference,
    naming_account_id: "66666666-6666-4666-8666-666666666666",
  };
  const user = userEvent.setup();
  render(<Composer onSend={jest.fn()} mention={foreign} />);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText(
    new RegExp(`originally named by ${foreign.naming_account_id}`),
  );
  expect(mockApi.getIdentity).toHaveBeenCalledWith(target);
});

test("account switch during fresh-auth cannot grant for the next human", async () => {
  mockDeferAuth = true;
  const user = userEvent.setup();
  const send = jest.fn();
  const view = render(<Composer onSend={send} />);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByRole("dialog");
  await user.click(screen.getByRole("button", { name: "Approve connection" }));
  await waitFor(() => expect(mockFreshAction).toBeDefined());
  mockAccount = "77777777-7777-4777-8777-777777777777";
  view.rerender(<Composer onSend={send} />);
  await act(async () => {
    await mockFreshAction?.();
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mockApi.grantPersonalConnection).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test("typed current-chat requests are account isolated and never send on view", async () => {
  mockApi.listPersonalConnectionRequests.mockResolvedValue({
    enabled: true,
    requests: [request],
  });
  const user = userEvent.setup();
  const view = render(
    <AgentMessagingRequests
      projectId={source.project_id}
      path="/source.chat"
      threadId="source"
    />,
  );
  const review = await screen.findByRole("button", {
    name: /Review messaging request/,
  });
  review.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog");
  expect(mockApi.resolvePersonalConnectionRequest).not.toHaveBeenCalled();
  mockAccount = "77777777-7777-4777-8777-777777777777";
  view.rerender(
    <AgentMessagingRequests
      projectId={source.project_id}
      path="/source.chat"
      threadId="source"
    />,
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    screen.queryByRole("button", { name: /Review messaging request/ }),
  ).toBeNull();
});

test("disabled messaging requests never inspect a project identity", async () => {
  mockApi.listPersonalConnectionRequests.mockResolvedValue({
    enabled: false,
    requests: [],
  });
  render(
    <AgentMessagingRequests
      projectId={source.project_id}
      path="/source.chat"
      threadId="source"
    />,
  );
  await waitFor(() =>
    expect(mockApi.listPersonalConnectionRequests).toHaveBeenCalled(),
  );
  expect(mockApi.resolveIdentity).not.toHaveBeenCalled();
});

test("My Agents drops old connections and destructive dialog on account switch", async () => {
  mockApi.listPersonalConnections.mockResolvedValue({
    enabled: true,
    connections: [activeConnection],
  });
  const user = userEvent.setup();
  const view = render(<MyAgentsPage />);
  await screen.findByText(/Status: active/);
  await user.click(
    screen.getByRole("button", { name: "Revoke all connections" }),
  );
  await screen.findByRole("dialog");
  mockAccount = "77777777-7777-4777-8777-777777777777";
  mockApi.listPersonalConnections.mockResolvedValue({
    enabled: true,
    connections: [],
  });
  view.rerender(<MyAgentsPage />);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByText(/Status: active/)).toBeNull();
  expect(mockApi.setPersonalMessagingState).not.toHaveBeenCalled();
});
