import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";

import {
  appendStreamMessage,
  getBestResponseText,
  getLatestMessageText,
  getLatestSummaryText,
} from "../acp";

function textEvent(
  type: "thinking" | "message",
  text: string,
  seq: number,
): AcpStreamMessage {
  return {
    type: "event",
    event: { type, text } as any,
    seq,
  } as AcpStreamMessage;
}

describe("appendStreamMessage", () => {
  test("adds paragraph break between adjacent markdown bold blocks", () => {
    const events = [textEvent("thinking", "**First block**", 1)];
    const merged = appendStreamMessage(
      events,
      textEvent("thinking", "**Second block**", 2),
    );

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe("**First block**\n\n**Second block**");
  });

  test("does not change plain token streaming", () => {
    const events = [textEvent("message", "hel", 1)];
    const merged = appendStreamMessage(events, textEvent("message", "lo", 2));

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe("hello");
  });

  test("keeps existing whitespace boundaries intact", () => {
    const events = [textEvent("thinking", "**First block** ", 1)];
    const merged = appendStreamMessage(
      events,
      textEvent("thinking", "**Second block**", 2),
    );

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe("**First block** **Second block**");
  });

  test("inserts a separating space between sentence chunks", () => {
    const events = [textEvent("message", "commit.", 1)];
    const merged = appendStreamMessage(
      events,
      textEvent("message", "I found a follow-up", 2),
    );

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe("commit. I found a follow-up");
  });
});

describe("response text helpers", () => {
  test("returns latest merged message text", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "Hel", 1),
      textEvent("message", "lo", 2),
    ];
    expect(getLatestMessageText(events)).toBe("Hello");
  });

  test("merges incremental summary chunks", () => {
    const events: AcpStreamMessage[] = [
      { type: "summary", finalResponse: "Hello", seq: 1 } as AcpStreamMessage,
      { type: "summary", finalResponse: " world", seq: 2 } as AcpStreamMessage,
    ];
    expect(getLatestSummaryText(events)).toBe("Hello world");
  });

  test("prefers summary text over streamed message text", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "draft", 1),
      { type: "summary", finalResponse: "final", seq: 2 } as AcpStreamMessage,
    ];
    expect(getBestResponseText(events)).toBe("final");
  });

  test("falls back to message text when summary is absent", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "final", 1),
    ];
    expect(getBestResponseText(events)).toBe("final");
  });
});
