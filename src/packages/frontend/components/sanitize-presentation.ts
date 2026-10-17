/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Presentation that sanitized HTML may keep when the context opts in
(FileContext.allowSafeStyles, e.g., Jupyter notebooks): a vetted subset of
inline styles, and presentational tags and attributes such as <font color>,
align and colspan.

What is never kept, however it is written: anything that loads a resource
(url(), image-set(), ...), indirection the sanitizer can't see through (var(),
env(), attr(), escapes, comments), positioning that could cover the app
(position, z-index, inset, transform, negative margins), and anything not
listed below.
*/

export interface SanitizeOptions {
  safeStyles?: boolean;
}

// Tags kept only with safeStyles (the base allowlist is in sanitize-html.ts).
export const PRESENTATION_TAGS = new Set([
  "font",
  "center",
  "details",
  "summary",
  "del",
  "ins",
  "strike",
  "big",
  "tt",
]);

const ALIGN = /^(left|right|center|justify|top|middle|bottom|baseline)$/i;
const COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,30}|rgba?\([0-9.,%\s]+\))$/i;
const LENGTH = /^\d{1,5}(\.\d+)?(px|%|em)?$/i;
const COUNT = /^\d{1,4}$/;

const PRESENTATION_ATTRIBUTE_VALUES: Record<string, RegExp> = {
  align: ALIGN,
  valign: ALIGN,
  color: COLOR,
  bgcolor: COLOR,
  width: LENGTH,
  height: LENGTH,
  border: LENGTH,
  cellpadding: LENGTH,
  cellspacing: LENGTH,
  colspan: COUNT,
  rowspan: COUNT,
  span: COUNT,
  start: COUNT,
  value: COUNT,
  size: /^[+-]?[1-7]$/,
  face: /^[\w\s,'"-]{1,100}$/,
  type: /^(1|a|i|disc|circle|square)$/i,
  open: /^(|open)$/i,
};

const PRESENTATION_ATTRIBUTES: Record<string, string[]> = {
  font: ["color", "face", "size"],
  table: ["align", "width", "border", "cellpadding", "cellspacing", "bgcolor"],
  tr: ["align", "valign", "bgcolor"],
  td: ["align", "valign", "colspan", "rowspan", "width", "height", "bgcolor"],
  th: ["align", "valign", "colspan", "rowspan", "width", "height", "bgcolor"],
  col: ["span", "width", "align", "valign"],
  colgroup: ["span", "width", "align", "valign"],
  img: ["align"],
  p: ["align"],
  div: ["align"],
  h1: ["align"],
  h2: ["align"],
  h3: ["align"],
  h4: ["align"],
  h5: ["align"],
  h6: ["align"],
  ol: ["start", "type"],
  ul: ["type"],
  li: ["value"],
  details: ["open"],
};

// The value of a presentational attribute, or undefined to drop it.
export function sanitizePresentationAttribute(
  tag: string,
  attr: string,
  value: string,
): string | undefined {
  if (!PRESENTATION_ATTRIBUTES[tag]?.includes(attr)) {
    return undefined;
  }
  const v = value.trim();
  return PRESENTATION_ATTRIBUTE_VALUES[attr]?.test(v) ? v : undefined;
}

// Properties that only change how content looks in place.
const STYLE_PROPERTIES = new Set([
  "color",
  "background",
  "background-color",
  "opacity",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-style",
  "text-indent",
  "text-shadow",
  "text-transform",
  "vertical-align",
  "white-space",
  "word-break",
  "overflow-wrap",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-style",
  "border-width",
  "border-radius",
  "border-collapse",
  "border-spacing",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "box-sizing",
  "display",
  "float",
  "clear",
  "overflow",
  "overflow-x",
  "overflow-y",
  "list-style",
  "list-style-type",
  "list-style-position",
  "table-layout",
  "caption-side",
  "empty-cells",
  "flex",
  "flex-direction",
  "flex-wrap",
  "justify-content",
  "align-items",
  "align-self",
  "gap",
  "row-gap",
  "column-gap",
  "column-count",
]);

const DISPLAY = new Set([
  "inline",
  "block",
  "inline-block",
  "flex",
  "inline-flex",
  "grid",
  "inline-grid",
  "list-item",
  "none",
  "table",
  "table-row",
  "table-cell",
]);

// Functions allowed in values; every other function (url, image-set, var,
// env, attr, element, paint, ...) drops the declaration.
const STYLE_FUNCTIONS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "calc",
  "linear-gradient",
  "radial-gradient",
  "repeating-linear-gradient",
  "repeating-radial-gradient",
]);

function safeStyleValue(property: string, value: string): boolean {
  if (value.length > 300 || /[\\<>@;{}]|\/\*|!/.test(value)) {
    // escapes, markup, at-rules, blocks, comments, !important
    return false;
  }
  for (const [, name] of value.matchAll(/([a-z-]*)\s*\(/gi)) {
    if (!STYLE_FUNCTIONS.has(name.toLowerCase())) {
      return false;
    }
  }
  if (
    (property.startsWith("margin") || property === "text-indent") &&
    /-|calc/i.test(value)
  ) {
    // negative offsets can pull content over the rest of the app
    return false;
  }
  if (property === "display" && !DISPLAY.has(value.toLowerCase())) {
    return false;
  }
  return true;
}

// Splits on ; outside parentheses and quotes.
function declarations(style: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < style.length; i++) {
    const c = style[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
    } else if (c === ";" && depth === 0) {
      out.push(style.slice(start, i));
      start = i + 1;
    }
  }
  out.push(style.slice(start));
  return out;
}

// The declarations of an inline style that are safe to keep, or undefined if
// none are.
export function sanitizeInlineStyle(style: string): string | undefined {
  if (style.length > 5000) {
    return undefined;
  }
  const kept: string[] = [];
  for (const decl of declarations(style)) {
    const colon = decl.indexOf(":");
    if (colon === -1) continue;
    const property = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (
      STYLE_PROPERTIES.has(property) &&
      value &&
      safeStyleValue(property, value)
    ) {
      kept.push(`${property}: ${value}`);
    }
  }
  return kept.length > 0 ? kept.join("; ") : undefined;
}
