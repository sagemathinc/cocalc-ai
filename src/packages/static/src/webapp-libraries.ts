import jQuery from "jquery";
// This is assumed in some of the ancient libraries we're still loading:
(window as any).$ = (window as any).jQuery = jQuery;

// node.js polyfill -- needed for some modules to load in the browser.
import { Buffer } from "buffer";
(window as any).Buffer = Buffer;

// this must come before anything that touches event handling, etc.
import "./webapp-error-reporter";

// jQuery plugins
// this is a require since it must happen after window.jQuery above (and imports happen before code).
import "jquery-tooltip/jquery.tooltip";

// Timeago jQuery plugin
import "timeago";

// Scroll into view plugin
import "jquery.scrollintoview/jquery.scrollintoview";

import "@cocalc/frontend/set-version-cookie.js";

import "./webapp-css";

// CSS style file for CoCalc.  This must be at the very end, and by using a
// dynamic import, it is imported in another chunk, hence after antd.
// That's important so this overrides antd.
function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) return error.stack;
  if (
    error != null &&
    typeof error == "object" &&
    typeof (error as any).stack == "string"
  ) {
    return (error as any).stack;
  }
}

// @ts-ignore -- handled by webpack but not typescript.
export const cocalcStylesReady = import("@cocalc/frontend/styles/index.css") // this is a dynamic import on purpose!
  .catch((error) => {
    const stack = getErrorStack(error);
    console.warn("CoCalc global stylesheet failed to load", {
      error,
      message: String(error),
      stack,
      location: window.location.href,
      scripts: Array.from(document.scripts)
        .map((script) => script.src)
        .filter((src) => src.length > 0),
      rspackChunks: Array.isArray((globalThis as any).rspackChunk_cocalc_static)
        ? {
            length: (globalThis as any).rspackChunk_cocalc_static.length,
            pushType: typeof (globalThis as any).rspackChunk_cocalc_static.push,
          }
        : { exists: false },
    });
    if (stack != null) {
      console.warn(stack);
    }
  });
