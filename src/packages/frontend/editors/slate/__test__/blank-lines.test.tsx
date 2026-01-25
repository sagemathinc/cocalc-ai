import "../elements/types";
import { markdown_to_slate } from "../markdown-to-slate";
import { stripBlankParagraphs } from "../padding";

test("stripBlankParagraphs removes blank_line paragraphs", () => {
  const markdown = "a\n\n\nb\n\n";
  const doc = markdown_to_slate(markdown, false, {});
  const withoutBlanks = stripBlankParagraphs(doc);

  expect(withoutBlanks.some((node) => node["blank"] === true)).toBe(false);
});
