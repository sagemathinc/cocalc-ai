import React, { useState } from "react";
import {
  captureGitDiffScrollAnchor,
  DiffBlock,
  diffLineNumberColumnWidth,
  getCommitReviewIndicatorState,
  MarkdownHistoryInput,
  buildGitShowArgs,
  formatMergeCommitBodyMarkdown,
  isMergeCommitSummary,
  matchGitDrawerScrollCommand,
  restoreGitDiffScrollAnchor,
  runGitDrawerScrollCommand,
} from "../git-commit-drawer";
import { act, fireEvent, render } from "@testing-library/react";

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
    expect(getCommitReviewIndicatorState({ abc1234: true }, "abc1234")).toEqual(
      {
        reviewed: true,
        known: true,
      },
    );
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

  it("keeps inline draft typing local to the small editor", () => {
    const renders: number[] = [];
    const originalType = (DiffBlock as any).type;
    (DiffBlock as any).type = function WrappedDiffBlock(props: any) {
      renders.push(Date.now());
      return originalType(props);
    };

    try {
      const rendered = render(
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
      expect(renders).toHaveLength(1);

      const line = rendered.container.querySelector("[data-git-anchor-id]");
      expect(line).toBeTruthy();
      act(() => {
        fireEvent.mouseEnter(line!);
      });
      expect(renders).toHaveLength(2);

      act(() => {
        rendered.getByTitle("Add inline comment").click();
      });
      expect(renders).toHaveLength(3);
      expect(latestMarkdownInputProps).toBeTruthy();

      act(() => {
        latestMarkdownInputProps.onChange("draft text");
      });

      expect(renders).toHaveLength(3);
    } finally {
      (DiffBlock as any).type = originalType;
    }
  });

  it("sizes diff line number gutters using ch units for wide line numbers", () => {
    expect(diffLineNumberColumnWidth(0)).toBe("calc(3ch + 12px)");
    expect(diffLineNumberColumnWidth(99)).toBe("calc(3ch + 12px)");
    expect(diffLineNumberColumnWidth(1000)).toBe("calc(4ch + 12px)");
    expect(diffLineNumberColumnWidth(12345)).toBe("calc(5ch + 12px)");
  });

  it("matches git review scroll keys without modifiers", () => {
    expect(
      matchGitDrawerScrollCommand({
        key: "ArrowDown",
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      } as KeyboardEvent),
    ).toBe("lineDown");
    expect(
      matchGitDrawerScrollCommand({
        key: " ",
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      } as KeyboardEvent),
    ).toBe("pageDown");
    expect(
      matchGitDrawerScrollCommand({
        key: " ",
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      } as KeyboardEvent),
    ).toBe("pageUp");
    expect(
      matchGitDrawerScrollCommand({
        key: "PageUp",
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      } as KeyboardEvent),
    ).toBe("pageUp");
    expect(
      matchGitDrawerScrollCommand({
        key: "Home",
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      } as KeyboardEvent),
    ).toBe("top");
    expect(
      matchGitDrawerScrollCommand({
        key: "PageDown",
        shiftKey: false,
        altKey: false,
        ctrlKey: true,
        metaKey: false,
      } as KeyboardEvent),
    ).toBeUndefined();
  });

  it("scrolls the git review drawer by line, page, and top commands", () => {
    const node = {
      scrollTop: 200,
      scrollHeight: 1600,
      clientHeight: 400,
    } as HTMLDivElement;

    expect(runGitDrawerScrollCommand(node, "lineDown")).toBe(true);
    expect(node.scrollTop).toBe(240);

    expect(runGitDrawerScrollCommand(node, "lineUp")).toBe(true);
    expect(node.scrollTop).toBe(200);

    expect(runGitDrawerScrollCommand(node, "pageDown")).toBe(true);
    expect(node.scrollTop).toBe(560);

    expect(runGitDrawerScrollCommand(node, "pageUp")).toBe(true);
    expect(node.scrollTop).toBe(200);

    expect(runGitDrawerScrollCommand(node, "top")).toBe(true);
    expect(node.scrollTop).toBe(0);

    expect(runGitDrawerScrollCommand(node, "lineUp")).toBe(false);
    expect(node.scrollTop).toBe(0);
  });

  it("captures the diff line nearest the drawer midpoint", () => {
    const node = {
      clientHeight: 200,
      getBoundingClientRect: () => ({ top: 100, bottom: 300 }),
      querySelectorAll: () =>
        [
          {
            dataset: { gitAnchorId: "line-a", gitHunkHash: "hunk-a" },
            getBoundingClientRect: () => ({ top: 120, bottom: 140 }),
          },
          {
            dataset: { gitAnchorId: "line-b", gitHunkHash: "hunk-b" },
            getBoundingClientRect: () => ({ top: 190, bottom: 210 }),
          },
        ] as any,
    } as any;

    expect(captureGitDiffScrollAnchor(node)).toEqual({
      anchorId: "line-b",
      hunkHash: "hunk-b",
      offsetTop: 90,
    });
  });

  it("restores drawer scroll from a captured diff anchor", () => {
    const target = {
      dataset: { gitAnchorId: "line-b", gitHunkHash: "hunk-b" },
      getBoundingClientRect: () => ({ top: 260, bottom: 280 }),
    };
    const node = {
      scrollTop: 200,
      scrollHeight: 1600,
      clientHeight: 400,
      getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
      querySelectorAll: () => [target] as any,
    } as any;

    expect(
      restoreGitDiffScrollAnchor(node, {
        anchorId: "line-b",
        hunkHash: "hunk-b",
        offsetTop: 120,
      }),
    ).toBe(true);
    expect(node.scrollTop).toBe(240);
  });
});
