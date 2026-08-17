/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { ChatSnapshot, ProjectedChatMessage } from "@cocalc/chat-client";
import {
  boundedProjectChatSnapshot,
  normalizeProjectChatLimit,
  normalizeProjectChatPath,
  projectChatSessionUpdate,
} from "./project-chat-session-service";

function message(
  index: number,
  content = `message ${index}`,
): ProjectedChatMessage {
  return {
    message_id: `message-${index}`,
    thread_id: "thread-1",
    sender_id: "account-1",
    role: index % 2 ? "agent" : "human",
    content,
    date: new Date(index * 1000).toISOString(),
    generating: false,
    acp_events: [{ large: "internal detail" }],
    acp_log_store: "acp-log/test.chat",
    acp_log_key: `thread-1:message-${index}`,
    acp_live_log_stream: `acp-live-log/test.chat/thread-1/message-${index}`,
    acp_live_preview_stream: `acp-preview-log/test.chat/thread-1/message-${index}`,
    activity: {
      state: "ready",
      events: [{ type: "text", text: "internal detail" }] as any[],
      markdown: `activity ${index}`,
    },
  };
}

function snapshot(messages: ProjectedChatMessage[]): ChatSnapshot {
  return {
    revision: 1,
    connection: "connected",
    ready: true,
    project_id: "11111111-1111-4111-8111-111111111111",
    path: "/home/user/test.chat",
    selected_thread_id: "thread-1",
    threads: [{ thread_id: "thread-1", state: "idle" }],
    messages,
  };
}

describe("project chat session projection", () => {
  it("loads a bounded recent tail without ACP event payloads", () => {
    const projected = boundedProjectChatSnapshot(
      snapshot(Array.from({ length: 50 }, (_, index) => message(index))),
      10,
    );
    expect(projected.messages.map(({ message_id }) => message_id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `message-${index + 40}`),
    );
    expect(projected.message_window).toEqual({
      limit: 10,
      loaded: 10,
      has_older: true,
      omitted: 40,
    });
    expect(projected.messages[0].acp_events).toBeUndefined();
    expect(projected.messages[0].acp_log_store).toBeUndefined();
    expect(projected.messages[0].acp_log_key).toBeUndefined();
    expect(projected.messages[0].acp_live_log_stream).toBeUndefined();
    expect(projected.messages[0].acp_live_preview_stream).toBeUndefined();
    expect(projected.messages[0].activity?.events).toEqual([]);
    expect(projected.threads).toEqual([
      { thread_id: "thread-1", state: "idle" },
    ]);
  });

  it("includes metadata only for the selected thread", () => {
    const projected = boundedProjectChatSnapshot(
      {
        ...snapshot([message(1)]),
        threads: [
          { thread_id: "thread-1", state: "idle" },
          { thread_id: "thread-2", state: "running" },
        ],
      },
      30,
    );

    expect(projected.threads.map(({ thread_id }) => thread_id)).toEqual([
      "thread-1",
    ]);
  });

  it("caps invalid and excessive limits", () => {
    expect(normalizeProjectChatLimit(Number.NaN)).toBe(30);
    expect(normalizeProjectChatLimit(-1)).toBe(30);
    expect(normalizeProjectChatLimit(20_000)).toBe(500);
  });

  it("confines chat paths to the project home directory", () => {
    expect(normalizeProjectChatPath("/home/user/work/../test.chat")).toBe(
      "/home/user/test.chat",
    );
    expect(() =>
      normalizeProjectChatPath("/home/user/../etc/private.chat"),
    ).toThrow("under /home/user");
    expect(() => normalizeProjectChatPath("/tmp/test.sage-chat")).toThrow(
      "under /home/user",
    );
  });

  it("truncates oversized individual message content", () => {
    const projected = boundedProjectChatSnapshot(
      snapshot([message(1, "x".repeat(300_000))]),
      30,
    );
    expect(Buffer.byteLength(projected.messages[0].content)).toBeLessThan(
      140 * 1024,
    );
    expect(projected.messages[0].content).toContain("content omitted");
  });

  it("emits only changed and removed messages", () => {
    const before = boundedProjectChatSnapshot(
      snapshot([message(1), message(2)]),
      30,
    );
    const after = boundedProjectChatSnapshot(
      { ...snapshot([message(2, "changed"), message(3)]), revision: 2 },
      30,
    );
    expect(projectChatSessionUpdate(before, after)).toMatchObject({
      kind: "update",
      revision: 2,
      messages: [
        expect.objectContaining({
          message_id: "message-2",
          content: "changed",
        }),
        expect.objectContaining({ message_id: "message-3" }),
      ],
      removed_message_ids: ["message-1"],
    });
  });
});
