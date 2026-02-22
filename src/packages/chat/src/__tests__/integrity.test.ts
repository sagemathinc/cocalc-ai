import { computeChatIntegrityReport } from "../integrity";

describe("computeChatIntegrityReport", () => {
  it("returns zero counters for a healthy codex thread", () => {
    const rootIso = "2026-02-20T00:00:00.000Z";
    const rows = [
      {
        event: "chat",
        sender_id: "user-1",
        date: rootIso,
        message_id: "m-root",
        thread_id: "t-1",
        history: [],
        acp_config: { model: "gpt-5.3-codex" },
      },
      {
        event: "chat",
        sender_id: "codex-agent",
        date: "2026-02-20T00:00:01.000Z",
        message_id: "m-2",
        thread_id: "t-1",
        reply_to: rootIso,
        reply_to_message_id: "m-root",
        history: [],
      },
      {
        event: "chat-thread-config",
        sender_id: "__thread_config__",
        date: rootIso,
        thread_id: "t-1",
        acp_config: { model: "gpt-5.3-codex", sessionId: "s-1" },
      },
    ];
    const report = computeChatIntegrityReport(rows);
    expect(report.counters).toEqual({
      orphan_messages: 0,
      duplicate_root_messages: 0,
      missing_thread_config: 0,
      invalid_reply_targets: 0,
      missing_identity_fields: 0,
    });
  });

  it("detects duplicate roots and invalid reply targets", () => {
    const rootIso = "2026-02-20T00:00:00.000Z";
    const rows = [
      {
        event: "chat",
        sender_id: "user-1",
        date: rootIso,
        message_id: "m-root-1",
        thread_id: "t-dup",
        history: [],
      },
      {
        event: "chat",
        sender_id: "user-2",
        date: "2026-02-20T00:00:00.001Z",
        message_id: "m-root-2",
        thread_id: "t-dup",
        history: [],
      },
      {
        event: "chat",
        sender_id: "codex-agent",
        date: "2026-02-20T00:00:02.000Z",
        message_id: "m-reply",
        thread_id: "t-dup",
        reply_to: rootIso,
        reply_to_message_id: "missing-root",
        history: [],
      },
    ];
    const report = computeChatIntegrityReport(rows);
    expect(report.counters.duplicate_root_messages).toBe(1);
    expect(report.counters.invalid_reply_targets).toBe(1);
    expect(report.examples.duplicate_root_thread_ids).toContain("t-dup");
    expect(report.examples.invalid_reply_message_ids).toContain("m-reply");
  });

  it("detects missing thread-config for codex roots", () => {
    const rows = [
      {
        event: "chat",
        sender_id: "user-1",
        date: "2026-02-20T00:00:00.000Z",
        message_id: "m-root",
        thread_id: "t-codex",
        history: [],
        acp_config: { model: "gpt-5.3-codex", sessionId: "s-1" },
      },
    ];
    const report = computeChatIntegrityReport(rows);
    expect(report.counters.missing_thread_config).toBe(1);
    expect(report.examples.missing_thread_config_thread_ids).toContain(
      "t-codex",
    );
  });

  it("detects rows missing message/thread identity fields", () => {
    const rows = [
      {
        event: "chat",
        sender_id: "user-1",
        date: "2026-02-20T00:00:00.000Z",
        history: [],
      },
    ];
    const report = computeChatIntegrityReport(rows);
    expect(report.counters.missing_identity_fields).toBe(1);
    expect(report.examples.missing_identity_rows).toContain(
      "2026-02-20T00:00:00.000Z:user-1",
    );
  });
});
