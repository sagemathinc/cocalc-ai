import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";

import {
  appendStreamMessage,
  getAgentMessageTexts,
  getBestResponseText,
  getInterruptedResponseMarkdown,
  getLiveResponseMarkdown,
  getMountedIntermediateResponseMarkdown,
  getLatestEventLineText,
  getLatestMessageText,
  getLatestSummaryText,
} from "../acp";

function textEvent(
  type: "thinking" | "message",
  text: string,
  seq: number,
  opts?: { delta?: boolean },
): AcpStreamMessage {
  return {
    type: "event",
    event: { type, text, ...(opts?.delta ? { delta: true } : {}) } as any,
    seq,
  } as AcpStreamMessage;
}

describe("appendStreamMessage", () => {
  test("adds a separating space between adjacent markdown bold blocks", () => {
    const events = [textEvent("thinking", "**First block**", 1)];
    const merged = appendStreamMessage(
      events,
      textEvent("thinking", "**Second block**", 2),
    );

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe(
      "**First block** **Second block**",
    );
  });

  test("does not change plain token streaming", () => {
    const events = [textEvent("message", "hel", 1)];
    const merged = appendStreamMessage(events, textEvent("message", "lo", 2));

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe("hello");
  });

  test("does not insert spaces inside camel-case product names", () => {
    const events = [textEvent("message", "Co", 1)];
    const merged = appendStreamMessage(events, textEvent("message", "Calc", 2));

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe("CoCalc");
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

  test("does not insert a space inside markdown links", () => {
    const events = [textEvent("message", "[messages.txt]", 1)];
    const merged = appendStreamMessage(
      events,
      textEvent("message", "(/home/wstein/messages.txt)", 2),
    );

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe(
      "[messages.txt](/home/wstein/messages.txt)",
    );
  });

  test("does not insert a space inside inline code spans", () => {
    const events = [textEvent("message", "`src/.", 1)];
    const merged = appendStreamMessage(
      events,
      textEvent("message", "agents`", 2),
    );

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe("`src/.agents`");
  });

  test("inserts a paragraph break between large app-server chunks", () => {
    const events = [
      textEvent(
        "message",
        "I traced the app-server path through the live activity renderer and confirmed the chunks are arriving as separate agent deltas.",
        1,
      ),
    ];
    const merged = appendStreamMessage(
      events,
      textEvent(
        "message",
        "The main chat row should preserve this as a new paragraph instead of collapsing everything into one long block of text.",
        2,
      ),
    );

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe(
      "I traced the app-server path through the live activity renderer and confirmed the chunks are arriving as separate agent deltas.\n\nThe main chat row should preserve this as a new paragraph instead of collapsing everything into one long block of text.",
    );
  });

  test("inserts a paragraph break before a short emphasized section heading", () => {
    const events = [
      textEvent(
        "message",
        "If this barrier is the right fix, the ACP test should pass without widening the blast radius.",
        1,
      ),
    ];
    const merged = appendStreamMessage(
      events,
      textEvent("message", "** Iteration 1** Area", 2),
    );

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe(
      "If this barrier is the right fix, the ACP test should pass without widening the blast radius.\n\n** Iteration 1** Area",
    );
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

  test("merges interleaved streamed message deltas into one live paragraph", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "Live Codex output", 1, { delta: true }),
      textEvent("thinking", "thinking chunk", 2),
      textEvent("message", " reaches the chat UI", 3, { delta: true }),
      textEvent("thinking", "another reasoning chunk", 4),
      textEvent("message", " through the log.", 5, { delta: true }),
    ];
    expect(getAgentMessageTexts(events)).toEqual([
      "Live Codex output reaches the chat UI through the log.",
    ]);
    expect(getLiveResponseMarkdown(events)).toBe(
      "Live Codex output reaches the chat UI through the log.",
    );
  });

  test("keeps camel-case product names intact across interleaved deltas", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "Co", 1, { delta: true }),
      textEvent("thinking", "reasoning chunk", 2),
      textEvent("message", "Calc", 3, { delta: true }),
    ];
    expect(getAgentMessageTexts(events)).toEqual(["CoCalc"]);
    expect(getLiveResponseMarkdown(events)).toBe("CoCalc");
  });

  test("keeps large interleaved app-server deltas as separate paragraphs", () => {
    const events: AcpStreamMessage[] = [
      textEvent(
        "message",
        "I traced the app-server path through the live activity renderer and confirmed the chunks are arriving as separate agent deltas.",
        1,
        { delta: true },
      ),
      textEvent("thinking", "reasoning chunk", 2),
      textEvent(
        "message",
        "The main chat row should preserve this as a new paragraph instead of collapsing everything into one long block of text.",
        3,
        { delta: true },
      ),
    ];
    expect(getAgentMessageTexts(events)).toEqual([
      "I traced the app-server path through the live activity renderer and confirmed the chunks are arriving as separate agent deltas.\n\nThe main chat row should preserve this as a new paragraph instead of collapsing everything into one long block of text.",
    ]);
    expect(getLiveResponseMarkdown(events)).toBe(
      "I traced the app-server path through the live activity renderer and confirmed the chunks are arriving as separate agent deltas.\n\nThe main chat row should preserve this as a new paragraph instead of collapsing everything into one long block of text.",
    );
  });

  test("keeps short emphasized section headings on a new paragraph", () => {
    const events: AcpStreamMessage[] = [
      textEvent(
        "message",
        "If this barrier is the right fix, the ACP test should pass without widening the blast radius.",
        1,
        { delta: true },
      ),
      textEvent("thinking", "reasoning chunk", 2),
      textEvent("message", "** Iteration 1** Area", 3, { delta: true }),
    ];
    expect(getAgentMessageTexts(events)).toEqual([
      "If this barrier is the right fix, the ACP test should pass without widening the blast radius.\n\n** Iteration 1** Area",
    ]);
    expect(getLiveResponseMarkdown(events)).toBe(
      "If this barrier is the right fix, the ACP test should pass without widening the blast radius.\n\n** Iteration 1** Area",
    );
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
    expect(
      getInterruptedResponseMarkdown(events, "Conversation interrupted."),
    ).toBe(
      "I’m running `sleep 20` in `bash` exactly as requested.\n\nConversation interrupted.",
    );
  });

  test("builds live markdown from agent messages without appending the summary", () => {
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
    expect(getLiveResponseMarkdown(events)).toBe("first\n\nsecond");
  });

  test("drops the last agent message from mounted intermediate markdown", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "first", 1),
      textEvent("thinking", "reasoning", 2),
      textEvent("message", "second", 3),
      textEvent("message", "**final summary**", 4),
    ];
    expect(getMountedIntermediateResponseMarkdown(events)).toBe(
      "first\n\nsecond",
    );
  });

  test("returns nothing for mounted intermediate markdown when there is only one agent block", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "**final summary**", 1),
    ];
    expect(getMountedIntermediateResponseMarkdown(events)).toBeUndefined();
  });

  test("keeps the latest live agent block when the summary extends it", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "I", 1),
      {
        type: "summary",
        finalResponse: "I'm checking the code path now.",
        seq: 2,
      } as AcpStreamMessage,
    ];
    expect(getLiveResponseMarkdown(events)).toBe("I");
  });

  test("falls back to the summary when there are no agent blocks yet", () => {
    const events: AcpStreamMessage[] = [
      {
        type: "summary",
        finalResponse: "final summary",
        seq: 1,
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
