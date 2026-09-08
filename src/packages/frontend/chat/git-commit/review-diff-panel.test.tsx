import { render, screen } from "@testing-library/react";
import { ReviewDiffPanel } from "./review-diff-panel";
import type { ReviewDiffPanelProps } from "./review-diff-panel";
import { useWorkingScrollGeneration } from "./working-scroll-generation";

jest.mock("./working-scroll-generation", () => ({
  useWorkingScrollGeneration: jest.fn(),
}));
jest.mock("./pierre-review-panel", () => ({
  __esModule: true,
  default: (props: any) => (
    <output aria-label="Review scope">
      {JSON.stringify({
        scope: props.scrollScope,
        generation: props.workingScrollGeneration,
        editing: props.activeEditingId,
      })}
    </output>
  ),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(useWorkingScrollGeneration).mockReturnValue(undefined);
});

const props = {
  files: [],
  scrollScope: "commit",
  linesTruncated: false,
  isHeadSelected: false,
} as unknown as ReviewDiffPanelProps;

test("renders Pierre directly and preserves the review while editing", async () => {
  const view = render(<ReviewDiffPanel {...props} />);
  const output = await screen.findByLabelText("Review scope");
  expect(JSON.parse(output.textContent!)).toEqual({ scope: "commit" });
  expect(screen.queryByRole("combobox", { name: "Diff renderer" })).toBeNull();
  view.rerender(<ReviewDiffPanel {...props} activeEditingId="comment" />);
  expect(screen.getByLabelText("Review scope")).toBe(output);
  expect(JSON.parse(output.textContent!)).toEqual({
    scope: "commit",
    editing: "comment",
  });
});

test("does not restore unversioned working-change coordinates", async () => {
  render(<ReviewDiffPanel {...props} isHeadSelected />);
  const output = await screen.findByLabelText("Review scope");
  expect(JSON.parse(output.textContent!)).toEqual({});
});

test("working patch generations have distinct persistence scopes", async () => {
  jest.mocked(useWorkingScrollGeneration).mockReturnValue("one");
  const view = render(<ReviewDiffPanel {...props} isHeadSelected />);
  const output = await screen.findByLabelText("Review scope");
  expect(JSON.parse(output.textContent!)).toEqual({
    scope: JSON.stringify(["commit", "loaded-working-patch", "one"]),
    generation: "one",
  });
  jest.mocked(useWorkingScrollGeneration).mockReturnValue("two");
  view.rerender(<ReviewDiffPanel {...props} isHeadSelected />);
  expect(JSON.parse(output.textContent!)).toEqual({
    scope: JSON.stringify(["commit", "loaded-working-patch", "two"]),
    generation: "two",
  });
});
