import "../elements/types";
import { markdown_to_slate } from "../markdown-to-slate";
import { slate_to_markdown } from "../slate-to-markdown";
import { stripBlankParagraphs } from "../padding";

test("stripBlankParagraphs removes blank_line paragraphs", () => {
  const markdown = "a\n\n\nb\n\n";
  const doc = markdown_to_slate(markdown, false, {});
  const withoutBlanks = stripBlankParagraphs(doc);

  expect(withoutBlanks.some((node) => node["blank"] === true)).toBe(false);
});

test("stripBlankParagraphs keeps non-whitespace paragraphs even if blank flag is set", () => {
  const doc = [{ type: "paragraph", blank: true, children: [{ text: "bar" }] }];
  const withoutBlanks = stripBlankParagraphs(doc as any);
  expect(withoutBlanks).toHaveLength(1);
  expect(withoutBlanks[0]?.["type"]).toBe("paragraph");
});

test("markdown parser preserves blank quoted line between quoted paragraphs", () => {
  const markdown = "> foo\n> \n> bar\n\nx";
  const doc = markdown_to_slate(markdown, false, {}) as any[];
  const quote = doc.find((n) => n?.type === "blockquote");
  expect(quote).toBeTruthy();
  expect(Array.isArray(quote?.children)).toBe(true);
  if (Array.isArray(quote?.children)) {
    expect(quote.children.length).toBe(3);
    expect(quote.children[0]?.type).toBe("paragraph");
    expect(quote.children[1]?.type).toBe("paragraph");
    expect(quote.children[2]?.type).toBe("paragraph");
    expect(quote.children[0]?.children?.[0]?.text ?? "").toContain("foo");
    expect(quote.children[1]?.children?.[0]?.text ?? "").toBe("");
    expect(quote.children[2]?.children?.[0]?.text ?? "").toContain("bar");
  }
});

test("html image followed by preserved blank lines is stable", () => {
  const markdown =
    '<img src="/blobs/paste.png?uuid=test"   width="202px"  height="82px"  style="object-fit:cover"/>\n\n\nb';
  const once = slate_to_markdown(markdown_to_slate(markdown, false, {}), {
    preserveBlankLines: true,
  });
  const twice = slate_to_markdown(markdown_to_slate(once, false, {}), {
    preserveBlankLines: true,
  });

  expect(twice).toBe(once);
  expect(once).toContain("/>\n\n\nb\n");
  expect(once).not.toContain("/>\n\n\n\nb");
});

test("html image followed by preserved blank lines and trailing blank lines is stable", () => {
  const markdown =
    '<img src="/blobs/paste.png?uuid=test"   width="202px"  height="82px"  style="object-fit:cover"/>\n\n\nb\n\n\n';
  const once = slate_to_markdown(markdown_to_slate(markdown, false, {}), {
    preserveBlankLines: true,
  });
  const twice = slate_to_markdown(markdown_to_slate(once, false, {}), {
    preserveBlankLines: true,
  });

  expect(twice).toBe(once);
  expect(once).toContain("/>\n\n\nb\n");
  expect(once).not.toContain("/>\n\n\n\nb");
});
