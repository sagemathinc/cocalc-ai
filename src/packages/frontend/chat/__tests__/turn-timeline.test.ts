import type { ArtifactPublication } from "@cocalc/chat";
import { buildTurnTimelineRows, splitAgentMarkdown } from "../turn-timeline";

function publication(
  artifact_id: string,
  published_at: string,
): ArtifactPublication {
  return {
    artifact_id,
    published_at,
    event: "chat-artifact-publication",
    sender_id: "agent",
    date: published_at,
    schema_version: 1,
    operation_id: `op-${artifact_id}`,
    message_id: "assistant-1",
    thread_id: "thread-1",
    snapshot: { title: artifact_id, markdown: "" },
  } as ArtifactPublication;
}

describe("splitAgentMarkdown", () => {
  it("keeps short output in one row", () => {
    expect(splitAgentMarkdown("one\n\ntwo", 100)).toEqual(["one\n\ntwo"]);
  });

  it("packs whole paragraphs into rows", () => {
    const text = ["a".repeat(40), "b".repeat(40), "c".repeat(40)].join("\n\n");
    expect(splitAgentMarkdown(text, 90)).toEqual([
      `${"a".repeat(40)}\n\n${"b".repeat(40)}`,
      "c".repeat(40),
    ]);
  });

  it("splits an oversized code block into valid fenced parts", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const text = `Intro\n\n\`\`\`ts\n${lines.join("\n")}\n\`\`\``;
    const parts = splitAgentMarkdown(text, 80);
    expect(parts[0]).toBe("Intro");
    for (const part of parts.slice(1)) {
      expect(part.startsWith("```ts\n")).toBe(true);
      expect(part.endsWith("\n```")).toBe(true);
      expect(part.length).toBeLessThanOrEqual(80);
    }
    expect(
      parts
        .slice(1)
        .map((part) => part.slice("```ts\n".length, -"\n```".length))
        .join("\n"),
    ).toBe(lines.join("\n"));
  });

  it("closes a code block that is still streaming", () => {
    const text = `\`\`\`\n${"x\n".repeat(50)}`;
    for (const part of splitAgentMarkdown(text, 40)) {
      expect(part.startsWith("```\n")).toBe(true);
      expect(part.endsWith("\n```")).toBe(true);
    }
  });

  it("keeps finished parts unchanged as the output grows", () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) =>
      `paragraph ${i} `.repeat(5),
    );
    const before = splitAgentMarkdown(
      paragraphs.slice(0, 10).join("\n\n"),
      200,
    );
    const after = splitAgentMarkdown(paragraphs.join("\n\n"), 200);
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
  });
});

describe("buildTurnTimelineRows", () => {
  it("orders agent output, guidance, and artifacts with stable ids", () => {
    const rows = buildTurnTimelineRows({
      blocks: [
        { kind: "agent", text: "Planning", time: 1000 },
        { kind: "guidance", text: "use tabs", time: 1500, state: "sent" },
        { kind: "agent", text: "Published the plan", time: 2000 },
        { kind: "agent", text: "Done", time: 4000 },
      ],
      artifacts: [
        publication("late", new Date(9000).toISOString()),
        publication("plan", new Date(3000).toISOString()),
      ],
    });
    expect(rows.map((row) => row.id)).toEqual([
      "agent:0:0",
      "guidance:1500:0",
      "agent:1:0",
      "artifact:plan",
      "agent:2:0",
      "artifact:late",
    ]);
  });

  it("skips empty blocks and splits long agent blocks into rows", () => {
    const text = Array.from({ length: 4 }, () => "z".repeat(30)).join("\n\n");
    const rows = buildTurnTimelineRows({
      blocks: [
        { kind: "agent", text: "  " },
        { kind: "agent", text },
      ],
      maxChars: 70,
    });
    expect(rows.map((row) => row.id)).toEqual(["agent:0:0", "agent:0:1"]);
  });
});
