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
loads once.  The parent posts the cell's current outputs by position.  The
frame keeps an output whose exact kind and value are unchanged, replaces one
that changed, inserts new ones in order and removes stale ones; only then does
it run each new JavaScript output, once, with `element` set to a jQuery
wrapper of its own div (as in classic Jupyter).  Plain text outputs between
the frame's outputs are carried in as text, so the cell's order is kept.  Scripts run via `new Function` inside the frame, so syntax
errors are caught and shown.

The frame has no access to this page, its origin or the session.  Scripts can
still use the network (e.g., to load a library from a CDN).

Other outputs of the cell (text, images, errors, ...) render normally.
*/

import type { Map } from "immutable";
import { useEffect, useRef } from "react";
import jquerySource from "jquery/dist/jquery.min.js?raw";
import AutosizedIframe from "./autosized-iframe";
import {
  APPLY_THEME_FUNCTION,
  resolveShellTheme,
  sameTheme,
  useThemeChanges,
} from "./frame-theme";
import type { ShellTheme } from "./frame-theme";

export const ACTIVE_OUTPUT_MESSAGE = "cocalc-active-outputs";

export interface ActiveOutput {
  // position of the output in the cell
  index: number;
  // "text": stdout/stderr between other outputs of the frame, carried along
  // as plain text so the cell's order is kept (errors are never carried).
  kind: "html" | "javascript" | "text";
  value: string;
  // class for text outputs: "output_stdout" or "output_stderr"
  className?: string;
}

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  const js =
    typeof (value as any).toJS === "function" ? (value as any).toJS() : value;
  return Array.isArray(js) ? js.join("") : `${js}`;
}

// The outputs that render in the frame, given the MIME type selected for each
// message (the Data renderer's choice); null if no JavaScript output is
// selected in this cell.  stdout/stderr between the first and last frame
// output go into the frame too, as plain text (ANSI colors dropped, stderr
// shaded as in the notebook), so the cell's order is kept.  Any other output
// kind there, including errors (which normally end a cell), renders after the
// frame with the notebook's own renderers: a known reordering.
export function activeGroup(
  messages: Map<string, any>[],
  selectedType: (message: Map<string, any>) => string | undefined,
  plainText: (message: Map<string, any>) => string = defaultPlainText,
): ActiveOutput[] | null {
  const selected = messages.map((m) =>
    m == null ? undefined : selectedType(m),
  );
  if (!selected.includes("application/javascript")) {
    return null;
  }
  const isActive = (type) =>
    type === "application/javascript" || type === "text/html";
  const first = selected.findIndex(isActive);
  let last = first;
  selected.forEach((type, i) => {
    if (isActive(type)) last = i;
  });
  const outputs: ActiveOutput[] = [];
  selected.forEach((type, i) => {
    const m = messages[i];
    if (m == null) return;
    if (isActive(type)) {
      outputs.push({
        index: i,
        kind: type === "application/javascript" ? "javascript" : "html",
        value: text(m.getIn(["data", type])),
      });
    } else if (i > first && i < last && isStream(m)) {
      outputs.push({
        index: i,
        kind: "text",
        value: plainText(m),
        className:
          m.get("name") === "stderr" ? "output_stderr" : "output_stdout",
      });
    }
  });
  return outputs;
}

function isStream(m: Map<string, any>): boolean {
  return m.get("name") === "stdout" || m.get("name") === "stderr";
}

function defaultPlainText(m: Map<string, any>): string {
  return text(m.get("text"));
}

// Runs in the frame.  Accepts updates only from the parent window.  Each
// position keeps its element while its exact kind, value and (for text)
// class are unchanged;
// otherwise it is replaced (and new JavaScript runs once).
const BOOTSTRAP = `(function () {
  var root = document.getElementById("cocalc-outputs");
  var rendered = new Map(); // index -> { kind, value, className, div }
  // The app's resolved palette, as shell-owned variables.
  ${APPLY_THEME_FUNCTION}
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
    applyTheme(data.theme);
    var wanted = new Set();
    var toRun = [];
    var prev = null;
    data.outputs.forEach(function (o) {
      if (!o || typeof o.index !== "number" || typeof o.value !== "string") return;
      if (o.kind !== "html" && o.kind !== "javascript" && o.kind !== "text") return;
      wanted.add(o.index);
      var cur = rendered.get(o.index);
      var className = o.className === "output_stderr" ? "output_stderr" : "output_stdout";
      if (!cur || cur.kind !== o.kind || cur.value !== o.value || (o.kind === "text" && cur.className !== className)) {
        if (cur) cur.div.remove();
        var div = document.createElement(o.kind === "text" ? "pre" : "div");
        if (o.kind === "javascript") {
          div.className = "output_javascript";
          toRun.push([div, o.value]);
        } else if (o.kind === "text") {
          div.className = className;
          div.textContent = o.value;
        } else {
          div.className = "output_html";
          div.innerHTML = o.value;
        }
        cur = { kind: o.kind, value: o.value, className: className, div: div };
        rendered.set(o.index, cur);
      }
      var next = prev ? prev.nextSibling : root.firstChild;
      if (cur.div !== next) root.insertBefore(cur.div, next);
      prev = cur.div;
    });
    rendered.forEach(function (cur, index) {
      if (!wanted.has(index)) {
        cur.div.remove();
        rendered.delete(index);
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

export const SHELL_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;font-family:sans-serif;color:var(--shell-text,CanvasText);background:var(--shell-surface,transparent)}pre.output_stdout,pre.output_stderr{margin:0;padding:2px 4px;white-space:pre-wrap;font-family:monospace}pre.output_stderr{background:var(--shell-danger-bg,#fff0f0)}</style><script>${scriptBody(
  `${jquerySource}`,
)}</script></head><body><div id="cocalc-outputs"></div><script>${scriptBody(
  BOOTSTRAP,
)}</script></body></html>`;

function sameOutputs(a: ActiveOutput[], b: ActiveOutput[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (x, i) =>
        x.index === b[i].index &&
        x.kind === b[i].kind &&
        x.className === b[i].className &&
        x.value === b[i].value,
    )
  );
}

export function ActiveOutputGroup({ outputs }: { outputs: ActiveOutput[] }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const outputsRef = useRef<ActiveOutput[]>(outputs);
  outputsRef.current = outputs;
  const themeRef = useRef<ShellTheme | null>(null);
  const post = (iframe: HTMLIFrameElement | null) => {
    if (iframe == null) return;
    themeRef.current = resolveShellTheme(iframe);
    // The frame is an opaque origin, so its origin can't be named here.
    iframe.contentWindow?.postMessage(
      {
        type: ACTIVE_OUTPUT_MESSAGE,
        outputs: outputsRef.current,
        theme: themeRef.current,
      },
      "*",
    );
  };
  // The frame compares exact values, so posting an unchanged list is a no-op.
  // Post only when the list actually changed (not, e.g., for a trailing
  // stdout outside the frame), to avoid cloning large outputs needlessly.
  const postedRef = useRef<ActiveOutput[] | null>(null);
  useEffect(() => {
    if (postedRef.current != null && sameOutputs(postedRef.current, outputs)) {
      return;
    }
    postedRef.current = outputs;
    post(frameRef.current);
  }, [outputs]);
  // Follow the app's theme.
  useThemeChanges(() => {
    const iframe = frameRef.current;
    if (iframe == null) return;
    if (!sameTheme(themeRef.current, resolveShellTheme(iframe))) {
      post(iframe);
    }
  });
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
