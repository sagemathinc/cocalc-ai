/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { markdownToSpeechText, splitSpeechText } from "./markdown-to-speech";

describe("markdownToSpeechText", () => {
  it("keeps semantic text while removing visual-only content", () => {
    const result = markdownToSpeechText(`
# Result

1. Read [the guide](https://example.com/guide).
2. Use \`pnpm test\`.

> Check $x^2$ carefully.

![chart](data:image/png;base64,abc)

https://example.com/raw
`);

    expect(result).toContain("Result");
    expect(result).toContain("Item 1.");
    expect(result).toContain("Item 2.");
    expect(result).toContain("Read the guide.");
    expect(result).toContain("code pnpm test");
    expect(result).toContain("Quote.");
    expect(result).toContain("$x^2$");
    expect(result).not.toContain("https://");
    expect(result).not.toContain("chart");
  });

  it("reads short code and omits long code blocks", () => {
    const result = markdownToSpeechText(
      `~~~ts\nconst n = 2;\n~~~\n\n~~~\n${"x".repeat(200)}\n~~~`,
    );
    expect(result).toContain("Code: const n = 2;");
    expect(result).toContain("Code block omitted.");
    expect(result).not.toContain("x".repeat(200));
  });
});

describe("splitSpeechText", () => {
  it("uses bounded chunks and prefers paragraph and sentence boundaries", () => {
    const chunks = splitSpeechText(
      "First sentence. Second sentence.\n\nThird paragraph.",
      24,
    );
    expect(chunks).toEqual([
      "First sentence.",
      "Second sentence.",
      "Third paragraph.",
    ]);
    expect(chunks.every((chunk) => chunk.length <= 24)).toBe(true);
  });
});
