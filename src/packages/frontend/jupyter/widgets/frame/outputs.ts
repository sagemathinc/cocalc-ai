/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Renders the outputs an Output widget captured, inside the widget frame.

The frame is an opaque origin with nothing to protect but itself, so outputs
render as classic Jupyter renders them: HTML and SVG as markup, JavaScript run
with `element` set to its output's jQuery wrapper.
*/

import $ from "jquery";
import Anser from "anser";
import MarkdownIt from "markdown-it";
import { typesetMath } from "./math";

const markdown = new MarkdownIt({ html: true, linkify: true });

// The richest representation first, as the notebook chooses.
const WIDGET_VIEW = "application/vnd.jupyter.widget-view+json";

const ORDER = [
  WIDGET_VIEW,
  "application/javascript",
  "text/html",
  "text/markdown",
  "text/latex",
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "text/plain",
];

function text(value: unknown): string {
  if (value == null) return "";
  return Array.isArray(value) ? value.join("") : `${value}`;
}

function pre(value: string, className: string): HTMLElement {
  const elt = document.createElement("pre");
  elt.className = className;
  elt.textContent = Anser.ansiToText(value);
  return elt;
}

function runJavascript(div: HTMLElement, code: string): void {
  try {
    new Function("element", code).call(window, $(div));
  } catch (err) {
    div.appendChild(pre(`${err}`, "output_stderr"));
  }
}

// What kind of output this is.  The Output widget's outputs are the
// captured messages' content (see capture_output_message in
// ipywidgets-state.ts), which has no output_type: a stream is {name, text},
// an error {ename, evalue, traceback}, anything else {data, metadata}.
export function outputKind(output: any): "stream" | "error" | "data" {
  if (output.output_type === "stream") return "stream";
  if (output.output_type === "error") return "error";
  if (output.output_type != null) return "data";
  if (output.text != null && output.data == null) return "stream";
  if (output.traceback != null || output.ename != null) return "error";
  return "data";
}

// renderWidget renders a widget view (display(widget) inside an Output
// widget) into an element; the frame's widget manager provides it.
export function renderOutput(
  output: any,
  destination: Element,
  renderWidget?: (model_id: string, el: HTMLElement) => Promise<void>,
): void {
  if (output == null || typeof output !== "object") return;
  const kind = outputKind(output);
  if (kind === "stream") {
    // Consecutive chunks of one stream are one block, as in Jupyter.
    const className =
      output.name === "stderr" ? "output_stderr" : "output_stdout";
    const last = destination.lastElementChild;
    const pre = last?.classList.contains("cocalc-widget-output")
      ? last.querySelector(`:scope > pre.${className}:only-child`)
      : null;
    if (pre != null) {
      pre.textContent += Anser.ansiToText(text(output.text));
      return;
    }
  }
  const div = document.createElement("div");
  div.className = "cocalc-widget-output";
  destination.appendChild(div);
  switch (kind) {
    case "stream":
      div.appendChild(
        pre(
          text(output.text),
          output.name === "stderr" ? "output_stderr" : "output_stdout",
        ),
      );
      return;
    case "error":
      div.appendChild(
        pre(
          text(
            Array.isArray(output.traceback)
              ? output.traceback.join("\n")
              : `${output.ename ?? ""}: ${output.evalue ?? ""}`,
          ),
          "output_stderr",
        ),
      );
      return;
  }
  const data = output.data;
  if (data == null || typeof data !== "object") return;
  const type = ORDER.find((t) => data[t] != null);
  if (type == null) return;
  if (type === WIDGET_VIEW) {
    const model_id = data[type]?.model_id;
    if (typeof model_id === "string" && renderWidget != null) {
      void renderWidget(model_id, div).catch((err) =>
        div.appendChild(pre(`Error rendering widget: ${err}`, "output_stderr")),
      );
    } else if (data["text/plain"] != null) {
      div.appendChild(pre(text(data["text/plain"]), "output_stdout"));
    }
    return;
  }
  const value = text(data[type]);
  switch (type) {
    case "application/javascript":
      runJavascript(div, value);
      return;
    case "text/html":
    case "image/svg+xml":
      $(div).html(value);
      typesetMath(div);
      return;
    case "text/markdown":
      div.innerHTML = markdown.render(value);
      typesetMath(div);
      return;
    case "text/latex":
      div.textContent = value;
      typesetMath(div);
      return;
    case "image/png":
    case "image/jpeg":
    case "image/gif": {
      const img = document.createElement("img");
      img.src = `data:${type};base64,${value.replace(/\s/g, "")}`;
      img.style.maxWidth = "100%";
      div.appendChild(img);
      return;
    }
    default:
      div.appendChild(pre(value, "output_stdout"));
  }
}
