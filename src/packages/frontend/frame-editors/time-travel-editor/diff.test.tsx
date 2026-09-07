import { render, screen } from "@testing-library/react";
import { Diff } from "./diff";

jest.mock("@cocalc/frontend/components/diff-viewer/document-diff", () => ({
  __esModule: true,
  default: (props: any) => (
    <output aria-label="Historical documents">{JSON.stringify(props)}</output>
  ),
}));

test("uses Pierre directly and follows selected history without changing documents", async () => {
  const props = {
    v0: "before",
    v1: "after",
    path: "a.md",
    use_json: false,
    font_size: 16,
    editor_settings: {} as any,
  };
  const { rerender } = render(<Diff {...props} />);
  expect(
    screen.queryByRole("combobox", { name: "Text diff renderer" }),
  ).toBeNull();
  const output = await screen.findByLabelText("Historical documents");
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
});
