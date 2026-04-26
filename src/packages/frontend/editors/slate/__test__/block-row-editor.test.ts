import { shouldSkipBlockRowChange } from "../block-row-editor";

describe("shouldSkipBlockRowChange", () => {
  it("does not skip content edits when Slate reuses the same top-level value array", () => {
    const value: any[] = [];

    expect(
      shouldSkipBlockRowChange({
        newValue: value as any,
        previousValue: value as any,
        operations: [{ type: "insert_text" }],
        nextMarkdown: "new",
        previousMarkdown: "old",
      }),
    ).toBe(false);
  });

  it("skips selection-only batches when Slate reuses the same top-level value array", () => {
    const value: any[] = [];

    expect(
      shouldSkipBlockRowChange({
        newValue: value as any,
        previousValue: value as any,
        operations: [{ type: "set_selection" }],
        nextMarkdown: "same",
        previousMarkdown: "same",
      }),
    ).toBe(true);
  });

  it("does not skip same-ref batches when the canonical markdown changed", () => {
    const value: any[] = [];

    expect(
      shouldSkipBlockRowChange({
        newValue: value as any,
        previousValue: value as any,
        operations: [{ type: "set_selection" }],
        nextMarkdown: "changed",
        previousMarkdown: "previous",
      }),
    ).toBe(false);
  });
});
