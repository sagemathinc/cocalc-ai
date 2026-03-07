import {
  buildGitShowArgs,
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

  it("matches plain git show semantics instead of forcing rename detection", () => {
    expect(
      buildGitShowArgs({
        isHeadSelected: false,
        contextLines: 3,
        commit: "49cb07ac6faa17607cadc31e6138ea5ee057e17f",
      }),
    ).toEqual([
      "-c",
      "core.pager=cat",
      "show",
      "--no-color",
      "--patch",
      "-U3",
      "--format=fuller",
      "49cb07ac6faa17607cadc31e6138ea5ee057e17f",
    ]);
    expect(
      buildGitShowArgs({
        isHeadSelected: true,
        contextLines: 7,
      }),
    ).toEqual([
      "-c",
      "core.pager=cat",
      "diff",
      "--no-color",
      "--patch",
      "-U7",
      "HEAD",
    ]);
  });
});
