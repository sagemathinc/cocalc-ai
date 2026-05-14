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
