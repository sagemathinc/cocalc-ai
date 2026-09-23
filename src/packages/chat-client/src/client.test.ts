/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "node:events";

import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";

let dbMock: EventEmitter & {
  isReady: () => boolean;
  get: () => Record<string, any>[];
  close: jest.Mock;
};

jest.mock("@cocalc/conat/sync-doc/immer-db", () => ({
  immerdb: () => dbMock,
}));

import { createHeadlessChatClient } from "./client";

async function until(predicate: () => boolean, timeoutMs = 1_500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("headless chat activity recovery", () => {
  it("loads the durable project-host activity log for a completed row", async () => {
    const events: AcpStreamMessage[] = [
      {
        type: "event",
        seq: 1,
        event: {
          type: "terminal",
          terminalId: "terminal-1",
          phase: "exit",
          command: "expr",
          args: ["17", "+", "45"],
          output: "62\n",
          exitStatus: { exitCode: 0 },
        },
      },
      { type: "summary", seq: 2, finalResponse: "Done." },
    ];
    dbMock = Object.assign(new EventEmitter(), {
      isReady: () => true,
      get: () => [
        {
          event: "chat",
          sender_id: "agent-account",
          date: "2026-08-14T00:00:00.000Z",
          message_id: "message-1",
          thread_id: "thread-1",
          acp_account_id: "agent-account",
          acp_log_store: "acp-log/chat.chat",
          acp_log_key: "thread-1:message-1",
          generating: false,
          history: [
            {
              author_id: "agent-account",
              content: "Done.",
              date: "2026-08-14T00:00:01.000Z",
            },
          ],
        },
      ],
      close: jest.fn(async () => undefined),
    });
    const projectHostClient = Object.assign(new EventEmitter(), {
      sync: {
        akv: jest.fn(() => ({
          get: jest.fn(async () => events),
          close: jest.fn(),
        })),
      },
    });
    const client = createHeadlessChatClient({
      account_id: "account-1",
      project_id: "project-1",
      path: "chat.chat",
      projectHostClient: projectHostClient as any,
      selected_thread_id: "thread-1",
    });

    await client.open();
    await until(
      () => client.getSnapshot().messages[0]?.activity?.state === "ready",
    );

    expect(client.getSnapshot().messages[0]).toEqual(
      expect.objectContaining({
        content: "Done.",
        activity: expect.objectContaining({
          state: "ready",
          markdown: expect.stringContaining("62"),
        }),
      }),
    );
    await client.close();
  });

  it("uses only the compact live preview for Essential startup", async () => {
    dbMock = Object.assign(new EventEmitter(), {
      isReady: () => true,
      get: () => [
        {
          event: "chat",
          sender_id: "agent-account",
          date: "2026-08-14T00:00:00.000Z",
          message_id: "completed-message",
          thread_id: "thread-1",
          acp_account_id: "agent-account",
          acp_log_store: "acp-log/chat.chat",
          acp_log_key: "thread-1:completed-message",
          generating: false,
          history: [],
        },
        {
          event: "chat",
          sender_id: "agent-account",
          date: "2026-08-14T00:01:00.000Z",
          message_id: "active-message",
          thread_id: "thread-1",
          acp_account_id: "agent-account",
          acp_log_store: "acp-log/chat.chat",
          acp_log_key: "thread-1:active-message",
          acp_live_log_stream: "acp-live-log/chat.chat/thread-1/active-message",
          acp_live_preview_stream:
            "acp-preview-log/chat.chat/thread-1/active-message",
          generating: true,
          history: [],
        },
      ],
      close: jest.fn(async () => undefined),
    });
    const previewEvents: AcpStreamMessage[] = [
      {
        type: "event",
        seq: 1,
        event: { type: "message", text: "Compact live progress." },
      },
    ];
    const previewStream = {
      close: jest.fn(),
      getAll: jest.fn(() => previewEvents),
      on: jest.fn(),
      removeListener: jest.fn(),
    };
    const projectHostClient = Object.assign(new EventEmitter(), {
      sync: {
        akv: jest.fn(() => {
          throw new Error("the full activity AKV must not be opened");
        }),
        dstream: jest.fn(async () => previewStream),
      },
    });
    const client = createHeadlessChatClient({
      account_id: "account-1",
      project_id: "project-1",
      path: "chat.chat",
      projectHostClient: projectHostClient as any,
      selected_thread_id: "thread-1",
      activityLoadPolicy: "live-preview-only",
    });

    await client.open();
    await until(
      () => client.getSnapshot().messages[1]?.activity?.state === "ready",
    );

    expect(projectHostClient.sync.akv).not.toHaveBeenCalled();
    expect(projectHostClient.sync.dstream).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "acp-preview-log/chat.chat/thread-1/active-message",
      }),
    );
    expect(client.getSnapshot().messages[0]?.activity).toBeUndefined();
    expect(client.getSnapshot().messages[1]?.activity?.markdown).toContain(
      "Compact live progress.",
    );
    await client.close();
  });
});

test("creates a Codex thread config in the constrained chat document", async () => {
  const rows: Record<string, any>[] = [];
  const set = jest.fn((row) => rows.push(row));
  const save = jest.fn(async () => undefined);
  dbMock = Object.assign(new EventEmitter(), {
    close: jest.fn(async () => undefined),
    commit: jest.fn(() => true),
    get: () => rows,
    isReady: () => true,
    save,
    set,
  });
  const projectHostClient = new EventEmitter();
  const client = createHeadlessChatClient({
    account_id: "account-1",
    path: "/home/user/new.chat",
    projectHostClient: projectHostClient as any,
    project_id: "project-1",
    selected_thread_id: "thread-1",
  });
  await client.open();

  await expect(
    client.createCodexThread({
      acp_config: {
        model: "gpt-test",
        sessionMode: "workspace-write",
      },
      name: "New chat",
      thread_id: "thread-1",
    }),
  ).resolves.toEqual({ thread_id: "thread-1" });

  expect(set).toHaveBeenCalledWith(
    expect.objectContaining({
      acp_config: expect.objectContaining({ model: "gpt-test" }),
      agent_kind: "acp",
      agent_mode: "interactive",
      agent_model: "gpt-test",
      event: "chat-thread-config",
      name: "New chat",
      thread_id: "thread-1",
    }),
  );
  expect(save).toHaveBeenCalled();
  await client.close();
});

test("updates settings without writing unrelated goal metadata", async () => {
  const goal = { sessionId: "session", observedAt: 1, goal: null };
  const existing = {
    event: "chat-thread-config",
    date: "1970-01-01T00:00:00.000Z",
    sender_id: "__thread_config__:thread-1",
    thread_id: "thread-1",
    agent_kind: "acp",
    agent_model: "old-model",
    acp_config: { model: "old-model" },
    acp_goal: goal,
  };
  const set = jest.fn();
  dbMock = Object.assign(new EventEmitter(), {
    close: jest.fn(async () => undefined),
    commit: jest.fn(() => true),
    get: () => [existing],
    isReady: () => true,
    save: jest.fn(async () => undefined),
    set,
  });
  const client = createHeadlessChatClient({
    account_id: "account-1",
    path: "/home/user/existing.chat",
    projectHostClient: new EventEmitter() as any,
    project_id: "project-1",
    selected_thread_id: "thread-1",
  });
  await client.open();

  await client.updateCodexThreadConfig({
    thread_id: "thread-1",
    acp_config: { model: "new-model", serviceTier: undefined },
  });

  expect(set).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "chat-thread-config",
      thread_id: "thread-1",
      agent_model: "new-model",
      acp_config: { model: "new-model", serviceTier: undefined },
    }),
  );
  expect(set.mock.calls[0][0]).not.toHaveProperty("acp_goal");
  expect(existing.acp_goal).toBe(goal);
  await client.close();
});
