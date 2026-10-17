/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { sanitizeMermaidSvg } from "./sanitize-mermaid-svg";
import {
  isExternalCssValue,
  sanitizeInlineStyle,
  sanitizeStyleSheet,
} from "./sanitize-svg-css";

// Real mermaid 11.16.1 output (strict, htmlLabels: false, as configured in
// get-mermaid.ts), rendered in Chromium.  The evil_* and directive diagrams
// try label markup, click callbacks, javascript: links, and external CSS via
// fontFamily/themeCSS directives.
const FIXTURES: Record<
  string,
  string
> = require("./__fixtures__/mermaid-11-svgs.json");

function parse(svg: string): Element {
  return new DOMParser().parseFromString(`<body>${svg}`, "text/html").body
    .firstElementChild!;
}

function assertPassive(root: Element) {
  for (const elt of [root, ...Array.from(root.querySelectorAll("*"))]) {
    expect(elt.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(elt.localName).not.toBe("foreignObject");
    expect(elt.localName).not.toBe("script");
    for (const name of elt.getAttributeNames()) {
      expect(name.toLowerCase().startsWith("on")).toBe(false);
      const value = elt.getAttribute(name)!;
      expect(value).not.toMatch(/javascript:/i);
      for (const url of value.match(/url\([^)]*\)/gi) ?? []) {
        expect(url).toMatch(/^url\(\s*['"]?#/);
      }
    }
  }
  for (const style of Array.from(root.querySelectorAll("style"))) {
    expect(style.textContent).not.toMatch(/@import/i);
    for (const url of style.textContent!.match(/url\([^)]*\)/gi) ?? []) {
      expect(url).toMatch(/^url\(\s*['"]?#/);
    }
  }
}

describe("sanitizeMermaidSvg on real mermaid output", () => {
  for (const [name, svg] of Object.entries(FIXTURES)) {
    it(`${name}: passive, and keeps the drawing`, () => {
      const clean = sanitizeMermaidSvg(svg)!;
      expect(clean).not.toBeNull();
      expect(clean.ownerDocument).toBe(document);
      assertPassive(clean);
      const original = parse(svg);
      const count = (root: Element, sel: string) =>
        root.querySelectorAll(sel).length;
      // Everything except foreignObject (journey, which has an SVG text
      // fallback beside it) and external CSS survives.
      for (const sel of ["text", "tspan", "path", "rect", "g", "marker"]) {
        expect(count(clean, sel)).toBe(count(original, sel));
      }
      const textOf = (root: Element) =>
        Array.from(root.querySelectorAll("text"))
          .map((t) => t.textContent)
          .join("|");
      expect(textOf(clean)).toBe(textOf(original));
    });
  }

  it("removes the external CSS a diagram directive injected", () => {
    expect(FIXTURES.evil_css).toContain("url(https://evil.example/b)");
    const clean = sanitizeMermaidSvg(FIXTURES.evil_css)!;
    expect(clean.outerHTML).not.toContain("evil.example");
  });

  it("keeps safe links and the C4 inline raster icon", () => {
    const flow = sanitizeMermaidSvg(FIXTURES.flow)!;
    expect(
      Array.from(flow.querySelectorAll("a")).map((a) =>
        a.getAttribute("xlink:href"),
      ),
    ).toContain("https://example.com/");
    const c4 = sanitizeMermaidSvg(FIXTURES.c4)!;
    expect(c4.querySelector("image")?.getAttribute("xlink:href")).toMatch(
      /^data:image\/png;base64,/,
    );
  });
});

describe("sanitizeMermaidSvg on hostile SVG", () => {
  const hostile = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
    <style>@import url(https://e.example/a.css); .a{fill:url(https://e.example/b)} .b{fill:url(#ok)} .c{background:u\\72l(https://e.example/c)}</style>
    <foreignObject><div><img src=x onerror="alert(2)"></div></foreignObject>
    <script>alert(3)</script>
    <a href="javascript:alert(4)"><text>j</text></a>
    <a xlink:href="https://example.com/"><text>ok</text></a>
    <use href="https://e.example/x.svg#a"/><use href="#local"/>
    <image href="https://e.example/track.png"/><image href="data:image/svg+xml;base64,PHN2Zz4="/>
    <animate attributeName="href" to="javascript:alert(5)"/>
    <set attributeName="onclick" to="alert(6)"/>
    <rect style="fill:url(https://e.example/d)" fill="url(https://e.example/e)" filter="url(#f)" onclick="alert(7)"/>
    <iframe srcdoc="x"></iframe>
    <!-- comment -->
  </svg>`;

  it("leaves nothing active or external", () => {
    const clean = sanitizeMermaidSvg(hostile)!;
    assertPassive(clean);
    const html = clean.outerHTML;
    expect(html).not.toContain("e.example");
    expect(html).not.toMatch(/alert/);
    expect(html).not.toMatch(/<(animate|set|iframe|img|div)\b/i);
    expect(clean.querySelector("a")?.getAttribute("href")).toBeNull();
    expect(
      Array.from(clean.querySelectorAll("a")).map((a) =>
        a.getAttribute("xlink:href"),
      ),
    ).toEqual([null, "https://example.com/"]);
    expect(
      Array.from(clean.querySelectorAll("use")).map((u) =>
        u.getAttribute("href"),
      ),
    ).toEqual([null, "#local"]);
    expect(
      Array.from(clean.querySelectorAll("image")).map((u) =>
        u.getAttribute("href"),
      ),
    ).toEqual([null, null]);
    expect(clean.querySelector("rect")?.getAttribute("filter")).toBe("url(#f)");
    expect(clean.querySelector("rect")?.getAttribute("fill")).toBeNull();
  });

  it("returns null for non-SVG output", () => {
    expect(sanitizeMermaidSvg("<div>no</div>")).toBeNull();
    expect(sanitizeMermaidSvg("")).toBeNull();
  });

  it("does not let style text become markup", () => {
    const clean = sanitizeMermaidSvg(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;</style></svg>`,
    )!;
    const container = document.createElement("div");
    container.replaceChildren(clean);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("meta")).toBeNull();
  });
});

describe("CSS policy", () => {
  // Stylesheets are parsed with the browser's CSS parser, which jsdom lacks;
  // here the policy must fail closed.  The real CSS behavior is checked in
  // Chromium by sanitize-mermaid-svg.browser-test.mjs.
  it("drops stylesheets it cannot parse (jsdom)", () => {
    expect(
      sanitizeStyleSheet("#d1{color:red} body{display:none}", "d1", document),
    ).toBe("");
  });

  it("drops all CSS without a usable scope id", () => {
    expect(sanitizeStyleSheet("#x{color:red}", null, document)).toBe("");
    expect(sanitizeStyleSheet("#x{color:red}", "a b", document)).toBe("");
  });

  it("applies the declaration policy to style attributes", () => {
    const out = sanitizeInlineStyle(
      `max-width: 100px; background-image: image-set("https://e.example/i.png" 1x); cursor: url(https://e.example/c), auto; position: fixed`,
      document,
    );
    expect(out).toContain("max-width: 100px");
    expect(out).not.toMatch(/e\.example|fixed/);
  });

  it("recognizes resource functions in any spelling", () => {
    for (const v of [
      `url(https://e)`,
      `image-set("https://e" 1x)`,
      `-webkit-image-set("https://e" 1x)`,
      `cross-fade(url(a), url(b))`,
      `element(#x)`,
      `src("https://e")`,
      `URL(x)`,
    ]) {
      expect(isExternalCssValue(v)).toBe(true);
    }
    expect(isExternalCssValue(`url(#g)`)).toBe(false);
    expect(isExternalCssValue(`url("#g")`)).toBe(false);
    expect(isExternalCssValue(`rgb(1, 2, 3)`)).toBe(false);
  });
});
