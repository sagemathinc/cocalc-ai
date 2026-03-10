import { buildAgentCommitPrompt } from "../git-commit-prompt";

describe("buildAgentCommitPrompt", () => {
  it("asks the agent to run git commit -a for AI-authored commit messages", () => {
    const prompt = buildAgentCommitPrompt({
      message: "",
      includeSummary: true,
    });
    expect(prompt).toContain("git commit -a");
    expect(prompt).not.toContain("detailed explanatory body");
  });

  it("keeps exact commit messages explicit while still using git commit -a", () => {
    const prompt = buildAgentCommitPrompt({
      message: "subject line",
      includeSummary: false,
    });
    expect(prompt).toContain("git commit -a");
    expect(prompt).toContain("Use this exact commit message:");
    expect(prompt).toContain("subject line");
  });
});
