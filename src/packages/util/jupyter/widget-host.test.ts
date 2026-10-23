/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  setStaticFontCorsHeaders,
  setWidgetHostHeaders,
  WIDGET_HOST_HEADERS,
} from "./widget-host";

function headers(f: (res: any) => void): { [name: string]: string } {
  const h: { [name: string]: string } = {};
  f({ setHeader: (name: string, value: string) => (h[name] = value) });
  return h;
}

describe("widget host headers", () => {
  it("sandbox the host document into an opaque origin, framed only by CoCalc", () => {
    const h = headers(setWidgetHostHeaders);
    expect(h["Content-Security-Policy"]).toBe(
      "sandbox allow-scripts allow-popups; frame-ancestors 'self'",
    );
    expect(h["Content-Security-Policy"]).not.toContain("allow-same-origin");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h).toEqual(WIDGET_HOST_HEADERS);
  });

  it("let opaque frames load the static fonts, and nothing else", () => {
    expect(
      headers((res) => setStaticFontCorsHeaders(res, "/x/static/a1b2.woff2")),
    ).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    for (const path of [
      "/static/app-1.js",
      "/static/app.html",
      "/static/x.css",
    ]) {
      expect(headers((res) => setStaticFontCorsHeaders(res, path))).toEqual({});
    }
  });
});
