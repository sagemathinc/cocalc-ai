/** @jest-environment jsdom */

import {
  codexActivityBlocksToSelectableMarkdown,
  computeAcpStateToRender,
  limitCodexActivityBlocks,
  shouldShowAcpResubmitToAgentButton,
} from "../message-state";
import "../../editors/slate/elements/types";
import { markdown_to_slate } from "../../editors/slate/markdown-to-slate";
import { slate_to_markdown } from "../../editors/slate/slate-to-markdown";

describe("codexActivityBlocksToSelectableMarkdown", () => {
  it("keeps agent and multi-paragraph guidance in one Markdown document", () => {
    const markdown = codexActivityBlocksToSelectableMarkdown([
      { kind: "agent", text: "Inspecting the project." },
      {
        kind: "guidance",
        text: "> quoted request\n\nFollow-up guidance.",
        state: "sent",
      },
      { kind: "agent", text: "The focused tests pass." },
    ]);

    expect(markdown).toBe(
      "Inspecting the project.\n\n" +
        "```guidance\n> quoted request\n\nFollow-up guidance.\n```\n\n" +
        "The focused tests pass.",
    );
    const slate = markdown_to_slate(markdown, true);
    expect(slate.map((node: any) => node.type)).toEqual([
      "paragraph",
      "guidance",
      "paragraph",
    ]);
    const guidance = slate[1] as any;
    expect(guidance.state).toBe("sent");
    expect(guidance.children.map((node: any) => node.type)).toEqual([
      "blockquote",
      "paragraph",
    ]);
    expect(slate_to_markdown(slate).trim()).toBe(markdown);
  });

  it("uses a longer outer fence when guidance contains fenced code", () => {
    const markdown = codexActivityBlocksToSelectableMarkdown([
      {
        kind: "guidance",
        state: "queued",
        text: "Try this:\n\n```ts\nconst n = 1;\n```",
      },
    ]);

    expect(markdown).toBe(
      "````guidance queued\nTry this:\n\n```ts\nconst n = 1;\n```\n````",
    );
    const slate = markdown_to_slate(markdown, true);
    expect((slate[0] as any).type).toBe("guidance");
    expect((slate[0] as any).state).toBe("queued");
    expect(slate_to_markdown(slate).trim()).toBe(markdown);
  });
});

describe("limitCodexActivityBlocks", () => {
  const blocks = Array.from({ length: 250 }, (_, index) => ({
    kind: "agent" as const,
    text: `activity ${index}`,
  }));

  it("shows the newest capped window and reports hidden activity", () => {
    const result = limitCodexActivityBlocks(blocks, 100);
    expect(result.hiddenCount).toBe(150);
    expect(result.visibleBlocks).toHaveLength(100);
    expect(result.visibleBlocks[0].text).toBe("activity 150");
    expect(result.visibleBlocks[99].text).toBe("activity 249");
  });

  it("supports loading earlier activity in bounded pages", () => {
    const result = limitCodexActivityBlocks(blocks, 200);
    expect(result.hiddenCount).toBe(50);
    expect(result.visibleBlocks).toHaveLength(200);
    expect(result.visibleBlocks[0].text).toBe("activity 50");
  });
});

describe("computeAcpStateToRender", () => {
  it("hides queue state for non-viewer messages", () => {
    const state = computeAcpStateToRender({
      acpState: "queue",
      latestThreadInterrupted: false,
      isViewersMessage: false,
      generating: false,
    });
    expect(state).toBe("");
  });

  it("shows queue state for viewer messages", () => {
    const state = computeAcpStateToRender({
      acpState: "queue",
      latestThreadInterrupted: false,
      isViewersMessage: true,
      generating: false,
    });
    expect(state).toBe("queue");
  });

  it("shows pre-run sending states for viewer messages", () => {
    expect(
      computeAcpStateToRender({
        acpState: "sending",
        latestThreadInterrupted: false,
        isViewersMessage: true,
        generating: false,
      }),
    ).toBe("sending");
    expect(
      computeAcpStateToRender({
        acpState: "sent",
        latestThreadInterrupted: false,
        isViewersMessage: true,
        generating: false,
      }),
    ).toBe("sent");
  });

  it("shows running state for viewer messages until the assistant row exists", () => {
    expect(
      computeAcpStateToRender({
        acpState: "running",
        latestThreadInterrupted: false,
        isViewersMessage: true,
        generating: false,
        showViewerRunning: true,
      }),
    ).toBe("running");
  });

  it("hides running state for viewer messages after the assistant row exists", () => {
    expect(
      computeAcpStateToRender({
        acpState: "running",
        latestThreadInterrupted: false,
        isViewersMessage: true,
        generating: false,
        showViewerRunning: false,
      }),
    ).toBe("");
    expect(
      computeAcpStateToRender({
        acpState: "running",
        latestThreadInterrupted: false,
        isViewersMessage: true,
        generating: false,
        showViewerRunning: false,
      }),
    ).toBe("");
  });

  it("hides running state for non-viewer messages unless generating", () => {
    expect(
      computeAcpStateToRender({
        acpState: "running",
        latestThreadInterrupted: false,
        isViewersMessage: false,
        generating: false,
      }),
    ).toBe("");
    expect(
      computeAcpStateToRender({
        acpState: "running",
        latestThreadInterrupted: false,
        isViewersMessage: false,
        generating: true,
      }),
    ).toBe("running");
  });

  it("clears running state when the latest thread message is interrupted", () => {
    const state = computeAcpStateToRender({
      acpState: "running",
      latestThreadInterrupted: true,
      isViewersMessage: true,
      generating: true,
    });
    expect(state).toBe("");
  });
});

describe("shouldShowAcpResubmitToAgentButton", () => {
  const base = {
    hasActions: true,
    hasParentMessage: true,
    isViewersMessage: false,
    parentAcpState: "not-sent",
    readOnly: false,
    renderedValue: "Codex authentication expired.",
  };

  it("shows on assistant replies to failed frontend ACP submissions", () => {
    expect(shouldShowAcpResubmitToAgentButton(base)).toBe(true);
  });

  it("hides while the assistant turn is actively running", () => {
    expect(
      shouldShowAcpResubmitToAgentButton({
        ...base,
        isTurnRunning: true,
      }),
    ).toBe(false);
  });

  it("shows on active terminal thread errors without parent not-sent state", () => {
    expect(
      shouldShowAcpResubmitToAgentButton({
        ...base,
        parentAcpState: undefined,
        terminalThreadErrorActive: true,
      }),
    ).toBe(true);
  });

  it("hides without parent not-sent state or an active terminal thread error", () => {
    expect(
      shouldShowAcpResubmitToAgentButton({
        ...base,
        parentAcpState: "queue",
      }),
    ).toBe(false);
  });

  it("hides for viewer messages and read-only chats", () => {
    expect(
      shouldShowAcpResubmitToAgentButton({
        ...base,
        isViewersMessage: true,
      }),
    ).toBe(false);
    expect(
      shouldShowAcpResubmitToAgentButton({
        ...base,
        readOnly: true,
      }),
    ).toBe(false);
  });
});
