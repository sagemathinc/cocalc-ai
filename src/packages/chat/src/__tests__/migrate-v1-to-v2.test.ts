import { migrateChatRows } from "../migrate-v1-to-v2";

describe("migrateChatRows", () => {
  it("adds ids and emits thread records", () => {
    const rootIso = "2026-02-20T10:00:00.000Z";
    const rows = [
      {
        event: "chat",
        sender_id: "user-1",
        date: rootIso,
        history: [{ author_id: "user-1", content: "hello", date: rootIso }],
        name: "Thread name",
        acp_config: { model: "gpt-5.3-codex" },
      },
      {
        event: "chat",
        sender_id: "codex-agent",
        date: "2026-02-20T10:00:01.000Z",
        reply_to: rootIso,
        history: [{ author_id: "codex-agent", content: "hi", date: rootIso }],
      },
      {
        event: "draft",
        sender_id: "user-1",
        date: 0,
        input: "tmp",
      },
    ];
    const { rows: out, report } = migrateChatRows(rows);
    const chats = out.filter((x) => x.event === "chat");
    const thread = out.find((x) => x.event === "chat-thread");
    const config = out.find((x) => x.event === "chat-thread-config");
    const state = out.find((x) => x.event === "chat-thread-state");
    const draft = out.find((x) => x.event === "draft");

    expect(chats).toHaveLength(2);
    expect(chats.every((x) => typeof x.message_id === "string")).toBe(true);
    expect(chats.every((x) => typeof x.thread_id === "string")).toBe(true);
    expect(chats[0].schema_version).toBe(2);
    expect(thread?.thread_id).toBe(chats[0].thread_id);
    expect(thread?.root_message_id).toBe(chats[0].message_id);
    expect(config?.thread_id).toBe(chats[0].thread_id);
    expect(config?.name).toBe("Thread name");
    expect(state?.thread_id).toBe(chats[0].thread_id);
    expect(draft).toBeTruthy();
    expect(report.invalid_chat_rows_skipped).toBe(0);
    expect(report.integrity_after.missing_thread_config).toBe(0);
  });

  it("can strip legacy root thread fields when requested", () => {
    const rootIso = "2026-02-20T11:00:00.000Z";
    const rows = [
      {
        event: "chat",
        sender_id: "user-1",
        date: rootIso,
        history: [{ author_id: "user-1", content: "hello", date: rootIso }],
        name: "Thread name",
        thread_color: "#123456",
        thread_icon: "robot",
      },
    ];
    const { rows: out } = migrateChatRows(rows, {
      keepLegacyThreadFields: false,
    });
    const chat = out.find((x) => x.event === "chat");
    expect(chat?.name).toBeUndefined();
    expect(chat?.thread_color).toBeUndefined();
    expect(chat?.thread_icon).toBeUndefined();
  });
});
