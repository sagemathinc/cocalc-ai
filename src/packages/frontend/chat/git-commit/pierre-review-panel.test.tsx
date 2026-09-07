import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PierreReviewPanel from "./pierre-review-panel";
import type { ReviewDiffPanelProps } from "./review-diff-panel";
import { buildDiffLineMetas, makeCommentAnchor } from "./diff-lines";

let mockTheme = "light";
let mockRecycle = false;
const mockScrollTo = jest.fn();
jest.mock("@cocalc/frontend/appearance/use-appearance", () => ({
  useAppearance: () => ({ resolved: mockTheme }),
}));
jest.mock("@cocalc/frontend/app-framework", () => require("react"));
jest.mock("@cocalc/frontend/components/copy-button", () => ({
  copyTextToClipboard: jest.fn(),
}));
jest.mock(
  "@cocalc/frontend/components/diff-viewer/highlighting-provider",
  () => ({ DiffHighlightingProvider: ({ children }: any) => children }),
);
jest.mock("@cocalc/frontend/components/diff-viewer/pierre-model", () => ({
  parseReviewPatchFiles: () => [{ name: "a.ts" }],
}));
jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ value }: any) => <div>{value}</div>,
}));
jest.mock("@cocalc/frontend/editors/markdown-input/multimode", () => ({
  __esModule: true,
  default: ({ value, onChange, onBlur }: any) => (
    <textarea
      aria-label="Comment editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={() => onBlur?.()}
    />
  ),
}));
jest.mock(
  "@pierre/diffs/react",
  () => {
    const React = require("react");
    return {
      CodeView: React.forwardRef((props: any, ref: any) => {
        React.useImperativeHandle(ref, () => ({ scrollTo: mockScrollTo }));
        return (
          <div
            ref={props.containerRef}
            data-testid="code-view"
            data-theme={props.options.themeType}
          >
            <button
              onClick={() =>
                props.onSelectedLinesChange({
                  id: props.items[0].id,
                  range: { start: 1, end: 1, side: "additions" },
                })
              }
            >
              Select new line
            </button>
            {!mockRecycle &&
              props.items.map((item: any) => (
                <div key={item.id}>
                  {props.renderCustomHeader(item)}
                  {item.annotations.map((annotation: any) => (
                    <div key={annotation.metadata}>
                      {props.renderAnnotation(annotation, item)}
                    </div>
                  ))}
                </div>
              ))}
          </div>
        );
      }),
    };
  },
  { virtual: true },
);

const file = {
  path: "a.ts",
  lines: [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ],
};
function props(): ReviewDiffPanelProps {
  return {
    files: [file],
    drawerScrollParent: null,
    virtuosoRef: { current: null },
    navigationRef: { current: null },
    onActiveFile: jest.fn(),
    linesTruncated: false,
    fontSize: 14,
    reviewEditorScope: "account:alice:commit:one",
    inlineCommentsByFile: new Map(),
    showResolvedComments: true,
    isHeadSelected: false,
    visibleDiffLinesByFile: {},
    onOpenFile: jest.fn().mockResolvedValue(undefined),
    onViewFile: jest.fn(),
    onShowMoreLines: jest.fn(),
    activeDraftBody: "",
    activeEditingBody: "",
    pendingKey: "",
    onOpenDraft: jest.fn(),
    onDraftBodyChange: jest.fn(),
    onCancelDraft: jest.fn(),
    onOpenEdit: jest.fn(),
    onEditingBodyChange: jest.fn(),
    onCancelEdit: jest.fn(),
    onCreateComment: jest.fn().mockResolvedValue(undefined),
    onUpdateComment: jest.fn().mockResolvedValue(undefined),
    onResolveComment: jest.fn().mockResolvedValue(undefined),
    onReopenComment: jest.fn().mockResolvedValue(undefined),
    diffFindMatchCounts: new Map(),
    diffFindMatchedLineIndexes: new Map(),
  };
}
beforeEach(() => {
  localStorage.clear();
  mockTheme = "light";
  mockRecycle = false;
  mockScrollTo.mockClear();
});

test("selection creates the exact legacy anchor, with keyboard comment activation", async () => {
  const p = props();
  const user = userEvent.setup();
  render(<PierreReviewPanel {...p} />);
  await user.click(screen.getByRole("button", { name: "Select new line" }));
  screen.getByRole("button", { name: "Add inline comment" }).focus();
  await user.keyboard("{Enter}");
  expect(p.onOpenDraft).toHaveBeenCalledWith(
    makeCommentAnchor(buildDiffLineMetas(file.lines)[5], "a.ts"),
  );
});

test("active editor survives recycling, layout and appearance changes without resetting buffered content", async () => {
  const p = {
    ...props(),
    activeDraft: makeCommentAnchor(buildDiffLineMetas(file.lines)[5], "a.ts"),
  };
  const user = userEvent.setup();
  const { rerender } = render(<PierreReviewPanel {...p} />);
  const editor = screen.getByRole("textbox", { name: "Comment editor" });
  await user.type(editor, "Retained comment");
  mockTheme = "dark";
  mockRecycle = true;
  rerender(<PierreReviewPanel {...p} fontSize={18} />);
  await user.click(screen.getByRole("checkbox", { name: "Side by side" }));
  expect(screen.getByTestId("code-view").getAttribute("data-theme")).toBe(
    "dark",
  );
  expect(screen.getByRole("textbox", { name: "Comment editor" })).toBe(editor);
  expect((editor as HTMLTextAreaElement).value).toBe("Retained comment");
  await user.click(screen.getByRole("button", { name: /Add comment/ }));
  expect(p.onCreateComment).toHaveBeenCalledWith(
    p.activeDraft,
    "Retained comment",
  );
});

test("missing legacy evidence remains visible and actionable rather than attaching to a nearby line", () => {
  const p = props();
  p.inlineCommentsByFile = new Map([
    [
      "a.ts",
      [
        {
          id: "old-id",
          file_path: "a.ts",
          side: "new",
          line: 99,
          snippet: "missing",
          body_md: "Do not lose me",
          status: "draft",
          created_at: 1,
          updated_at: 1,
          local_revision: 1,
        },
      ],
    ],
  ]);
  render(<PierreReviewPanel {...p} />);
  expect(
    screen.getByRole("region", { name: "Unmatched legacy comments" }),
  ).not.toBeNull();
  expect(screen.getByText("Do not lose me")).not.toBeNull();
});
