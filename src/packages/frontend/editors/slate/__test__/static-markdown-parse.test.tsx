import { render } from "@testing-library/react";
import StaticMarkdown from "../static-markdown";
import * as parser from "../markdown-to-slate";

test("blank-line preservation is opt-out without stripping code whitespace", () => {
  const value =
    "First paragraph\n\n\nSecond paragraph\n\n```text\nfirst\n\nlast\n```";
  const { container, rerender } = render(<StaticMarkdown value={value} />);
  expect(container.querySelector(".cocalc-blank-line")).not.toBeNull();
  rerender(<StaticMarkdown value={value} preserveBlankLines={false} />);
  expect(container.querySelector(".cocalc-blank-line")).toBeNull();
  expect(container.querySelector("pre")?.textContent).toContain(
    "first\n\nlast",
  );
  rerender(<StaticMarkdown value={value} preserveBlankLines />);
  expect(container.querySelector(".cocalc-blank-line")).not.toBeNull();
});

test("unchanged Markdown is not reparsed on parent or internal state renders", () => {
  const parse = jest.spyOn(parser, "markdown_to_slate");
  try {
    const { rerender } = render(<StaticMarkdown value="first value" />);
    expect(parse).toHaveBeenCalledTimes(1);
    rerender(<StaticMarkdown value="first value" style={{ fontSize: 18 }} />);
    expect(parse).toHaveBeenCalledTimes(1);
    rerender(<StaticMarkdown value="second value" style={{ fontSize: 18 }} />);
    expect(parse).toHaveBeenCalledTimes(2);
  } finally {
    parse.mockRestore();
  }
});
