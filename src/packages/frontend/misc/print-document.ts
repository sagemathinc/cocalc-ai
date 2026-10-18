/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Write untrusted HTML into a popup for printing.

A popup opened with window.open("") has the app's origin, so anything active in
content written into it runs with the user's session.  writePassiveDocument
owns the whole boundary, whatever produced the HTML:

1. The document shell (CSP, title, our own stylesheets) is written by us.
   PASSIVE_DOCUMENT_CSP comes first in <head> and blocks all script in the
   document: inline <script>, event handler attributes, javascript: URLs and
   srcdoc iframes (which inherit the policy).  frame-src 'none' also blocks
   child documents loaded from a URL, which would get their own policy.
2. The untrusted body is parsed in an inert document (nothing loads or runs
   there), and everything that can navigate the popup or embed another
   document is removed: <meta> (http-equiv=refresh would load a new document
   without our CSP), <base>, <script>, frames, plugins, forms.
3. The remaining nodes are imported into the popup directly.  They are never
   serialized and parsed again, since a reparse can turn text (e.g., inside
   SVG <style>) back into live markup.

The opener can still call w.print() and set w.onload: a CSP only restricts the
document's own scripts.  Stylesheets, fonts and images still load.
*/

export const PASSIVE_DOCUMENT_CSP = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'">`;

// Elements removed with their contents from untrusted printed content.
const REMOVED_ELEMENTS = [
  "meta",
  "base",
  "script",
  "noscript",
  "template",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "fencedframe",
  "form",
  "link:not([rel='stylesheet'])",
].join(",");

// Escape text for use in element content or a quoted attribute value.
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PassiveDocument {
  title: string;
  // Trusted markup for <head>, written by our own code (stylesheet links,
  // <style>).  Never put untrusted content here.
  head?: string;
  // Trusted inline style for <body>.
  bodyStyle?: string;
  // Untrusted HTML for the body, or an element of an inert (DOMParser)
  // document whose children are the body.
  body: string | HTMLElement;
}

// Parse untrusted HTML in an inert document and remove everything that can
// navigate or embed another document, run script, or submit.  Returns the
// inert body, whose child nodes are ready to import.
export function passiveBody(html: string): HTMLElement {
  const parsed = new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body>${html}`,
    "text/html",
  );
  // Anything the parser hoisted into <head> (e.g., a leading <meta>) is
  // dropped together with the head.
  return passivize(parsed.body);
}

// Remove, in place, everything that can navigate or embed another document,
// run script, or submit.  body must belong to an inert document.
function passivize(body: HTMLElement): HTMLElement {
  for (const elt of Array.from(body.querySelectorAll(REMOVED_ELEMENTS))) {
    elt.remove();
  }
  for (const elt of Array.from(body.querySelectorAll("*"))) {
    for (const name of elt.getAttributeNames()) {
      const lower = name.toLowerCase();
      if (
        lower.startsWith("on") ||
        lower === "srcdoc" ||
        lower === "formaction" ||
        (/(^|:)href$|^(src|action|data)$/.test(lower) &&
          /^\s*(javascript|vbscript|data:text\/html)/i.test(
            elt.getAttribute(name) ?? "",
          ))
      ) {
        elt.removeAttribute(name);
      }
    }
  }
  return body;
}

export function writePassiveDocument(
  w: Window,
  { title, head = "", bodyStyle, body }: PassiveDocument,
): void {
  const content =
    typeof body === "string" ? passiveBody(body) : passivize(body);
  const doc = w.document;
  doc.open();
  doc.write(
    `<!doctype html><html lang="en"><head>${PASSIVE_DOCUMENT_CSP}<meta charset="utf-8"><title>${escapeHtmlText(
      title,
    )}</title>${head}</head><body></body></html>`,
  );
  if (bodyStyle) {
    doc.body.setAttribute("style", bodyStyle);
  }
  // Import before close(), so images in the content delay the load event,
  // which is when callers print.
  doc.body.append(
    ...Array.from(content.childNodes).map((node) => doc.importNode(node, true)),
  );
  doc.close();
}

// Write a complete exported HTML document (e.g., a Jupyter export) through the
// passive boundary.  Only the title and https stylesheet links of its <head>
// are kept (the head is the exporter's template: content in the body can't
// add to it); the body is passivized in the inert parse and imported as nodes,
// never reparsed.  `css` is the caller's own constant stylesheet (never
// document content), e.g. the exporter's print rules.
export function writePassiveHtmlDocument(
  w: Window,
  html: string,
  { css }: { css?: string } = {},
): void {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const head = Array.from(
    parsed.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
  )
    .map((link) => link.getAttribute("href") ?? "")
    .filter((href) => /^https:\/\//i.test(href))
    .map(
      (href) =>
        `<link rel="stylesheet" href="${escapeHtmlText(href)}" crossorigin="anonymous" referrerpolicy="no-referrer">`,
    )
    .join("");
  const style = css ? `<style>${css.replace(/<\//g, "<\\/")}</style>` : "";
  writePassiveDocument(w, {
    title: parsed.title,
    head: head + style,
    body: parsed.body,
  });
}
