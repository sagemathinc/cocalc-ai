import React, { useState } from "react";
import {
  buildGitInlineDraftEditorId,
  buildGitInlineEditEditorId,
  buildGitDiffFindMatches,
  GIT_DIFF_LIST_FOOTER_SPACER_HEIGHT,
  buildGitReviewEditorScope,
  filterGitReviewLogEntries,
  buildGitReviewFileSectionId,
  buildGitReviewNoteEditorId,
  captureGitDiffScrollAnchor,
  commentAnchorKey,
  DiffBlock,
  diffLineNumberColumnWidth,
  GitDiffFilesPanel,
  getGitDiffFindVisibleLineLimitUpdate,
  getNextRenderedDiffLineLimit,
  getRenderedDiffLineLimit,
  getCommitReviewIndicatorState,
  isGitDiffFindTargetRendered,
  MarkdownHistoryInput,
  ReviewNoteEditor,
  resolveGitReviewLoadFailure,
  resolveGitReviewSaveCompletion,
  resolveGitReviewSaveState,
  shouldClearGitReviewSavingOnScopeChange,
  buildGitLogArgs,
  buildGitShowArgs,
  formatMergeCommitBodyMarkdown,
  isMergeCommitSummary,
  matchGitDrawerScrollCommand,
  resolveGitCommitSearchChange,
  restoreGitDiffScrollAnchor,
  runGitDrawerScrollCommand,
  scrollGitDrawerElementIntoView,
  shouldRefreshGitReviewStateOnReconnect,
  shouldCaptureGitDrawerFindShortcut,
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

jest.mock("react-virtuoso", () => {
  const React = require("react");
  return {
    Virtuoso: React.forwardRef(function MockVirtuoso(props: any, _ref: any) {
      const { data = [], itemContent, components } = props;
      const Footer = components?.Footer;
      return React.createElement(
        "div",
        { "data-testid": "mock-virtuoso" },
        ...data.map((item: any, index: number) =>
          React.createElement(
            React.Fragment,
            { key: index },
            itemContent(index, item),
          ),
        ),
        Footer ? React.createElement(Footer) : null,
      );
    }),
  };
});

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

  it("excludes merge commits from the git review log", () => {
    expect(buildGitLogArgs()).toContain("--no-merges");
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

  it("scopes git review editor cache ids by both account and commit", () => {
    const accountAScope = buildGitReviewEditorScope({
      accountId: "acct-a",
      commitSha: "abc1234",
    });
    const accountBScope = buildGitReviewEditorScope({
      accountId: "acct-b",
      commitSha: "abc1234",
    });
    const otherCommitScope = buildGitReviewEditorScope({
      accountId: "acct-a",
      commitSha: "def5678",
    });

    expect(buildGitReviewNoteEditorId(accountAScope)).not.toBe(
      buildGitReviewNoteEditorId(accountBScope),
    );
    expect(
      buildGitInlineDraftEditorId({
        scope: accountAScope,
        filePath: "src/example.ts",
        anchorId: "new:17",
      }),
    ).not.toBe(
      buildGitInlineDraftEditorId({
        scope: accountBScope,
        filePath: "src/example.ts",
        anchorId: "new:17",
      }),
    );
    expect(
      buildGitInlineDraftEditorId({
        scope: accountAScope,
        filePath: "src/example.ts",
        anchorId: "new:17",
      }),
    ).not.toBe(
      buildGitInlineDraftEditorId({
        scope: otherCommitScope,
        filePath: "src/example.ts",
        anchorId: "new:17",
      }),
    );
    expect(
      buildGitInlineEditEditorId({
        scope: accountAScope,
        filePath: "src/example.ts",
        commentId: "comment-1",
      }),
    ).not.toBe(
      buildGitInlineEditEditorId({
        scope: accountBScope,
        filePath: "src/example.ts",
        commentId: "comment-1",
      }),
    );
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

  it("refreshes git review state on reconnect only for editable persisted commits", () => {
    expect(
      shouldRefreshGitReviewStateOnReconnect({
        open: true,
        accountId: "acct-1",
        commit: "abc1234",
        reviewLoading: false,
        reviewSaving: false,
      }),
    ).toBe(true);
    expect(
      shouldRefreshGitReviewStateOnReconnect({
        open: true,
        accountId: "acct-1",
        commit: "HEAD",
        reviewLoading: false,
        reviewSaving: false,
      }),
    ).toBe(false);
    expect(
      shouldRefreshGitReviewStateOnReconnect({
        open: false,
        accountId: "acct-1",
        commit: "abc1234",
        reviewLoading: false,
        reviewSaving: false,
      }),
    ).toBe(false);
    expect(
      shouldRefreshGitReviewStateOnReconnect({
        open: true,
        accountId: "",
        commit: "abc1234",
        reviewLoading: false,
        reviewSaving: false,
      }),
    ).toBe(false);
    expect(
      shouldRefreshGitReviewStateOnReconnect({
        open: true,
        accountId: "acct-1",
        commit: "abc1234",
        reviewLoading: true,
        reviewSaving: false,
      }),
    ).toBe(false);
    expect(
      shouldRefreshGitReviewStateOnReconnect({
        open: true,
        accountId: "acct-1",
        commit: "abc1234",
        reviewLoading: false,
        reviewSaving: true,
      }),
    ).toBe(false);
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

  it("buffers private review note typing until blur or save", () => {
    const onPersistDraft = jest.fn();
    const onCancel = jest.fn();
    const onSave = jest.fn();

    const rendered = render(
      React.createElement(ReviewNoteEditor, {
        historyId: "git-review-note:test",
        value: "existing",
        committedValue: "existing",
        fontSize: 14,
        saving: false,
        disabled: false,
        onPersistDraft,
        onCancel,
        onSave,
      }),
    );

    expect(latestMarkdownInputProps).toBeTruthy();

    act(() => {
      latestMarkdownInputProps.onChange("edited locally");
    });

    expect(latestMarkdownInputProps.value).toBe("edited locally");
    expect(onPersistDraft).not.toHaveBeenCalled();

    act(() => {
      latestMarkdownInputProps.onBlur("edited locally");
    });
    expect(onPersistDraft).toHaveBeenCalledWith("edited locally");

    const saveButton = rendered.getByText("Save note");
    act(() => {
      saveButton.click();
    });
    expect(onPersistDraft).toHaveBeenLastCalledWith("edited locally");
    expect(onSave).toHaveBeenCalledWith("edited locally");
  });

  it("saves the private review note on shift-enter", () => {
    const onPersistDraft = jest.fn();
    const onSave = jest.fn();

    render(
      React.createElement(ReviewNoteEditor, {
        historyId: "git-review-note:test",
        value: "existing",
        committedValue: "existing",
        fontSize: 14,
        saving: false,
        disabled: false,
        onPersistDraft,
        onCancel: jest.fn(),
        onSave,
      }),
    );

    act(() => {
      latestMarkdownInputProps.onChange("save me");
    });
    act(() => {
      latestMarkdownInputProps.onShiftEnter("save me");
    });

    expect(onPersistDraft).toHaveBeenCalledWith("save me");
    expect(onSave).toHaveBeenCalledWith("save me");
  });

  it("prefers the latest draft note when another review action saves", () => {
    expect(
      resolveGitReviewSaveState({
        draft: {
          reviewed: false,
          note: "newer draft note",
          comments: {},
        },
        next: {
          reviewed: true,
        },
        reviewed: false,
        reviewNote: "older committed note",
        reviewNoteDraft: "stale render note",
        reviewComments: {},
      }),
    ).toEqual({
      reviewed: true,
      note: "newer draft note",
      comments: {},
    });
  });

  it("preserves a newer in-memory draft when an older save completes", () => {
    expect(
      resolveGitReviewSaveCompletion({
        payload: {
          reviewed: true,
          note: "saved note",
        },
        sent: {
          reviewed: true,
          note: "saved note",
        },
        current: {
          reviewed: true,
          noteDraft: "newer local draft",
        },
      }),
    ).toEqual({
      reviewed: true,
      reviewNote: "saved note",
      reviewNoteDraft: "newer local draft",
      reviewDirty: true,
    });
  });

  it("keeps a local review draft visible when persisted review loading fails", () => {
    expect(
      resolveGitReviewLoadFailure({
        draft: {
          reviewed: true,
          note: "local draft note",
          updated_at: 1234,
        },
        error: "closed",
      }),
    ).toEqual({
      reviewError: "closed",
      reviewed: true,
      reviewNote: "local draft note",
      reviewNoteDraft: "local draft note",
      reviewUpdatedAt: 1234,
    });
  });

  it("clears git review saving only when the active commit scope changes", () => {
    expect(
      shouldClearGitReviewSavingOnScopeChange({
        reviewSaving: true,
        previousScope: "aaa1111",
        nextScope: "bbb2222",
      }),
    ).toBe(true);
    expect(
      shouldClearGitReviewSavingOnScopeChange({
        reviewSaving: true,
        previousScope: "aaa1111",
        nextScope: "aaa1111",
      }),
    ).toBe(false);
    expect(
      shouldClearGitReviewSavingOnScopeChange({
        reviewSaving: false,
        previousScope: "aaa1111",
        nextScope: "bbb2222",
      }),
    ).toBe(false);
  });

  it("does not persist a private review note when cancel wins after blur ordering", () => {
    const onPersistDraft = jest.fn();
    const onCancel = jest.fn();

    const rendered = render(
      React.createElement(ReviewNoteEditor, {
        historyId: "git-review-note:test",
        value: "existing",
        committedValue: "existing",
        fontSize: 14,
        saving: false,
        disabled: false,
        onPersistDraft,
        onCancel,
        onSave: jest.fn(),
      }),
    );

    act(() => {
      latestMarkdownInputProps.onChange("discard me");
    });

    const cancelButton = rendered.getByText("Cancel");
    act(() => {
      fireEvent.mouseDown(cancelButton);
    });
    act(() => {
      latestMarkdownInputProps.onBlur("discard me");
    });
    act(() => {
      cancelButton.click();
    });

    expect(onPersistDraft).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("does not persist a private review note when keyboard focus moves to cancel first", () => {
    const onPersistDraft = jest.fn();
    const onCancel = jest.fn();

    const rendered = render(
      React.createElement(ReviewNoteEditor, {
        historyId: "git-review-note:test",
        value: "existing",
        committedValue: "existing",
        fontSize: 14,
        saving: false,
        disabled: false,
        onPersistDraft,
        onCancel,
        onSave: jest.fn(),
      }),
    );

    act(() => {
      latestMarkdownInputProps.onChange("discard me");
    });

    const cancelButton = rendered.getByText("Cancel");
    act(() => {
      fireEvent.focus(cancelButton);
    });
    act(() => {
      latestMarkdownInputProps.onBlur("discard me");
    });
    act(() => {
      cancelButton.click();
    });

    expect(onPersistDraft).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("persists a private review note if action-button focus is abandoned", () => {
    const onPersistDraft = jest.fn();

    const rendered = render(
      React.createElement(ReviewNoteEditor, {
        historyId: "git-review-note:test",
        value: "existing",
        committedValue: "existing",
        fontSize: 14,
        saving: false,
        disabled: false,
        onPersistDraft,
        onCancel: jest.fn(),
        onSave: jest.fn(),
      }),
    );

    act(() => {
      latestMarkdownInputProps.onChange("keep me");
    });

    const cancelButton = rendered.getByText("Cancel");
    act(() => {
      fireEvent.focus(cancelButton);
    });
    act(() => {
      latestMarkdownInputProps.onBlur("keep me");
    });
    act(() => {
      fireEvent.blur(cancelButton);
    });

    expect(onPersistDraft).toHaveBeenCalledWith("keep me");
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

  it("keeps diff-line hover from re-rendering the whole diff block", () => {
    const renders: number[] = [];
    const originalType = (DiffBlock as any).type;
    (DiffBlock as any).type = function WrappedDiffBlock(props: any) {
      renders.push(Date.now());
      return originalType(props);
    };

    try {
      function Harness() {
        const [draftAnchorId, setDraftAnchorId] = useState<string | undefined>(
          undefined,
        );
        const [draftValue, setDraftValue] = useState("");
        return React.createElement(DiffBlock, {
          filePath: "src/example.ts",
          lines: stableDiffLines,
          languageHint: "ts",
          fontSize: 14,
          comments: stableComments,
          showResolvedComments: false,
          commentEnabled: true,
          activeDraftAnchorId: draftAnchorId,
          activeDraftBody: draftValue,
          onOpenDraft: (anchor: any) => {
            setDraftAnchorId(commentAnchorKey(anchor));
            setDraftValue((current) =>
              draftAnchorId === commentAnchorKey(anchor) ? current : "",
            );
          },
          onDraftBodyChange: setDraftValue,
          onCancelDraft: () => {
            setDraftAnchorId(undefined);
            setDraftValue("");
          },
          onCreateComment: noopAsync,
          onUpdateComment: noopAsync,
          onResolveComment: noopAsync,
          onReopenComment: noopAsync,
        });
      }

      const rendered = render(React.createElement(Harness));
      expect(renders).toHaveLength(1);

      const line = rendered.container.querySelector("[data-git-anchor-id]");
      expect(line).toBeTruthy();
      act(() => {
        fireEvent.mouseEnter(line!);
      });
      expect(renders).toHaveLength(1);

      act(() => {
        rendered.getAllByTitle("Add inline comment")[0].click();
      });
      expect(latestMarkdownInputProps).toBeTruthy();

      act(() => {
        latestMarkdownInputProps.onChange("draft text");
      });
      expect(latestMarkdownInputProps.value).toBe("draft text");
    } finally {
      (DiffBlock as any).type = originalType;
    }
  });

  it("preserves inline draft text across diff block remounts", () => {
    function Harness() {
      const [visible, setVisible] = useState(true);
      const [draftAnchorId, setDraftAnchorId] = useState<string | undefined>(
        undefined,
      );
      const [draftValue, setDraftValue] = useState("");
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          { onClick: () => setVisible((v) => !v) },
          "toggle",
        ),
        visible
          ? React.createElement(DiffBlock, {
              filePath: "src/example.ts",
              lines: stableDiffLines,
              languageHint: "ts",
              fontSize: 14,
              comments: stableComments,
              showResolvedComments: false,
              commentEnabled: true,
              activeDraftAnchorId: draftAnchorId,
              activeDraftBody: draftValue,
              onOpenDraft: (anchor: any) => {
                setDraftAnchorId(commentAnchorKey(anchor));
                setDraftValue((current) =>
                  draftAnchorId === commentAnchorKey(anchor) ? current : "",
                );
              },
              onDraftBodyChange: setDraftValue,
              onCancelDraft: () => {
                setDraftAnchorId(undefined);
                setDraftValue("");
              },
              onCreateComment: noopAsync,
              onUpdateComment: noopAsync,
              onResolveComment: noopAsync,
              onReopenComment: noopAsync,
            })
          : null,
      );
    }

    const rendered = render(React.createElement(Harness));
    act(() => {
      rendered.getAllByTitle("Add inline comment")[0].click();
    });
    expect(latestMarkdownInputProps).toBeTruthy();

    act(() => {
      latestMarkdownInputProps.onChange("persist me");
    });
    expect(latestMarkdownInputProps.value).toBe("persist me");

    act(() => {
      rendered.getByText("toggle").click();
    });
    act(() => {
      rendered.getByText("toggle").click();
    });

    expect(latestMarkdownInputProps).toBeTruthy();
    expect(latestMarkdownInputProps.value).toBe("persist me");
  });

  it("does not re-render the whole diff block on inline draft typing", () => {
    const renders: number[] = [];
    const originalType = (DiffBlock as any).type;
    (DiffBlock as any).type = function WrappedDiffBlock(props: any) {
      renders.push(Date.now());
      return originalType(props);
    };

    try {
      function Harness() {
        const [draftAnchorId, setDraftAnchorId] = useState<string | undefined>(
          undefined,
        );
        const [draftValue, setDraftValue] = useState("");
        return React.createElement(DiffBlock, {
          filePath: "src/example.ts",
          lines: stableDiffLines,
          languageHint: "ts",
          fontSize: 14,
          comments: stableComments,
          showResolvedComments: false,
          commentEnabled: true,
          activeDraftAnchorId: draftAnchorId,
          activeDraftBody: draftValue,
          onOpenDraft: (anchor: any) => {
            setDraftAnchorId(commentAnchorKey(anchor));
            setDraftValue("");
          },
          onDraftBodyChange: setDraftValue,
          onCancelDraft: () => {
            setDraftAnchorId(undefined);
            setDraftValue("");
          },
          onCreateComment: noopAsync,
          onUpdateComment: noopAsync,
          onResolveComment: noopAsync,
          onReopenComment: noopAsync,
        });
      }

      const rendered = render(React.createElement(Harness));
      act(() => {
        rendered.getAllByTitle("Add inline comment")[0].click();
      });
      expect(renders).toHaveLength(2);
      expect(latestMarkdownInputProps).toBeTruthy();

      act(() => {
        latestMarkdownInputProps.onChange("typed locally");
      });

      expect(latestMarkdownInputProps.value).toBe("typed locally");
      expect(renders).toHaveLength(2);
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

  it("caps rendered diff blocks per file and grows them in fixed increments", () => {
    expect(getRenderedDiffLineLimit(undefined)).toBe(300);
    expect(getRenderedDiffLineLimit(1)).toBe(300);
    expect(getRenderedDiffLineLimit(420)).toBe(420);
    expect(getNextRenderedDiffLineLimit(undefined)).toBe(500);
    expect(getNextRenderedDiffLineLimit(300)).toBe(500);
    expect(getNextRenderedDiffLineLimit(420)).toBe(620);
  });

  it("adds a footer spacer below the virtualized diff list", () => {
    const rendered = render(
      React.createElement(GitDiffFilesPanel, {
        files: [{ path: "src/example.ts", lines: stableDiffLines }],
        drawerScrollParent: null,
        virtuosoRef: { current: null },
        fontSize: 14,
        editorTheme: null,
        reviewEditorScope: "scope:test",
        inlineCommentsByFile: new Map(),
        showResolvedComments: false,
        isHeadSelected: false,
        visibleDiffLinesByFile: {},
        onOpenFile: noopAsync,
        onShowMoreLines: () => {},
        activeDraftBody: "",
        activeEditingBody: "",
        pendingKey: "",
        onOpenDraft: () => {},
        onDraftBodyChange: () => {},
        onCancelDraft: () => {},
        onOpenEdit: () => {},
        onEditingBodyChange: () => {},
        onCancelEdit: () => {},
        onCreateComment: noopAsync,
        onUpdateComment: noopAsync,
        onResolveComment: noopAsync,
        onReopenComment: noopAsync,
        diffFindMatchCounts: new Map(),
        diffFindMatchedLineIndexes: new Map(),
      }),
    );

    const spacer = rendered.getByTestId("git-diff-list-footer-spacer");
    expect((spacer as HTMLDivElement).style.height).toBe(
      `${GIT_DIFF_LIST_FOOTER_SPACER_HEIGHT}px`,
    );
  });

  it("builds stable file section ids for changed-file navigation", () => {
    expect(buildGitReviewFileSectionId("src/example.ts", 0)).toMatch(
      /^git-review-file-0-/,
    );
    expect(buildGitReviewFileSectionId("src/example.ts", 0)).toBe(
      buildGitReviewFileSectionId("src/example.ts", 0),
    );
    expect(buildGitReviewFileSectionId("src/example.ts", 0)).not.toBe(
      buildGitReviewFileSectionId("src/example.ts", 1),
    );
  });

  it("builds file and line matches for drawer-local diff search", () => {
    expect(
      buildGitDiffFindMatches({
        query: "widget",
        data: {
          files: [
            {
              path: "src/widget.ts",
              lines: ["@@ -1 +1 @@", "-old widget", "+new widget"],
            },
            {
              path: "src/other.ts",
              lines: ["context only"],
            },
          ],
        } as any,
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "file",
        fileIndex: 0,
        preview: "src/widget.ts",
      }),
      expect.objectContaining({
        kind: "line",
        fileIndex: 0,
        lineIndex: 1,
        preview: "-old widget",
      }),
      expect.objectContaining({
        kind: "line",
        fileIndex: 0,
        lineIndex: 2,
        preview: "+new widget",
      }),
    ]);
  });

  it("tracks active diff-find render readiness per target file only", () => {
    const data = {
      files: [
        {
          path: "src/alpha.ts",
          lines: Array.from({ length: 600 }, (_, idx) => `alpha ${idx}`),
        },
        {
          path: "src/beta.ts",
          lines: Array.from({ length: 600 }, (_, idx) => `beta ${idx}`),
        },
      ],
    } as any;
    const activeLineMatch = {
      id: "line:0:450",
      kind: "line",
      fileIndex: 0,
      lineIndex: 450,
      preview: "alpha 450",
    } as const;
    const alphaSectionId = buildGitReviewFileSectionId("src/alpha.ts", 0);
    const betaSectionId = buildGitReviewFileSectionId("src/beta.ts", 1);

    expect(
      isGitDiffFindTargetRendered({
        data,
        match: activeLineMatch,
        visibleDiffLinesByFile: {},
      }),
    ).toBe(false);

    expect(
      isGitDiffFindTargetRendered({
        data,
        match: activeLineMatch,
        visibleDiffLinesByFile: {
          [betaSectionId]: 520,
        },
      }),
    ).toBe(false);

    expect(
      isGitDiffFindTargetRendered({
        data,
        match: activeLineMatch,
        visibleDiffLinesByFile: {
          [alphaSectionId]: 451,
        },
      }),
    ).toBe(true);
  });

  it("expands hidden diff-find line matches in their own file", () => {
    const data = {
      files: [
        {
          path: "src/alpha.ts",
          lines: Array.from({ length: 600 }, (_, idx) => `alpha ${idx}`),
        },
        {
          path: "src/beta.ts",
          lines: Array.from({ length: 600 }, (_, idx) => `beta ${idx}`),
        },
      ],
    } as any;
    const activeLineMatch = {
      id: "line:0:450",
      kind: "line",
      fileIndex: 0,
      lineIndex: 450,
      preview: "alpha 450",
    } as const;
    const visibleLineMatch = {
      id: "line:0:120",
      kind: "line",
      fileIndex: 0,
      lineIndex: 120,
      preview: "alpha 120",
    } as const;
    const alphaSectionId = buildGitReviewFileSectionId("src/alpha.ts", 0);
    const betaSectionId = buildGitReviewFileSectionId("src/beta.ts", 1);

    expect(
      getGitDiffFindVisibleLineLimitUpdate({
        data,
        match: visibleLineMatch,
        visibleDiffLinesByFile: {},
      }),
    ).toBeUndefined();

    expect(
      getGitDiffFindVisibleLineLimitUpdate({
        data,
        match: activeLineMatch,
        visibleDiffLinesByFile: {},
      }),
    ).toEqual({
      sectionId: alphaSectionId,
      neededLimit: 451,
    });

    expect(
      getGitDiffFindVisibleLineLimitUpdate({
        data,
        match: activeLineMatch,
        visibleDiffLinesByFile: {
          [betaSectionId]: 520,
        },
      }),
    ).toEqual({
      sectionId: alphaSectionId,
      neededLimit: 451,
    });

    expect(
      getGitDiffFindVisibleLineLimitUpdate({
        data,
        match: activeLineMatch,
        visibleDiffLinesByFile: {
          [alphaSectionId]: 451,
        },
      }),
    ).toBeUndefined();
  });

  it("filters the commit list down to unreviewed commits when requested", () => {
    expect(
      filterGitReviewLogEntries({
        entries: [
          { hash: "aaa1111", subject: "Reviewed commit" },
          { hash: "bbb2222", subject: "Unreviewed commit" },
          { hash: "ccc3333", subject: "Unknown review state" },
        ],
        reviewedByCommit: {
          aaa1111: true,
          bbb2222: false,
        },
        onlyUnreviewed: true,
      }),
    ).toEqual([
      { hash: "bbb2222", subject: "Unreviewed commit" },
      { hash: "ccc3333", subject: "Unknown review state" },
    ]);
  });

  it("preserves the current commit search across antd auto-clear after selection", () => {
    expect(
      resolveGitCommitSearchChange({
        currentSearch: "slate",
        nextSearch: "",
        preserveSearchOnAutoClear: true,
      }),
    ).toEqual({
      search: "slate",
      preserveSearchOnAutoClear: false,
    });

    expect(
      resolveGitCommitSearchChange({
        currentSearch: "slate",
        nextSearch: "",
        preserveSearchOnAutoClear: false,
      }),
    ).toEqual({
      search: "",
      preserveSearchOnAutoClear: false,
    });

    expect(
      resolveGitCommitSearchChange({
        currentSearch: "slate",
        nextSearch: "codex",
        preserveSearchOnAutoClear: true,
      }),
    ).toEqual({
      search: "codex",
      preserveSearchOnAutoClear: false,
    });
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

  it("does not hijack ctrl/cmd-f from editable targets", () => {
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");

    expect(
      shouldCaptureGitDrawerFindShortcut({
        key: "f",
        altKey: false,
        ctrlKey: true,
        metaKey: false,
        target: input,
        activeElement: input,
      } as any),
    ).toBe(false);

    expect(
      shouldCaptureGitDrawerFindShortcut({
        key: "F",
        altKey: false,
        ctrlKey: false,
        metaKey: true,
        target: editor,
        activeElement: editor,
      } as any),
    ).toBe(false);

    expect(
      shouldCaptureGitDrawerFindShortcut({
        key: "f",
        altKey: false,
        ctrlKey: true,
        metaKey: false,
        target: document.createElement("div"),
        activeElement: document.body,
      } as any),
    ).toBe(true);
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

  it("scrolls drawer targets with drawer-owned start and center math", () => {
    const node = {
      scrollTop: 200,
      scrollHeight: 2000,
      clientHeight: 400,
      getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
    } as any;
    const target = {
      getBoundingClientRect: () => ({ top: 340, bottom: 380, height: 40 }),
    } as any;

    expect(
      scrollGitDrawerElementIntoView(node, target, {
        block: "start",
        offsetTop: 16,
      }),
    ).toBe(true);
    expect(node.scrollTop).toBe(424);

    node.scrollTop = 200;
    expect(
      scrollGitDrawerElementIntoView(node, target, {
        block: "center",
      }),
    ).toBe(true);
    expect(node.scrollTop).toBe(260);
  });
});
