/*
 * The crash UI is deliberately shown at most once per page load. Keep this
 * guard local: window.onerror belongs to the database reporter, and clearing
 * it here suppresses the report for the error that triggered this UI.
 */

import Crash from "./crash";
import CrashMessage from "./crash-message";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  COCALC_REACT_ERROR_EVENT,
  COCALC_REACT_ROOT_READY_EVENT,
  type ReactErrorEventDetail,
} from "@cocalc/frontend/app/react-error-reporting";
import { isIgnorableBrowserError } from "./webapp-error-filter";

let crashDisplayed = false;
let managedReactRoot = false;

function showCrash({
  msg,
  url,
  lineno,
  colno,
  error,
  showLoadFail,
}: {
  msg: string;
  url?: string;
  lineno?: number;
  colno?: number;
  error: unknown;
  showLoadFail: boolean;
}): void {
  if (crashDisplayed) {
    return;
  }
  const crash = document.getElementById("cocalc-react-crash");
  if (crash == null) return;
  crashDisplayed = true;
  crash.style.display = "block";

  const errorbox = document.getElementById(
    showLoadFail ? "cocalc-error-report-startup" : "cocalc-error-report-react",
  );
  if (errorbox == null) return;
  const stack =
    error != null &&
    typeof error === "object" &&
    "stack" in error &&
    typeof error.stack === "string"
      ? error.stack
      : "<no stacktrace>";
  console.warn({ errorbox }, "rendering", { msg, lineno });
  createRoot(errorbox).render(
    React.createElement(CrashMessage, {
      msg,
      lineNo: lineno,
      columnNo: colno,
      url,
      stack,
      showLoadFail,
    }),
  );
}

function handleError(event: ErrorEvent): void {
  if (event.defaultPrevented) {
    // see https://github.com/sagemathinc/cocalc/issues/5963
    return;
  }
  const { message: msg, filename: url, lineno, colno, error } = event;
  if (isIgnorableBrowserError(msg)) {
    return;
  }
  if (error == null) {
    // Sometimes this window.onerror gets called with error null.
    return;
  }
  console.warn("handleError", { msg, url, lineno, colno, error });
  if (isWhitelisted({ error })) {
    console.warn("handleError -- whitelisted");
    return;
  }
  const showLoadFail =
    document.getElementById("cocalc-error-report-startup") != null;
  if (managedReactRoot && !showLoadFail) {
    // React 19 classifies render failures via the root callbacks. A generic
    // browser error after startup is still reported, but is not proof that the
    // application root is unusable.
    return;
  }
  showCrash({ msg, url, lineno, colno, error, showLoadFail });
}

function handleReactError(event: Event): void {
  const detail = (event as CustomEvent<ReactErrorEventDetail>).detail;
  if (detail?.kind !== "uncaught") return;
  const error = detail.error;
  const msg =
    error != null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : `${error}`;
  showCrash({
    msg,
    error,
    showLoadFail: false,
  });
}

export default function init() {
  // console.log("installing window error handler");
  // Add a banner in case react crashes (it will be revealed)
  const crashContainer = document.getElementById("cocalc-crash-container");
  if (crashContainer != null) {
    createRoot(crashContainer).render(React.createElement(Crash));
  } else {
    throw Error(
      "there must be a div with id cocalc-crash-container in the document!",
    );
  }

  // Install error handler.
  window.addEventListener("error", handleError);
  window.addEventListener(COCALC_REACT_ROOT_READY_EVENT, () => {
    managedReactRoot = true;
  });
  window.addEventListener(COCALC_REACT_ERROR_EVENT, handleReactError);
}

export function startedUp() {
  const elt = document.getElementById("cocalc-error-report-startup");
  if (elt) {
    elt.remove();
  }
}

export function finishedLoading() {
  const load = document.getElementById("cocalc-load-container");
  if (load != null) {
    load.innerHTML = "";
    load.remove();
  }
}

function isWhitelisted({ error }): boolean {
  try {
    const stack = `${error?.stack ?? error}`;

    if (stack.toLowerCase().includes("minified react error")) {
      // these are not useful to report to the user at all
      return true;
    }
    if (
      stack.includes("jupyter/output-messages") ||
      stack.includes("jupyterGetElt") ||
      stack.includes("run_inline_js")
    ) {
      // see https://github.com/sagemathinc/cocalc/issues/7993
      // we should never show a popup cocalc crash when a jupyter message results
      // in a crash, since this is user level code.
      // "jupyter/output-messages" only works in dev mode, whereas jupyterGetElt works in prod.
      return true;
    }
    if (stack.includes("TypeError: $(...).")) {
      // see https://github.com/sagemathinc/cocalc/issues/7993
      // Getting Application Error: Uncaught TypeError: $(...).popover is not a function when opening old plotly
      // notebook used elsewhere.  It's somehow assuming jquery?  Just running it will then work.
      return true;
    }
    if (stack.includes("Bokeh")) {
      // see https://github.com/sagemathinc/cocalc/issues/6507
      return true;
    }

    if (stack.includes("codemirror/addon/edit/closetag")) {
      // This closetag codemirror addon sometimes crashes; it's harmless, but scary.  This will probably
      // get automatically fixed when we upgrade to codemirror 6.
      return true;
    }
    if (
      stack.includes("jquery.js") ||
      stack.includes("N.slice is not a function")
    ) {
      // we can't do anything about errors deep in jquery...
      // e.g., one thing that causes this: https://sagemathcloud.zendesk.com/agent/tickets/17324
      // Steps to reproduce:
      // - Open any TeX document
      // - Split vertically the view and set the right view to PDF - native
      // - Enable "Build on save"
      // - Make any edit to your latex file
      // - Save
      // - Move your mouse to the pdf view
      return true;
    }
    if (
      stack.includes("Viewport.syncScrollArea") ||
      stack.includes("xterm") ||
      stack.includes("xterm-addon-webgl") ||
      stack.includes("reading 'loadCell'") ||
      stack.includes("renderRows") // xtermjs in general...
    ) {
      // ranodmly happens sometimes with webgl based terminal, but then it still works fine.
      return true;
    }
    return false;
  } catch (_err) {
    // if anything is wrong with checking above, still show error.
    return false;
  }
}
