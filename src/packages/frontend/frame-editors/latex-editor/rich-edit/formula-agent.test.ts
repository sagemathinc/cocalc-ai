jest.mock("@cocalc/frontend/project/new/navigator-intents", () => ({
  dispatchNavigatorPromptIntent: jest.fn(),
  submitNavigatorPromptInWorkspaceChat: jest.fn(),
}));

import {
  createFormulaAgentPrompt,
  getFormulaAgentContext,
} from "./formula-agent";

describe("Formula Agent prompt", () => {
  it("includes the full project path, formula, and one-based line number", () => {
    const prompt = createFormulaAgentPrompt({
      project_id: "project-id",
      path: "home/user/latex/widget.tex",
      source: "$x^2$",
      from: { line: 7, ch: 3 },
      to: { line: 7, ch: 8 },
      context: "before\n$x^2$\nafter",
      contextTruncated: false,
    });
    expect(prompt).toContain("home/user/latex/widget.tex");
    expect(prompt).toContain("line 8");
    expect(prompt).toContain("$$\n$x^2$\n$$");
    expect(prompt).toContain("Ask what change they want before editing");
  });

  it("keeps at most two adjacent lines on each side", () => {
    const lines = ["zero", "one", "two", "FORMULA", "four", "five", "six"];
    const context = getFormulaAgentContext(
      (line) => lines[line],
      lines.length,
      { line: 3, ch: 0 },
      { line: 3, ch: 7 },
      "FORMULA",
    );
    expect(context.text).toBe("one\ntwo\nFORMULA\nfour\nfive");
    expect(context.truncated).toBe(false);
  });

  it("bounds very long source windows to 1000 characters", () => {
    const lines = ["a".repeat(1500), "FORMULA", "b".repeat(1500)];
    const context = getFormulaAgentContext(
      (line) => lines[line],
      lines.length,
      { line: 1, ch: 0 },
      { line: 1, ch: 7 },
      "FORMULA",
    );
    expect(context.text.length).toBeLessThanOrEqual(1000);
    expect(context.text).toContain("FORMULA");
    expect(context.truncated).toBe(true);
  });
});
