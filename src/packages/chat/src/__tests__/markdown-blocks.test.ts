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

  test.each([
    ["$$", "$$"],
    ["\\[", "\\]"],
    ["\\begin{align*}", "\\end{align*}"],
  ])("ignores blank lines inside display math (%s)", (open, close) => {
    const math = `${open}\nx\n\ny\n${close}`;
    const text = `${math}\n\nafter`;
    expect(markdownBlockBoundaries(text)).toEqual([
      { end: math.length, start: math.length + 2 },
    ]);
    expect(markdownBlockBoundaries(`${open}\nx\n\ny`)).toEqual([]);
    const inline = `${open}x${close}`;
    expect(markdownBlockBoundaries(`${inline}\n\nafter`)).toEqual([
      { end: inline.length, start: inline.length + 2 },
    ]);
  });

  test("does not treat math delimiters inside code as math", () => {
    const code = "```\n$$\n```";
    expect(markdownBlockBoundaries(`${code}\n\nafter`)).toEqual([
      { end: code.length, start: code.length + 2 },
    ]);
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
