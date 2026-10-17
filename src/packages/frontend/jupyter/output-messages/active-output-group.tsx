/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
JavaScript output never runs in the app page.

When the representation selected for an output (the same choice the Data
renderer makes) is application/javascript, that cell's JavaScript outputs and
its selected text/html outputs render together, in order, in one opaque
sandboxed frame ("opaque-scripts": scripts, no same-origin).  JavaScript often
renders into other outputs of the same cell (Bokeh, or JS that fills a sibling
div), which is why they share a frame.

The frame's document is a constant shell (jQuery and a small bootstrap), so it
loads once.  The parent posts the cell's current outputs, keyed by position
and content.  The frame keeps outputs whose key is unchanged, inserts new ones
in order and removes stale ones; only then does it run each new JavaScript
output, once, with `element` set to a jQuery wrapper of its own div (as in
classic Jupyter).  Scripts run via `new Function` inside the frame, so syntax
errors are caught and shown.

The frame has no access to this page, its origin or the session.  Scripts can
still use the network (e.g., to load a library from a CDN).

Other outputs of the cell (text, images, errors, ...) render normally.
*/

import type { Map } from "immutable";
import { useEffect, useMemo, useRef } from "react";
import jquerySource from "jquery/dist/jquery.min.js?raw";
import AutosizedIframe from "./autosized-iframe";

export const ACTIVE_OUTPUT_MESSAGE = "cocalc-active-outputs";

export interface ActiveOutput {
  key: string;
  kind: "html" | "javascript";
  value: string;
}

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  const js =
    typeof (value as any).toJS === "function" ? (value as any).toJS() : value;
  return Array.isArray(js) ? js.join("") : `${js}`;
}

// A short content hash, so a changed output (update_display_data) gets a new
// key and runs once more, while an unchanged one never re-runs.
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return (h >>> 0).toString(36) + "." + s.length.toString(36);
}

// The outputs (by index into messages) that render in the frame, given the
// MIME type selected for each message; null if no JavaScript output is
// selected in this cell.
export function activeGroup(
  messages: Map<string, any>[],
  selectedType: (message: Map<string, any>) => string | undefined,
): ActiveOutput[] | null {
  const selected = messages.map((m) =>
    m == null ? undefined : selectedType(m),
  );
  if (!selected.includes("application/javascript")) {
    return null;
  }
  const outputs: ActiveOutput[] = [];
  selected.forEach((type, i) => {
    if (type !== "application/javascript" && type !== "text/html") return;
    const value = text(messages[i].getIn(["data", type]));
    outputs.push({
      key: `${i}:${hash(value)}`,
      kind: type === "application/javascript" ? "javascript" : "html",
      value,
    });
  });
  return outputs;
}

// Runs in the frame.  Accepts updates only from the parent window.
const BOOTSTRAP = `(function () {
  var root = document.getElementById("cocalc-outputs");
  var rendered = new Map();
  function run(div, code) {
    try {
      new Function("element", code).call(window, jQuery(div));
    } catch (err) {
      var pre = document.createElement("pre");
      pre.className = "cocalc-javascript-error";
      pre.textContent = String(err);
      div.appendChild(pre);
    }
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== ${JSON.stringify(ACTIVE_OUTPUT_MESSAGE)} || !Array.isArray(data.outputs)) return;
    var wanted = new Set();
    var toRun = [];
    var prev = null;
    data.outputs.forEach(function (o) {
      if (!o || typeof o.key !== "string" || typeof o.value !== "string") return;
      wanted.add(o.key);
      var div = rendered.get(o.key);
      if (!div) {
        div = document.createElement("div");
        if (o.kind === "javascript") {
          div.className = "output_javascript";
          toRun.push([div, o.value]);
        } else {
          div.className = "output_html";
          div.innerHTML = o.value;
        }
        rendered.set(o.key, div);
      }
      var next = prev ? prev.nextSibling : root.firstChild;
      if (div !== next) root.insertBefore(div, next);
      prev = div;
    });
    rendered.forEach(function (div, key) {
      if (!wanted.has(key)) {
        div.remove();
        rendered.delete(key);
      }
    });
    // All outputs are in the DOM before any new script runs, so a script can
    // target an output that comes after it.
    toRun.forEach(function (x) { run(x[0], x[1]); });
  });
})();`;

// Make code safe to embed in an inline <script>.
function scriptBody(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

export const SHELL_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:sans-serif}</style><script>${scriptBody(
  `${jquerySource}`,
)}</script></head><body><div id="cocalc-outputs"></div><script>${scriptBody(
  BOOTSTRAP,
)}</script></body></html>`;

export function ActiveOutputGroup({ outputs }: { outputs: ActiveOutput[] }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const outputsRef = useRef<ActiveOutput[]>(outputs);
  outputsRef.current = outputs;
  const post = (iframe: HTMLIFrameElement | null) => {
    // The frame is an opaque origin, so its origin can't be named here.
    iframe?.contentWindow?.postMessage(
      { type: ACTIVE_OUTPUT_MESSAGE, outputs: outputsRef.current },
      "*",
    );
  };
  // Keys only change when outputs do; posting the same list is a no-op.
  const keys = useMemo(() => outputs.map((o) => o.key).join("|"), [outputs]);
  useEffect(() => {
    post(frameRef.current);
  }, [keys]);
  return (
    <AutosizedIframe
      srcDoc={SHELL_DOCUMENT}
      profile="opaque-scripts"
      title="Jupyter JavaScript output"
      onLoad={(iframe) => {
        frameRef.current = iframe;
        post(iframe);
      }}
    />
  );
}
