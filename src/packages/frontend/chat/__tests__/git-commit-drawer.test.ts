import React, { useState } from "react";
import {
  DiffBlock,
  getCommitReviewIndicatorState,
  MarkdownHistoryInput,
  buildGitShowArgs,
  formatMergeCommitBodyMarkdown,
  isMergeCommitSummary,
} from "../git-commit-drawer";
import { act, render } from "@testing-library/react";

let latestMarkdownInputProps: any = null;
const noopAsync = async () => {};
const stableDiffLines = ["@@ -1 +1 @@", "-old", "+new"];
const stableComments: any[] = [];

jest.mock("@cocalc/frontend/editors/markdown-input/multimode", () => ({
  __esModule: true,
  default: (props: any) => {
    latestMarkdownInputProps = props;
    return null;
  },
}));

describe("git commit drawer merge commit formatting", () => {
  beforeEach(() => {
    latestMarkdownInputProps = null;
  });

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

  it("keeps undo and redo local for git review note/comment editors", () => {
    render(
      React.createElement(MarkdownHistoryInput, {
        historyId: "git-inline-draft:file.ts:1",
        value: "hello",
        onChange: () => {},
      }),
    );

    expect(latestMarkdownInputProps).toBeTruthy();
    expect(latestMarkdownInputProps.saveDebounceMs).toBe(0);
    expect(latestMarkdownInputProps.undoMode).toBe("local");
    expect(latestMarkdownInputProps.redoMode).toBe("local");
  });

  it("treats missing review state as unknown instead of not reviewed", () => {
    expect(getCommitReviewIndicatorState({}, "abc1234")).toEqual({
      reviewed: false,
      known: false,
    });
    expect(
      getCommitReviewIndicatorState({ abc1234: false }, "abc1234"),
    ).toEqual({
      reviewed: false,
      known: true,
    });
    expect(
      getCommitReviewIndicatorState({ abc1234: true }, "abc1234"),
    ).toEqual({
      reviewed: true,
      known: true,
    });
  });

  it("preserves onModeChange forwarding for git review note/comment editors", () => {
    const onModeChange = jest.fn();

    render(
      React.createElement(MarkdownHistoryInput, {
        historyId: "git-inline-draft:file.ts:1",
        value: "hello",
        onChange: () => {},
        onModeChange,
      }),
    );

    act(() => {
      latestMarkdownInputProps.onModeChange("markdown");
    });
    expect(onModeChange).toHaveBeenCalledWith("markdown");
  });

  it("does not re-commit diff blocks on unrelated parent state changes", () => {
    const renders: number[] = [];
    const originalType = (DiffBlock as any).type;
    (DiffBlock as any).type = function WrappedDiffBlock(props: any) {
      renders.push(Date.now());
      return originalType(props);
    };

    try {
      function Harness() {
        const [value, setValue] = useState(0);
        return React.createElement(
          React.Fragment,
          null,
          React.createElement(
            "button",
            { onClick: () => setValue((v) => v + 1) },
            "bump",
          ),
          React.createElement("span", null, value),
          React.createElement(DiffBlock, {
            filePath: "src/example.ts",
            lines: stableDiffLines,
            languageHint: "ts",
            fontSize: 14,
            comments: stableComments,
            showResolvedComments: false,
            commentEnabled: true,
            onCreateComment: noopAsync,
            onUpdateComment: noopAsync,
            onResolveComment: noopAsync,
            onReopenComment: noopAsync,
          }),
        );
      }

      const rendered = render(React.createElement(Harness));
      expect(renders).toHaveLength(1);

      act(() => {
        rendered.getByText("bump").click();
      });

      expect(renders).toHaveLength(1);
    } finally {
      (DiffBlock as any).type = originalType;
    }
  });
});
