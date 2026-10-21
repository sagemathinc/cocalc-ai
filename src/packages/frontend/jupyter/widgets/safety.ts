/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Widgets run in the app page (until they move into an opaque frame), so the
widget state of a notebook (shared with every collaborator) must not choose
code or markup that runs there:

- Widget classes come only from the bundled ipywidgets modules.  Any other
  module, which the widget library would otherwise fetch from
  cdn.jsdelivr.net/npm/<name> and evaluate here, is refused (the widget shows
  an error instead), unless it is in CDN_WIDGET_MODULES at exactly the pinned
  version.  That list is empty: a listed library still runs third-party code
  in the app page and may render model-supplied HTML itself.
- The HTML and HTMLMath views render their value through an inert parse with
  everything active removed (no scripts, handlers, frames, forms, styles,
  style attributes, and only http(s)/mailto URLs), never through innerHTML,
  in a box that contains its painting.  (HTMLMath's typeset is a no-op here:
  MathJax.Hub is stubbed in ipywidget.tsx.)
- Descriptions marked as HTML are shown as text.
*/

import {
  escapeHtmlText,
  passiveBody,
} from "@cocalc/frontend/misc/print-document";

export const BUNDLED_WIDGET_MODULES = new Set([
  "@jupyter-widgets/base",
  "@jupyter-widgets/controls",
  "@jupyter-widgets/output",
]);

// Third-party widget libraries that may still load from the CDN, by exact
// package name and the one pinned version allowed (the requested version
// must equal it).  Empty until widgets run in an opaque frame: this is a
// product decision (William), since e.g. k3d, bqplot, jupyter-leaflet and
// ipympl stop working without it.  Never a module that loads code from its
// model state (e.g. anywidget).
export const CDN_WIDGET_MODULES = new Map<string, string>();

// Throws unless the widget library may load this module.
export function assertAllowedWidgetModule(
  moduleName: unknown,
  moduleVersion: unknown,
): void {
  const name = `${moduleName ?? ""}`;
  if (BUNDLED_WIDGET_MODULES.has(name)) return;
  const pinned = CDN_WIDGET_MODULES.get(name);
  if (pinned != null && `${moduleVersion ?? ""}` === pinned) return;
  throw Error(`widget module '${name.slice(0, 100)}' is not supported`);
}

// Besides what passiveBody removes: anything that restyles the page or
// animates attributes into script URLs.
const ALSO_REMOVED = "style,link,animate,set,animateMotion,animateTransform";

// Attributes holding a URL, checked by how a URL parser reads them.
const URL_ATTRIBUTES = new Set([
  "href",
  "xlink:href",
  "src",
  "action",
  "formaction",
  "data",
  "poster",
  "background",
  "cite",
  "longdesc",
  "lowsrc",
  "dynsrc",
]);
// URL lists or pings that the check above doesn't parse.
const DROPPED_ATTRIBUTES = new Set(["srcset", "imagesrcset", "ping"]);

function isSafeWidgetUrl(elt: Element, name: string, value: string): boolean {
  let url: URL;
  try {
    url = new URL(value, "https://widget.invalid/");
  } catch {
    return false;
  }
  if (["http:", "https:", "mailto:"].includes(url.protocol)) return true;
  // Images never run script, whatever their type.
  return (
    url.protocol === "data:" &&
    name === "src" &&
    elt.localName === "img" &&
    /^data:image\//i.test(value.trim())
  );
}

// The nodes to show for widget HTML, created in doc but never parsed there.
export function inertWidgetHtml(html: string, doc: Document): Node[] {
  const body = passiveBody(html);
  for (const elt of Array.from(body.querySelectorAll(ALSO_REMOVED))) {
    elt.remove();
  }
  for (const elt of Array.from(body.querySelectorAll("*"))) {
    for (const name of elt.getAttributeNames()) {
      const lower = name.toLowerCase();
      const value = elt.getAttribute(name) ?? "";
      if (
        lower === "style" ||
        DROPPED_ATTRIBUTES.has(lower) ||
        (URL_ATTRIBUTES.has(lower) && !isSafeWidgetUrl(elt, lower, value)) ||
        /(?:^|[\s;,])\s*(?:javascript|vbscript):/i.test(value)
      ) {
        elt.removeAttribute(name);
      }
    }
    if (elt.hasAttribute("target")) {
      elt.setAttribute("rel", "noopener noreferrer");
    }
  }
  return Array.from(body.childNodes).map((node) => doc.importNode(node, true));
}

// The class to use for a loaded widget class: the HTML views made inert.
export function safeWidgetClass(
  className: string,
  moduleName: string,
  cls: any,
): any {
  if (
    moduleName !== "@jupyter-widgets/controls" ||
    typeof cls !== "function" ||
    (className !== "HTMLView" && className !== "HTMLMathView")
  ) {
    return cls;
  }
  // The view's own update sets innerHTML; ours replaces it and then runs
  // the rest of the chain (the parent's update).
  const parentUpdate = Object.getPrototypeOf(cls.prototype)?.update;
  const math = className === "HTMLMathView";
  return class extends cls {
    update(...args: any[]) {
      const content = (this as any).content as HTMLElement;
      // Nothing in it paints outside its box (no overlays on the page).
      content.style.position = "relative";
      content.style.contain = "paint";
      content.replaceChildren(
        ...inertWidgetHtml(
          `${(this as any).model.get("value") ?? ""}`,
          content.ownerDocument,
        ),
      );
      if (math) (this as any).typeset(content);
      return parentUpdate?.apply(this, args);
    }
  };
}

// For description_allow_html: shown as text.
export function inlineSanitize(value: unknown): string {
  return escapeHtmlText(`${value ?? ""}`);
}
