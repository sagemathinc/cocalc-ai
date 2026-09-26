import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { copyTextToClipboard } from "@cocalc/frontend/components/copy-to-clipboard-util";
import {
  MAX_RENDERED_TEXT_CHARS,
  PagedText,
  textPage,
  textPageCount,
} from "../paged-text";
import { joinedTextSource } from "../text-source";

jest.mock("@cocalc/frontend/components/copy-to-clipboard-util", () => ({
  copyTextToClipboard: jest.fn(async () => true),
}));

test.each([
  "paragraph ".repeat(400_000),
  "# Heading\n\n**bold** and `code`\n\n".repeat(100_000),
])(
  "multi-megabyte content never reaches the renderer in one piece",
  async (value) => {
    const source = joinedTextSource([value.slice(0, 100), value.slice(100)]);
    source.toString = jest.fn(source.toString);
    const child = jest.fn((part: string) => (
      <pre data-testid="page">{part}</pre>
    ));
    render(<PagedText value={source}>{child}</PagedText>);
    expect(screen.getByTestId("page").textContent).toBe(textPage(value, 0));
    const user = userEvent.setup();
    const next = screen.getByRole("button", { name: "Next part" });
    next.focus();
    await user.keyboard("{Enter}");
    expect(next).toHaveFocus();
    expect(screen.getByTestId("page").textContent).toBe(textPage(value, 1));
    fireEvent.click(screen.getByRole("button", { name: "Last part" }));
    expect(screen.getByTestId("page").textContent).toBe(
      textPage(value, textPageCount(value) - 1),
    );
    expect(
      child.mock.calls.every(
        ([part]) => part.length <= MAX_RENDERED_TEXT_CHARS,
      ),
    ).toBe(true);
    expect(source.toString).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy full text" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copied full text" }),
      ).toBeTruthy(),
    );
    expect(copyTextToClipboard).toHaveBeenLastCalledWith({ text: value });
    expect(source.toString).toHaveBeenCalledTimes(1);
  },
);

test("paging is lossless at Unicode and source-fragment boundaries", () => {
  const value =
    "a".repeat(MAX_RENDERED_TEXT_CHARS - 2) + "\u{1f680}".repeat(20_000);
  const source = joinedTextSource([
    value.slice(0, 20),
    value.slice(20, 16383),
    value.slice(16383),
  ]);
  const pages = Array.from({ length: textPageCount(source) }, (_, i) =>
    textPage(source, i),
  );
  expect(pages.join("")).toBe(value);
  expect(pages.every((part) => part.length <= MAX_RENDERED_TEXT_CHARS)).toBe(
    true,
  );
  for (const part of pages) {
    expect(part).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  }
});

test("short output stays intact without navigation", () => {
  render(
    <PagedText value="**small**">{(part) => <pre>{part}</pre>}</PagedText>,
  );
  expect(screen.getByText("**small**")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

test("streaming follows the tail, but does not interrupt a reader paging back", () => {
  let value = "first" + "x".repeat(MAX_RENDERED_TEXT_CHARS * 3) + "tail";
  const view = (followTail = true) => (
    <PagedText value={value} followTail={followTail}>
      {(part) => <pre data-testid="page">{part}</pre>}
    </PagedText>
  );
  const { rerender } = render(view());
  expect(screen.getByTestId("page").textContent).toContain("tail");
  fireEvent.click(screen.getByRole("button", { name: "First part" }));
  value += "x".repeat(MAX_RENDERED_TEXT_CHARS * 2) + "new tail";
  rerender(view());
  expect(screen.getByTestId("page").textContent).toContain("first");
  fireEvent.click(screen.getByRole("button", { name: "Follow latest" }));
  expect(screen.getByTestId("page").textContent).toContain("new tail");
  const tail = screen.getByTestId("page");
  const text = tail.textContent;
  rerender(view(false));
  expect(screen.getByTestId("page")).toBe(tail);
  expect(tail.textContent).toBe(text);
  fireEvent.click(screen.getByRole("button", { name: "First part" }));
  expect(screen.getByTestId("page").textContent).toContain("first");
  value = "small replacement";
  rerender(view());
  expect(screen.getByTestId("page").textContent).toBe(value);
});

test("completion preserves a manually selected page and keyboard focus", () => {
  const value = "page ".repeat(MAX_RENDERED_TEXT_CHARS);
  const view = (followTail: boolean) => (
    <PagedText value={value} followTail={followTail}>
      {(part) => <pre data-testid="page">{part}</pre>}
    </PagedText>
  );
  const { rerender } = render(view(true));
  fireEvent.click(screen.getByRole("button", { name: "First part" }));
  const next = screen.getByRole("button", { name: "Next part" });
  next.focus();
  fireEvent.click(next);
  const page = screen.getByTestId("page");
  rerender(view(false));
  expect(screen.getByTestId("page")).toBe(page);
  expect(page.textContent).toBe(textPage(value, 1));
  expect(next).toHaveFocus();
});
