import { __test__ } from "../block-markdown-editor-core";

const { findNextMatchIndex, findPreviousMatchIndex } = __test__;

describe("block search helpers", () => {
  test("findNextMatchIndex advances and wraps", () => {
    const markdown = "one two one two";
    const selection = { start: 0, end: 0 };
    expect(findNextMatchIndex(markdown, "one", selection, null)).toBe(0);
    expect(findNextMatchIndex(markdown, "one", selection, 0)).toBe(8);
    expect(findNextMatchIndex(markdown, "one", selection, 8)).toBe(0);
  });

  test("findPreviousMatchIndex goes backward and wraps", () => {
    const markdown = "one two one two";
    const selection = { start: markdown.length, end: markdown.length };
    expect(findPreviousMatchIndex(markdown, "one", selection, null)).toBe(8);
    expect(findPreviousMatchIndex(markdown, "one", selection, 8)).toBe(0);
    expect(findPreviousMatchIndex(markdown, "one", selection, 0)).toBe(8);
  });

  test("finds matches across markdown structure", () => {
    const markdown = [
      "Intro **bold** text",
      "",
      "- item with $x^2$ and **bold** again",
      "",
      "More **bold** here",
    ].join("\n");
    const lower = markdown.toLowerCase();
    const selection = { start: 0, end: 0 };

    const first = lower.indexOf("bold");
    const second = lower.indexOf("bold", first + 1);
    const third = lower.indexOf("bold", second + 1);

    expect(findNextMatchIndex(markdown, "bold", selection, null)).toBe(first);
    expect(findNextMatchIndex(markdown, "bold", selection, first)).toBe(second);
    expect(findNextMatchIndex(markdown, "bold", selection, second)).toBe(third);

    const endSelection = { start: markdown.length, end: markdown.length };
    expect(findPreviousMatchIndex(markdown, "bold", endSelection, null)).toBe(
      third,
    );
  });
});
