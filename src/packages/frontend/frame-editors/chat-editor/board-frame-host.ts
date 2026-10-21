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
come back to it; the oldest are dropped beyond a small limit. A placeholder
that is not shown to the user (no size, scrolled out, under an ancestor
with visibility: hidden, aria-hidden or inert, as an inactive editor tab is)
hides its frame.

Keyboard order: the frame lives at the end of the page, so the card keeps
its place in the tab order with focus proxies. Tabbing onto the placeholder
moves focus into the frame; tabbing out of the frame (forward or back) lands
on sentinels around it, which send focus to marks the card renders just
after and just before the placeholder ([data-board-frame-exit] and
[data-board-frame-enter]), so the next Tab continues from the card. The
sentinels are in the tab order only while focus is in the frame, so the
page's ordinary traversal never reaches them.

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
// A frame just created has had no chance to be attached yet (its card's
// layout effect may not have run): it is pending, not hidden, for this long,
// and isn't dropped to make room meanwhile.
export const BOARD_FRAME_PENDING_MS = 10_000;

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
  // The iframe between its two focus sentinels.
  wrapper: HTMLDivElement;
  before: HTMLElement;
  after: HTMLElement;
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
  // When it was created, until a placeholder first shows it.
  pendingSince?: number;
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
let evictTimer: ReturnType<typeof setTimeout> | undefined;

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
    // In the accessibility tree the frame is where the card is: the
    // placeholder it covers owns it (the frame itself lives at the end of the
    // body), so a screen reader's virtual cursor and frame list find it at
    // the card, not after the whole application.
    if (placeholder === active) {
      placeholder.element.setAttribute("aria-owns", entry.iframe.id);
    } else {
      placeholder.element.removeAttribute("aria-owns");
    }
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
  setSentinels(entry, false);
}

// The sentinels take focus only while focus is in the frame (to catch Tab
// leaving it).
function setSentinels(entry: Entry, on: boolean): void {
  entry.before.tabIndex = on ? 0 : -1;
  entry.after.tabIndex = on ? 0 : -1;
}

// Whether the user can see this element at all: not under visibility:
// hidden (computed, so inherited from an ancestor), aria-hidden or inert.
function shownToUser(element: HTMLElement): boolean {
  if (element.closest('[aria-hidden="true"], [inert]') != null) return false;
  return getComputedStyle(element).visibility === "visible";
}

// A focus sentinel beside the iframe.
function sentinel(onFocus: () => void): HTMLElement {
  const el = document.createElement("span");
  el.tabIndex = -1;
  el.dataset.boardFrameSentinel = "";
  Object.assign(el.style, {
    position: "fixed",
    width: "1px",
    height: "1px",
    opacity: "0",
    overflow: "hidden",
  });
  el.addEventListener("focus", onFocus);
  return el;
}

// What Tab can reach, in document order (positive tabIndex is not
// reordered: nothing here uses it).
const TABBABLE =
  'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';

function isTabbable(el: HTMLElement): boolean {
  if (el.tabIndex < 0 || (el as HTMLButtonElement).disabled) return false;
  // Not the frames themselves, nor anything the user can't see.
  if (layer?.contains(el)) return false;
  if (el.closest('[inert], [hidden], [aria-hidden="true"]') != null) {
    return false;
  }
  for (
    let node: HTMLElement | null = el;
    node != null;
    node = node.parentElement
  ) {
    if (getComputedStyle(node).display === "none") return false;
  }
  return getComputedStyle(el).visibility === "visible";
}

// The control Tab (or Shift+Tab) reaches from this mark: the first tabbable
// element after it, or the last before it.
function adjacentControl(
  mark: HTMLElement,
  forward: boolean,
): HTMLElement | undefined {
  const all = [...document.querySelectorAll<HTMLElement>(TABBABLE)];
  const beyond = all.filter((el) => {
    const position = mark.compareDocumentPosition(el);
    return forward
      ? (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
          (position & Node.DOCUMENT_POSITION_CONTAINED_BY) === 0
      : (position & Node.DOCUMENT_POSITION_PRECEDING) !== 0 &&
          (position & Node.DOCUMENT_POSITION_CONTAINS) === 0;
  });
  if (!forward) beyond.reverse();
  return beyond.find(isTabbable);
}

// Leaving the frame: focus goes to the control before or after the card's
// placeholder (past the marks it renders beside it), as if the board were
// there; at the page's very end or start, to the mark itself, so the next
// Tab continues from the board's place.
function focusMark(entry: Entry, which: "enter" | "exit"): void {
  setSentinels(entry, false);
  const placeholder = entry.placeholders[entry.placeholders.length - 1];
  const sibling =
    which === "enter"
      ? placeholder?.element.previousElementSibling
      : placeholder?.element.nextElementSibling;
  if (
    sibling instanceof HTMLElement &&
    sibling.dataset[which === "enter" ? "boardFrameEnter" : "boardFrameExit"] !=
      null
  ) {
    (adjacentControl(sibling, which === "exit") ?? sibling).focus();
  } else {
    (document.activeElement as HTMLElement | null)?.blur?.();
  }
}

// The live entry for a frame a card holds: the frame itself, or the frame
// that replaced it (Refresh in another place showing the same view), which
// took over its placeholders. A frame dropped and created anew for the
// view is not it.
function liveEntry(frame: BoardFrame): Entry | undefined {
  const entry = entries.get(frame.key);
  if (entry == null) return undefined;
  if (entry === frame) return entry;
  return entry.placeholders === (frame as Entry).placeholders
    ? entry
    : undefined;
}

/** Move focus into a shown frame (its placeholder's focus proxy). */
export function focusBoardFrame(frame: BoardFrame): void {
  const entry = liveEntry(frame);
  if (entry == null) return;
  if (entry.iframe.style.visibility !== "visible") return;
  entry.iframe.focus();
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
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      right <= left ||
      bottom <= top ||
      !shownToUser(placeholder.element)
    ) {
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

// Drops hidden frames over the limit or past their time, and schedules the
// next check for when the oldest hidden frame left would pass it: so a
// hidden frame (and its interpreters) lives at most its time, even if
// nothing else happens.
function evictHidden(now = Date.now()): void {
  // A frame created moments ago and not yet attached is pending: it neither
  // counts against the limit nor is dropped for it (only once the grace
  // period is over, as a hidden frame).
  let pendingUntil: number | undefined;
  const isPending = (entry: Entry) => {
    if (entry.pendingSince == null) return false;
    const until = entry.pendingSince + BOARD_FRAME_PENDING_MS;
    if (now >= until) return false;
    pendingUntil = Math.min(pendingUntil ?? until, until);
    return true;
  };
  const hidden = [...entries.values()]
    .filter((entry) => entry.placeholders.length === 0 && !isPending(entry))
    .sort((a, b) => (b.hiddenSince ?? 0) - (a.hiddenSince ?? 0));
  let oldest: number | undefined;
  hidden.forEach((entry, index) => {
    const since = entry.hiddenSince ?? now;
    if (
      index >= BOARD_FRAME_MAX_HIDDEN ||
      now - since > BOARD_FRAME_HIDDEN_TTL_MS
    ) {
      destroyBoardFrame(entry.key);
    } else {
      oldest = Math.min(oldest ?? since, since);
    }
  });
  if (evictTimer != null) {
    clearTimeout(evictTimer);
    evictTimer = undefined;
  }
  const next = Math.min(
    oldest == null ? Infinity : oldest + BOARD_FRAME_HIDDEN_TTL_MS,
    pendingUntil ?? Infinity,
  );
  if (next < Infinity) {
    evictTimer = setTimeout(
      () => {
        evictTimer = undefined;
        evictHidden();
      },
      Math.max(0, next - now) + 1,
    );
  }
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
  // For the placeholder showing it to own it (aria-owns).
  iframe.id = `cocalc-board-frame-${crypto.randomUUID()}`;
  // Out of the page's ordinary tab order (it lives at the end of the body):
  // keyboard users enter it only through the card's placeholder, and leave
  // through its sentinels.
  iframe.tabIndex = -1;
  Object.assign(iframe.style, {
    position: "fixed",
    border: "none",
    borderRadius: "4px",
    visibility: "hidden",
    pointerEvents: "none",
  });
  const nonce = crypto.randomUUID();
  const wrapper = document.createElement("div");
  let entry: Entry;
  const before = sentinel(() => focusMark(entry, "enter"));
  const after = sentinel(() => focusMark(entry, "exit"));
  wrapper.append(before, iframe, after);
  iframe.addEventListener("focus", () => setSentinels(entry, true));
  // Leaving the frame: a sentinel (Tab) takes focus first, then they leave
  // the tab order again.
  iframe.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement !== iframe) setSentinels(entry, false);
    }, 0);
  });
  entry = {
    key,
    path,
    iframe,
    wrapper,
    before,
    after,
    text,
    name,
    nonce,
    loads: 0,
    answered: false,
    frameError: "",
    placeholders,
    hiddenSince: placeholders.length === 0 ? Date.now() : undefined,
    pendingSince: placeholders.length === 0 ? Date.now() : undefined,
  };
  // A second load is another document, which this card did not load.
  iframe.addEventListener("load", () => {
    entry.loads += 1;
  });
  iframe.src = `${frameUrl}#sb-nonce=${nonce}`;
  entries.set(key, entry);
  getLayer().appendChild(wrapper);
  hide(entry);
  notify(entry);
  layoutBoardFrames();
  schedule();
  // Created hidden (no placeholder yet): it expires like any hidden frame.
  if (entry.hiddenSince != null) evictHidden();
  return entry;
}

/** Show the frame over `element` until the returned function is called. */
export function attachBoardFrame(
  frame: BoardFrame,
  element: HTMLElement,
  onState: (state: BoardFrameState) => void,
): () => void {
  const attached = liveEntry(frame);
  if (attached == null) return () => {};
  const placeholder: Placeholder = {
    element,
    clipAncestors: clippingAncestors(element),
    onState,
  };
  attached.placeholders.push(placeholder);
  attached.hiddenSince = undefined;
  attached.pendingSince = undefined;
  notify(attached);
  layoutBoardFrames();
  schedule();
  return () => {
    // The frame now showing the view, if Refresh replaced it meanwhile.
    const entry = liveEntry(attached);
    if (entry == null) return;
    const index = entry.placeholders.indexOf(placeholder);
    if (index < 0) return;
    entry.placeholders.splice(index, 1);
    element.removeAttribute("aria-owns");
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
  entry.wrapper.remove();
}

/** For tests. */
export function resetBoardFrames(): void {
  for (const key of [...entries.keys()]) destroyBoardFrame(key);
  if (animationFrame != null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(animationFrame);
  }
  animationFrame = undefined;
  if (evictTimer != null) clearTimeout(evictTimer);
  evictTimer = undefined;
  layer?.remove();
  layer = undefined;
}
