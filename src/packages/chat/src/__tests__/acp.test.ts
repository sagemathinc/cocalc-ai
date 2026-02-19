import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";

import { appendStreamMessage } from "../acp";

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
});
