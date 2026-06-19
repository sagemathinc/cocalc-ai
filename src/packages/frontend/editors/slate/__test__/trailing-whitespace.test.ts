import {
  differsOnlyByTrailingMarkdownBlankWhitespace,
  preserveSourceForTrailingBlankWhitespaceOnly,
  removeTrailingMarkdownBlankWhitespace,
} from "../trailing-whitespace";

describe("trailing markdown blank whitespace", () => {
  it("normalizes trailing blank lines and whitespace-only final lines", () => {
    expect(removeTrailingMarkdownBlankWhitespace("a\n")).toBe("a");
    expect(removeTrailingMarkdownBlankWhitespace("a\n\n\t \n  ")).toBe("a");
    expect(removeTrailingMarkdownBlankWhitespace("a\r\n\r\n  ")).toBe("a");
  });

  it("detects EOF-only blank whitespace changes", () => {
    expect(differsOnlyByTrailingMarkdownBlankWhitespace("a", "a\n")).toBe(true);
    expect(differsOnlyByTrailingMarkdownBlankWhitespace("a\n", "a\n\n")).toBe(
      true,
    );
  });

  it("does not treat content changes as trailing whitespace-only changes", () => {
    expect(differsOnlyByTrailingMarkdownBlankWhitespace("a", "b\n")).toBe(
      false,
    );
    expect(differsOnlyByTrailingMarkdownBlankWhitespace("a\nb", "a\nb\n")).toBe(
      true,
    );
    expect(differsOnlyByTrailingMarkdownBlankWhitespace("a\nb", "a\n\nb")).toBe(
      false,
    );
  });

  it("preserves trailing spaces on the final content line", () => {
    expect(removeTrailingMarkdownBlankWhitespace("a  ")).toBe("a  ");
    expect(differsOnlyByTrailingMarkdownBlankWhitespace("a", "a  ")).toBe(
      false,
    );
  });

  it("keeps the source baseline when normalization only adds EOF blank whitespace", () => {
    expect(
      preserveSourceForTrailingBlankWhitespaceOnly({
        source: "a",
        normalized: "a\n",
      }),
    ).toBe("a");
    expect(
      preserveSourceForTrailingBlankWhitespaceOnly({
        source: "a\n",
        normalized: "a\n\n",
      }),
    ).toBe("a\n");
  });

  it("uses the normalized value when content changes", () => {
    expect(
      preserveSourceForTrailingBlankWhitespaceOnly({
        source: "a",
        normalized: "b\n",
      }),
    ).toBe("b\n");
  });
});
