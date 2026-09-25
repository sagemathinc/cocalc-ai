/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createRemoteHeadlessChatClient,
  type ChatSnapshot,
  type HeadlessChatClient,
} from "@cocalc/chat-client";
import { AgentList, Chat, SafeMessageContent } from "./chat-surface";

jest.mock("@cocalc/chat-client", () => ({
  AgentSessionIndex: class {
    subscribe() {
      return () => undefined;
    }
    async open() {}
    close() {}
  },
  createRemoteHeadlessChatClient: jest.fn(),
}));

const snapshot: ChatSnapshot = {
  connection: "connected",
  messages: [
    {
      content: "Finished the requested step.",
      date: "2026-08-15T00:00:00.000Z",
      generating: false,
      message_id: "message-1",
      role: "agent",
      sender_id: "codex",
      state: "complete",
      thread_id: "thread-1",
    },
  ],
  path: "/home/user/work.chat",
  project_id: "11111111-1111-4111-8111-111111111111",
  ready: true,
  revision: 1,
  selected_thread_id: "thread-1",
  threads: [
    {
      acp_config: {} as any,
      agent_kind: "acp",
      name: "Research",
      state: "idle",
      thread_id: "thread-1",
    },
  ],
};

function mockClient(value: ChatSnapshot = snapshot): HeadlessChatClient {
  const client = {
    close: jest.fn(async () => undefined),
    createCodexThread: jest.fn(async ({ thread_id }) => ({ thread_id })),
    getSnapshot: jest.fn(() => value),
    interrupt: jest.fn(async () => undefined),
    loadOlderMessages: jest.fn(async () => undefined),
    open: jest.fn(async () => undefined),
    reconnect: jest.fn(async () => undefined),
    selectThread: jest.fn(),
    sendToExistingCodexThread: jest.fn(async () => ({
      message_id: "message-2",
      thread_id: "thread-1",
    })),
    sendGuidanceToCodexThread: jest.fn(async () => ({
      message_id: "guidance-1",
      thread_id: "thread-1",
    })),
    updateCodexThreadConfig: jest.fn(async () => undefined),
    subscribe: jest.fn((listener: (value: ChatSnapshot) => void) => {
      listener(value);
      return () => undefined;
    }),
  };
  (createRemoteHeadlessChatClient as jest.Mock).mockReturnValue(client);
  return client;
}

afterEach(() => jest.clearAllMocks());

test("creates a new Essential Codex thread through the project-host service", async () => {
  const client = mockClient();
  window.history.replaceState(
    {},
    "",
    `/essential/projects/${snapshot.project_id}/codex`,
  );
  const session = {
    accountId: "22222222-2222-4222-8222-222222222222",
    openProjectHost: jest.fn(async () => ({ client: {} })),
  };
  render(
    <AgentList
      project={
        {
          host_id: "host-1",
          project_id: snapshot.project_id,
          title: "Test",
        } as any
      }
      session={session as any}
    />,
  );

  fireEvent.click(
    await screen.findByRole("button", { name: "New Codex chat" }),
  );
  await waitFor(() => expect(client.createCodexThread).toHaveBeenCalled());
  expect(client.createCodexThread).toHaveBeenCalledWith(
    expect.objectContaining({
      acp_config: expect.objectContaining({
        paymentSource: "auto",
        sessionMode: "workspace-write",
        workingDirectory: "/home/user",
      }),
      name: "Codex chat",
      thread_id: expect.any(String),
    }),
  );
  expect(createRemoteHeadlessChatClient).toHaveBeenCalledWith(
    expect.objectContaining({
      path: expect.stringMatching(/^\/home\/user\/.*\.chat$/),
      project_id: snapshot.project_id,
    }),
  );
  await waitFor(() =>
    expect(window.location.pathname).toContain(
      `/essential/projects/${snapshot.project_id}/codex/chat`,
    ),
  );
});

test("renders approval links as safe visible links in their chat context", () => {
  render(
    <SafeMessageContent content="Approve on the [CoCalc VM approval page](https://staging.cocalc.ai/projects/p/vms?agent_grant=grant-1)." />,
  );

  const link = screen.getByRole("link", { name: "CoCalc VM approval page" });
  expect(link).toHaveAttribute(
    "href",
    "https://staging.cocalc.ai/projects/p/vms?agent_grant=grant-1",
  );
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noreferrer");
});

test("renders raw HTML and unsafe links as inert content", () => {
  const { container } = render(
    <SafeMessageContent
      content={'<script>alert("x")</script> [unsafe](javascript:alert("x"))'}
    />,
  );

  expect(container.querySelector("script")).toBeNull();
  expect(screen.queryByRole("link", { name: "unsafe" })).toBeNull();
  expect(container).toHaveTextContent('[unsafe](javascript:alert("x"))');
});

test("refreshes an idle Codex thread without sending a synthetic prompt", async () => {
  const client = mockClient();
  const session = {
    accountId: "22222222-2222-4222-8222-222222222222",
    openProjectHost: jest.fn(async () => ({ client: {} })),
  };
  render(
    <Chat
      project={
        {
          host_id: "host-1",
          project_id: snapshot.project_id,
          title: "Test",
        } as any
      }
      route={{
        chatPath: snapshot.path,
        kind: "chat",
        projectId: snapshot.project_id,
        threadId: "thread-1",
      }}
      session={session as any}
    />,
  );

  expect(
    screen.queryByRole("button", { name: "Continue Codex" }),
  ).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(client.reconnect).toHaveBeenCalledWith(
      "constrained-client-user-request",
    ),
  );
});

test("shows that a ready empty Codex thread can accept its first message", async () => {
  mockClient({ ...snapshot, messages: [] });
  const session = {
    accountId: "22222222-2222-4222-8222-222222222222",
    openProjectHost: jest.fn(async () => ({ client: {} })),
  };
  render(
    <Chat
      project={
        {
          host_id: "host-1",
          project_id: snapshot.project_id,
          title: "Test",
        } as any
      }
      route={{
        chatPath: snapshot.path,
        kind: "chat",
        projectId: snapshot.project_id,
        threadId: "thread-1",
      }}
      session={session as any}
    />,
  );

  expect(
    await screen.findByText("No messages yet. Send a message to begin."),
  ).toBeInTheDocument();
  expect(screen.queryByText("Waiting for chat history...")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Message Codex" })).toBeEnabled();
});

test("sends the current prompt with Shift+Enter", async () => {
  const client = mockClient();
  const session = {
    accountId: "22222222-2222-4222-8222-222222222222",
    openProjectHost: jest.fn(async () => ({ client: {} })),
  };
  render(
    <Chat
      project={
        {
          host_id: "host-1",
          project_id: snapshot.project_id,
          title: "Test",
        } as any
      }
      route={{
        chatPath: snapshot.path,
        kind: "chat",
        projectId: snapshot.project_id,
        threadId: "thread-1",
      }}
      session={session as any}
    />,
  );

  const input = await screen.findByRole("textbox", { name: "Message Codex" });
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: "Run the next test" } });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

  await waitFor(() =>
    expect(client.sendToExistingCodexThread).toHaveBeenCalledWith({
      text: "Run the next test",
      thread_id: "thread-1",
    }),
  );
  expect(
    screen.queryByText("Prompt accepted by Codex"),
  ).not.toBeInTheDocument();
});

test("sends Shift+Enter as guidance while Codex is running", async () => {
  const running: ChatSnapshot = {
    ...snapshot,
    messages: [
      ...snapshot.messages,
      {
        content: "Working...",
        date: "2026-08-15T00:00:01.000Z",
        generating: true,
        message_id: "message-running",
        role: "agent",
        sender_id: "codex",
        state: "running",
        thread_id: "thread-1",
      },
    ],
  };
  const client = mockClient(running);
  const session = {
    accountId: "22222222-2222-4222-8222-222222222222",
    openProjectHost: jest.fn(async () => ({ client: {} })),
  };
  render(
    <Chat
      project={
        {
          host_id: "host-1",
          project_id: snapshot.project_id,
          title: "Test",
        } as any
      }
      route={{
        chatPath: snapshot.path,
        kind: "chat",
        projectId: snapshot.project_id,
        threadId: "thread-1",
      }}
      session={session as any}
    />,
  );

  const input = await screen.findByRole("textbox", { name: "Message Codex" });
  fireEvent.change(input, { target: { value: "Check the edge case" } });
  expect(screen.getByRole("button", { name: "Send guidance" })).toBeEnabled();
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

  await waitFor(() =>
    expect(client.sendGuidanceToCodexThread).toHaveBeenCalledWith({
      text: "Check the edge case",
      thread_id: "thread-1",
    }),
  );
  expect(client.sendToExistingCodexThread).not.toHaveBeenCalled();
});

test("shows and updates the thread model, reasoning, and payment source", async () => {
  const configured: ChatSnapshot = {
    ...snapshot,
    threads: [
      {
        ...snapshot.threads[0],
        acp_config: {
          model: "gpt-5.6-luna",
          paymentSource: "auto",
          reasoning: "medium",
        },
      },
    ],
  };
  const client = mockClient(configured);
  const session = {
    accountId: "22222222-2222-4222-8222-222222222222",
    hubApi: {
      system: {
        getCodexPaymentSource: jest.fn(async () => ({
          hasAccountApiKey: false,
          hasProjectApiKey: false,
          hasSiteApiKey: true,
          hasSubscription: true,
          sharedHomeMode: "disabled",
          source: "subscription",
        })),
      },
    },
    openProjectHost: jest.fn(async () => ({ client: {} })),
  };
  render(
    <Chat
      project={
        {
          host_id: "host-1",
          project_id: snapshot.project_id,
          title: "Test",
        } as any
      }
      route={{
        chatPath: snapshot.path,
        kind: "chat",
        projectId: snapshot.project_id,
        threadId: "thread-1",
      }}
      session={session as any}
    />,
  );

  expect(await screen.findByRole("combobox", { name: "Model" })).toHaveValue(
    "gpt-5.6-luna",
  );
  expect(screen.getByRole("combobox", { name: "Reasoning" })).toHaveValue(
    "medium",
  );
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Paid by" })).toHaveTextContent(
      "Automatic (ChatGPT subscription)",
    ),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Model" }), {
    target: { value: "gpt-6-luna" },
  });
  await waitFor(() =>
    expect(client.updateCodexThreadConfig).toHaveBeenCalledWith({
      thread_id: "thread-1",
      acp_config: expect.objectContaining({
        model: "gpt-6-luna",
        paymentSource: "auto",
      }),
    }),
  );
});
