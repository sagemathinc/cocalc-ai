/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import katex from "katex";
import HTML from "@cocalc/frontend/components/html-ssr";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { latexMathToHtml } from "@cocalc/frontend/misc/math-to-html";
import { katexTrust } from "@cocalc/frontend/misc/katex-trust";
import KaTeX from "./katex";
import DefaultMath from "./ssr";
import { hasMath, splitMath } from "./segments";

describe("splitMath", () => {
  it("returns the text unchanged when there is no math", () => {
    expect(splitMath("a < b \\(")).toEqual([
      { type: "text", value: "a < b $" },
    ]);
  });

  it("splits text and math, keeping delimiters on the math", () => {
    const segments = splitMath("x $a$ y $$b$$ z \\(c\\)");
    expect(segments).toEqual([
      { type: "text", value: "x " },
      { type: "math", value: "$a$" },
      { type: "text", value: " y " },
      { type: "math", value: "$$b$$" },
      { type: "text", value: " z " },
      { type: "math", value: "$c$" },
    ]);
    expect(hasMath(segments)).toBe(true);
  });

  it("unescapes \\$ in text", () => {
    expect(splitMath("costs \\$5 and $x$")).toEqual([
      { type: "text", value: "costs $5 and " },
      { type: "math", value: "$x$" },
    ]);
  });
});

const PAYLOAD = "<img src=x onerror=alert(1)>";

describe("mixed text and math is never reparsed as HTML", () => {
  it("DefaultMath keeps markup beside math as text", () => {
    const { container } = render(<DefaultMath data={`${PAYLOAD} $x^2$`} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.textContent).toContain(PAYLOAD);
  });

  it("KaTeX (Markdown) keeps markup beside math as text", () => {
    const { container } = render(
      <KaTeX data={`${PAYLOAD} $x^2$`} inMarkdown />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.textContent).toContain(PAYLOAD);
  });

  it("KaTeX (fallback path) keeps markup beside math as text", async () => {
    const { container } = render(<KaTeX data={`${PAYLOAD} $x^2$`} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img");
  });

  it("html-ssr does not decode entities twice", () => {
    const html = renderToStaticMarkup(
      <FileContext.Provider value={{}}>
        <HTML value={"&amp;lt;img src=x onerror=alert(1)&amp;gt; $x$"} />
      </FileContext.Provider>,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&amp;lt;img");
    expect(html).toContain("katex");
  });

  it("html-ssr keeps escaped markup next to math as text", () => {
    const html = renderToStaticMarkup(
      <HTML value={"&lt;img src=x onerror=alert(1)&gt; $x$"} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes KaTeX error messages, which quote the input", () => {
    const html = latexMathToHtml(`$\\undefinedcmd ${PAYLOAD}$`);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("katexTrust", () => {
  const render = (tex: string) =>
    katex.renderToString(tex, { trust: katexTrust, throwOnError: false });

  it("allows http(s) and mailto links", () => {
    expect(render("\\href{https://example.com}{x}")).toContain(
      'href="https://example.com"',
    );
    expect(render("\\url{mailto:a@b.c}")).toContain('href="mailto:a@b.c"');
  });

  it("denies other protocols and the HTML commands", () => {
    expect(render("\\href{javascript:alert(1)}{x}")).not.toContain("href=");
    expect(render("\\href{data:text/html,x}{x}")).not.toContain("href=");
    expect(render("\\htmlClass{x}{y}")).not.toContain('class="x"');
    expect(render("\\htmlStyle{color:red}{y}")).not.toContain(
      'style="color:red',
    );
    expect(render("\\includegraphics{https://e.example/a.png}")).not.toContain(
      "<img",
    );
  });
});
