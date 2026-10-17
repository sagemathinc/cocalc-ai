/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Whether HTML output looks the same after sanitizing.

Notebook HTML output is never rendered unsanitized in the app page.  Output
that the sanitizer would visibly change -- styles, scripts, forms, tags or
attributes outside the allowlist -- is rendered in an opaque frame instead,
where it can keep all of that.  Everything else renders inline, sanitized,
which is cheaper and fits the page.

This only chooses where output renders; it is not a security boundary (the
inline path sanitizes regardless, and the frame is sandboxed).
*/

import {
  isAllowedHtmlTag,
  isDocumentContainerHtmlTag,
  sanitizeHtmlAttributes,
} from "@cocalc/frontend/components/sanitize-html";

// Attributes whose loss does not change how the output looks, as long as the
// output brings no stylesheet or script that could refer to them (any <style>
// or <script> already sends it to a frame).
const COSMETIC_ATTRIBUTES = new Set([
  "class",
  "id",
  "title",
  "lang",
  "dir",
  "role",
  "translate",
]);

function isCosmeticAttribute(attr: string): boolean {
  return (
    COSMETIC_ATTRIBUTES.has(attr) ||
    attr.startsWith("aria-") ||
    attr.startsWith("data-")
  );
}

function isInlineMathScript(el: Element): boolean {
  // html-ssr typesets these instead of dropping them
  return (
    el.tagName.toLowerCase() === "script" &&
    (el.getAttribute("type") ?? "").toLowerCase().startsWith("math/tex")
  );
}

export function sanitizedHtmlIsFaithful(html: string): boolean {
  if (typeof DOMParser == "undefined") {
    return false;
  }
  // An inert document: nothing loads or runs.
  const doc = new DOMParser().parseFromString(html, "text/html");
  // A leading <script> lands in the head, as do <style>, <link>, <meta>,
  // <base>, <title>, ...
  for (const el of Array.from(doc.head.children)) {
    if (!isInlineMathScript(el)) {
      return false;
    }
  }
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (isInlineMathScript(el)) {
      continue;
    }
    if (!isAllowedHtmlTag(tag) || isDocumentContainerHtmlTag(tag)) {
      return false;
    }
    const attribs: Record<string, string> = {};
    for (const { name, value } of Array.from(el.attributes)) {
      attribs[name.toLowerCase()] = value;
    }
    const kept = sanitizeHtmlAttributes(tag, attribs);
    for (const [attr, value] of Object.entries(attribs)) {
      if (kept[attr] === value || isCosmeticAttribute(attr)) {
        continue;
      }
      if (attr === "allowfullscreen" && kept[attr] != null) {
        continue;
      }
      return false;
    }
  }
  return true;
}
