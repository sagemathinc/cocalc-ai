import { parseChatPreviewRows } from "../preview";

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
});
