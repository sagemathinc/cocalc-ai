import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DocumentDiff from "./document-diff";

let mockTheme = "light";
const mockParse = jest.fn((source) => [
  { name: source.path, contents: source.after },
]);
jest.mock("./pierre-model", () => ({
  parsePreviewSource: (source: any) => mockParse(source),
}));
jest.mock("./highlighting-provider", () => ({
  DiffHighlightingProvider: ({ children }: any) => children,
}));
jest.mock("@cocalc/frontend/appearance/use-appearance", () => ({
  useAppearance: () => ({ resolved: mockTheme }),
}));
jest.mock(
  "@pierre/diffs/react",
  () => ({
    CodeView: ({ containerRef, items, options, onKeyDown, style }: any) => (
      <div
        ref={containerRef}
        onKeyDown={onKeyDown}
        style={style}
        data-version={items[0].version}
        data-theme={options.themeType}
        data-split={options.diffStyle}
        data-kind={items[0].type}
      >
        {(items[0].fileDiff ?? items[0].file).contents}
      </div>
    ),
  }),
  { virtual: true },
);
const props = {
  before: "old",
  after: "new",
  path: "a.ts",
  label: "Selected versions",
  fontSize: 14,
};
beforeEach(() => {
  localStorage.clear();
  mockTheme = "light";
  mockParse.mockClear();
});

test("updates versioned content in place and respects explicit appearance and keyboard preferences", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<DocumentDiff {...props} />);
  const viewport = screen.getByRole("region", { name: "Selected versions" });
  expect(viewport).toHaveTextContent("new");
  expect(viewport).toHaveAttribute("data-version", "0");
  rerender(<DocumentDiff {...props} after="changed version" />);
  expect(viewport).toHaveTextContent("changed version");
  expect(viewport).toHaveAttribute("data-version", "1");
  mockTheme = "dark";
  rerender(<DocumentDiff {...props} after="changed version" />);
  expect(viewport).toHaveAttribute("data-theme", "dark");
  expect(viewport).toHaveAttribute("data-version", "1");
  screen.getByRole("checkbox", { name: "Side by side" }).focus();
  await user.keyboard(" ");
  expect(viewport).toHaveAttribute("data-split", "split");
  expect(viewport.scrollTop).toBe(0);
  Object.defineProperties(viewport, {
    clientHeight: { value: 500 },
    scrollHeight: { value: 3000 },
  });
  viewport.focus();
  await user.keyboard(" ");
  expect(viewport.scrollTop).toBe(450);
  await user.keyboard("{Shift>} {/Shift}");
  expect(viewport.scrollTop).toBe(0);
});

test("oversized sources fail explicitly without invoking the parser or truncating", () => {
  const { rerender } = render(
    <DocumentDiff {...props} after={"a".repeat(4 * 1024 * 1024)} />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("4 MB");
  expect(mockParse).not.toHaveBeenCalled();
  rerender(<DocumentDiff {...props} after={"\n".repeat(100_001)} />);
  expect(screen.getByRole("alert")).toHaveTextContent("100,000 lines");
  expect(mockParse).not.toHaveBeenCalled();
  rerender(<DocumentDiff {...props} />);
  expect(
    screen.getByRole("region", { name: "Selected versions" }),
  ).toHaveTextContent("new");
});

test("equal versions use a file item and can transition back to a diff", () => {
  const { rerender } = render(<DocumentDiff {...props} />);
  rerender(<DocumentDiff {...props} after="old" />);
  const viewport = screen.getByRole("region", { name: "Selected versions" });
  expect(viewport).toHaveAttribute("data-kind", "file");
  expect(viewport).toHaveTextContent("old");
  expect(screen.getByRole("status")).toHaveTextContent("Identical versions");
  rerender(<DocumentDiff {...props} after="new again" />);
  expect(viewport).toHaveAttribute("data-kind", "diff");
  expect(viewport).toHaveTextContent("new again");
  expect(screen.queryByRole("status")).toBeNull();
});
