/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// How the shared browser viewer turns the human's keys into the browser's
// (see @cocalc/util/shared-browser-protocol): pure functions, shared with the
// browser service's end-to-end tests.

import type { ViewerMessage } from "./shared-browser-protocol";

type KeyMessage = Extract<ViewerMessage, { type: "key" }>;

interface KeyLike {
  key: string;
  code: string;
  keyCode?: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

// The browser runs on Linux: on a Mac or iPad, Cmd does what Ctrl does there.
export function isApplePlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform);
}

// CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
export function modifiers(e: KeyLike, apple: boolean): number {
  return (
    (e.altKey ? 1 : 0) |
    (e.ctrlKey || (apple && e.metaKey) ? 2 : 0) |
    (e.metaKey && !apple ? 4 : 0) |
    (e.shiftKey ? 8 : 0)
  );
}

// The shortcut key (Ctrl, or Cmd on Apple) is down.
export function isAccel(e: KeyLike, apple: boolean): boolean {
  return (apple ? e.metaKey : e.ctrlKey) && !e.altKey;
}

const SPECIAL: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

export function keyMessage(
  event: "keyDown" | "keyUp",
  e: KeyLike,
  apple: boolean,
): KeyMessage {
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
  const text = printable ? e.key : e.key === "Enter" ? "\r" : undefined;
  // The browser's own key code is the Windows virtual key code CDP wants.
  // (A character's code is not: "(" is 40, which is ArrowDown.)
  const keyCode =
    e.keyCode ||
    SPECIAL[e.key] ||
    (/^[a-z0-9]$/i.test(e.key) ? e.key.toUpperCase().charCodeAt(0) : 0);
  return {
    type: "key",
    event: event === "keyDown" ? (text ? "keyDown" : "rawKeyDown") : "keyUp",
    key: e.key,
    code: e.code,
    text: event === "keyDown" ? text : undefined,
    keyCode,
    modifiers: modifiers(e, apple),
  };
}

// What a shortcut does to the page zoom (as in a browser): 1 in, -1 out, 0
// back to 100%; undefined for other keys.
export function zoomShortcut(
  e: KeyLike,
  apple: boolean,
): -1 | 0 | 1 | undefined {
  if (!isAccel(e, apple)) return undefined;
  return (
    { "=": 1, "+": 1, "-": -1, _: -1, "0": 0 } as Record<string, -1 | 0 | 1>
  )[e.key.toLowerCase()];
}

export const ZOOMS = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];

export function nextZoom(current: number, direction: number): number {
  if (direction === 0) return 1;
  if (direction > 0)
    return ZOOMS.find((z) => z > current + 0.001) ?? ZOOMS[ZOOMS.length - 1];
  return [...ZOOMS].reverse().find((z) => z < current - 0.001) ?? ZOOMS[0];
}
