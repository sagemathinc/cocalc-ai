/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
CoCalc's own output policy for the SVG that mermaid renders.

Diagram text comes from documents other people can edit.  Mermaid's strict
mode sanitizes too, but we do not want the page's safety to depend on
mermaid's or DOMPurify's configuration, so the final SVG goes through this
allowlist before it reaches the page:

- only SVG elements we know mermaid uses; anything else, including
  foreignObject (an HTML integration point) and every HTML element, is
  dropped with its contents;
- no event handler attributes;
- links: <a> may point only to safe URLs (http, https, mailto, relative);
  <use> only to fragments in the same SVG; <image> only to inline raster
  data: URLs;
- url(...) in attributes, inline styles and <style> sheets may only refer to
  fragments (#id), and @import is removed, so nothing external is loaded.

The result is a DOM node, not a string: the caller inserts it directly.  It is
never serialized and parsed again, since serializing SVG <style> text and
parsing it back as HTML is a known way to turn text into live markup.

Mermaid is initialized with htmlLabels: false (see get-mermaid.ts), so labels
are native SVG text and dropping foreignObject loses nothing.
*/

import { isSafeHtmlUrl } from "@cocalc/frontend/components/sanitize-html";

const SVG_NS = "http://www.w3.org/2000/svg";

const ALLOWED_ELEMENTS = new Set(
  [
    "svg",
    "g",
    "defs",
    "symbol",
    "use",
    "switch",
    "title",
    "desc",
    "style",
    "a",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "textPath",
    "marker",
    "image",
    "linearGradient",
    "radialGradient",
    "stop",
    "pattern",
    "clipPath",
    "mask",
    "filter",
    "feBlend",
    "feColorMatrix",
    "feComposite",
    "feDropShadow",
    "feFlood",
    "feGaussianBlur",
    "feMerge",
    "feMergeNode",
    "feMorphology",
    "feOffset",
  ].map((name) => name.toLowerCase()),
);

const HREF_ATTRIBUTES = new Set(["href", "xlink:href"]);
const ATTRIBUTE_NAME = /^[a-zA-Z_][a-zA-Z0-9_.:-]*$/;
const RASTER_DATA_URL =
  /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]*$/i;

// Parse mermaid's SVG markup and return a sanitized SVG element, or null if
// there is no usable SVG.  The parsing document is inert: nothing in it loads
// or runs.
export function sanitizeMermaidSvg(
  svg: string,
  doc: Document = document,
): SVGSVGElement | null {
  const parsed = new DOMParser().parseFromString(
    `<!doctype html><body>${svg}`,
    "text/html",
  );
  const root = parsed.body.firstElementChild;
  if (root == null || !isSvgElement(root, "svg")) {
    return null;
  }
  sanitizeElement(root);
  return doc.importNode(root, true) as unknown as SVGSVGElement;
}

function isSvgElement(elt: Element, name?: string): boolean {
  return (
    elt.namespaceURI === SVG_NS &&
    (name == null || elt.localName.toLowerCase() === name)
  );
}

function sanitizeElement(elt: Element): void {
  for (const attr of Array.from(elt.attributes)) {
    const value = sanitizeAttribute(elt, attr.name, attr.value);
    if (value == null) {
      elt.removeAttributeNode(attr);
    } else if (value !== attr.value) {
      attr.value = value;
    }
  }
  const tag = elt.localName.toLowerCase();
  for (const child of Array.from(elt.childNodes)) {
    if (child.nodeType === 1) {
      const childElt = child as Element;
      if (
        !isSvgElement(childElt) ||
        !ALLOWED_ELEMENTS.has(childElt.localName.toLowerCase())
      ) {
        childElt.remove();
      } else {
        sanitizeElement(childElt);
      }
    } else if (child.nodeType === 3) {
      if (tag === "style") {
        child.nodeValue = sanitizeCss(child.nodeValue ?? "");
      }
    } else {
      // comments, processing instructions, CDATA
      child.remove();
    }
  }
}

function sanitizeAttribute(
  elt: Element,
  rawName: string,
  value: string,
): string | null {
  const name = rawName.toLowerCase();
  if (!ATTRIBUTE_NAME.test(rawName) || name.startsWith("on")) {
    return null;
  }
  if (HREF_ATTRIBUTES.has(name)) {
    return sanitizeHref(elt.localName.toLowerCase(), value);
  }
  if (name.includes("href")) {
    return null;
  }
  if (name === "style") {
    return sanitizeCss(value);
  }
  if (/url\s*\(/i.test(value)) {
    return onlyFragmentUrls(value) ? value : null;
  }
  return value;
}

function sanitizeHref(tag: string, value: string): string | null {
  const trimmed = value.trim();
  if (tag === "a") {
    return isSafeHtmlUrl(trimmed) ? value : null;
  }
  if (tag === "image") {
    return RASTER_DATA_URL.test(trimmed) ? value : null;
  }
  // use, textPath, gradients, patterns, ...: same-document fragments only.
  return trimmed.startsWith("#") ? value : null;
}

function onlyFragmentUrls(value: string): boolean {
  const urls = value.match(/url\s*\(([^)]*)\)?/gi) ?? [];
  return urls.every((url) =>
    /^url\s*\(\s*(['"]?)#[^'"()\s]*\1\s*\)$/i.test(url),
  );
}

// Remove @import, any url(...) that is not a same-document fragment, and the
// legacy script-in-CSS form expression(...).
export function sanitizeCss(css: string): string {
  return decodeCssEscapes(css)
    .replace(/@import[^;]*;?/gi, "")
    .replace(/expression\s*\(/gi, "(")
    .replace(/url\s*\(([^)]*)\)?/gi, (match) =>
      onlyFragmentUrls(match) ? match : "none",
    );
}

// CSS escapes could spell url( or @import in a way the patterns above miss,
// so decode them first.  Mermaid's own CSS has none.  A decoded backslash
// or quote is dropped rather than reintroduced as syntax.
function decodeCssEscapes(css: string): string {
  return css.replace(/\\(?:([0-9a-f]{1,6})\s?|([\s\S]))/gi, (_, hex, char) => {
    const decoded =
      hex != null
        ? String.fromCodePoint(safeCodePoint(parseInt(hex, 16)))
        : char;
    return /[\\'"]/.test(decoded) ? "" : decoded;
  });
}

function safeCodePoint(n: number): number {
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? n : 0xfffd;
}
