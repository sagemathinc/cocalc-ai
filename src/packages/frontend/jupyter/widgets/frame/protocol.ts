/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Messages between the app page and a widget host frame.

Widgets never run in the app page.  Each displayed widget renders in its own
frame, /static/widget-host.html, sandboxed with an opaque origin (see
frame/host.ts).  The app page (frame/relay.ts) is the only thing the frame can
talk to, over a MessagePort handed to it once, and it answers only the requests
below, each checked: a frame can read this notebook's widget state, write
model values of this notebook, and send widget comm messages to this
notebook's kernel; nothing else.
*/

// The handshake: the frame posts READY (with the nonce from its URL fragment)
// to its parent; the parent answers that message with INIT, carrying the port.
export const WIDGET_HOST_READY = "cocalc-widget-host-ready";
export const WIDGET_HOST_INIT = "cocalc-widget-host-init";

// The widget host document, relative to the app's static path.
export const WIDGET_HOST_PATH = "widget-host.html";

// One entry of the notebook's widget state table.
export interface WidgetStateEntry {
  model_id: string;
  type: "state" | "value" | "buffers" | "message";
  data: any;
}

import type { ShellTheme } from "@cocalc/frontend/jupyter/output-messages/frame-theme";

// The app's resolved palette (see output-messages/frame-theme.ts).
export type WidgetTheme = ShellTheme | null;

// app page -> frame
export type ParentMessage =
  | { type: "snapshot"; entries: WidgetStateEntry[] }
  | { type: "change"; entries: WidgetStateEntry[] }
  // the latest custom message of a model, with its buffers resolved
  | {
      type: "message";
      model_id: string;
      message: any;
      buffers: ArrayBuffer[];
    }
  | {
      type: "reply";
      id: number;
      result?: any;
      error?: string;
    }
  | { type: "theme"; theme: WidgetTheme };

// frame -> app page
export type FrameRequest =
  | { type: "getBuffers"; id: number; model_id: string }
  | {
      type: "setModelValue";
      model_id: string;
      changed: { [key: string]: any };
    }
  | {
      type: "sendComm";
      comm_id: string;
      data: any;
      buffers?: ArrayBuffer[];
    }
  | { type: "height"; height: number };

// Limits on what a frame may send.  Views send small JSON updates; anything
// bigger is refused, not truncated.
export const MAX_REQUEST_JSON_BYTES = 1_000_000;
export const MAX_REQUEST_BUFFER_BYTES = 16_000_000;
// Writes (setModelValue + sendComm) per second: per frame (a slider drag
// sends a few dozen), and for all the frames of a notebook together.
export const MAX_WRITES_PER_SECOND = 60;
export const MAX_NOTEBOOK_WRITES_PER_SECOND = 200;
// Buffer requests (each a project RPC) per frame per second.
export const MAX_BUFFER_REQUESTS_PER_SECOND = 20;
// Value writes are saved to the shared state at most this often.
export const SAVE_INTERVAL_MS = 100;

export const MIN_FRAME_HEIGHT = 20;
export const MAX_FRAME_HEIGHT = 25_000;

const MODEL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isModelId(x: unknown): x is string {
  return typeof x === "string" && MODEL_ID_RE.test(x);
}

// A plain object of any realm (structured clone creates received messages in
// the receiving realm, but checks should not depend on that).
export function isPlainObject(x: unknown): x is { [key: string]: any } {
  if (x == null || typeof x !== "object" || Array.isArray(x)) return false;
  if (Object.prototype.toString.call(x) !== "[object Object]") return false;
  const proto = Object.getPrototypeOf(x);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

// The size of x as JSON, or undefined if x isn't plain JSON data (only plain
// objects, arrays, strings, finite numbers, booleans and null).
export function jsonSize(x: unknown): number | undefined {
  try {
    const s = JSON.stringify(x, function (_key, value) {
      if (
        value != null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !isPlainObject(value)
      ) {
        throw Error("not JSON");
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw Error("not JSON");
      }
      return value;
    });
    return s == null ? undefined : s.length;
  } catch {
    return undefined;
  }
}

export function isBufferList(x: unknown): x is ArrayBuffer[] {
  return (
    Array.isArray(x) &&
    x.every((b) => Object.prototype.toString.call(b) === "[object ArrayBuffer]")
  );
}

export function bufferBytes(buffers: ArrayBuffer[] | undefined): number {
  let n = 0;
  for (const b of buffers ?? []) n += b.byteLength;
  return n;
}

export function clampHeight(height: unknown): number | undefined {
  if (typeof height !== "number" || !Number.isFinite(height)) return;
  return Math.min(
    MAX_FRAME_HEIGHT,
    Math.max(MIN_FRAME_HEIGHT, Math.ceil(height)),
  );
}
