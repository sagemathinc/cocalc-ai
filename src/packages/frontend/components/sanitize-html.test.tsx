/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import HTML from "./html-ssr";
import { FileContext } from "@cocalc/frontend/lib/file-context";

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
  function renderTrusted(value: string): string {
    // noSanitize: true is what project/page/content.tsx sets for every editor
    // tab, which is how the iframe XSS reached chat.
    return renderToStaticMarkup(
      <FileContext.Provider
        value={{
          noSanitize: true,
          MathComponent: ({ data }) => <React.Fragment>{data}</React.Fragment>,
        }}
      >
        <HTML value={value} />
      </FileContext.Provider>,
    );
  }

  it("sandboxes an iframe with srcdoc", () => {
    const html = renderTrusted('<iframe srcdoc="<script>alert(1)</script>"></iframe>');
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
});
