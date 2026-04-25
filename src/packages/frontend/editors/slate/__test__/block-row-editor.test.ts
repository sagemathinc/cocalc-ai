import { shouldSkipBlockRowChange } from "../block-row-editor";

describe("shouldSkipBlockRowChange", () => {
  it("does not skip content edits when Slate reuses the same top-level value array", () => {
    const value: any[] = [];

    expect(
      shouldSkipBlockRowChange({
        newValue: value as any,
        previousValue: value as any,
        operations: [{ type: "insert_text" }],
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
      }),
    ).toBe(true);
  });
});
