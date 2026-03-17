import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";

import {
  appendStreamMessage,
  getAgentMessageTexts,
  getBestResponseText,
  getInterruptedResponseMarkdown,
  getLiveResponseMarkdown,
  getLatestEventLineText,
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
    expect((merged[0] as any).event.text).toBe(
      "**First block**\n\n**Second block**",
    );
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
    expect((merged[0] as any).event.text).toBe(
      "**First block** **Second block**",
    );
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
    const events: AcpStreamMessage[] = [textEvent("message", "final", 1)];
    expect(getBestResponseText(events)).toBe("final");
  });

  test("returns only the latest textual event line", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "first line", 1),
      textEvent("thinking", "second line", 2),
      textEvent("message", "latest line", 3),
    ];
    expect(getLatestEventLineText(events)).toBe("latest line");
  });

  test("returns all distinct agent message blocks in order", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "first", 1),
      textEvent("message", "first", 2),
      textEvent("thinking", "reasoning", 3),
      textEvent("message", "second", 4),
    ];
    expect(getAgentMessageTexts(events)).toEqual(["first", "second"]);
  });

  test("replaces progressive partial agent messages instead of duplicating them", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "I", 1),
      textEvent("message", "I'm", 2),
      textEvent("message", "I'm testing", 3),
    ];
    expect(getAgentMessageTexts(events)).toEqual(["I'm testing"]);
    expect(getLiveResponseMarkdown(events)).toBe("I'm testing");
  });

  test("replaces earlier agent text that differs only by transient code-span spacing", () => {
    const events: AcpStreamMessage[] = [
      textEvent(
        "message",
        "I’m running ` sleep 20` in ` bash` exactly as requested.",
        1,
      ),
      textEvent(
        "message",
        "I’m running `sleep 20` in `bash` exactly as requested.",
        2,
      ),
    ];
    expect(getAgentMessageTexts(events)).toEqual([
      "I’m running `sleep 20` in `bash` exactly as requested.",
    ]);
    expect(getInterruptedResponseMarkdown(events, "Conversation interrupted.")).toBe(
      "I’m running `sleep 20` in `bash` exactly as requested.\n\nConversation interrupted.",
    );
  });

  test("builds live markdown from agent messages plus streamed summary", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "first", 1),
      textEvent("thinking", "reasoning", 2),
      textEvent("message", "second", 3),
      {
        type: "summary",
        finalResponse: "final summary",
        seq: 4,
      } as AcpStreamMessage,
    ];
    expect(getLiveResponseMarkdown(events)).toBe(
      "first\n\nsecond\n\nfinal summary",
    );
  });

  test("replaces a partial live agent block when the streamed summary extends it", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "I", 1),
      {
        type: "summary",
        finalResponse: "I'm checking the code path now.",
        seq: 2,
      } as AcpStreamMessage,
    ];
    expect(getLiveResponseMarkdown(events)).toBe(
      "I'm checking the code path now.",
    );
  });

  test("does not duplicate the summary when it matches the latest agent block", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "final summary", 1),
      {
        type: "summary",
        finalResponse: "final summary",
        seq: 2,
      } as AcpStreamMessage,
    ];
    expect(getLiveResponseMarkdown(events)).toBe("final summary");
  });

  test("falls back to the latest text event before the first agent message", () => {
    const events: AcpStreamMessage[] = [
      textEvent("thinking", "reasoning 1", 1),
      textEvent("thinking", "reasoning 2", 2),
    ];
    expect(getLiveResponseMarkdown(events)).toBe("reasoning 2");
  });

  test("builds interrupted markdown from all agent blocks plus the notice", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "First paragraph.", 1),
      textEvent("message", "Second paragraph.", 2),
    ];
    expect(
      getInterruptedResponseMarkdown(events, "Conversation interrupted."),
    ).toBe(
      "First paragraph.\n\nSecond paragraph.\n\nConversation interrupted.",
    );
  });
});
