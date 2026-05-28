import { parseChatPreviewRows } from "../preview";
import { from_str } from "@cocalc/sync/editor/immer-db/doc";

describe("parseChatPreviewRows", () => {
  it("parses valid json lines and skips invalid lines", () => {
    const parsed = parseChatPreviewRows(
      [
        "",
        '{"event":"chat","sender_id":"u1","date":"2026-01-01T00:00:00.000Z"}',
        "not-json",
        '{"event":"chat-thread-config","thread_id":"t1"}',
      ].join("\n"),
    );
    expect(parsed.parsedRows).toBe(2);
    expect(parsed.parseErrors).toBe(1);
    expect((parsed.rows[0] as any).event).toBe("chat");
    expect((parsed.rows[1] as any).event).toBe("chat-thread-config");
  });

  it("returns empty result for non-string input", () => {
    expect(parseChatPreviewRows(undefined as any)).toEqual({
      rows: [],
      parsedRows: 0,
      parseErrors: 0,
    });
  });

  it("parses native immer chat syncdoc content", () => {
    const doc = from_str(
      "",
      ["date", "sender_id", "event", "message_id", "thread_id"],
      ["input"],
    )
      .set({
        event: "chat-thread-config",
        sender_id: "system",
        date: "2026-03-20T05:59:00.000Z",
        thread_id: "thread-1",
        name: "Native Thread",
      })
      .set({
        event: "chat",
        sender_id: "alice",
        date: "2026-03-20T06:00:00.000Z",
        message_id: "message-1",
        thread_id: "thread-1",
        history: [
          {
            author_id: "alice",
            content: "Hello from native chat.",
            date: "2026-03-20T06:00:00.000Z",
          },
        ],
      });

    const parsed = parseChatPreviewRows(doc.to_str());
    expect(parsed.parseErrors).toBe(0);
    expect(parsed.parsedRows).toBe(2);
    expect(parsed.rows.map((row) => row.event).sort()).toEqual([
      "chat",
      "chat-thread-config",
    ]);
  });
});
