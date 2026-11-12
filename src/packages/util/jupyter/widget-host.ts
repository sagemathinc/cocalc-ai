/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Headers for static/widget-host.html, the document of a Jupyter widget frame
(see frontend/jupyter/widgets/frame/host.ts), on every server that serves the
webapp's static files.

The CSP sandbox gives the document an opaque origin however it is opened
(framed, or as a page), so widget code there never runs with the site's
origin; only CoCalc pages may frame it.  The host script also refuses to
start outside an opaque origin, so a server that forgets these headers fails
closed.
*/

export const WIDGET_HOST_FILENAME = "widget-host.html";

export const WIDGET_HOST_HEADERS: { [name: string]: string } = {
  "Content-Security-Policy":
    "sandbox allow-scripts allow-popups; frame-ancestors 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function setWidgetHostHeaders(res: {
  setHeader: (name: string, value: string) => unknown;
}): void {
  for (const [name, value] of Object.entries(WIDGET_HOST_HEADERS)) {
    res.setHeader(name, value);
  }
}

// Widget frames are opaque origins, so the fonts their CSS loads from /static
// (KaTeX, widget icons) are CORS requests with Origin: null.  The webapp's
// static fonts are public files: let any origin use them.
const FONT_RE = /\.(?:woff2?|ttf|otf|eot)$/i;

export function setStaticFontCorsHeaders(
  res: { setHeader: (name: string, value: string) => unknown },
  path: string,
): void {
  if (!FONT_RE.test(path)) return;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

// The widget host loads its script (and the chunks and styles that script
// loads) from /static.  From the frame's opaque origin those are cross-origin
// requests, so on a server that sends Cross-Origin-Embedder-Policy:
// require-corp (CoCalc Lite/Plus) the frame needs them to carry
// Cross-Origin-Resource-Policy, or the browser blocks them and widgets never
// render.  They are the webapp's public bundles.
const SCRIPT_OR_STYLE_RE = /\.(?:m?js|css)$/i;

export function setStaticScriptCorpHeaders(
  res: { setHeader: (name: string, value: string) => unknown },
  path: string,
): void {
  if (!SCRIPT_OR_STYLE_RE.test(path)) return;
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}
