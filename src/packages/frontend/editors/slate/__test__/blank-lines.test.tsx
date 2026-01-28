import "../elements/types";
import { markdown_to_slate } from "../markdown-to-slate";
import { stripBlankParagraphs } from "../padding";

test("stripBlankParagraphs removes blank_line paragraphs", () => {
  const markdown = "a\n\n\nb\n\n";
  const doc = markdown_to_slate(markdown, false, {});
  const withoutBlanks = stripBlankParagraphs(doc);

  expect(withoutBlanks.some((node) => node["blank"] === true)).toBe(false);
});

test("stripBlankParagraphs keeps non-whitespace paragraphs even if blank flag is set", () => {
  const doc = [
    { type: "paragraph", blank: true, children: [{ text: "bar" }] },
  ];
  const withoutBlanks = stripBlankParagraphs(doc as any);
  expect(withoutBlanks).toHaveLength(1);
  expect(withoutBlanks[0]?.["type"]).toBe("paragraph");
});
