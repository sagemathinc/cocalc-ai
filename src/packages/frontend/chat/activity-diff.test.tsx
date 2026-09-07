import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityDiff } from "./activity-diff";
import type { LineDiffResult } from "@cocalc/util/line-diff";

jest.mock("@cocalc/frontend/components/diff-viewer/document-diff", () => ({
  ReadOnlyDiff: ({ source }: any) => (
    <output aria-label="Recorded source">{JSON.stringify(source)}</output>
  ),
}));

const empty: LineDiffResult = {
  lines: [],
  types: [],
  gutters: [],
  chunkBoundaries: [],
};

test("recorded sources render directly and update without a selector", async () => {
  const view = (text: string) => (
    <ActivityDiff
      diff={{ ...empty, source: { kind: "add", text } }}
      path="a.ts"
      fontSize={14}
    />
  );
  const { rerender } = render(view("first"));
  const output = await screen.findByLabelText("Recorded source");
  expect(JSON.parse(output.textContent!)).toMatchObject({ after: "first" });
  expect(screen.queryByRole("combobox")).toBeNull();
  rerender(view("updated"));
  expect(screen.getByLabelText("Recorded source")).toBe(output);
  expect(JSON.parse(output.textContent!)).toMatchObject({ after: "updated" });
});

test.each([undefined, { kind: "unified" as const, text: "@@ incomplete" }])(
  "incomplete source preserves raw evidence with keyboard-accessible disclosure: %s",
  async (source) => {
    const user = userEvent.setup();
    const diff: LineDiffResult = {
      lines: ["<script>literal</script>"],
      types: [1],
      gutters: ["recorded gutter"],
      chunkBoundaries: [0],
      source,
    };
    const { container } = render(
      <ActivityDiff diff={diff} path="a.ts" fontSize={14} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A reliable diff is unavailable",
    );
    expect(screen.queryByLabelText("Recorded source")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    const summary = screen.getByRole("button", { name: "Recorded diff data" });
    summary.focus();
    expect(summary).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(JSON.parse(container.querySelector("pre")!.textContent!)).toEqual(
      JSON.parse(JSON.stringify(diff)),
    );
    expect(container.querySelector("script")).toBeNull();
  },
);
