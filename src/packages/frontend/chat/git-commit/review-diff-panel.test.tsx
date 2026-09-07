import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewDiffPanel } from "./review-diff-panel";
import type { ReviewDiffPanelProps } from "./review-diff-panel";
import { captureClassicScrollAnchor } from "./renderer-scroll";
import { classicScrollTarget } from "./renderer-scroll";
import { buildLegacyFileLocations } from "./legacy-locations";
import { useWorkingScrollGeneration } from "./working-scroll-generation";
jest.mock("./working-scroll-generation", () => ({
  useWorkingScrollGeneration: jest.fn(),
}));
import {
  readScrollAnchor,
  writeScrollAnchor,
} from "@cocalc/frontend/components/diff-viewer/scroll-anchor";

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  jest.mocked(useWorkingScrollGeneration).mockReturnValue(undefined);
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

test.each([false, true, "navigation"])(
  "waits for virtualizer completion and respects cancellation=%s",
  (cancel) => {
    jest.useFakeTimers();
    const files = [{ path: "a.ts", lines: ["@@ -1 +1 @@", "-old", "+new"] }];
    const locations = buildLegacyFileLocations(files);
    const anchor = {
      location: {
        targetId: "restore",
        fileId: locations[0].fileId,
        side: "new" as const,
        line: 1,
      },
      offset: 0,
    };
    writeScrollAnchor(anchor);
    const viewport = document.createElement("div");
    const scrollIntoView = jest.fn();
    const scrollToIndex = jest.fn();
    const props = {
      files,
      scrollScope: "restore",
      drawerScrollParent: viewport,
      visibleDiffLinesByFile: {},
      virtuosoRef: { current: { scrollIntoView, scrollToIndex } },
      navigationRef: { current: null },
    } as unknown as ReviewDiffPanelProps;
    const view = render(<ReviewDiffPanel {...props} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const row = document.createElement("div");
    row.id = classicScrollTarget(locations, anchor)!.elementId;
    row.getBoundingClientRect = () => ({ top: 300, height: 20 }) as DOMRect;
    viewport.append(row);
    view.rerender(
      <ReviewDiffPanel {...props} onClaimScrollRestoration={() => {}} />,
    );
    act(() => jest.advanceTimersByTime(50));
    expect(viewport.scrollTop).toBe(0);
    if (cancel === "navigation") {
      props.navigationRef.current!.navigateToFile(1, "smooth");
      expect(scrollToIndex).toHaveBeenCalledWith({
        index: 1,
        align: "start",
        behavior: "smooth",
      });
    } else if (cancel) fireEvent.wheel(viewport);
    act(() => {
      scrollIntoView.mock.calls[0][0].done();
      jest.advanceTimersByTime(50);
    });
    expect(viewport.scrollTop).toBe(cancel ? 0 : 300);
    view.unmount();
    jest.useRealTimers();
  },
);

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
  jest.mocked(captureClassicScrollAnchor).mockReturnValue({
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

test("working patch generations have distinct persistence scopes", () => {
  jest.mocked(useWorkingScrollGeneration).mockReturnValue("generation-one");
  const scope = JSON.stringify([
    "working",
    "loaded-working-patch",
    "generation-one",
  ]);
  const viewport = document.createElement("div");
  const anchor = {
    location: {
      targetId: scope,
      fileId: "file",
      side: "new" as const,
      line: 12,
    },
    offset: 0,
  };
  jest.mocked(captureClassicScrollAnchor).mockReturnValue(anchor);
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
  expect(captureClassicScrollAnchor).toHaveBeenCalledWith(viewport, scope, []);
  view.unmount();
  expect(readScrollAnchor(scope)).toEqual(anchor);
  expect(
    readScrollAnchor(
      JSON.stringify(["working", "loaded-working-patch", "generation-two"]),
    ),
  ).toBeUndefined();
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
  const scrollIntoView = jest.fn();
  const props = {
    files: [{ path: "a.ts", lines: ["@@ -1 +1 @@", "-old", "+new"] }],
    drawerScrollParent: document.createElement("div"),
    scrollScope: "restore-classic",
    visibleDiffLinesByFile: {},
    virtuosoRef: { current: { scrollIntoView } },
    onClaimScrollRestoration: claim,
  } as unknown as ReviewDiffPanelProps;
  const view = render(<ReviewDiffPanel {...props} />);
  expect(claim).toHaveBeenCalled();
  expect(scrollIntoView).toHaveBeenCalledWith({
    index: 0,
    align: "start",
    behavior: "auto",
    done: expect.any(Function),
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
