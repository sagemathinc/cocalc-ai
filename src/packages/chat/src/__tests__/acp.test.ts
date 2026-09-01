import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";

import {
  appendStreamMessage,
  appendStreamMessages,
  getAgentMessageTexts,
  getBestResponseText,
  getInterruptedResponseMarkdown,
  getLiveResponseBlocks,
  getLiveResponseMarkdown,
  getMountedIntermediateResponseBlocks,
  getMountedIntermediateResponseMarkdown,
  getLatestEventLineText,
  getLatestMessageText,
  getLatestSummaryText,
  mergeProgressiveMessageText,
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
  test("never deduplicates a raw delta against the accumulated prefix", () => {
    expect(
      mergeProgressiveMessageText("Initial update.", "I", {
        previousHasDelta: true,
        nextIsDelta: true,
      }),
    ).toBe("Initial update. I");
  });

  test("compares whitespace-normalized snapshots without changing their text", () => {
    const previous = "  Alpha   `  beta  `\n gamma  ";
    const next = "Alpha `beta` gamma   delta";

    expect(mergeProgressiveMessageText(previous, next)).toBe(next);
    expect(mergeProgressiveMessageText(next, previous)).toBe(next);
  });

  test("matches the allocating normalization behavior across mixed text", () => {
    const referenceMerge = (previous: string, next: string) => {
      if (!previous || !next) return undefined;
      if (next.startsWith(previous)) return next;
      if (previous.startsWith(next) || previous.endsWith(next)) return previous;
      const normalize = (text: string) =>
        text
          .replace(/`\s+/g, "`")
          .replace(/\s+`/g, "`")
          .replace(/\s+/g, " ")
          .trim();
      const normalizedPrevious = normalize(previous);
      const normalizedNext = normalize(next);
      if (!normalizedPrevious || !normalizedNext) return undefined;
      if (normalizedNext.startsWith(normalizedPrevious)) return next;
      if (normalizedPrevious.startsWith(normalizedNext)) return previous;
      if (normalizedPrevious === normalizedNext) {
        return next.length >= previous.length ? next : previous;
      }
      return undefined;
    };
    let state = 0x5eed1234;
    const alphabet = ["a", "b", "`", " ", "\n", "\t", "\u00a0"];
    const randomText = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      const length = state % 80;
      let text = "";
      for (let i = 0; i < length; i += 1) {
        state = (state * 1664525 + 1013904223) >>> 0;
        text += alphabet[state % alphabet.length];
      }
      return text;
    };

    for (let i = 0; i < 2_000; i += 1) {
      const previous = randomText();
      const next = randomText();
      expect(mergeProgressiveMessageText(previous, next)).toBe(
        referenceMerge(previous, next),
      );
    }
  });

  test("does not merge normalized-empty snapshots into delta streams", () => {
    expect(
      mergeProgressiveMessageText(" \n\t ", "\u00a0", {
        previousHasDelta: true,
      }),
    ).toBeUndefined();
  });

  test("handles large formatting-changing snapshots repeatedly", () => {
    const words = Array.from({ length: 5_000 }, (_, index) => `word${index}`);
    const previous = words.join("  ");
    const next = `${words.join(" ")} final`;
    const events = [
      textEvent("message", previous, 1),
      textEvent("message", next, 2),
    ];

    for (let i = 0; i < 20; i += 1) {
      expect(getLiveResponseMarkdown(events)).toBe(next);
      expect(getLiveResponseBlocks(events)).toEqual([
        {
          kind: "agent",
          text: next,
          time: undefined,
          state: undefined,
        },
      ]);
    }
  });

  test("compacts long progressive runs without losing guidance chronology", () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`);
    const events = words.map((_, index) => ({
      type: "event",
      event: {
        type: "message",
        text: words.slice(0, index + 1).join(" "),
      },
      seq: index + 1,
      time: (index + 1) * 1_000,
    })) as AcpStreamMessage[];

    expect(
      getLiveResponseBlocks(events, [
        { date: 19_500, text: "check this too", state: "sent" },
      ]),
    ).toEqual([
      {
        kind: "agent",
        text: words.slice(0, 19).join(" "),
        time: 19_000,
        state: undefined,
      },
      {
        kind: "guidance",
        text: "check this too",
        time: 19_500,
        state: "sent",
      },
      {
        kind: "agent",
        text: words.slice(19).join(" "),
        time: 40_000,
        state: undefined,
      },
    ]);
  });

  test("does not compact long runs of independent agent messages", () => {
    const events = Array.from({ length: 20 }, (_, index) =>
      textEvent("message", `independent block ${index}`, index + 1),
    );
    expect(getAgentMessageTexts(events)).toEqual(
      Array.from({ length: 20 }, (_, index) => `independent block ${index}`),
    );
  });

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

  test("does not insert a space inside decimal numbers split across chunks", () => {
    const events = [textEvent("message", "31.", 1)];
    const merged = appendStreamMessage(events, textEvent("message", "7", 2));

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe("31.7");
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

  test("does not insert a space after a single-star emphasis opener", () => {
    const events = [textEvent("message", "with the *", 1)];
    const merged = appendStreamMessage(
      events,
      textEvent("message", "original* stale host row", 2),
    );

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe(
      "with the *original* stale host row",
    );
  });

  test("does not insert a space after a double-star emphasis opener", () => {
    const events = [textEvent("message", "with the **", 1)];
    const merged = appendStreamMessage(
      events,
      textEvent("message", "original** stale host row", 2),
    );

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe(
      "with the **original** stale host row",
    );
  });

  test("does not insert a space inside dotfile markdown links", () => {
    const events = [textEvent("message", "[.", 1)];
    const merged = appendStreamMessage(
      events,
      textEvent(
        "message",
        "local/hub-daemon.env](/home/wstein/build/cocalc-lite2/src/.local/hub-daemon.env)",
        2,
      ),
    );

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe(
      "[.local/hub-daemon.env](/home/wstein/build/cocalc-lite2/src/.local/hub-daemon.env)",
    );
  });

  test("does not insert a space inside markdown file names split at an extension dot", () => {
    const events = [textEvent("message", "[README.", 1)];
    const merged = appendStreamMessage(
      events,
      textEvent(
        "message",
        "md](/home/wstein/build/cocalc-lite2/src/README.md)",
        2,
      ),
    );

    expect(merged).toHaveLength(1);
    expect((merged[0] as any).event.text).toBe(
      "[README.md](/home/wstein/build/cocalc-lite2/src/README.md)",
    );
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

describe("appendStreamMessages", () => {
  test("matches repeated single-message appends", () => {
    const start = [textEvent("message", "Hel", 1)];
    const batch = [
      textEvent("message", "lo", 2),
      textEvent("message", ".", 3),
      textEvent("thinking", "Next", 4),
    ];

    const repeated = batch.reduce(
      (events, message) => appendStreamMessage(events, message),
      start,
    );
    const merged = appendStreamMessages(start, batch);

    expect(merged).toEqual(repeated);
  });

  test("preserves progressive full snapshots for live projection", () => {
    const merged = appendStreamMessages(
      [],
      [
        textEvent("message", "I", 1),
        textEvent("message", "I'm", 2),
        textEvent("message", "I'm testing", 3),
      ],
    );

    expect(merged).toHaveLength(3);
    expect(getLiveResponseMarkdown(merged)).toBe("I'm testing");
  });

  test("preserves paragraph boundaries while appending message-only preview deltas", () => {
    const merged = appendStreamMessages(
      [],
      [
        textEvent("message", "I checked the preview stream.", 1, {
          delta: true,
        }),
        textEvent(
          "message",
          "The frontend should preserve this paragraph.",
          2,
          {
            delta: true,
          },
        ),
        textEvent(
          "message",
          "The completed activity log already formats it correctly.",
          3,
          { delta: true },
        ),
      ],
    );

    expect(merged).toHaveLength(1);
    expect(((merged[0] as any).event.text as string).split("\n\n")).toEqual([
      "I checked the preview stream.",
      "The frontend should preserve this paragraph.",
      "The completed activity log already formats it correctly.",
    ]);
    expect(getLiveResponseMarkdown(merged)).toBe(
      "I checked the preview stream.\n\nThe frontend should preserve this paragraph.\n\nThe completed activity log already formats it correctly.",
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

  test("interleaves live guidance between timed agent message blocks", () => {
    const events: AcpStreamMessage[] = [
      {
        type: "event",
        event: { type: "message", text: "first" },
        seq: 1,
        time: 1000,
      } as any,
      {
        type: "event",
        event: { type: "message", text: "second" },
        seq: 2,
        time: 3000,
      } as any,
    ];
    expect(
      getLiveResponseBlocks(events, [
        { date: 2000, text: "please check X", state: "sent" },
      ]),
    ).toEqual([
      { kind: "agent", text: "first", time: 1000, state: undefined },
      {
        kind: "guidance",
        text: "please check X",
        time: 2000,
        state: "sent",
      },
      { kind: "agent", text: "second", time: 3000, state: undefined },
    ]);
  });

  test("uses lightweight preview status boundaries for guidance ordering", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "I checked the preview stream.", 1, {
        delta: true,
      }),
      { type: "status", state: "running", seq: 2, time: 2000 } as any,
      textEvent("message", "The frontend should preserve this paragraph.", 3, {
        delta: true,
      }),
    ];
    (events[0] as any).time = 1000;
    (events[2] as any).time = 3000;

    expect(
      getLiveResponseBlocks(events, [
        { date: 2500, text: "please keep this in order", state: "sent" },
      ]),
    ).toEqual([
      {
        kind: "agent",
        text: "I checked the preview stream.",
        time: 1000,
        state: undefined,
      },
      {
        kind: "guidance",
        text: "please keep this in order",
        time: 2500,
        state: "sent",
      },
      {
        kind: "agent",
        text: "The frontend should preserve this paragraph.",
        time: 3000,
        state: undefined,
      },
    ]);
  });

  test("splits progressive agent text around live guidance chronologically", () => {
    const events: AcpStreamMessage[] = [
      {
        type: "event",
        event: { type: "message", text: "I'm going to inspect the host." },
        seq: 1,
        time: 1000,
      } as any,
      {
        type: "event",
        event: {
          type: "message",
          text: "I'm going to inspect the host. The remote probe is still running.",
        },
        seq: 2,
        time: 3000,
      } as any,
    ];
    expect(
      getLiveResponseBlocks(events, [
        { date: 2000, text: "please check the proxy too", state: "sent" },
      ]),
    ).toEqual([
      {
        kind: "agent",
        text: "I'm going to inspect the host.",
        time: 1000,
        state: undefined,
      },
      {
        kind: "guidance",
        text: "please check the proxy too",
        time: 2000,
        state: "sent",
      },
      {
        kind: "agent",
        text: "The remote probe is still running.",
        time: 3000,
        state: undefined,
      },
    ]);
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
    expect(getLiveResponseBlocks(events)).toEqual([
      {
        kind: "agent",
        text: "Live Codex output reaches the chat UI through the log.",
        time: undefined,
        state: undefined,
      },
    ]);
  });

  test("preserves exact whitespace in recovered deltas interleaved with terminal output", () => {
    const events: AcpStreamMessage[] = [
      textEvent(
        "message",
        "It has deterministic cleanup and compile-time",
        1002,
        { delta: true },
      ),
      {
        type: "event",
        seq: 1003,
        event: {
          type: "terminal",
          terminalId: "background-build",
          phase: "data",
          chunk: "building...",
        },
      } as any,
      textEvent(
        "message",
        " owner-escape rejection. I would prototype one witness now",
        1054,
        { delta: true },
      ),
      {
        type: "event",
        seq: 1055,
        event: {
          type: "terminal",
          terminalId: "background-build",
          phase: "data",
          chunk: "still building...",
        },
      } as any,
      textEvent(
        "message",
        "\u2014preferably one exact coordinate vector.",
        1127,
        { delta: true },
      ),
      { type: "status", state: "running", seq: 1128 } as any,
    ];

    expect(getLiveResponseBlocks(events)).toEqual([
      {
        kind: "agent",
        text: "It has deterministic cleanup and compile-time owner-escape rejection. I would prototype one witness now\u2014preferably one exact coordinate vector.",
        time: undefined,
        state: undefined,
      },
    ]);
  });

  test("preserves completed agent-message paragraphs during interruption recovery", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "First", 1, { delta: true }),
      textEvent("message", " update.", 2, { delta: true }),
      { type: "status", state: "running", seq: 3 } as any,
      {
        type: "event",
        seq: 4,
        event: {
          type: "terminal",
          terminalId: "build",
          phase: "exit",
          exitStatus: { exitCode: 0 },
        },
      } as any,
      textEvent("message", "Second", 5, { delta: true }),
      textEvent("message", " update.", 6, { delta: true }),
      { type: "status", state: "running", seq: 7 } as any,
    ];

    expect(getInterruptedResponseMarkdown(events, "Turn interrupted.")).toBe(
      "First update.\n\nSecond update.\n\nTurn interrupted.",
    );
  });

  test("appends generated blob images to live and final response markdown", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "Here is the generated image.", 1),
      {
        type: "event",
        seq: 2,
        event: {
          type: "image",
          status: "completed",
          blob: {
            uuid: "blob-1",
            filename: "image.png",
            url: "/blobs/image.png?uuid=blob-1",
          },
        },
      } as any,
      {
        type: "summary",
        seq: 3,
        finalResponse: "Here is the generated image.",
      } as any,
    ];
    const expected =
      "Here is the generated image.\n\n![Generated image](/blobs/image.png?uuid=blob-1)";
    expect(getLiveResponseMarkdown(events)).toBe(expected);
    expect(getBestResponseText(events)).toBe(expected);
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

  test("keeps message-only preview deltas as separate paragraphs", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "I checked the preview stream.", 1, { delta: true }),
      textEvent("message", "The frontend should preserve this paragraph.", 2, {
        delta: true,
      }),
      textEvent(
        "message",
        "The completed activity log already formats it correctly.",
        3,
        { delta: true },
      ),
    ];
    expect(getAgentMessageTexts(events)).toEqual([
      "I checked the preview stream.\n\nThe frontend should preserve this paragraph.\n\nThe completed activity log already formats it correctly.",
    ]);
    expect(getLiveResponseMarkdown(events)).toBe(
      "I checked the preview stream.\n\nThe frontend should preserve this paragraph.\n\nThe completed activity log already formats it correctly.",
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

  test("drops the final duplicated summary block from mounted intermediate markdown", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "first", 1),
      textEvent("thinking", "reasoning", 2),
      textEvent("message", "second", 3),
      textEvent("message", "**final summary**", 4),
      {
        type: "summary",
        finalResponse: "**final summary**",
        seq: 5,
      } as AcpStreamMessage,
    ];
    expect(getMountedIntermediateResponseMarkdown(events)).toBe(
      "first\n\nsecond",
    );
  });

  test("keeps mounted intermediate blocks when there is no duplicated summary block", () => {
    const events: AcpStreamMessage[] = [
      {
        type: "event",
        event: { type: "message", text: "first" },
        seq: 1,
        time: 1000,
      } as any,
      {
        type: "event",
        event: { type: "message", text: "second" },
        seq: 2,
        time: 3000,
      } as any,
    ];
    expect(
      getMountedIntermediateResponseBlocks(events, [
        { date: 2000, text: "please check X", state: "sent" },
      ]),
    ).toEqual([
      { kind: "agent", text: "first", time: 1000, state: undefined },
      {
        kind: "guidance",
        text: "please check X",
        time: 2000,
        state: "sent",
      },
      { kind: "agent", text: "second", time: 3000, state: undefined },
    ]);
  });

  test("drops only the final duplicated summary block from mounted intermediate response blocks", () => {
    const events: AcpStreamMessage[] = [
      {
        type: "event",
        event: { type: "message", text: "first" },
        seq: 1,
        time: 1000,
      } as any,
      {
        type: "event",
        event: { type: "message", text: "second" },
        seq: 2,
        time: 3000,
      } as any,
      {
        type: "summary",
        finalResponse: "second",
        seq: 3,
        time: 4000,
      } as any,
    ];
    expect(
      getMountedIntermediateResponseBlocks(events, [
        { date: 2000, text: "please check X", state: "sent" },
      ]),
    ).toEqual([
      { kind: "agent", text: "first", time: 1000, state: undefined },
      {
        kind: "guidance",
        text: "please check X",
        time: 2000,
        state: "sent",
      },
    ]);
  });

  test("treats non-message activity as a boundary between progressive agent messages", () => {
    const events: AcpStreamMessage[] = [
      {
        type: "event",
        event: { type: "message", text: "I traced the activity reducer." },
        seq: 1,
        time: 1000,
      } as any,
      {
        type: "event",
        event: {
          type: "file",
          path: "src/packages/frontend/chat/message.tsx",
          operation: "read",
        },
        seq: 2,
        time: 2000,
      } as any,
      {
        type: "event",
        event: {
          type: "message",
          text: "I traced the activity reducer.\n\nThe inline path was merging across tool events.",
        },
        seq: 3,
        time: 3000,
      } as any,
      {
        type: "summary",
        finalResponse:
          "I traced the activity reducer.\n\nThe inline path was merging across tool events.",
        seq: 4,
        time: 4000,
      } as any,
    ];
    expect(getLiveResponseBlocks(events)).toEqual([
      {
        kind: "agent",
        text: "I traced the activity reducer.",
        time: 1000,
        state: undefined,
      },
      {
        kind: "agent",
        text: "The inline path was merging across tool events.",
        time: 3000,
        state: undefined,
      },
    ]);
    expect(getMountedIntermediateResponseBlocks(events)).toEqual([
      {
        kind: "agent",
        text: "I traced the activity reducer.",
        time: 1000,
        state: undefined,
      },
    ]);
  });

  test("keeps a single mounted intermediate markdown block when there is no summary to trim against", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "**final summary**", 1),
    ];
    expect(getMountedIntermediateResponseMarkdown(events)).toBe(
      "**final summary**",
    );
  });

  test("returns nothing for mounted intermediate markdown when the only block duplicates the summary", () => {
    const events: AcpStreamMessage[] = [
      textEvent("message", "**final summary**", 1),
      {
        type: "summary",
        finalResponse: "**final summary**",
        seq: 2,
      } as AcpStreamMessage,
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
