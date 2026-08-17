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
import { Chat, SafeMessageContent } from "./chat-surface";

jest.mock("@cocalc/chat-client", () => ({
  AgentSessionIndex: class {},
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

function mockClient(): HeadlessChatClient {
  const client = {
    close: jest.fn(async () => undefined),
    getSnapshot: jest.fn(() => snapshot),
    interrupt: jest.fn(async () => undefined),
    loadOlderMessages: jest.fn(async () => undefined),
    open: jest.fn(async () => undefined),
    reconnect: jest.fn(async () => undefined),
    selectThread: jest.fn(),
    sendToExistingCodexThread: jest.fn(async () => ({
      message_id: "message-2",
      thread_id: "thread-1",
    })),
    subscribe: jest.fn((listener: (value: ChatSnapshot) => void) => {
      listener(snapshot);
      return () => undefined;
    }),
  };
  (createRemoteHeadlessChatClient as jest.Mock).mockReturnValue(client);
  return client;
}

afterEach(() => jest.clearAllMocks());

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

test("continues an idle Codex thread and catches up without another prompt", async () => {
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

  const continueButton = await screen.findByRole("button", {
    name: "Continue Codex",
  });
  await waitFor(() => expect(continueButton).toBeEnabled());
  fireEvent.click(continueButton);
  await waitFor(() =>
    expect(client.sendToExistingCodexThread).toHaveBeenCalledWith({
      text: "continue",
      thread_id: "thread-1",
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Catch up" }));
  await waitFor(() =>
    expect(client.reconnect).toHaveBeenCalledWith(
      "constrained-client-user-request",
    ),
  );
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
});
