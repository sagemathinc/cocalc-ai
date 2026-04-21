import { shouldDirectSetExternalSlateValue } from "../external-value-strategy";

describe("shouldDirectSetExternalSlateValue", () => {
  it("directly applies clear operations", () => {
    expect(
      shouldDirectSetExternalSlateValue({
        forceDirectSetForClear: true,
        previousBlockCount: 10,
        nextBlockCount: 1,
        nextMarkdownLength: 0,
        isMergeFocused: true,
      }),
    ).toBe(true);
  });

  it("uses direct replacement for large unfocused external updates", () => {
    expect(
      shouldDirectSetExternalSlateValue({
        forceDirectSetForClear: false,
        previousBlockCount: 300,
        nextBlockCount: 300,
        nextMarkdownLength: 10_000,
        isMergeFocused: false,
      }),
    ).toBe(true);
    expect(
      shouldDirectSetExternalSlateValue({
        forceDirectSetForClear: false,
        previousBlockCount: 10,
        nextBlockCount: 10,
        nextMarkdownLength: 60_000,
        isMergeFocused: false,
      }),
    ).toBe(true);
  });

  it("keeps diff/patch behavior for focused editors", () => {
    expect(
      shouldDirectSetExternalSlateValue({
        forceDirectSetForClear: false,
        previousBlockCount: 300,
        nextBlockCount: 300,
        nextMarkdownLength: 60_000,
        isMergeFocused: true,
      }),
    ).toBe(false);
  });

  it("keeps the existing initial-load direct replacement heuristic", () => {
    expect(
      shouldDirectSetExternalSlateValue({
        forceDirectSetForClear: false,
        previousBlockCount: 1,
        nextBlockCount: 40,
        nextMarkdownLength: 1_000,
        isMergeFocused: false,
      }),
    ).toBe(true);
  });
});
