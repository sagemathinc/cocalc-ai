import "../elements/types";

import { Element } from "slate";

import { markdown_to_slate } from "../markdown-to-slate";
import { withBlockSpacerParagraphs } from "../normalize";
import { slate_to_markdown } from "../slate-to-markdown";

function isSpacerParagraph(node: any): boolean {
  return (
    Element.isElement(node) && node.type === "paragraph" && node.spacer === true
  );
}

function stripTrailingNewlines(markdown: string): string {
  return markdown.replace(/\n+$/g, "");
}

test("fresh markdown parse gets spacer after trailing code block", () => {
  const markdown = "hello\n\n```\nfoo\n```";
  const value = withBlockSpacerParagraphs(markdown_to_slate(markdown, false));

  expect(value[value.length - 2]?.["type"]).toBe("code_block");
  expect(isSpacerParagraph(value[value.length - 1])).toBe(true);
  expect(
    stripTrailingNewlines(
      slate_to_markdown(value, { preserveBlankLines: false }),
    ),
  ).toBe(markdown);
});

test("fresh markdown parse gets spacer before leading code block", () => {
  const markdown = "```\nfoo\n```";
  const value = withBlockSpacerParagraphs(markdown_to_slate(markdown, false));

  expect(isSpacerParagraph(value[0])).toBe(true);
  expect(value[1]?.["type"]).toBe("code_block");
  expect(isSpacerParagraph(value[2])).toBe(true);
  expect(
    stripTrailingNewlines(
      slate_to_markdown(value, { preserveBlankLines: false }),
    ),
  ).toBe(markdown);
});
