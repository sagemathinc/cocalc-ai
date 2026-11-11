/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  setStaticFontCorsHeaders,
  setStaticScriptCorpHeaders,
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

  it("let opaque frames load the static scripts and styles (for COEP servers), not documents", () => {
    for (const path of [
      "/static/widget-host-8f1b.js",
      "/static/a1b2.mjs",
      "/static/x.css",
    ]) {
      expect(headers((res) => setStaticScriptCorpHeaders(res, path))).toEqual({
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
    }
    for (const path of [
      "/static/app.html",
      "/static/widget-host.html",
      "/static/a.woff2",
      "/static/x.json",
    ]) {
      expect(headers((res) => setStaticScriptCorpHeaders(res, path))).toEqual(
        {},
      );
    }
  });
});
