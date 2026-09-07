import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewDiffPanel } from "./review-diff-panel";
import type { ReviewDiffPanelProps } from "./review-diff-panel";
import { captureClassicScrollAnchor } from "./renderer-scroll";

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
