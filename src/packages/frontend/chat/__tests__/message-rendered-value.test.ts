/** @jest-environment jsdom */

import {
  ACP_THINKING_PLACEHOLDER,
  resolveEffectiveGenerating,
  resolveMountedCodexRenderedValue,
  resolveRenderedMessageValue,
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
