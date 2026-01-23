import { markdownEscape } from "../util";

describe("markdownEscape", () => {
  it("keeps parentheses and underscores in plain text", () => {
    expect(markdownEscape("Hello (Jim), what's up")).toBe(
      "Hello (Jim), what's up",
    );
    expect(markdownEscape("foo_bar baz")).toBe("foo_bar baz");
  });

  it("escapes emphasis markers when they would parse as emphasis", () => {
    expect(markdownEscape("this is _em_")).toBe("this is \\_em\\_");
    expect(markdownEscape("this is *em*")).toBe("this is \\*em\\*");
    expect(markdownEscape("**bold** text")).toBe("\\*\\*bold\\*\\* text");
    expect(markdownEscape("2 * 3")).toBe("2 * 3");
    expect(markdownEscape("mix **bold** and *em*")).toBe(
      "mix \\*\\*bold\\*\\* and \\*em\\*",
    );
    expect(markdownEscape("a*b*c")).toBe("a\\*b\\*c");
  });

  it("escapes structural line starts when first child", () => {
    expect(markdownEscape("- item", true)).toBe("\\- item");
    expect(markdownEscape("* item", true)).toBe("\\* item");
    expect(markdownEscape("+ item", true)).toBe("\\+ item");
    expect(markdownEscape("1. item", true)).toBe("1\\. item");
    expect(markdownEscape("1) item", true)).toBe("1\\) item");
    expect(markdownEscape("## Heading", true)).toBe("\\#\\# Heading");
    expect(markdownEscape("---", true)).toBe("\\-\\-\\-");
  });

  it("escapes reference definitions and table separators", () => {
    expect(markdownEscape("[ref]: http://x")).toBe("\\[ref]: http://x");
    expect(markdownEscape("text\n[ref]: http://x")).toBe(
      "text\n\\[ref]: http://x",
    );
    expect(markdownEscape("| --- | --- |")).toBe("\\| --- \\| --- \\|");
    expect(markdownEscape("a | b | c")).toBe("a | b | c");
    expect(markdownEscape("[x](http://y)")).toBe("[x](http://y)");
    expect(markdownEscape("brackets [like] this")).toBe("brackets [like] this");
  });

  it("escapes backticks, backslashes, dollars, and angle brackets", () => {
    expect(markdownEscape("`code`")).toBe("\\`code\\`");
    expect(markdownEscape("\\path")).toBe("\\\\path");
    expect(markdownEscape("$5")).toBe("\\$5");
    expect(markdownEscape("1 < 2 > 0")).toBe("1 &lt; 2 &gt; 0");
  });
});
