/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
JavaScript output never runs in the app page.

A cell's application/javascript outputs, together with its text/html outputs
(JavaScript often renders into them, e.g. Bokeh, or into a sibling output),
are rendered in order inside one opaque sandboxed frame.  Each JavaScript
output runs with a small jQuery-like `element` bound to its own div, as in
classic Jupyter.  The frame has no access to this page, its origin, or the
user's session; scripts can still use the network (e.g. to load libraries
from a CDN).

Other outputs of the cell (text, images, errors, ...) render normally.
*/

import type { Map } from "immutable";
import AutosizedIframe from "./autosized-iframe";

// The sandbox untrusted Jupyter output already uses: scripts in an opaque
// origin (no allow-same-origin).
const SANDBOX = "allow-forms allow-scripts allow-presentation";

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  // immutable List or array of lines
  const js =
    typeof (value as any).toJS === "function" ? (value as any).toJS() : value;
  return Array.isArray(js) ? js.join("") : `${js}`;
}

export function isJavascriptMessage(message: Map<string, any>): boolean {
  return message.getIn(["data", "application/javascript"]) != null;
}

function isHtmlMessage(message: Map<string, any>): boolean {
  return message.getIn(["data", "text/html"]) != null;
}

// Indices (into messages) of the outputs that render in the group frame, or
// null if the cell has no JavaScript output.
export function activeGroup(messages: Map<string, any>[]): number[] | null {
  if (!messages.some((m) => m != null && isJavascriptMessage(m))) {
    return null;
  }
  const group: number[] = [];
  messages.forEach((m, i) => {
    if (m != null && (isJavascriptMessage(m) || isHtmlMessage(m))) {
      group.push(i);
    }
  });
  return group;
}

// A minimal jQuery-like wrapper, enough for typical JavaScript outputs.
const ELEMENT_SHIM = `
window.__cocalcElement = function (el) {
  var w = {
    0: el, length: 1,
    get: function (i) { return i == null ? [el] : el; },
    html: function (v) { if (v === undefined) return el.innerHTML; el.innerHTML = v; return w; },
    text: function (v) { if (v === undefined) return el.textContent; el.textContent = v; return w; },
    append: function (v) {
      if (typeof v === "string") el.insertAdjacentHTML("beforeend", v);
      else if (v && v[0] instanceof Node) el.appendChild(v[0]);
      else if (v instanceof Node) el.appendChild(v);
      return w;
    },
    empty: function () { el.innerHTML = ""; return w; },
    css: function (k, v) { if (typeof k === "object") Object.assign(el.style, k); else el.style[k] = v; return w; },
    attr: function (k, v) { if (v === undefined) return el.getAttribute(k); el.setAttribute(k, v); return w; },
    find: function (s) { return el.querySelectorAll(s); },
  };
  return w;
};`;

// Make code safe to embed in an inline <script>.
function scriptBody(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

export function groupDocument(
  messages: Map<string, any>[],
  group: number[],
): string {
  const parts: string[] = [];
  for (const i of group) {
    const message = messages[i];
    if (isJavascriptMessage(message)) {
      const id = `cocalc-js-output-${i}`;
      const code = text(message.getIn(["data", "application/javascript"]));
      parts.push(
        `<div class="output_javascript" id="${id}"></div>` +
          `<script>(function (element) { try {\n${scriptBody(code)}\n} catch (err) { element.text(String(err)); } })(window.__cocalcElement(document.getElementById(${JSON.stringify(id)})));</script>`,
      );
    } else {
      parts.push(
        `<div class="output_html">${text(message.getIn(["data", "text/html"]))}</div>`,
      );
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:sans-serif}</style><script>${ELEMENT_SHIM}</script></head><body>${parts.join("\n")}</body></html>`;
}

export function ActiveOutputGroup({
  messages,
  group,
}: {
  messages: Map<string, any>[];
  group: number[];
}) {
  return (
    <AutosizedIframe
      srcDoc={groupDocument(messages, group)}
      sandbox={SANDBOX}
      title="Jupyter JavaScript output"
    />
  );
}
