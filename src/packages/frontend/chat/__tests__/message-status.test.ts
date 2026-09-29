/** @jest-environment jsdom */

import { getLiveResponseBlocks } from "@cocalc/chat";
import {
  computeAcpStateToRender,
  acpMessageStatePresentation,
  getAcpMessageDeliveryLabel,
  guidanceMarkdown,
  shouldShowAcpResubmitToAgentButton,
} from "../message-state";
import "../../editors/slate/elements/types";
import { markdown_to_slate } from "../../editors/slate/markdown-to-slate";
import { slate_to_markdown } from "../../editors/slate/slate-to-markdown";

describe("runtime-aware message state", () => {
  test.each(["acp", "codex"] as const)(
    "labels %s submissions and retains non-running states",
    (runtimeKind) => {
      const name = runtimeKind === "acp" ? "ACP agent" : "Codex";
      for (const [state, label] of [
        ["sending", `submitting to ${name}`],
        ["sent", `waiting for ${name}`],
        ["running", `${name} is working`],
        ["error", "error"],
      ]) {
        expect(
          acpMessageStatePresentation({
            state,
            runtimeKind,
            isViewersMessage: true,
          }),
        ).toEqual({ label, canSteer: false });
      }
      expect(
        acpMessageStatePresentation({
          state: "running",
          runtimeKind,
          isViewersMessage: false,
        }).label,
      ).toBe("running");
    },
  );
  it("offers queued steering only for the native runtime", () => {
    expect(
      acpMessageStatePresentation({
        state: "queue",
        runtimeKind: "acp",
        isViewersMessage: true,
      }),
    ).toEqual({ label: "queue", canSteer: false });
    expect(
      acpMessageStatePresentation({
        state: "queue",
        runtimeKind: "codex",
        isViewersMessage: true,
      }),
    ).toEqual({ label: "queue", canSteer: true });
  });
  it("names Claude Code rather than the generic ACP agent", () => {
    expect(
      acpMessageStatePresentation({
        state: "running",
        runtimeKind: "acp",
        isViewersMessage: true,
        agentName: "Claude Code",
      }).label,
    ).toBe("Claude Code is working");
    expect(
      acpMessageStatePresentation({
        state: "sending",
        runtimeKind: "acp",
        isViewersMessage: true,
        agentName: "Claude Code",
      }).label,
    ).toBe("submitting to Claude Code");
  });
});

describe("getAcpMessageDeliveryLabel", () => {
  it("distinguishes a received sync answer from an ordinary posted comment", () => {
    expect(
      getAcpMessageDeliveryLabel({
        postOnly: true,
        attentionResponse: { response_id: "answer-1" },
        deliveredAtMs: 4100,
      }),
    ).toBe("Answer received by agent");
    expect(getAcpMessageDeliveryLabel({ postOnly: true })).toBe(
      "Posted · Not sent to agent",
    );
  });

  it.each([undefined, null, 0, -1, NaN, Infinity, "invalid"])(
    "does not claim receipt from an invalid timestamp %s",
    (deliveredAtMs) => {
      expect(
        getAcpMessageDeliveryLabel({
          postOnly: true,
          attentionResponse: { response_id: "answer-1" },
          deliveredAtMs,
        }),
      ).toBe("Answer saved · Receipt unconfirmed");
      expect(getAcpMessageDeliveryLabel({ deliveredAtMs })).toBeUndefined();
    },
  );

  it("shows a received guidance receipt instead of an indefinite waiting spinner", () => {
    expect(getAcpMessageDeliveryLabel({ deliveredAtMs: 5000 })).toBe(
      "Received by agent",
    );
    expect(getAcpMessageDeliveryLabel({})).toBeUndefined();
  });
});

describe("guidanceMarkdown", () => {
  it("keeps the latest suffix from cumulative live projection events", () => {
    const blocks = getLiveResponseBlocks([
      {
        type: "event",
        seq: 1,
        event: { type: "message", text: "Reviewing config objects" },
      },
      {
        type: "event",
        seq: 2,
        event: {
          type: "message",
          text: "Reviewing config objects changed.",
        },
      },
    ]);

    expect(blocks.map(({ text }) => text)).toEqual([
      "Reviewing config objects changed.",
    ]);
  });

  it("renders multi-paragraph guidance as one guidance element", () => {
    const markdown = guidanceMarkdown(
      "> quoted request\n\nFollow-up guidance.",
      "sent",
    );

    expect(markdown).toBe(
      "```guidance\n> quoted request\n\nFollow-up guidance.\n```",
    );
    const slate = markdown_to_slate(markdown, true);
    expect(slate.map((node: any) => node.type)).toEqual(["guidance"]);
    const guidance = slate[0] as any;
    expect(guidance.state).toBe("sent");
    expect(guidance.children.map((node: any) => node.type)).toEqual([
      "blockquote",
      "paragraph",
    ]);
    expect(slate_to_markdown(slate).trim()).toBe(markdown);
  });

  it("uses a longer outer fence when guidance contains fenced code", () => {
    const markdown = guidanceMarkdown(
      "Try this:\n\n```ts\nconst n = 1;\n```",
      "queued",
    );

    expect(markdown).toBe(
      "````guidance queued\nTry this:\n\n```ts\nconst n = 1;\n```\n````",
    );
    const slate = markdown_to_slate(markdown, true);
    expect((slate[0] as any).type).toBe("guidance");
    expect((slate[0] as any).state).toBe("queued");
    expect(slate_to_markdown(slate).trim()).toBe(markdown);
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
