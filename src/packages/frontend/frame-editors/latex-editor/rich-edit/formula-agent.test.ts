jest.mock("@cocalc/frontend/project/new/navigator-intents", () => ({
  dispatchNavigatorPromptIntent: jest.fn(),
  submitNavigatorPromptInWorkspaceChat: jest.fn(),
}));

import { createFormulaAgentPrompt } from "./formula-agent";

describe("Formula Agent prompt", () => {
  it("includes the full project path, formula, and one-based line number", () => {
    const prompt = createFormulaAgentPrompt({
      project_id: "project-id",
      path: "home/user/latex/widget.tex",
      source: "$x^2$",
      from: { line: 7, ch: 3 },
      to: { line: 7, ch: 8 },
      formulaType: "math-inline",
      instruction: "Add a subscript n to x.",
    });
    expect(prompt).toContain("home/user/latex/widget.tex");
    expect(prompt).toContain('"line": 8');
    expect(prompt).toContain("$$\n$x^2$\n$$");
    expect(prompt).toContain("Add a subscript n to x.");
    expect(prompt).toContain("Do not ask them to repeat it.");
    expect(prompt).toContain("Do not merely reply with proposed LaTeX");
    expect(prompt).toContain(
      "<details><summary>Agent instructions and context</summary>",
    );
  });

  it("uses metadata for the file and exact source range", () => {
    const prompt = createFormulaAgentPrompt({
      project_id: "project-id",
      path: "home/user/latex/widget.tex",
      source: "$x^2$",
      from: { line: 7, ch: 3 },
      to: { line: 9, ch: 8 },
      formulaType: "math-inline",
      instruction: "Add a subscript n to x.",
    });
    expect(prompt).toContain('"line": 8');
    expect(prompt).toContain('"line_end": 10');
    expect(prompt).not.toContain("Nearby source");
  });

  it("includes the explicit live-edit instruction", () => {
    const prompt = createFormulaAgentPrompt({
      project_id: "project-id",
      path: "home/user/latex/widget.tex",
      source: "$x^2$",
      from: { line: 7, ch: 3 },
      to: { line: 7, ch: 8 },
      formulaType: "math-inline",
      instruction: "Add a subscript n to x.",
    });
    expect(prompt).toContain("Do not merely reply with proposed LaTeX");
    expect(prompt).toContain("Intent metadata");
  });
});
