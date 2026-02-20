import {
  addToHistory,
  buildChatMessage,
  buildChatMessageRecordV2,
  buildThreadConfigRecord,
  buildThreadRecord,
  buildThreadStateRecord,
  CHAT_SCHEMA_V2,
} from "..";

describe("chat helpers", () => {
  test("addToHistory prepends entries with timestamps", () => {
    const history = addToHistory([], {
      author_id: "user-1",
      content: "Hello",
    });
    expect(history).toHaveLength(1);
    expect(history[0].author_id).toBe("user-1");
    expect(history[0].content).toBe("Hello");
    expect(history[0].date).toMatch(/^20\d{2}-/);
  });

  test("buildChatMessage constructs message with metadata", () => {
    const msg = buildChatMessage({
      sender_id: "agent",
      date: new Date("2024-01-01T00:00:00Z"),
      prevHistory: [],
      content: "Response",
      generating: false,
      acp_thread_id: "thread-123",
    });
    expect(msg.sender_id).toBe("agent");
    expect(msg.history[0].content).toBe("Response");
    expect(msg.acp_thread_id).toBe("thread-123");
    expect(msg.generating).toBe(false);
  });

  test("buildThreadRecord constructs schema-v2 thread identity", () => {
    const thread = buildThreadRecord({
      thread_id: "thread-1",
      root_message_id: "msg-1",
      created_by: "user-1",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    expect(thread.event).toBe("chat-thread");
    expect(thread.thread_id).toBe("thread-1");
    expect(thread.root_message_id).toBe("msg-1");
    expect(thread.schema_version).toBe(CHAT_SCHEMA_V2);
  });

  test("buildThreadConfigRecord stores configurable thread metadata", () => {
    const cfg = buildThreadConfigRecord({
      thread_id: "thread-1",
      updated_by: "user-1",
      name: "My Thread",
      thread_icon: "bot",
      thread_color: "#123456",
      thread_image: "https://example.com/image.png",
      pin: true,
      acp_config: { model: "gpt-5.3-codex", sessionId: "session-1" },
    });
    expect(cfg.event).toBe("chat-thread-config");
    expect(cfg.thread_id).toBe("thread-1");
    expect(cfg.thread_image).toBe("https://example.com/image.png");
    expect(cfg.pin).toBe(true);
    expect(cfg.acp_config?.model).toBe("gpt-5.3-codex");
  });

  test("buildChatMessageRecordV2 includes explicit message/thread ids", () => {
    const msg = buildChatMessageRecordV2({
      message_id: "msg-1",
      thread_id: "thread-1",
      sender_id: "agent",
      date: "2026-01-01T00:00:00.000Z",
      prevHistory: [],
      content: "Hello from v2",
      generating: false,
    });
    expect(msg.message_id).toBe("msg-1");
    expect(msg.thread_id).toBe("thread-1");
    expect(msg.schema_version).toBe(CHAT_SCHEMA_V2);
  });

  test("buildThreadStateRecord captures runtime status", () => {
    const state = buildThreadStateRecord({
      thread_id: "thread-1",
      state: "running",
      active_message_id: "msg-2",
    });
    expect(state.event).toBe("chat-thread-state");
    expect(state.state).toBe("running");
    expect(state.active_message_id).toBe("msg-2");
    expect(state.schema_version).toBe(CHAT_SCHEMA_V2);
  });
});
