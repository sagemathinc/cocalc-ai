import { parse_markdown } from "./parse";

it("parses every CoCalc math delimiter in a Node process without a DOM", () => {
  expect(typeof globalThis.document).toBe("undefined");
  for (const formula of [
    "$x_1$",
    "\\(x_1\\)",
    "$$x_1$$",
    "\\[x_1\\]",
    "\\begin{equation}x_1\\end{equation}",
  ]) {
    const { tokens } = parse_markdown(formula);
    const math = tokens
      .flatMap((t) => [t, ...(t.children ?? [])])
      .filter((t) => t.type.startsWith("math_"));
    expect(math).toHaveLength(1);
    expect(math[0].content).toContain("x_1");
  }
});

it("preserves metadata, source lines, references, and code whitespace", () => {
  const { meta, tokens, references, lines } = parse_markdown(
    '---\ntitle: Example\n---\n\n[guide][ref]\n\n[ref]: https://cocalc.ai "CoCalc"\n\n```text\ntrailing  \n```',
  );
  expect(meta).toBe("title: Example");
  expect(references?.REF).toEqual({
    title: "CoCalc",
    href: "https://cocalc.ai",
  });
  expect(lines).toContain("trailing  ");
  expect(tokens.find((t) => t.type === "fence")?.content).toBe("trailing  \n");
});
