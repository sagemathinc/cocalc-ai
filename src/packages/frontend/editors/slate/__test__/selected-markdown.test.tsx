/** @jest-environment jsdom */
import { render } from "@testing-library/react";
import StaticMarkdown from "../static-markdown";
import { selectedMarkdown } from "../selection-source";

it("preserves list structure, bold, italic, code and links", () => {
  const { container } = render(
    <StaticMarkdown
      value={
        "- **bold** and *italic*\n- [link](https://example.com) and `code`"
      }
    />,
  );
  const list = container.querySelector("ul")!;
  const range = document.createRange();
  range.selectNodeContents(list);
  const markdown = selectedMarkdown(range);
  expect(markdown).toContain("**bold**");
  expect(markdown).toMatch(/[*_]italic[*_]/);
  expect(markdown).toContain("[link](https://example.com)");
  expect(markdown).toContain("`code`");
  expect(markdown.match(/^\s*[-*] /gm)).toHaveLength(2);
});

it("trims partial leaves without losing their formatting or adding other text", () => {
  const { container } = render(
    <StaticMarkdown value={"before **bold phrase** after"} />,
  );
  const text = container.querySelector("strong")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 2);
  range.setEnd(text, 7);
  expect(selectedMarkdown(range).trim()).toBe("**ld ph**");
});

it("preserves nested lists", () => {
  const { container } = render(
    <StaticMarkdown value={"- parent\n  - **nested**\n- sibling"} />,
  );
  const range = document.createRange();
  range.selectNodeContents(container.querySelector("ul")!);
  const markdown = selectedMarkdown(range);
  expect(markdown).toMatch(/\n +[-*] \*\*nested\*\*/);
});

it("preserves math and fenced code when quoting a complete passage", () => {
  const { container } = render(
    <StaticMarkdown value={"Use $x^2$:\n\n```python\nprint(1)\n```"} />,
  );
  const range = document.createRange();
  range.selectNodeContents(container.querySelector(".cocalc-slate-render")!);
  const markdown = selectedMarkdown(range);
  expect(markdown).toContain("$x^2$");
  expect(markdown).toContain("```python\nprint(1)\n```");
});
