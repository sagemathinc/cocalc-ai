/** @jest-environment jsdom */

import {
  ACP_THINKING_PLACEHOLDER,
  resolveEffectiveGenerating,
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
      }),
    ).toBe("row text");
  });

  it("uses log content when generating", () => {
    expect(
      resolveRenderedMessageValue({
        rowValue: "row text",
        logValue: "live log text",
        generating: true,
      }),
    ).toBe("live log text");
  });

  it("uses log content when row is blank", () => {
    expect(
      resolveRenderedMessageValue({
        rowValue: "",
        logValue: "log fallback",
        generating: false,
      }),
    ).toBe("log fallback");
  });

  it("falls back to row when log text is empty", () => {
    expect(
      resolveRenderedMessageValue({
        rowValue: "row text",
        logValue: "   ",
        generating: true,
      }),
    ).toBe("row text");
  });

  it("suppresses the ACP placeholder body while Codex is still starting", () => {
    expect(
      shouldSuppressAcpPlaceholderBody({
        value: ACP_THINKING_PLACEHOLDER,
        generating: true,
        showCodexActivity: true,
      }),
    ).toBe(true);

    expect(
      shouldSuppressAcpPlaceholderBody({
        value: ACP_THINKING_PLACEHOLDER,
        generating: true,
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
