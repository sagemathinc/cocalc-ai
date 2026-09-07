import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Diff } from "./diff";

jest.mock("./classic-diff", () => ({
  ClassicDiff: () => <div>Classic text</div>,
}));
jest.mock("@cocalc/frontend/components/diff-viewer/document-diff", () => ({
  __esModule: true,
  default: (props: any) => (
    <output aria-label="Historical documents">{JSON.stringify(props)}</output>
  ),
}));

test("switches inline with keyboard and follows selected history without changing documents", async () => {
  const user = userEvent.setup();
  const props = {
    v0: "before",
    v1: "after",
    path: "a.md",
    use_json: false,
    font_size: 16,
    editor_settings: {} as any,
  };
  const { rerender } = render(<Diff {...props} />);
  expect(screen.getByText("Classic text")).toBeVisible();
  const renderer = screen.getByRole("combobox", { name: "Text diff renderer" });
  renderer.focus();
  await user.selectOptions(renderer, "pierre");
  const output = await screen.findByLabelText("Historical documents");
  expect(renderer).toHaveFocus();
  expect(JSON.parse(output.textContent!)).toMatchObject({
    before: "before",
    after: "after",
    path: "a.md",
    fontSize: 16,
  });
  expect(screen.queryByText("Classic text")).not.toBeInTheDocument();
  rerender(<Diff {...props} v1="new version" use_json />);
  expect(JSON.parse(output.textContent!)).toMatchObject({
    after: "new version",
    path: "history.json",
  });
  await user.selectOptions(renderer, "classic");
  expect(screen.getByText("Classic text")).toBeVisible();
  expect(
    screen.queryByLabelText("Historical documents"),
  ).not.toBeInTheDocument();
});
