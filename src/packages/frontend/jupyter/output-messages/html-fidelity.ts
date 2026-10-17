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

It parses with htmlToDOM, the parser html-ssr renders with, so it gives the
same answer in the browser and in Node (static export).
*/

import { htmlToDOM } from "html-react-parser";
import {
  isAllowedHtmlTag,
  sanitizeHtmlAttributes,
} from "@cocalc/frontend/components/sanitize-html";

// Attributes whose loss does not change how the output looks or behaves, as
// long as the output brings no stylesheet or script that could refer to them
// (any <style> or <script> already sends it to a frame).
function isTolerableLoss(attr: string): boolean {
  return attr === "class" || attr.startsWith("data-");
}

interface Node {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: Node[];
}

function isInlineMathScript(node: Node): boolean {
  // html-ssr typesets these instead of dropping them
  return (
    node.name === "script" &&
    (node.attribs?.type ?? "").toLowerCase().startsWith("math/tex")
  );
}

function faithful(nodes: Node[]): boolean {
  for (const node of nodes) {
    if (node.type === "text" || node.type === "comment") {
      continue;
    }
    if (node.type === "directive") {
      // <!doctype ...>
      continue;
    }
    const tag = node.name?.toLowerCase();
    if (tag == null) {
      return false;
    }
    if (isInlineMathScript(node)) {
      continue;
    }
    const attribs = node.attribs ?? {};
    if (tag === "html" || tag === "body") {
      // html-ssr renders only their children
      if (
        !Object.keys(attribs).every((a) => isTolerableLoss(a.toLowerCase()))
      ) {
        return false;
      }
    } else if (tag === "head") {
      // html-ssr renders only the inline math in it, so that is all it may
      // hold (besides whitespace and comments)
      if (
        !(node.children ?? []).every(
          (c) =>
            c.type === "comment" ||
            isInlineMathScript(c) ||
            (c.type === "text" && !`${(c as any).data ?? ""}`.trim()),
        )
      ) {
        return false;
      }
      continue;
    } else {
      if (!isAllowedHtmlTag(tag)) {
        return false;
      }
      const lower: Record<string, string> = {};
      for (const [name, value] of Object.entries(attribs)) {
        lower[name.toLowerCase()] = value;
      }
      const kept = sanitizeHtmlAttributes(tag, lower);
      for (const [attr, value] of Object.entries(lower)) {
        if (kept[attr] === value || isTolerableLoss(attr)) {
          continue;
        }
        if (attr === "allowfullscreen" && kept[attr] != null) {
          continue;
        }
        return false;
      }
    }
    if (!faithful(node.children ?? [])) {
      return false;
    }
  }
  return true;
}

export function sanitizedHtmlIsFaithful(html: string): boolean {
  try {
    return faithful(htmlToDOM(html) as unknown as Node[]);
  } catch {
    return false;
  }
}
