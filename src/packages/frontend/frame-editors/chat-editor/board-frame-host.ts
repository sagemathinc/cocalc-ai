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
// A frame that replaced the one focus was in takes focus when its card
// attaches it (the card detaches the old frame first, which moves focus
// out), if that is this soon.
const BOARD_FRAME_REFOCUS_MS = 1_000;

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
  // The placeholder the frame covers: the newest one the user can see, or
  // the newest if none can be seen (activeOf).
  active?: Placeholder;
  // Until when its card's attaching it gives it focus (BOARD_FRAME_REFOCUS_MS),
  // and where hiding it meanwhile sent focus: only from there (or from
  // nowhere) does attaching take it back, never from a place the user chose.
  refocusUntil?: number;
  focusMovedTo?: Element | null;
}

function activeOf(entry: Entry): Placeholder | undefined {
  const { active, placeholders } = entry;
  return active != null && placeholders.includes(active)
    ? active
    : placeholders[placeholders.length - 1];
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
  const active = activeOf(entry);
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

// Hide a frame. If focus is in it, it first moves to the nearest visible
// control around the place it was shown (`from`), so keystrokes never go to
// an invisible board; with none, focus leaves the frame.
function hide(entry: Entry, from?: HTMLElement): void {
  if (document.activeElement === entry.iframe) {
    if (!focusNear(from)) entry.iframe.blur();
    if (entry.refocusUntil != null) entry.focusMovedTo = document.activeElement;
  }
  Object.assign(entry.iframe.style, {
    visibility: "hidden",
    pointerEvents: "none",
  });
  setSentinels(entry, false);
}

// Focus the nearest visible control around the place a frame was shown,
// after it, else before it; false if there is none.
function focusNear(from?: HTMLElement): boolean {
  const target =
    from?.isConnected === true
      ? (adjacentControl(from, true) ?? adjacentControl(from, false))
      : undefined;
  target?.focus();
  return target != null;
}

// Focus for a frame that replaced the one focus was in: the frame if it is
// shown, else (its place is hidden) as when hiding a frame with focus.
function takeFocus(entry: Entry, from?: HTMLElement): void {
  if (entry.iframe.style.visibility === "visible") {
    entry.iframe.focus();
  } else {
    focusNear(from);
  }
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
  const placeholder = activeOf(entry);
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

// Where a placeholder is on screen, clipped to what of it is visible, or
// undefined if the user can't see it (no size, scrolled out of view, or
// hidden, as an inactive tab is).
function visibleRect(
  placeholder: Placeholder,
):
  | { rect: DOMRect; left: number; top: number; right: number; bottom: number }
  | undefined {
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
    return undefined;
  }
  return { rect, left, top, right, bottom };
}

// Lay each shown frame over its placeholder, clipped to what of the
// placeholder is visible. With the view in several places, that is the
// newest place the user can see (so a visible card never says the board is
// elsewhere while no board shows); if none can be seen, the frame is hidden
// without unloading it, still belonging to the place it was last shown.
export function layoutBoardFrames(): void {
  for (const entry of entries.values()) {
    const { placeholders } = entry;
    if (placeholders.length === 0) continue;
    // With none visible, the frame stays with the placeholder it covered
    // (so focus leaving it continues from where the board was last shown).
    const previous = activeOf(entry)!;
    let chosen = previous;
    let shown: ReturnType<typeof visibleRect>;
    for (let i = placeholders.length - 1; i >= 0; i--) {
      shown = visibleRect(placeholders[i]);
      if (shown != null) {
        chosen = placeholders[i];
        break;
      }
    }
    if (chosen !== activeOf(entry)) {
      entry.active = chosen;
      notify(entry);
    }
    if (shown == null) {
      hide(entry, chosen.element);
      continue;
    }
    const { rect, left, top, right, bottom } = shown;
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
// event reports, so shown frames follow them every animation frame. While
// every attached frame is hidden (its editor in an inactive tab, say), the
// placeholders are only checked every BOARD_FRAME_IDLE_POLL_MS, until one
// can be seen again.
export const BOARD_FRAME_IDLE_POLL_MS = 500;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function anyVisible(): boolean {
  for (const entry of entries.values()) {
    if (
      entry.placeholders.length > 0 &&
      entry.iframe.style.visibility === "visible"
    ) {
      return true;
    }
  }
  return false;
}

// What usually reveals a hidden board (a click or keypress switching tabs, a
// resize) wakes the idle loop at once, rather than at its next check.
let waking = false;
function wakeOnInput(): void {
  if (waking || typeof window === "undefined") return;
  waking = true;
  const wake = () => {
    if (idleTimer != null) schedule();
  };
  for (const type of ["pointerdown", "keydown", "focusin", "resize"]) {
    window.addEventListener(type, wake, { capture: true, passive: true });
  }
}

function schedule(): void {
  if (typeof requestAnimationFrame !== "function") return;
  wakeOnInput();
  if (idleTimer != null) {
    // Something changed (a card attached, say): look again at once.
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  if (animationFrame != null) return;
  const step = () => {
    animationFrame = undefined;
    if (!anyShown()) return;
    layoutBoardFrames();
    if (anyVisible()) {
      animationFrame = requestAnimationFrame(step);
    } else {
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        if (animationFrame == null) step();
      }, BOARD_FRAME_IDLE_POLL_MS);
    }
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
  const entry = entries.get(key);
  // Claimed for the card that asked, until it attaches: pending, so neither
  // its time nor the limit drops it meanwhile (as for a new frame).
  if (entry != null && entry.placeholders.length === 0) {
    entry.pendingSince = Date.now();
  }
  return entry;
}

/** Whether this frame (or the one that replaced it) is still live. */
export function isBoardFrameLive(frame: BoardFrame): boolean {
  return liveEntry(frame) != null;
}

/** A new frame for this view, replacing any earlier one; it loads at once,
 * hidden until a placeholder shows it. */
// Reads of a view's board: only the newest may make its frame, so a slower,
// older read (another place showing the view, an earlier Refresh) never
// replaces what a newer one made. A superseded read adopts the newest one's
// frame instead (nextBoardFrame).
interface LoadState {
  latest: number;
  // The newest read's outcome, once it has one.
  done?: number;
  failed?: number;
  waiters: ((frame: BoardFrame | undefined) => void)[];
}
const loads = new Map<string, LoadState>();

function loadState(key: string): LoadState {
  let state = loads.get(key);
  if (state == null) {
    state = { latest: 0, waiters: [] };
    loads.set(key, state);
  }
  return state;
}

/** A read of this view's board is starting: its generation. */
export function beginBoardLoad(key: string): number {
  return ++loadState(key).latest;
}

/** Whether this read is still the newest of its view's. */
export function isLatestBoardLoad(key: string, generation: number): boolean {
  return loadState(key).latest === generation;
}

/** The frame the newest read of this view makes (undefined if it fails). */
export function nextBoardFrame(key: string): Promise<BoardFrame | undefined> {
  const state = loadState(key);
  if (state.done === state.latest) {
    return Promise.resolve(entries.get(key));
  }
  if (state.failed === state.latest) return Promise.resolve(undefined);
  return new Promise((resolve) => state.waiters.push(resolve));
}

function settleLoad(key: string, generation: number, frame?: BoardFrame) {
  const state = loadState(key);
  if (state.latest !== generation) return;
  if (state.done === generation || state.failed === generation) return;
  if (frame != null) state.done = generation;
  else state.failed = generation;
  const waiters = state.waiters.splice(0);
  for (const resolve of waiters) resolve(frame);
}

/** The newest read of this view failed: those waiting for it get nothing. */
export function boardLoadFailed(key: string, generation: number): void {
  settleLoad(key, generation);
}

// Cards of a view with no frame (their own read failed, while another
// place's read later made one): told of each frame made for the view, which
// they then show too.
const createdListeners = new Map<string, Set<(frame: BoardFrame) => void>>();

/** Call `listener` with each new frame made for this view, until the
 * returned function is called. */
export function onBoardFrameCreated(
  key: string,
  listener: (frame: BoardFrame) => void,
): () => void {
  let listeners = createdListeners.get(key);
  if (listeners == null) {
    listeners = new Set();
    createdListeners.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && createdListeners.get(key) === listeners) {
      createdListeners.delete(key);
    }
  };
}

export function createBoardFrame({
  key,
  path,
  frameUrl,
  sandbox,
  text,
  name,
  title,
  generation,
}: {
  key: string;
  path: string;
  frameUrl: string;
  sandbox: string;
  text: string;
  name: string;
  title: string;
  // The read this frame is made from (beginBoardLoad), if any.
  generation?: number;
}): BoardFrame {
  const previous = entries.get(key);
  const placeholders = previous?.placeholders ?? [];
  // Refresh can finish while the keyboard user is back in the old board:
  // focus then follows to the new frame, not to the page's body.
  const hadFocus =
    previous != null && document.activeElement === previous.iframe;
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
  if (hadFocus) {
    entry.refocusUntil = Date.now() + BOARD_FRAME_REFOCUS_MS;
    takeFocus(entry, activeOf(entry)?.element);
  }
  schedule();
  // Created hidden (no placeholder yet): it expires like any hidden frame.
  if (entry.hiddenSince != null) evictHidden();
  if (generation != null) settleLoad(key, generation, entry);
  for (const listener of [...(createdListeners.get(key) ?? [])]) {
    listener(entry);
  }
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
  attached.active = placeholder;
  attached.hiddenSince = undefined;
  attached.pendingSince = undefined;
  notify(attached);
  layoutBoardFrames();
  if (attached.refocusUntil != null) {
    const focused = document.activeElement;
    if (
      Date.now() <= attached.refocusUntil &&
      (focused == null ||
        focused === document.body ||
        focused === attached.iframe ||
        focused === attached.focusMovedTo)
    ) {
      takeFocus(attached, element);
    }
    attached.refocusUntil = undefined;
    attached.focusMovedTo = undefined;
  }
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
      hide(entry, element);
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
  loads.clear();
  createdListeners.clear();
  if (animationFrame != null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(animationFrame);
  }
  animationFrame = undefined;
  if (idleTimer != null) clearTimeout(idleTimer);
  idleTimer = undefined;
  if (evictTimer != null) clearTimeout(evictTimer);
  evictTimer = undefined;
  layer?.remove();
  layer = undefined;
}
