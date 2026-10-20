/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import HTML from "./html-ssr";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import {
  isAllowedHtmlTag,
  sanitizeHtmlAttributes,
  shouldDropHtmlTagContents,
} from "./sanitize-html";

function renderHtml(value: string): string {
  return renderToStaticMarkup(
    <FileContext.Provider
      value={{
        MathComponent: ({ data }) => <React.Fragment>{data}</React.Fragment>,
      }}
    >
      <HTML value={value} />
    </FileContext.Provider>,
  );
}

describe("HTML SSR sanitization", () => {
  it("drops disallowed xmp raw-text contents", () => {
    expect(renderHtml("<xmp><img src=x onerror=alert(1)></xmp>")).not.toContain(
      "<img",
    );
    expect(renderHtml("<xmp><script>alert(1)</script></xmp>")).not.toContain(
      "<script",
    );
  });

  it("preserves allowed display HTML", () => {
    expect(renderHtml("<p>Hello <b>world</b></p>")).toContain(
      "<p>Hello <b>world</b></p>",
    );
  });

  it("drops unsafe attributes and URL schemes", () => {
    const html = renderHtml(
      '<a href="javascript:alert(1)" onclick="alert(2)">bad</a><img src=x onerror=alert(3)>',
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("onerror");
  });
});

describe("iframes on the sanitized path", () => {
  it.each([
    '<iframe src="https://example.com/page"></iframe>',
    '<iframe srcdoc="<p>hello</p>"></iframe>',
    "<iframe></iframe>",
    '<iframe src="data:text/html,hello"></iframe>',
  ])("renders no frame for an unvetted %s", (html) => {
    expect(renderHtml(`<p>before</p>${html}<p>after</p>`)).toBe(
      "<div><p>before</p><p>after</p></div>",
    );
  });

  it("keeps a vetted embed", () => {
    expect(
      renderHtml('<iframe src="https://www.youtube.com/embed/abc"></iframe>'),
    ).toContain('<iframe src="https://www.youtube.com/embed/abc">');
  });
});

describe("safety floor (applies even when noSanitize is set)", () => {
  function renderTrusted(value: string, inline = false): string {
    // noSanitize: true is what project/page/content.tsx sets for every editor
    // tab, which is how the iframe XSS reached chat.
    return renderToStaticMarkup(
      <FileContext.Provider
        value={{
          noSanitize: true,
          MathComponent: ({ data }) => <React.Fragment>{data}</React.Fragment>,
        }}
      >
        <HTML value={value} inline={inline} />
      </FileContext.Provider>,
    );
  }

  it("sandboxes an iframe with srcdoc", () => {
    const html = renderTrusted(
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    );
    expect(html).toContain("sandbox=");
    expect(html).not.toContain("allow-same-origin");
  });

  it("sandboxes an iframe with a data: URL", () => {
    const html = renderTrusted(
      '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>',
    );
    expect(html).toContain("sandbox=");
    expect(html).not.toContain("allow-same-origin");
  });

  it("overrides an author-supplied allow-same-origin sandbox", () => {
    const html = renderTrusted(
      '<iframe srcdoc="<script>alert(1)</script>" sandbox="allow-scripts allow-same-origin"></iframe>',
    );
    expect(html).not.toContain("allow-same-origin");
  });

  it("leaves a vetted youtube embed alone", () => {
    const html = renderTrusted(
      '<iframe src="https://www.youtube.com/embed/abc"></iframe>',
    );
    expect(html).toContain("youtube.com/embed/abc");
    expect(html).not.toContain("sandbox=");
  });

  it("drops object and embed", () => {
    expect(renderTrusted('<object data="x.swf"></object>')).not.toContain(
      "<object",
    );
    expect(renderTrusted('<embed src="x.swf">')).not.toContain("<embed");
  });

  // Server-rendered markup (e.g., notebook export, also written into a print
  // popup of the app's origin) is parsed as a document, so a <script> element
  // in it runs.
  it("never emits a script element, except inline math", () => {
    const html = renderTrusted(
      '<p>a</p><script>window.ran = 1</script><SCRIPT type="text/javascript">window.ran = 2</SCRIPT><script type="math/tex">x^2</script>',
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("window.ran");
    expect(html).toContain("x^2");
  });

  it("drops script URLs, however they are written", () => {
    const html = renderTrusted(
      [
        '<a href="javascript:alert(1)">a</a>',
        '<a href=" JaVaScRiPt:alert(2)">b</a>',
        '<a href="java&#x09;script:alert(3)">c</a>',
        '<a href="&#x01;javascript:alert(4)">d</a>',
        '<a href="vbscript:msgbox(5)">e</a>',
        '<form action="javascript:alert(6)"><button formaction="javascript:alert(7)">f</button></form>',
        '<iframe src="javascript:alert(8)"></iframe>',
        '<a href="https://example.com/javascript:ok">g</a>',
      ].join(""),
    );
    // (not even React's neutralized javascript: replacement)
    expect(html).not.toMatch(/="\s*(java|vb)script:/i);
    expect(html).toContain("https://example.com/javascript:ok");
  });

  it("drops event handler attributes", () => {
    const html = renderTrusted(
      '<b onclick="alert(1)" ONMOUSEOVER="alert(2)">x</b><img src="x.png" onerror="alert(3)">',
    );
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).toContain("x.png");
  });

  it("still keeps classes and styles, which is what noSanitize is for", () => {
    const html = renderTrusted('<div class="keep" style="color:red">hi</div>');
    expect(html).toContain('class="keep"');
    expect(html).toContain("color:red");
  });

  it("renders a standalone inline body tag as literal text", () => {
    const html = renderTrusted("<body>", true);
    expect(html).toContain("&lt;body&gt;");
    expect(html).not.toContain("<body>");
  });

  it("unwraps full-document containers and drops document metadata", () => {
    const html = renderTrusted(
      "<html><head><title>Hidden title</title></head><body>Visible body</body></html>",
    );
    expect(html).toContain("Visible body");
    expect(html).not.toContain("Hidden title");
    expect(html).not.toMatch(/<\/?(?:html|head|body|title)\b/i);
  });
});

describe("central policy: template and checkboxes", () => {
  it("drops template with its contents", () => {
    expect(shouldDropHtmlTagContents("template")).toBe(true);
    expect(shouldDropHtmlTagContents("TEMPLATE")).toBe(true);
  });

  it("allows only checkbox inputs, always disabled", () => {
    expect(isAllowedHtmlTag("input", { type: "checkbox" })).toBe(true);
    expect(isAllowedHtmlTag("input", { type: "text" })).toBe(false);
    expect(isAllowedHtmlTag("input")).toBe(false);
    expect(
      sanitizeHtmlAttributes("input", {
        type: "checkbox",
        checked: "",
        name: "x",
        style: "position:fixed",
        onclick: "z",
      }),
    ).toEqual({ type: "checkbox", disabled: "", checked: "" });
    expect(
      sanitizeHtmlAttributes("input", { type: "image", src: "x" }),
    ).toEqual({});
  });
});

describe("HTML (sanitized) with template content", () => {
  it("never renders template children", () => {
    const html = renderToStaticMarkup(
      <HTML
        value={`<template><iframe srcdoc="<script>parent.__xss=1</script>"></iframe><img src=x onerror="parent.__xss=2"></template>ok`}
      />,
    );
    expect(html).not.toContain("iframe");
    expect(html).not.toContain("img");
    expect(html).toContain("ok");
  });
});
