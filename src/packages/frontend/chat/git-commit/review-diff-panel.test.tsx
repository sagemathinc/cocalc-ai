import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewDiffPanel } from "./review-diff-panel";
import type { ReviewDiffPanelProps } from "./review-diff-panel";
import { captureClassicScrollAnchor } from "./renderer-scroll";
import {
  readScrollAnchor,
  writeScrollAnchor,
} from "@cocalc/frontend/components/diff-viewer/scroll-anchor";

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
});

jest.mock("./drawer-sections", () => ({
  GitDiffFilesPanel: () => <div>Classic rows</div>,
}));
jest.mock("./renderer-scroll", () => ({
  ...jest.requireActual("./renderer-scroll"),
  captureClassicScrollAnchor: jest.fn(),
}));
jest.mock("./pierre-review-panel", () => ({
  __esModule: true,
  default: ({ initialScrollAnchor }: any) => (
    <output aria-label="Restored source">
      {JSON.stringify(initialScrollAnchor)}
    </output>
  ),
}));

test("renderer control passes captured coordinates without losing focus and disables switching during editing", async () => {
  const anchor = {
    location: {
      targetId: "scope",
      fileId: "file",
      side: "new" as const,
      line: 80,
    },
    offset: -2,
  };
  jest.mocked(captureClassicScrollAnchor).mockReturnValue(anchor);
  const props = {
    files: [],
    scrollScope: "scope",
    drawerScrollParent: document.createElement("div"),
    navigationRef: { current: null },
    fontSize: 14,
  } as unknown as ReviewDiffPanelProps;
  const user = userEvent.setup();
  const view = render(<ReviewDiffPanel {...props} />);
  const select = screen.getByRole("combobox", { name: "Diff renderer" });
  select.focus();
  await user.selectOptions(select, "pierre");
  expect(await screen.findByLabelText("Restored source")).toHaveTextContent(
    JSON.stringify(anchor),
  );
  expect(select).toHaveFocus();
  expect(screen.queryByText("Classic rows")).not.toBeInTheDocument();
  view.rerender(<ReviewDiffPanel {...props} activeEditingId="comment" />);
  expect(select).toBeDisabled();
});

test("Classic flushes the last captured position on close under its target scope", () => {
  const viewport = document.createElement("div");
  const anchor = {
    location: {
      targetId: "close",
      fileId: "file",
      side: "new" as const,
      line: 12,
    },
    offset: -3,
  };
  jest.mocked(captureClassicScrollAnchor).mockReturnValue(anchor);
  const view = render(
    <ReviewDiffPanel
      {...({
        files: [],
        drawerScrollParent: viewport,
        scrollScope: "close",
      } as unknown as ReviewDiffPanelProps)}
    />,
  );
  fireEvent.scroll(viewport);
  expect(readScrollAnchor("close")).toBeUndefined();
  view.unmount();
  expect(readScrollAnchor("close")).toEqual(anchor);
  expect(readScrollAnchor("another-review")).toBeUndefined();
});

test("does not persist unversioned working-change coordinates", () => {
  const viewport = document.createElement("div");
  jest
    .mocked(captureClassicScrollAnchor)
    .mockReturnValue({
      location: { targetId: "working", fileId: "file", side: "new", line: 12 },
      offset: 0,
    });
  const view = render(
    <ReviewDiffPanel
      {...({
        files: [],
        drawerScrollParent: viewport,
        scrollScope: "working",
        isHeadSelected: true,
      } as unknown as ReviewDiffPanelProps)}
    />,
  );
  fireEvent.scroll(viewport);
  view.unmount();
  expect(readScrollAnchor("working")).toBeUndefined();
});

test("Classic claims valid semantic restoration instead of competing with drawer pixels", () => {
  writeScrollAnchor({
    location: {
      targetId: "restore-classic",
      fileId: JSON.stringify(["a.ts", "a.ts"]),
      side: "old",
      line: 1,
    },
    offset: 0,
  });
  const claim = jest.fn();
  const scrollToIndex = jest.fn();
  const props = {
    files: [{ path: "a.ts", lines: ["@@ -1 +1 @@", "-old", "+new"] }],
    drawerScrollParent: document.createElement("div"),
    scrollScope: "restore-classic",
    visibleDiffLinesByFile: {},
    virtuosoRef: { current: { scrollToIndex } },
    onClaimScrollRestoration: claim,
  } as unknown as ReviewDiffPanelProps;
  const view = render(<ReviewDiffPanel {...props} />);
  expect(claim).toHaveBeenCalled();
  expect(scrollToIndex).toHaveBeenCalledWith({
    index: 0,
    align: "start",
    behavior: "auto",
  });
  view.unmount();
  claim.mockClear();
  render(
    <ReviewDiffPanel
      {...props}
      activeDiffFindMatch={{
        id: "line",
        kind: "line",
        fileIndex: 0,
        lineIndex: 1,
        preview: "old",
      }}
    />,
  );
  expect(claim).not.toHaveBeenCalled();
});
