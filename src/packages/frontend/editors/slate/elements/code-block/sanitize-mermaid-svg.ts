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
- links: <a> may point only to http, https, mailto or relative URLs; <use>
  only to fragments in the same SVG; <image> only to inline raster data:
  URLs;
- CSS (<style>, style attributes, presentation attributes) is parsed by the
  browser and rebuilt so it loads nothing and can only style this SVG (see
  sanitize-svg-css.ts).

The result is a DOM node, not a string: the caller inserts it directly.  It is
never serialized and parsed again, since serializing SVG <style> text and
parsing it back as HTML is a known way to turn text into live markup.

Mermaid is initialized with htmlLabels: false (see get-mermaid.ts), so labels
are native SVG text and dropping foreignObject loses nothing.
*/

import {
  isExternalCssValue,
  sanitizeInlineStyle,
  sanitizeStyleSheet,
} from "./sanitize-svg-css";

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
  // Mermaid's CSS is written for the root's id; rules are scoped to it.
  sanitizeElement(root, { scope: root.getAttribute("id"), doc });
  return doc.importNode(root, true) as unknown as SVGSVGElement;
}

function isSvgElement(elt: Element, name?: string): boolean {
  return (
    elt.namespaceURI === SVG_NS &&
    (name == null || elt.localName.toLowerCase() === name)
  );
}

interface Context {
  scope: string | null;
  doc: Document;
}

function sanitizeElement(elt: Element, context: Context): void {
  for (const attr of Array.from(elt.attributes)) {
    const value = sanitizeAttribute(elt, attr.name, attr.value, context);
    if (value == null) {
      elt.removeAttributeNode(attr);
    } else if (value !== attr.value) {
      attr.value = value;
    }
  }
  const tag = elt.localName.toLowerCase();
  if (tag === "style") {
    // Rebuilt from the parsed sheet; any child elements are dropped too.
    elt.textContent = sanitizeStyleSheet(
      elt.textContent ?? "",
      context.scope,
      context.doc,
    );
    return;
  }
  for (const child of Array.from(elt.childNodes)) {
    if (child.nodeType === 1) {
      const childElt = child as Element;
      if (
        !isSvgElement(childElt) ||
        !ALLOWED_ELEMENTS.has(childElt.localName.toLowerCase())
      ) {
        childElt.remove();
      } else {
        sanitizeElement(childElt, context);
      }
    } else if (child.nodeType !== 3) {
      // comments, processing instructions, CDATA
      child.remove();
    }
  }
}

function sanitizeAttribute(
  elt: Element,
  rawName: string,
  value: string,
  context: Context,
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
    return sanitizeInlineStyle(value, context.doc);
  }
  // Presentation attributes (fill, cursor, filter, ...) are CSS values too.
  return isExternalCssValue(value) ? null : value;
}

function sanitizeHref(tag: string, value: string): string | null {
  const trimmed = value.trim();
  if (tag === "a") {
    return isSafeLink(trimmed) ? value : null;
  }
  if (tag === "image") {
    return RASTER_DATA_URL.test(trimmed) ? value : null;
  }
  // use, textPath, gradients, patterns, ...: same-document fragments only.
  return trimmed.startsWith("#") ? value : null;
}

// http, https, mailto, or a relative URL (no scheme).
function isSafeLink(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme == null) {
    // Relative.  A leading control character or backslash could make a
    // browser see a scheme we didn't, so reject those.
    return !/^[\u0000-\u0020\\]/.test(url);
  }
  return scheme === "http" || scheme === "https" || scheme === "mailto";
}
