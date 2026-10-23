/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The widget host: the document of a widget frame (/static/widget-host.html).

It renders one widget of a notebook.  The app page embeds it sandboxed
(allow-scripts, never allow-same-origin), and the hub also serves it with
`Content-Security-Policy: sandbox allow-scripts`, so it has an opaque origin
however it is opened.  It refuses to start otherwise: in an origin it could
hand widget state (and so widget code) to whoever opened it.

The handshake is the frame's: this script (CoCalc's, running before any widget
code) posts a ready message with the nonce from its URL fragment to its parent,
and the parent answers that one message, from that window, with the
MessagePort to its relay (relay.ts) and the model to render.  The frame starts
once; every later init message is ignored, so nothing can swap the port, and
the parent kills the frame if it ever says ready again or reloads.  Widget
code and markup run freely here: nothing in this origin belongs to the user.
*/

import "@jupyter-widgets/controls/css/widgets.css";
import { renderOutput } from "./outputs";
import { typesetWidgetMath } from "./math";
import { RemoteWidgetState } from "./remote-state";
import { WidgetManager } from "./widget-manager";
import {
  isModelId,
  type ParentMessage,
  type WidgetTheme,
  WIDGET_HOST_INIT,
  WIDGET_HOST_READY,
} from "./protocol";

// Some widgets (e.g., ipympl) use Font Awesome icons: the stylesheet from the
// CDN, pinned by its hash.
const FONT_AWESOME =
  "https://cdn.jsdelivr.net/npm/font-awesome@4.7.0/css/font-awesome.min.css";
const FONT_AWESOME_INTEGRITY =
  "sha384-wvfXpqpZZVQGK6TAh5PVlGOfQNHSoD2xbE+QkPxCAFlNEevoEH3Sl0sibVcOQVnN";

const THEME_COLORS = [
  "text",
  "surface",
  "dangerBg",
  "border",
  "inset",
  "hover",
];

// Whether this document runs in an opaque origin inside a parent.
export function isIsolated(win: Window = window): boolean {
  return win.origin === "null" && win.parent !== win;
}

function applyTheme(theme: WidgetTheme): void {
  if (theme == null || typeof theme !== "object") return;
  const style = document.documentElement.style;
  const props: [string, string][] = [
    ...THEME_COLORS.map((name): [string, string] => [name, "color"]),
    ["fontFamily", "font-family"],
    ["fontSize", "font-size"],
  ];
  for (const [name, cssProperty] of props) {
    const v = theme[name as keyof typeof theme];
    if (typeof v === "string" && v && CSS.supports(cssProperty, v)) {
      style.setProperty(`--shell-${name}`, v);
    }
  }
  if (theme.colorScheme === "dark" || theme.colorScheme === "light") {
    style.colorScheme = theme.colorScheme;
  }
}

function showError(root: HTMLElement, message: string): void {
  const div = document.createElement("div");
  div.className = "cocalc-widget-error";
  div.textContent = message;
  root.replaceChildren(div);
}

async function start(
  port: MessagePort,
  model_id: string,
  root: HTMLElement,
): Promise<void> {
  const state = new RemoteWidgetState(port);
  port.onmessage = (event) => {
    const msg = event.data as ParentMessage;
    if (msg?.type === "theme") {
      applyTheme(msg.theme);
    } else {
      state.handle(msg);
    }
  };
  port.start();

  // Report the content's height, at most once a frame.
  let scheduled = false;
  const reportHeight = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const height = Math.max(
        document.body.scrollHeight,
        document.body.getBoundingClientRect().height,
      );
      port.postMessage({ type: "height", height });
    });
  };
  new ResizeObserver(reportHeight).observe(document.body);
  reportHeight();

  const manager = new WidgetManager({
    ipywidgets_state: state,
    host: {
      sendCommMessageToKernel: ({ comm_id, data, buffers }) => {
        const list = (buffers ?? []).map((b: any) =>
          b instanceof ArrayBuffer
            ? b
            : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
        );
        port.postMessage({ type: "sendComm", comm_id, data, buffers: list });
      },
      // Widgets displayed inside an Output widget render in this frame too.
      renderOutput: (output, destination) =>
        renderOutput(output, destination, (model_id, el) =>
          manager.manager.render(model_id, el),
        ),
    },
  });
  typesetWidgetMath(root);
  try {
    await manager.manager.render(model_id, root);
  } catch (err) {
    console.error("Error rendering widget:", err);
    showError(root, `Error rendering widget: ${err}`);
  }
}

export function init(): void {
  const root = document.getElementById("cocalc-widget");
  if (root == null) return;
  if (!isIsolated()) {
    // Opened as a page, or framed without the sandbox: do nothing.
    showError(root, "Widgets render only inside a notebook.");
    return;
  }
  const nonce = location.hash.slice(1);
  if (!nonce) return;
  let started = false;
  window.addEventListener("message", (event) => {
    if (started || event.source !== window.parent) return;
    const data = event.data;
    const port = event.ports?.[0];
    if (data?.type !== WIDGET_HOST_INIT || data.nonce !== nonce) return;
    if (port == null || !isModelId(data.model_id)) return;
    started = true;
    applyTheme(data.theme);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = FONT_AWESOME;
    link.integrity = FONT_AWESOME_INTEGRITY;
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
    void start(port, data.model_id, root);
  });
  window.parent.postMessage({ type: WIDGET_HOST_READY, nonce }, "*");
}
