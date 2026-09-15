import React, { useRef } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { serializeAgentMention } from "@cocalc/util/agent-mentions";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";
import { NameAgent } from "./name-agent";
jest.mock("./name-context", () => ({ cachedAgentNameContext: () => ({}) }));
import { useAgentMentions } from "./use-agent-mentions";
import { AgentMessagingRequests } from "./messaging-requests";
import { MyAgentsPage } from "../account/my-agents-page";
import { openAgentThread } from "./open-agent";

jest.mock("./open-agent", () => ({ openAgentThread: jest.fn() }));

let mockAccount = "11111111-1111-4111-8111-111111111111";
let mockMessagingUI = true;
jest.mock("./use-ui-preference", () => ({
  useAgentMessagingUI: () => mockMessagingUI,
}));
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
const mockDirectory = {
  enabled: true,
  agents: [
    namedAgent,
    {
      ...namedAgent,
      name: "builder",
      endpoint: source,
      thread_id: "source",
      path: "/source.chat",
    },
  ],
};
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
  mockMessagingUI = true;
  jest.clearAllMocks();
  jest.mocked(openAgentThread).mockResolvedValue();
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

test("opting out hides naming and approval without changing private draft or permissions", async () => {
  mockMessagingUI = false;
  const user = userEvent.setup();
  const onSend = jest.fn();
  render(
    <>
      <NameAgent
        projectId={source.project_id}
        path="/source.chat"
        threadId="source"
      />
      <Composer onSend={onSend} />
    </>,
  );
  expect(screen.queryByRole("button", { name: "Name agent" })).toBeNull();
  const draft = (
    screen.getByRole("textbox", {
      name: "Private draft",
    }) as HTMLTextAreaElement
  ).value;
  await user.click(screen.getByRole("button", { name: "Select reviewer" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("textbox", { name: "Private draft" })).toHaveValue(
    draft,
  );
  expect(mockApi.resolveIdentity).not.toHaveBeenCalled();
  expect(mockApi.registerIdentity).not.toHaveBeenCalled();
  expect(mockApi.grantPersonalConnection).not.toHaveBeenCalled();
  expect(mockApi.setPersonalMessagingState).not.toHaveBeenCalled();
  expect(mockApi.setPersonalConnectionState).not.toHaveBeenCalled();
});

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

async function saveAgentName() {
  const user = userEvent.setup();
  render(
    <NameAgent
      projectId={source.project_id}
      path="/source.chat"
      threadId="source"
      initiallyOpen
    />,
  );
  await user.type(
    await screen.findByRole("textbox", { name: "Agent name" }),
    "builder",
  );
  await user.click(screen.getByRole("button", { name: "Save agent name" }));
}

test("naming an already registered thread resolves its identity without fresh auth", async () => {
  mockDeferAuth = true;
  await saveAgentName();
  await waitFor(() =>
    expect(mockApi.nameAgent).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: source, name: "builder" }),
    ),
  );
  expect(mockApi.resolveIdentity).toHaveBeenCalledWith({
    project_id: source.project_id,
    path: "/source.chat",
    thread_id: "source",
  });
  expect(mockApi.registerIdentity).not.toHaveBeenCalled();
  expect(mockFreshAction).toBeUndefined();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("new identity registration retains fresh auth before saving name metadata", async () => {
  mockApi.resolveIdentity.mockResolvedValue(undefined);
  mockDeferAuth = true;
  await saveAgentName();
  await waitFor(() => expect(mockFreshAction).toBeDefined());
  expect(mockApi.registerIdentity).not.toHaveBeenCalled();
  expect(mockApi.nameAgent).not.toHaveBeenCalled();
  await act(async () => {
    await mockFreshAction?.();
  });
  expect(mockApi.registerIdentity).toHaveBeenCalledTimes(1);
  expect(mockApi.registerIdentity).toHaveBeenCalledWith({
    project_id: source.project_id,
    path: "/source.chat",
    thread_id: "source",
  });
  expect(mockApi.nameAgent).toHaveBeenCalledWith(
    expect.objectContaining({ endpoint: source, name: "builder" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("canceling fresh auth for new registration preserves the name form without naming", async () => {
  mockApi.resolveIdentity.mockResolvedValue(undefined);
  mockCancelAuth = true;
  await saveAgentName();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Save agent name" }),
    ).toBeEnabled(),
  );
  expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue(
    "builder",
  );
  expect(mockApi.registerIdentity).not.toHaveBeenCalled();
  expect(mockApi.nameAgent).not.toHaveBeenCalled();
});

test.each([source, undefined])(
  "account change during identity lookup prevents registration and naming (%p)",
  async (identity) => {
    let finishLookup!: (identity: unknown) => void;
    mockApi.resolveIdentity.mockReturnValue(
      new Promise((resolve) => {
        finishLookup = resolve;
      }),
    );
    await saveAgentName();
    await waitFor(() => expect(mockApi.resolveIdentity).toHaveBeenCalled());
    mockAccount = "77777777-7777-4777-8777-777777777777";
    await act(async () => {
      finishLookup(identity);
    });
    expect(mockApi.registerIdentity).not.toHaveBeenCalled();
    expect(mockApi.nameAgent).not.toHaveBeenCalled();
    expect(mockFreshAction).toBeUndefined();
  },
);

test("account change while registration fresh auth is pending prevents the registration retry", async () => {
  mockApi.resolveIdentity.mockResolvedValue(undefined);
  mockDeferAuth = true;
  await saveAgentName();
  await waitFor(() => expect(mockFreshAction).toBeDefined());
  mockAccount = "77777777-7777-4777-8777-777777777777";
  await act(async () => {
    await mockFreshAction?.();
  });
  expect(mockApi.registerIdentity).not.toHaveBeenCalled();
  expect(mockApi.nameAgent).not.toHaveBeenCalled();
});

test("account change during registration prevents the subsequent metadata mutation", async () => {
  mockApi.resolveIdentity.mockResolvedValue(undefined);
  let finishRegistration!: (identity: unknown) => void;
  mockApi.registerIdentity.mockReturnValue(
    new Promise((resolve) => {
      finishRegistration = resolve;
    }),
  );
  await saveAgentName();
  await waitFor(() => expect(mockApi.registerIdentity).toHaveBeenCalled());
  mockAccount = "77777777-7777-4777-8777-777777777777";
  await act(async () => {
    finishRegistration(source);
  });
  expect(mockApi.nameAgent).not.toHaveBeenCalled();
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

async function openNamedRequest() {
  mockApi.listPersonalConnectionRequests.mockResolvedValue({
    enabled: true,
    requests: [{ ...request, both_directions: true }],
  });
  const user = userEvent.setup();
  const view = render(<AgentMessagingRequests />);
  const review = await screen.findByRole("button", {
    name: /^Review messaging request:/,
  });
  review.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("Both directions");
  return { user, view, dialog };
}

test("native fresh approval resolves the exact request once without a direct grant or send", async () => {
  mockDeferAuth = true;
  const { user, dialog } = await openNamedRequest();
  const approve = within(dialog).getByRole("button", {
    name: "Approve requested connection",
  });
  approve.focus();
  await user.keyboard("{Enter}{Enter}");
  expect(mockFreshAction).toBeDefined();
  expect(mockApi.resolvePersonalConnectionRequest).not.toHaveBeenCalled();
  expect(mockApi.grantPersonalConnection).not.toHaveBeenCalled();
  mockApi.listPersonalConnectionRequests.mockResolvedValue({
    enabled: true,
    requests: [{ ...request, state: "approved" }],
  });
  await act(async () => {
    await mockFreshAction!();
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mockApi.resolvePersonalConnectionRequest).toHaveBeenCalledTimes(1);
  expect(mockApi.resolvePersonalConnectionRequest).toHaveBeenCalledWith({
    request_id: request.request_id,
    decision: "approve",
  });
  expect(mockApi.grantPersonalConnection).not.toHaveBeenCalled();
  expect(mockApi.nameAgent).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen.queryByRole("button", {
        name: /^Review messaging request:/,
      }),
    ).toBeNull(),
  );
});

test("canceling native request fresh-auth keeps the request reviewable without resolving it", async () => {
  mockCancelAuth = true;
  const { user, dialog } = await openNamedRequest();
  await user.click(
    within(dialog).getByRole("button", {
      name: "Approve requested connection",
    }),
  );
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(mockApi.resolvePersonalConnectionRequest).not.toHaveBeenCalled();
  expect(mockApi.nameAgent).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() =>
    expect(
      screen.getByRole("button", {
        name: /^Review messaging request:/,
      }),
    ).toHaveFocus(),
  );
});

test("native request fresh-auth callback cannot resolve after switching accounts", async () => {
  mockDeferAuth = true;
  const { user, view, dialog } = await openNamedRequest();
  await user.click(
    within(dialog).getByRole("button", {
      name: "Approve requested connection",
    }),
  );
  expect(mockFreshAction).toBeDefined();
  mockAccount = "77777777-7777-4777-8777-777777777777";
  view.rerender(<AgentMessagingRequests />);
  await act(async () => {
    await mockFreshAction!();
  });
  expect(mockApi.resolvePersonalConnectionRequest).not.toHaveBeenCalled();
  expect(mockApi.nameAgent).not.toHaveBeenCalled();
  expect(mockApi.grantPersonalConnection).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("My Agents opens the selected thread in-app using keyboard activation", async () => {
  const user = userEvent.setup();
  render(<MyAgentsPage />);
  const open = screen.getByRole("button", { name: "Open @reviewer" });
  expect(open).not.toHaveAttribute("href");
  expect(openAgentThread).not.toHaveBeenCalled();
  open.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(openAgentThread).toHaveBeenCalledWith({
      project_id: target.project_id,
      path: namedAgent.path,
      thread_id: namedAgent.thread_id,
    }),
  );
  expect(openAgentThread).toHaveBeenCalledTimes(1);
});

test("My Agents keeps navigation failures visible and permits an explicit retry", async () => {
  const user = userEvent.setup();
  jest
    .mocked(openAgentThread)
    .mockRejectedValueOnce(new Error("Project unavailable"));
  render(<MyAgentsPage />);
  const open = screen.getByRole("button", { name: "Open @reviewer" });
  await user.click(open);
  expect(await screen.findByText("Error: Project unavailable")).toBeVisible();
  expect(open).toBeEnabled();
  expect(openAgentThread).toHaveBeenCalledTimes(1);
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

test("My Agents presents a bidirectional pair once with shared keyboard-operable controls", async () => {
  mockApi.listPersonalConnections.mockResolvedValue({
    enabled: true,
    connections: [
      activeConnection,
      {
        ...activeConnection,
        link_id: "reverse",
        source: target,
        target: source,
      },
    ],
  });
  const user = userEvent.setup();
  render(<MyAgentsPage />);
  await user.click(await screen.findByRole("button", { name: /^Details:/ }));
  await screen.findByText("Communication in both directions");
  const groups = screen.getAllByRole("group", { name: /^Connection:/ });
  expect(groups).toHaveLength(1);
  const pause = within(groups[0]).getByRole("button", {
    name: /^Pause connection:/,
  });
  expect(
    within(groups[0]).getAllByRole("button", { name: /^Revoke connection:/ }),
  ).toHaveLength(1);
  pause.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(mockApi.setPersonalConnectionState).toHaveBeenCalledWith({
      direction_group_id: "group",
      state: "paused",
    }),
  );
  expect(mockApi.setPersonalConnectionState).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(pause).toBeEnabled());
  await user.click(
    within(groups[0]).getByRole("button", { name: /^Revoke connection:/ }),
  );
  await waitFor(() =>
    expect(mockApi.setPersonalConnectionState).toHaveBeenLastCalledWith({
      direction_group_id: "group",
      state: "revoked",
    }),
  );
  expect(mockApi.setPersonalConnectionState).toHaveBeenCalledTimes(2);
  await user.click(
    screen.getByRole("button", { name: "Connections for @reviewer" }),
  );
  expect(screen.getByRole("heading", { name: "Connections" })).toHaveFocus();
  expect(screen.getAllByRole("group", { name: /^Connection:/ })).toHaveLength(
    1,
  );
});

test("My Agents collapses old approvals without hiding another current grant", async () => {
  mockApi.listPersonalConnections.mockResolvedValue({
    enabled: true,
    connections: [
      activeConnection,
      {
        ...activeConnection,
        link_id: "old",
        direction_group_id: "old-group",
        status: "expired",
        created_at: "2026-09-01T00:00:00Z",
        reason: "Previous test approval",
      },
    ],
  });
  const user = userEvent.setup();
  render(<MyAgentsPage />);
  const details = await screen.findByRole("button", { name: /^Details:/ });
  expect(details).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByRole("button", { name: /^Pause connection:/ }),
  ).toBeNull();
  details.focus();
  await user.keyboard("{Enter}");
  expect(details).toHaveAttribute("aria-expanded", "true");
  const summary = await screen.findByText("Earlier approvals (1)");
  const history = summary.closest("details")!;
  expect(history).not.toHaveAttribute("open");
  expect(screen.getAllByRole("group", { name: /^Connection:/ })).toHaveLength(
    1,
  );
  expect(
    screen.getAllByRole("button", { name: /^Pause connection:/ }),
  ).toHaveLength(1);
  expect(mockApi.setPersonalConnectionState).not.toHaveBeenCalled();
  await user.click(summary);
  expect(history).toHaveAttribute("open");
  expect(
    within(history).getByText("Reason: Previous test approval"),
  ).toBeVisible();
  expect(within(history).queryByRole("button")).toBeNull();
  expect(mockApi.setPersonalConnectionState).not.toHaveBeenCalled();
  details.focus();
  await user.keyboard("{Enter}");
  expect(details).toHaveAttribute("aria-expanded", "false");
  expect(details).toHaveFocus();
  expect(
    screen.queryByRole("button", { name: /^Pause connection:/ }),
  ).toBeNull();
});

test("one table row retains separate controls for overlapping current approvals", async () => {
  mockApi.listPersonalConnections.mockResolvedValue({
    enabled: true,
    connections: [
      activeConnection,
      {
        ...activeConnection,
        link_id: "other-link",
        direction_group_id: "other-group",
      },
    ],
  });
  const user = userEvent.setup();
  render(<MyAgentsPage />);
  const details = await screen.findByRole("button", { name: /^Details:/ });
  expect(screen.getAllByRole("button", { name: /^Details:/ })).toHaveLength(1);
  expect(screen.getAllByRole("row")).toHaveLength(2);
  await user.click(details);
  const pauses = screen.getAllByRole("button", { name: /^Pause connection:/ });
  expect(pauses).toHaveLength(2);
  await user.click(pauses[0]);
  await waitFor(() =>
    expect(mockApi.setPersonalConnectionState).toHaveBeenCalledTimes(1),
  );
  expect(mockApi.setPersonalConnectionState).toHaveBeenCalledWith({
    direction_group_id: "group",
    state: "paused",
  });
});

test("bidirectional renewal offers one approval preserving both directions", async () => {
  mockApi.listPersonalConnections.mockResolvedValue({
    enabled: true,
    connections: [
      { ...activeConnection, status: "expired" },
      {
        ...activeConnection,
        status: "expired",
        link_id: "reverse",
        source: target,
        target: source,
      },
    ],
  });
  const user = userEvent.setup();
  render(<MyAgentsPage />);
  await user.click(await screen.findByRole("button", { name: /^Details:/ }));
  await user.click(
    await screen.findByRole("button", { name: "Renew connection" }),
  );
  expect(
    screen.getByRole("checkbox", {
      name: "Allow communication in both directions",
    }),
  ).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Approve connection" }));
  await waitFor(() =>
    expect(mockApi.grantPersonalConnection).toHaveBeenCalledWith(
      expect.objectContaining({ source, target, both_directions: true }),
    ),
  );
  expect(mockApi.grantPersonalConnection).toHaveBeenCalledTimes(1);
});

test("pair observations use latest valid timestamps and mixed states stay explicit", async () => {
  const latest = "2026-09-14T12:00:00Z";
  mockApi.listPersonalConnections.mockResolvedValue({
    enabled: true,
    connections: [
      {
        ...activeConnection,
        last_attempt_at: "2026-09-13T12:00:00Z",
        last_accepted_at: "invalid",
      },
      {
        ...activeConnection,
        link_id: "reverse",
        source: target,
        target: source,
        status: "paused",
        paused: true,
        last_attempt_at: latest,
        last_accepted_at: null,
      },
    ],
  });
  const user = userEvent.setup();
  render(<MyAgentsPage />);
  await user.click(await screen.findByRole("button", { name: /^Details:/ }));
  await screen.findByText(/Status: active \/ paused \(varies by direction\)/);
  expect(
    screen.getByText(
      `Last observed attempt (either direction): ${new Date(latest).toLocaleString()}`,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText("Last observed acceptance (either direction): Unknown"),
  ).toBeTruthy();
  expect(screen.queryByText(/Invalid Date/)).toBeNull();
});
