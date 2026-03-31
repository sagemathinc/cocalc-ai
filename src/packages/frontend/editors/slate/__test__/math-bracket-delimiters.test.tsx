/** @jest-environment jsdom */

import { render } from "@testing-library/react";
import "../elements/types";
import { markdown_to_slate } from "../markdown-to-slate";
import StaticMarkdown from "../static-markdown";

function findByType(nodes: any[], type: string): any | undefined {
  for (const node of nodes ?? []) {
    if (node?.type === type) return node;
    if (Array.isArray(node?.children)) {
      const match = findByType(node.children, type);
      if (match) return match;
    }
  }
  return undefined;
}

describe("markdown bracket math delimiters", () => {
  const markdown = String.raw`If \(a = 7\), then

\[
a^{10} = 7^{10} = 282{,}475{,}249.
\]`;

  it("parses \\(...\\) and \\[...\\] into slate math nodes", () => {
    const doc = markdown_to_slate(markdown, false, {}) as any[];
    const inlineMath = findByType(doc, "math_inline");
    const blockMath = findByType(doc, "math_block");

    expect(inlineMath?.value).toBe("a = 7");
    expect(blockMath?.value).toContain("a^{10} = 7^{10} = 282{,}475{,}249.");
  });

  it("renders bracket-delimited math via katex", () => {
    const { container } = render(<StaticMarkdown value={markdown} />);

    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(container.innerHTML).not.toContain("\\(");
    expect(container.innerHTML).not.toContain("\\[");
  });
});
