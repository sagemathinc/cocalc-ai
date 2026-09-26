import { fireEvent, render, screen } from "@testing-library/react";
import * as parser from "@cocalc/frontend/editors/slate/markdown-to-slate";
import { selectedMarkdown } from "@cocalc/frontend/editors/slate/selection-source";
import BoundedStaticMarkdown from "../bounded-static-markdown";
import { MAX_RENDERED_TEXT_CHARS } from "../paged-text";

test("bounded Markdown still serializes structured selections", () => {
  const { container } = render(
    <BoundedStaticMarkdown
      value={"**bold phrase**\n\n" + "rest ".repeat(100_000)}
    />,
  );
  const bold = container.querySelector("strong")!;
  const range = document.createRange();
  range.selectNodeContents(bold);
  expect(selectedMarkdown(range)).toContain("**bold phrase**");
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.click(screen.getByRole("button", { name: "Next part" }));
  expect(container.querySelector("strong")).toBeNull();
  selection.removeAllRanges();
});

test("a huge final paragraph only parses one bounded excerpt, including after paging", () => {
  const parse = jest.spyOn(parser, "markdown_to_slate");
  try {
    const { container } = render(
      <BoundedStaticMarkdown value={"Huge paragraph ".repeat(300_000)} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next part" }));
    expect(parse.mock.calls.length).toBeGreaterThan(0);
    expect(
      parse.mock.calls.every(
        ([text]) => text.length <= MAX_RENDERED_TEXT_CHARS,
      ),
    ).toBe(true);
    expect(container.textContent!.length).toBeLessThan(
      MAX_RENDERED_TEXT_CHARS + 1_000,
    );
  } finally {
    parse.mockRestore();
  }
});

test("terminal fences are applied after bounding the output", () => {
  const parse = jest.spyOn(parser, "markdown_to_slate");
  try {
    const { container } = render(
      <BoundedStaticMarkdown
        value={"output\n".repeat(100_000)}
        format={(part) => `\`\`\`sh\n${part}\n\`\`\``}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next part" }));
    expect(container.querySelector("pre.cocalc-slate-code-block")).toBeTruthy();
    expect(
      parse.mock.calls.every(
        ([text]) => text.length <= MAX_RENDERED_TEXT_CHARS + 10,
      ),
    ).toBe(true);
  } finally {
    parse.mockRestore();
  }
});
