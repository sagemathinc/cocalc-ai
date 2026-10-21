/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Widgets run in the app page (until they move into an opaque frame), so the
widget state of a notebook (shared with every collaborator) must not choose
code or markup that runs there:

- Widget classes come only from the bundled ipywidgets modules, or from a
  short list of well-known third-party widget libraries (loaded from the
  CDN by exact package name and a plain version).  Any other module, which
  the widget library would otherwise fetch from cdn.jsdelivr.net/npm/<name>
  and evaluate here, is refused.
- The HTML and HTMLMath views render their value through an inert parse with
  everything active removed (no scripts, handlers, frames, forms, styles or
  script URLs), never through innerHTML.
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

// Third-party widget libraries still loaded from the CDN.  Exact package
// names only: a name can't be a path, and never a module that loads code
// from its model state (e.g. anywidget).
export const CDN_WIDGET_MODULES = new Set([
  "k3d",
  "bqplot",
  "jupyter-leaflet",
  "jupyter-matplotlib",
  "jupyterlab-plotly",
  "ipyvolume",
  "ipycanvas",
  "ipyevents",
  "jupyter-threejs",
  "nglview-js-widgets",
]);

const PLAIN_VERSION =
  /^[~^]?\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.]{1,40})?$/;

// Throws unless the widget library may load this module.
export function assertAllowedWidgetModule(
  moduleName: unknown,
  moduleVersion: unknown,
): void {
  const name = `${moduleName ?? ""}`;
  if (BUNDLED_WIDGET_MODULES.has(name)) return;
  if (
    CDN_WIDGET_MODULES.has(name) &&
    PLAIN_VERSION.test(`${moduleVersion ?? ""}`)
  ) {
    return;
  }
  throw Error(`widget module '${name.slice(0, 100)}' is not supported`);
}

// Besides what passiveBody removes: anything that restyles the page or
// animates attributes into script URLs.
const ALSO_REMOVED = "style,link,animate,set,animateMotion,animateTransform";

// The nodes to show for widget HTML, created in doc but never parsed there.
export function inertWidgetHtml(html: string, doc: Document): Node[] {
  const body = passiveBody(html);
  for (const elt of Array.from(body.querySelectorAll(ALSO_REMOVED))) {
    elt.remove();
  }
  for (const elt of Array.from(body.querySelectorAll("*"))) {
    for (const name of elt.getAttributeNames()) {
      const value = elt.getAttribute(name) ?? "";
      if (/(?:^|[\s;,])\s*(?:javascript|vbscript):/i.test(value)) {
        elt.removeAttribute(name);
      }
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
