/** @jest-environment jsdom */

import { buildHiddenPrompt, buildVisiblePrompt } from "./cell-tool";

describe("Jupyter cell Codex prompts", () => {
  it("builds a minimal hidden prompt for bugfix mode", () => {
    const prompt = buildHiddenPrompt({
      mode: "bugfix",
      path: "/tmp/test.ipynb",
      cellId: "cell-17",
      cellType: "code",
      kernelLanguage: "python",
      kernelDisplay: "Python 3",
      extra: "The output looks wrong",
      targetLanguage: "",
    });

    expect(prompt).toContain("Jupyter notebook path: /tmp/test.ipynb");
    expect(prompt).toContain("Selected cell id: cell-17");
    expect(prompt).toContain("Selected cell type: code");
    expect(prompt).toContain(
      "Treat the live in-memory notebook state as the source of truth",
    );
    expect(prompt).toContain("The output looks wrong");
    expect(prompt).not.toContain("Cells BEFORE current cell");
    expect(prompt).not.toContain("Current cell content:");
    expect(prompt).not.toContain("```python");
  });

  it("builds concise visible prompts for code and markdown actions", () => {
    expect(
      buildVisiblePrompt({
        mode: "explain",
        cellType: "code",
        extra: "",
        targetLanguage: "",
      }),
    ).toBe("Explain this cell.");

    expect(
      buildVisiblePrompt({
        mode: "translate_text",
        cellType: "markdown",
        extra: "",
        targetLanguage: "French",
      }),
    ).toBe("Translate this Markdown cell to French.");
  });
});
