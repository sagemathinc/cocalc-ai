/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import {
  createRemoteHeadlessChatClient,
  type ChatSnapshot,
  type ProjectedChatMessage,
} from "@cocalc/chat-client";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  AgentLoadingPreview,
  selectedPreviewMessages,
} from "./loading-preview";

jest.mock("@cocalc/chat-client", () => ({
  createRemoteHeadlessChatClient: jest.fn(),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      projectConat: jest.fn(async () => ({ request: jest.fn() })),
    },
  },
}));

function message(
  message_id: string,
  thread_id = "selected",
  content = message_id,
): ProjectedChatMessage {
  return {
    message_id,
    thread_id,
    sender_id: "sender",
    role: "agent",
    content,
    date: "2026-09-17T00:00:00.000Z",
    generating: false,
  };
}

test("keeps only the five newest nonempty messages in the selected thread", () => {
  expect(
    selectedPreviewMessages(
      [
        message("old"),
        message("other", "another-thread"),
        message("empty", "selected", ""),
        message("one"),
        message("two"),
        message("three"),
        message("four"),
        message("five"),
      ],
      "selected",
    ).map(({ message_id }) => message_id),
  ).toEqual(["one", "two", "three", "four", "five"]);
});

test("opens a bounded routed preview and closes it on unmount", async () => {
  const snapshot: ChatSnapshot = {
    revision: 1,
    connection: "connected",
    ready: true,
    project_id: "11111111-1111-4111-8111-111111111111",
    path: "/home/user/agent.chat",
    selected_thread_id: "selected",
    threads: [],
    messages: [message("recent")],
  };
  const close = jest.fn(async () => undefined);
  const client = {
    close,
    open: jest.fn(async () => undefined),
    subscribe: jest.fn((listener) => {
      listener(snapshot);
      return jest.fn();
    }),
  };
  jest.mocked(createRemoteHeadlessChatClient).mockReturnValue(client as any);
  const agent = {
    account_id: "22222222-2222-4222-8222-222222222222",
    endpoint: {
      agent_id: "33333333-3333-4333-8333-333333333333",
      project_id: snapshot.project_id,
    },
    name: "research",
    path: snapshot.path,
    thread_id: "selected",
  } as any;

  const view = render(
    createElement(AgentLoadingPreview, {
      accountId: agent.account_id,
      agent,
    }),
  );

  expect(await screen.findByText("recent")).toBeInTheDocument();
  expect(webapp_client.conat_client.projectConat).toHaveBeenCalledWith({
    project_id: snapshot.project_id,
    caller: "AgentLoadingPreview",
    requireRouting: true,
  });
  expect(createRemoteHeadlessChatClient).toHaveBeenCalledWith(
    expect.objectContaining({
      initial_message_limit: 5,
      selected_thread_id: "selected",
    }),
  );

  view.unmount();
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
});
