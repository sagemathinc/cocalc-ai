import {
  markdownBlockBoundaries,
  nextMarkdownBlockBoundary,
} from "../markdown-blocks";

describe("markdownBlockBoundaries", () => {
  test("splits paragraphs at blank lines", () => {
    const text = "one\n\ntwo\n\n\nthree";
    expect(
      markdownBlockBoundaries(text).map(({ end, start }) => [
        text.slice(0, end),
        text.slice(start),
      ]),
    ).toEqual([
      ["one", "two\n\n\nthree"],
      ["one\n\ntwo", "three"],
    ]);
  });

  test("ignores blank lines inside fenced code", () => {
    const text = "~~~\na\n\n```\nb\n~~~\n\nafter";
    expect(markdownBlockBoundaries(text)).toEqual([
      { end: text.indexOf("~~~\n\nafter") + 3, start: text.indexOf("after") },
    ]);
  });

  test("keeps indented list continuations in the same block", () => {
    expect(markdownBlockBoundaries("- item\n\n  more\n- next")).toEqual([]);
  });

  test("finds the boundary that completes the block at an offset", () => {
    const text = "alpha beta\n\ngamma\n\ndelta";
    expect(nextMarkdownBlockBoundary(text, 3)).toEqual({
      end: 10,
      start: 12,
    });
    // An offset right after a separator means the earlier block was done.
    expect(nextMarkdownBlockBoundary(text, 12)).toEqual({ end: 10, start: 12 });
    expect(nextMarkdownBlockBoundary(text, 13)).toEqual({
      end: 12 + "gamma".length,
      start: text.indexOf("delta"),
    });
    expect(nextMarkdownBlockBoundary(text, text.length)).toBeUndefined();
  });
});
