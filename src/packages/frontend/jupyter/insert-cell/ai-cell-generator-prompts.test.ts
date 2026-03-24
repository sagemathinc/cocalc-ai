/** @jest-environment jsdom */

import {
  buildGenerateCellHiddenPrompt,
  buildGenerateCellVisiblePrompt,
} from "./ai-cell-generator";

describe("Jupyter generate-cell Agent prompts", () => {
  it("builds a minimal hidden prompt with insertion metadata", () => {
    const prompt = buildGenerateCellHiddenPrompt({
      prompt: "Create a summary statistics cell and a short explanation.",
      path: "/tmp/test.ipynb",
      cellId: "cell-12",
      anchorCellType: "code",
      position: "below",
      kernelLanguage: "python",
      kernelDisplay: "Python 3",
    });

    expect(prompt).toContain("Jupyter notebook path: /tmp/test.ipynb");
    expect(prompt).toContain("Anchor cell id: cell-12");
    expect(prompt).toContain("Anchor cell type: code");
    expect(prompt).toContain("Requested position: below");
    expect(prompt).toContain(
      "Treat the live in-memory notebook state as the source of truth",
    );
    expect(prompt).toContain("Create a summary statistics cell");
    expect(prompt).not.toContain("Cells BEFORE insertion point");
    expect(prompt).not.toContain("Pick an example");
    expect(prompt).not.toContain("```python");
  });

  it("builds concise visible prompts for insertion and replacement", () => {
    expect(
      buildGenerateCellVisiblePrompt({
        prompt: "Create a chart.",
        position: "above",
        anchorCellType: "code",
      }),
    ).toBe("Generate new cells above this code cell: Create a chart.");

    expect(
      buildGenerateCellVisiblePrompt({
        prompt: "Rewrite this explanation.",
        position: "replace",
        anchorCellType: "markdown",
      }),
    ).toBe(
      "Generate new cells by replacing this Markdown cell: Rewrite this explanation.",
    );
  });
});
