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
