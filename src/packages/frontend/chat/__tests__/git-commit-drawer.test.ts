import {
  formatMergeCommitBodyMarkdown,
  isMergeCommitSummary,
} from "../git-commit-drawer";

describe("git commit drawer merge commit formatting", () => {
  it("detects merge commits from summary headers", () => {
    expect(
      isMergeCommitSummary({
        message: "Merge branch 'main'",
        extraHeaderLines: ["Merge: 1234567 89abcde"],
      }),
    ).toBe(true);
    expect(
      isMergeCommitSummary({
        message: "Normal commit",
        extraHeaderLines: [],
      }),
    ).toBe(false);
  });

  it("wraps merge commit bodies in a safe fenced code block", () => {
    const body = "Conflicts resolved\n```\nkeep literal\n```";
    expect(formatMergeCommitBodyMarkdown(body)).toBe(
      "````\nConflicts resolved\n```\nkeep literal\n```\n````",
    );
  });
});
