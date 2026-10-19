/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Board frames that survive their card's remounts.

A board's state (the user's edits, the camera, the running interpreter) lives
only in its frame, and moving an iframe in the DOM reloads it. The card is
remounted whenever its frame is maximized, the workbench layout changes, an
editor tab is switched, or the chat list scrolls it out and back: React gives
the new card new DOM. So the iframes do not live in the card at all. Each one
sits in a fixed layer on document.body and is laid over a placeholder that the
card renders, clipped to the placeholder's scrolling ancestors. A remounted
card with the same view key takes over the same frame, which never moved.

A frame no card shows stays alive, hidden, for a while, so that its card can
come back to it; the oldest are dropped beyond a small limit.

The frame protocol (Sagebrush's web/board-host-protocol.md, "The
bootstrap") is answered here. Each frame element is loaded with a nonce in its
address (#sb-nonce=, a fragment, so it is not sent to the server). Only a
"ready" from that element's own window, carrying that nonce, from the first
document the element loaded, is answered, once, with the board. A document
the frame is later navigated to was never given the nonce, and a second
"load" means such a document, which gets nothing more.

No MessagePort is posted yet: without one the frame shows the board without
Submit, since this card does not take answers. The port arrives with the
steps that use it (edits saved to the file, answers to the agent).
*/

export const BOARD_FRAME_MAX_HIDDEN = 4;
export const BOARD_FRAME_HIDDEN_TTL_MS = 15 * 60_000;

// Below the app's popups, menus and dialogs, above ordinary page content.
const LAYER_Z_INDEX = "1";

export interface BoardFrameState {
  // This placeholder is the one the frame is laid over.
  active: boolean;
  // The frame reported that it could not show the board.
  frameError: string;
}

export interface BoardFrame {
  readonly key: string;
  readonly path: string;
  readonly iframe: HTMLIFrameElement;
}

interface Entry extends BoardFrame {
  text: string;
  name: string;
  nonce: string;
  // Documents the element has loaded; only the first is answered.
  loads: number;
  answered: boolean;
  frameError: string;
  // Mounted placeholders, most recent last; the frame covers the last one.
  placeholders: Placeholder[];
  hiddenSince?: number;
}

interface Placeholder {
  element: HTMLElement;
  clipAncestors: HTMLElement[];
  onState: (state: BoardFrameState) => void;
}

const entries = new Map<string, Entry>();
let layer: HTMLDivElement | undefined;
let listening = false;
let animationFrame: number | undefined;

function getLayer(): HTMLDivElement {
  if (layer?.isConnected) return layer;
  layer = document.createElement("div");
  layer.dataset.cocalcBoardFrames = "";
  Object.assign(layer.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "0",
    height: "0",
    zIndex: LAYER_Z_INDEX,
  });
  document.body.appendChild(layer);
  return layer;
}

function onMessage(event: MessageEvent): void {
  for (const entry of entries.values()) {
    const frame = entry.iframe.contentWindow;
    if (!frame || event.source !== frame) continue;
    const data = event.data;
    if (data == null || typeof data !== "object" || data.version !== 1) return;
    if (data.sagebrush === "ready") {
      // Only the document this element was loaded with, once: only it was
      // given the nonce.
      if (entry.answered || entry.loads > 1 || data.nonce !== entry.nonce) {
        return;
      }
      entry.answered = true;
      frame.postMessage(
        { sagebrush: "board", version: 1, text: entry.text, name: entry.name },
        "*",
      );
    } else if (
      data.sagebrush === "error" &&
      entry.answered &&
      entry.loads <= 1
    ) {
      entry.frameError =
        `${data.message ?? "The board could not be shown."}`.slice(0, 500);
      notify(entry);
    }
    return;
  }
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", onMessage);
}

function notify(entry: Entry): void {
  const active = entry.placeholders[entry.placeholders.length - 1];
  for (const placeholder of entry.placeholders) {
    placeholder.onState({
      active: placeholder === active,
      frameError: entry.frameError,
    });
  }
}

function hide(entry: Entry): void {
  Object.assign(entry.iframe.style, {
    visibility: "hidden",
    pointerEvents: "none",
  });
}

function clippingAncestors(element: HTMLElement): HTMLElement[] {
  const result: HTMLElement[] = [];
  for (
    let node = element.parentElement;
    node != null && node !== document.body;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (
      /auto|scroll|hidden|clip/.test(`${style.overflowX} ${style.overflowY}`)
    ) {
      result.push(node);
    }
  }
  return result;
}

// Lay each shown frame over its placeholder, clipped to what of the
// placeholder is visible. A placeholder with no size (an inactive tab) or
// scrolled out of view hides its frame without unloading it.
export function layoutBoardFrames(): void {
  for (const entry of entries.values()) {
    const placeholder = entry.placeholders[entry.placeholders.length - 1];
    if (placeholder == null) continue;
    const rect = placeholder.element.getBoundingClientRect();
    let left = 0;
    let top = 0;
    let right = window.innerWidth;
    let bottom = window.innerHeight;
    for (const ancestor of placeholder.clipAncestors) {
      const clip = ancestor.getBoundingClientRect();
      left = Math.max(left, clip.left);
      top = Math.max(top, clip.top);
      right = Math.min(right, clip.right);
      bottom = Math.min(bottom, clip.bottom);
    }
    left = Math.max(left, rect.left);
    top = Math.max(top, rect.top);
    right = Math.min(right, rect.right);
    bottom = Math.min(bottom, rect.bottom);
    if (rect.width <= 0 || rect.height <= 0 || right <= left || bottom <= top) {
      hide(entry);
      continue;
    }
    Object.assign(entry.iframe.style, {
      visibility: "visible",
      pointerEvents: "auto",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      clipPath: `inset(${top - rect.top}px ${rect.right - right}px ${
        rect.bottom - bottom
      }px ${left - rect.left}px)`,
    });
  }
}

function anyShown(): boolean {
  for (const entry of entries.values()) {
    if (entry.placeholders.length > 0) return true;
  }
  return false;
}

// Placeholders move with scrolling, resizing and layout changes that no
// event reports, so shown frames follow them every animation frame.
function schedule(): void {
  if (animationFrame != null || typeof requestAnimationFrame !== "function") {
    return;
  }
  const step = () => {
    animationFrame = undefined;
    if (!anyShown()) return;
    layoutBoardFrames();
    animationFrame = requestAnimationFrame(step);
  };
  animationFrame = requestAnimationFrame(step);
}

function evictHidden(now = Date.now()): void {
  const hidden = [...entries.values()]
    .filter((entry) => entry.placeholders.length === 0)
    .sort((a, b) => (b.hiddenSince ?? 0) - (a.hiddenSince ?? 0));
  hidden.forEach((entry, index) => {
    if (
      index >= BOARD_FRAME_MAX_HIDDEN ||
      now - (entry.hiddenSince ?? now) > BOARD_FRAME_HIDDEN_TTL_MS
    ) {
      destroyBoardFrame(entry.key);
    }
  });
}

/** The live frame for this view, if there is one. */
export function getBoardFrame(key: string): BoardFrame | undefined {
  evictHidden();
  return entries.get(key);
}

/** A new frame for this view, replacing any earlier one; it loads at once,
 * hidden until a placeholder shows it. */
export function createBoardFrame({
  key,
  path,
  frameUrl,
  sandbox,
  text,
  name,
  title,
}: {
  key: string;
  path: string;
  frameUrl: string;
  sandbox: string;
  text: string;
  name: string;
  title: string;
}): BoardFrame {
  const placeholders = entries.get(key)?.placeholders ?? [];
  destroyBoardFrame(key);
  listen();
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", sandbox);
  iframe.title = title;
  Object.assign(iframe.style, {
    position: "fixed",
    border: "none",
    borderRadius: "4px",
    visibility: "hidden",
    pointerEvents: "none",
  });
  const nonce = crypto.randomUUID();
  const entry: Entry = {
    key,
    path,
    iframe,
    text,
    name,
    nonce,
    loads: 0,
    answered: false,
    frameError: "",
    placeholders,
    hiddenSince: placeholders.length === 0 ? Date.now() : undefined,
  };
  // A second load is another document, which this card did not load.
  iframe.addEventListener("load", () => {
    entry.loads += 1;
  });
  iframe.src = `${frameUrl}#sb-nonce=${nonce}`;
  entries.set(key, entry);
  getLayer().appendChild(iframe);
  notify(entry);
  layoutBoardFrames();
  schedule();
  return entry;
}

/** Show the frame over `element` until the returned function is called. */
export function attachBoardFrame(
  frame: BoardFrame,
  element: HTMLElement,
  onState: (state: BoardFrameState) => void,
): () => void {
  const entry = entries.get(frame.key);
  if (entry == null || entry !== frame) return () => {};
  const placeholder: Placeholder = {
    element,
    clipAncestors: clippingAncestors(element),
    onState,
  };
  entry.placeholders.push(placeholder);
  entry.hiddenSince = undefined;
  notify(entry);
  layoutBoardFrames();
  schedule();
  return () => {
    const index = entry.placeholders.indexOf(placeholder);
    if (index < 0) return;
    entry.placeholders.splice(index, 1);
    if (entry.placeholders.length === 0) {
      entry.hiddenSince = Date.now();
      hide(entry);
      evictHidden();
    } else {
      notify(entry);
      layoutBoardFrames();
    }
  };
}

export function destroyBoardFrame(key: string): void {
  const entry = entries.get(key);
  if (entry == null) return;
  entries.delete(key);
  entry.iframe.remove();
}

/** For tests. */
export function resetBoardFrames(): void {
  for (const key of [...entries.keys()]) destroyBoardFrame(key);
  if (animationFrame != null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(animationFrame);
  }
  animationFrame = undefined;
  layer?.remove();
  layer = undefined;
}
