import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityDiff } from "./activity-diff";
import type { LineDiffResult } from "@cocalc/util/line-diff";
jest.mock("./activity-pierre-diff", () => ({
  __esModule: true,
  default: ({ diff }: any) => (
    <output aria-label="Recorded patch">{diff.source.text}</output>
  ),
}));
test("new recorded sources update in place while legacy entries retain Classic", async () => {
  const user = userEvent.setup();
  const diff: LineDiffResult = {
    lines: [],
    types: [],
    gutters: [],
    chunkBoundaries: [],
  };
  const view = (value: LineDiffResult) => (
    <ActivityDiff diff={value} path="a.ts" fontSize={14}>
      <div>Classic rows</div>
    </ActivityDiff>
  );
  const { rerender } = render(view(diff));
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  rerender(view({ ...diff, source: { kind: "add", text: "first" } }));
  const renderer = screen.getByRole("combobox", {
    name: "Activity diff renderer",
  });
  renderer.focus();
  await user.selectOptions(renderer, "pierre");
  expect(await screen.findByLabelText("Recorded patch")).toHaveTextContent(
    "first",
  );
  expect(renderer).toHaveFocus();
  expect(screen.queryByText("Classic rows")).not.toBeInTheDocument();
  rerender(view({ ...diff, source: { kind: "add", text: "updated" } }));
  expect(screen.getByLabelText("Recorded patch")).toHaveTextContent("updated");
  await user.selectOptions(renderer, "classic");
  expect(screen.getByText("Classic rows")).toBeVisible();
});
