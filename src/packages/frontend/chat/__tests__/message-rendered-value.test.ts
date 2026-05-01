/** @jest-environment jsdom */

import {
  ACP_THINKING_PLACEHOLDER,
  resolveEffectiveGenerating,
  resolveInlineCodexActivityMode,
  resolveMountedCodexRenderedValue,
  resolveRenderedMessageValue,
  canUseCompletedCachedCodexActivity,
  resolveCodexShowActivityButtonState,
  shouldLoadCodexPreviewBody,
  shouldShowCodexShowActivityButton,
  shouldSuppressAcpPlaceholderBody,
} from "../message";

describe("resolveRenderedMessageValue", () => {
  it("prefers row content when not generating and row has text", () => {
    expect(
      resolveRenderedMessageValue({
        rowValue: "row text",
        logValue: "log text",
        generating: false,
        interrupted: false,
      }),
    ).toBe("row text");
  });

  it("uses log content when generating", () => {
    expect(
      resolveRenderedMessageValue({
        rowValue: "row text",
        logValue: "live log text",
        generating: true,
        interrupted: false,
      }),
    ).toBe("live log text");
  });

  it("uses log content when row is blank", () => {
    expect(
      resolveRenderedMessageValue({
        rowValue: "",
        logValue: "log fallback",
        generating: false,
        interrupted: false,
      }),
    ).toBe("log fallback");
  });

  it("uses log content when the durable row is still the ACP placeholder", () => {
    expect(
      resolveRenderedMessageValue({
        rowValue: ACP_THINKING_PLACEHOLDER,
        logValue: "partial live output",
        generating: false,
        interrupted: false,
      }),
    ).toBe("partial live output");
  });

  it("falls back to row when log text is empty", () => {
    expect(
      resolveRenderedMessageValue({
        rowValue: "row text",
        logValue: "   ",
        generating: true,
        interrupted: false,
      }),
    ).toBe("row text");
  });

  it("prefers log content for interrupted Codex rows", () => {
    expect(
      resolveRenderedMessageValue({
        rowValue: ACP_THINKING_PLACEHOLDER,
        logValue: "full live output\n\nConversation interrupted.",
        generating: false,
        interrupted: true,
      }),
    ).toBe("full live output\n\nConversation interrupted.");
  });

  it("prefers durable interrupted row content once it is available", () => {
    expect(
      resolveRenderedMessageValue({
        rowValue: "Paragraph one.\n\nConversation interrupted.",
        logValue: "older log content",
        generating: false,
        interrupted: true,
      }),
    ).toBe("Paragraph one.\n\nConversation interrupted.");
  });

  it("suppresses the ACP placeholder body while Codex is still starting", () => {
    expect(
      shouldSuppressAcpPlaceholderBody({
        value: ACP_THINKING_PLACEHOLDER,
        showCodexActivity: true,
      }),
    ).toBe(true);

    expect(
      shouldSuppressAcpPlaceholderBody({
        value: ACP_THINKING_PLACEHOLDER,
        showCodexActivity: false,
      }),
    ).toBe(false);
  });

  it("treats interrupted Codex rows as no longer generating", () => {
    expect(
      resolveEffectiveGenerating({
        isCodexThread: true,
        generating: true,
        acpInterrupted: true,
      }),
    ).toBe(false);

    expect(
      resolveEffectiveGenerating({
        isCodexThread: true,
        generating: true,
        acpInterrupted: false,
      }),
    ).toBe(true);
  });
});

describe("resolveMountedCodexRenderedValue", () => {
  it("keeps mounted streamed Codex output and appends the final summary once", () => {
    expect(
      resolveMountedCodexRenderedValue({
        renderedValue: "final summary",
        mountedGeneratingPrefixValue: "streamed body still visible",
        showCodexActivity: true,
        generating: false,
        interrupted: false,
      }),
    ).toBe("streamed body still visible\n\nfinal summary");
  });

  it("falls back to the durable summary when there is no preserved intermediate prefix", () => {
    expect(
      resolveMountedCodexRenderedValue({
        renderedValue: "final summary",
        mountedGeneratingPrefixValue: undefined,
        showCodexActivity: true,
        generating: false,
        interrupted: false,
      }),
    ).toBe("final summary");
  });

  it("does not override non-Codex rows", () => {
    expect(
      resolveMountedCodexRenderedValue({
        renderedValue: "final summary",
        mountedGeneratingPrefixValue: "streamed body still visible",
        showCodexActivity: false,
        generating: false,
        interrupted: false,
      }),
    ).toBe("final summary");
  });

  it("does not override while the turn is still generating", () => {
    expect(
      resolveMountedCodexRenderedValue({
        renderedValue: "live body",
        mountedGeneratingPrefixValue: "older streamed body",
        showCodexActivity: true,
        generating: true,
        interrupted: false,
      }),
    ).toBe("live body");
  });
});

describe("resolveInlineCodexActivityMode", () => {
  it("forces live activity while a Codex turn is still generating", () => {
    expect(
      resolveInlineCodexActivityMode({
        showCodexActivity: true,
        generating: true,
        expandedCompletedActivity: false,
      }),
    ).toBe("live");
  });

  it("shows completed activity only when explicitly expanded", () => {
    expect(
      resolveInlineCodexActivityMode({
        showCodexActivity: true,
        generating: false,
        expandedCompletedActivity: true,
      }),
    ).toBe("completed");

    expect(
      resolveInlineCodexActivityMode({
        showCodexActivity: true,
        generating: false,
        expandedCompletedActivity: false,
      }),
    ).toBe("hidden");
  });

  it("stays hidden for non-Codex rows", () => {
    expect(
      resolveInlineCodexActivityMode({
        showCodexActivity: false,
        generating: true,
        expandedCompletedActivity: true,
      }),
    ).toBe("hidden");
  });
});

describe("shouldLoadCodexPreviewBody", () => {
  it("does not load completed Codex activity during passive rendering", () => {
    expect(
      shouldLoadCodexPreviewBody({
        showCodexActivity: true,
        projectId: "project-id",
        generating: false,
        interrupted: false,
        allowAsyncCompletedCodexActivityLoad: false,
        rowMessageValue: "durable summary",
      }),
    ).toBe(false);
  });

  it("allows async completed Codex activity loading only after explicit expansion", () => {
    expect(
      shouldLoadCodexPreviewBody({
        showCodexActivity: true,
        projectId: "project-id",
        generating: false,
        interrupted: false,
        allowAsyncCompletedCodexActivityLoad: true,
        rowMessageValue: "durable summary",
      }),
    ).toBe(true);
  });

  it("still loads when the durable row body is blank", () => {
    expect(
      shouldLoadCodexPreviewBody({
        showCodexActivity: true,
        projectId: "project-id",
        generating: false,
        interrupted: false,
        allowAsyncCompletedCodexActivityLoad: false,
        rowMessageValue: "   ",
      }),
    ).toBe(true);
  });
});

describe("shouldShowCodexShowActivityButton", () => {
  it("hides the button for the currently running turn", () => {
    expect(
      shouldShowCodexShowActivityButton({
        showCodexActivity: true,
        expandedCodexActivity: false,
        hasVisibleCompletedActivity: false,
        canToggle: true,
        effectiveGenerating: true,
        isLastMessageInThread: true,
      }),
    ).toBe(false);
  });

  it("shows the button for older Codex turns even while another turn is running", () => {
    expect(
      shouldShowCodexShowActivityButton({
        showCodexActivity: true,
        expandedCodexActivity: false,
        hasVisibleCompletedActivity: false,
        canToggle: true,
        effectiveGenerating: true,
        isLastMessageInThread: false,
      }),
    ).toBe(true);
  });

  it("shows the button when a completed row is marked expanded but has no visible cached activity", () => {
    expect(
      shouldShowCodexShowActivityButton({
        showCodexActivity: true,
        expandedCodexActivity: true,
        hasVisibleCompletedActivity: false,
        canToggle: true,
        effectiveGenerating: false,
        isLastMessageInThread: true,
      }),
    ).toBe(true);
  });

  it("hides the button when completed activity is already visible inline", () => {
    expect(
      shouldShowCodexShowActivityButton({
        showCodexActivity: true,
        expandedCodexActivity: true,
        hasVisibleCompletedActivity: true,
        canToggle: true,
        effectiveGenerating: false,
        isLastMessageInThread: true,
      }),
    ).toBe(false);
  });
});

describe("resolveCodexShowActivityButtonState", () => {
  it("shows a loading state after explicit expansion while activity is being fetched", () => {
    expect(
      resolveCodexShowActivityButtonState({
        allowAsyncCompletedCodexActivityLoad: true,
        hasVisibleCompletedActivity: false,
        hasLogRef: true,
        loadState: "loading",
      }),
    ).toEqual({
      label: "Loading activity...",
      loading: true,
      disabled: true,
    });
  });

  it("marks missing completed activity as unavailable after a completed fetch", () => {
    expect(
      resolveCodexShowActivityButtonState({
        allowAsyncCompletedCodexActivityLoad: true,
        hasVisibleCompletedActivity: false,
        hasLogRef: true,
        loadState: "loaded",
      }),
    ).toEqual({
      label: "Activity not available",
      loading: false,
      disabled: true,
    });
  });

  it("keeps the normal label before an explicit load starts", () => {
    expect(
      resolveCodexShowActivityButtonState({
        allowAsyncCompletedCodexActivityLoad: false,
        hasVisibleCompletedActivity: false,
        hasLogRef: true,
        loadState: "idle",
      }),
    ).toEqual({
      label: "Show activity",
      loading: false,
      disabled: false,
    });
  });
});

describe("canUseCompletedCachedCodexActivity", () => {
  it("rejects cached completed activity after a reconnecting stream state", () => {
    expect(
      canUseCompletedCachedCodexActivity({
        liveStatus: "reconnecting",
      }),
    ).toBe(false);
  });

  it("rejects cached completed activity after a stream error", () => {
    expect(
      canUseCompletedCachedCodexActivity({
        liveStatus: "error",
      }),
    ).toBe(false);
  });

  it("allows cached completed activity for stable live states", () => {
    expect(
      canUseCompletedCachedCodexActivity({
        liveStatus: "connected",
      }),
    ).toBe(true);
    expect(
      canUseCompletedCachedCodexActivity({
        liveStatus: "idle",
      }),
    ).toBe(true);
  });
});
