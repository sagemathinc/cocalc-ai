/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { ChatSnapshot } from "./types";
import {
  PROJECT_CHAT_SESSION_NOT_FOUND,
  RemoteHeadlessChatClient,
  projectChatSessionSubject,
  type ProjectChatSessionStreamEvent,
} from "./remote-client";

const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PATH = "/home/user/test.chat";
const THREAD_ID = "thread-1";

function snapshot(revision: number, content: string): ChatSnapshot {
  return {
    revision,
    connection: "connected",
    ready: true,
    project_id: PROJECT_ID,
    path: PATH,
    selected_thread_id: THREAD_ID,
    threads: [{ thread_id: THREAD_ID, state: "idle" }],
    messages: [
      {
        message_id: "message-1",
        thread_id: THREAD_ID,
        sender_id: "codex",
        role: "agent",
        content,
        date: "2026-08-15T00:00:00.000Z",
        generating: false,
      },
    ],
  };
}

function createClient(projectHostClient: any) {
  return new RemoteHeadlessChatClient({
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    path: PATH,
    projectHostClient,
    selected_thread_id: THREAD_ID,
  });
}

test("builds a project- and account-scoped service subject", () => {
  expect(
    projectChatSessionSubject({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    }),
  ).toBe(
    `services.account-${ACCOUNT_ID}._.${PROJECT_ID}._.project-chat-session`,
  );
  expect(() =>
    projectChatSessionSubject({
      account_id: "invalid",
      project_id: PROJECT_ID,
    }),
  ).toThrow("valid account and project ids");
});

test("cleans up a server session when the update stream cannot open", async () => {
  const request = jest.fn(async (_subject, [name]) => {
    if (name === "open") {
      return {
        data: {
          session_id: `session-${request.mock.calls.length}`,
          stream_name: "broken-stream",
          snapshot: snapshot(1, "initial"),
        },
      };
    }
    return { data: null };
  });
  const client = createClient({
    request,
    sync: {
      dstream: jest.fn(async () => Promise.reject(new Error("offline"))),
    },
  });

  await expect(client.open()).rejects.toThrow("offline");
  await expect(client.open()).rejects.toThrow("offline");

  expect(
    request.mock.calls.filter(([, [name]]) => name === "open"),
  ).toHaveLength(2);
  expect(
    request.mock.calls.filter(([, [name]]) => name === "close"),
  ).toHaveLength(2);
});

test("ignores stream updates older than the current server snapshot", () => {
  const client = createClient({});
  const internal = client as any;
  internal.applySnapshot(snapshot(2, "current"), true);
  internal.handleEvent({
    kind: "update",
    revision: 1,
    connection: "connected",
    ready: true,
    messages: [{ ...snapshot(1, "stale").messages[0], content: "stale" }],
  } satisfies ProjectChatSessionStreamEvent);

  expect(client.getSnapshot().messages[0].content).toBe("current");
});

test("reports service and stream open phases", async () => {
  const phases: string[] = [];
  const stream = {
    close: jest.fn(),
    getAll: jest.fn(() => []),
    on: jest.fn(),
    removeListener: jest.fn(),
  };
  const client = new RemoteHeadlessChatClient({
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    path: PATH,
    projectHostClient: {
      request: jest.fn(async () => ({
        data: {
          session_id: "session-1",
          stream_name: "stream-1",
          snapshot: snapshot(1, "ready"),
        },
      })),
      sync: { dstream: jest.fn(async () => stream) },
    } as any,
    selected_thread_id: THREAD_ID,
    onOpenPhase: (phase) => phases.push(phase),
  });

  await client.open();

  expect(phases).toEqual([
    "service_open_start",
    "service_open_done",
    "stream_open_start",
    "stream_open_done",
  ]);
  await client.close();
});

test("retains the selected thread and expanded message window on reconnect", async () => {
  let openCount = 0;
  const request = jest.fn(async (_subject, [name, args]) => {
    if (name === "open") {
      openCount += 1;
      const options = args[0];
      return {
        data: {
          session_id: `session-${openCount}`,
          stream_name: `stream-${openCount}`,
          snapshot: {
            ...snapshot(1, `snapshot ${openCount}`),
            selected_thread_id: options.selected_thread_id,
            message_window: {
              limit: options.limit,
              loaded: 1,
              has_older: true,
              omitted: 100,
            },
          },
        },
      };
    }
    if (name === "setLimit") {
      return {
        data: {
          ...snapshot(2, "expanded"),
          selected_thread_id: "thread-1",
          message_window: {
            limit: args[0].limit,
            loaded: 1,
            has_older: true,
            omitted: 40,
          },
        },
      };
    }
    return { data: null };
  });
  const client = new RemoteHeadlessChatClient({
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    path: PATH,
    projectHostClient: {
      request,
      sync: { dstream: jest.fn(async () => streamStub()) },
    } as any,
    selected_thread_id: THREAD_ID,
  });

  await client.open();
  await client.loadOlderMessages(90);
  client.selectThread("thread-2");
  await client.reconnect("test");

  const openCalls = request.mock.calls.filter(([, [name]]) => name === "open");
  expect(openCalls).toHaveLength(2);
  expect(openCalls[1][1][1][0]).toMatchObject({
    selected_thread_id: "thread-2",
    limit: 90,
  });
  expect(client.getSnapshot().messages[0].content).toBe("snapshot 2");
  await client.close();
});

test("recreates an expired session and safely retries the operation", async () => {
  let openCount = 0;
  let sendCount = 0;
  const request = jest.fn(async (_subject, [name, args]) => {
    if (name === "open") {
      openCount += 1;
      return {
        data: {
          session_id: `session-${openCount}`,
          stream_name: `stream-${openCount}`,
          snapshot: snapshot(1, `snapshot ${openCount}`),
        },
      };
    }
    if (name === "send") {
      sendCount += 1;
      if (sendCount === 1) throw new Error(PROJECT_CHAT_SESSION_NOT_FOUND);
      return {
        data: {
          message_id: "message-sent",
          thread_id: args[0].thread_id,
        },
      };
    }
    return { data: null };
  });
  const client = new RemoteHeadlessChatClient({
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    path: PATH,
    projectHostClient: {
      request,
      sync: { dstream: jest.fn(async () => streamStub()) },
    } as any,
    selected_thread_id: THREAD_ID,
  });

  await client.open();
  await expect(
    client.sendToExistingCodexThread({ thread_id: THREAD_ID, text: "test" }),
  ).resolves.toEqual({
    message_id: "message-sent",
    thread_id: THREAD_ID,
  });

  expect(openCount).toBe(2);
  expect(sendCount).toBe(2);
  await client.close();
});

test("accepts lower server revisions after opening a replacement session", () => {
  const client = createClient({});
  const internal = client as any;
  internal.applySnapshot(snapshot(50, "old session"), true);
  internal.applySnapshot(snapshot(1, "replacement snapshot"), true);
  internal.handleEvent({
    kind: "update",
    revision: 2,
    connection: "connected",
    ready: true,
    messages: [{ ...snapshot(2, "replacement update").messages[0] }],
  } satisfies ProjectChatSessionStreamEvent);

  expect(client.getSnapshot().messages[0].content).toBe("replacement update");
});

function streamStub() {
  return {
    close: jest.fn(),
    getAll: jest.fn(() => []),
    on: jest.fn(),
    removeListener: jest.fn(),
  };
}
