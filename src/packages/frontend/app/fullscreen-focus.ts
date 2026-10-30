/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Keyboard focus across fullscreen transitions. Entering or leaving
// fullscreen unmounts the focused control (the nav/sidebar enter button, or
// the exit button after the banners) and mounts the other one elsewhere;
// without a hand-off, focus falls to the body. The control that mounts next
// takes the focus; if none does (narrow layouts have no enter button), the
// fallback picks a stable app-shell control. The hand-off is short-lived, so
// a later mount (e.g. after a resize) never steals focus.

// On both fullscreen controls (enter and exit).
export const FULLSCREEN_CONTROL = "data-fullscreen-control";
// On the app-shell control that takes focus when no fullscreen control
// replaces the exit button (the compact nav's "More navigation").
export const FULLSCREEN_EXIT_FOCUS = "data-fullscreen-exit-focus";

const FALLBACK_DELAY_MS = 150;
// Hidden panes (e.g. the agents workspace's inactive content) are inert and
// can hold duplicate navigation.
const UNFOCUSABLE_ANCESTOR = '[inert], [hidden], [aria-hidden="true"]';

let pending = false;
let timer: ReturnType<typeof setTimeout> | undefined;

// Call right before a transition that unmounts the focused fullscreen control.
export function handOffFullscreenFocus(): void {
  pending = true;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!pending) return;
    pending = false;
    focusFallback();
  }, FALLBACK_DELAY_MS);
}

// For transitions not started by a control (the browser leaving fullscreen):
// hand off only if a fullscreen control has the focus.
export function handOffFullscreenFocusIfFocused(): void {
  const active = document.activeElement;
  if (active?.closest(`[${FULLSCREEN_CONTROL}]`) != null) {
    handOffFullscreenFocus();
  }
}

// Called by a fullscreen control after it mounts or changes mode. An inert
// copy (a retained hidden pane) can't take focus and leaves the hand-off for
// the visible one.
export function takeFullscreenFocus(el: HTMLElement | null): void {
  if (!pending || el == null || !tryFocus(el)) return;
  pending = false;
  clearTimeout(timer);
}

function tryFocus(el: HTMLElement): boolean {
  if (el.closest(UNFOCUSABLE_ANCESTOR) != null) return false;
  el.focus();
  return document.activeElement === el;
}

function focusFallback(): void {
  const active = document.activeElement;
  if (active != null && active !== document.body) return;
  const candidates = [
    ...document.querySelectorAll<HTMLElement>(`[${FULLSCREEN_CONTROL}]`),
    ...document.querySelectorAll<HTMLElement>(`[${FULLSCREEN_EXIT_FOCUS}]`),
    ...document.querySelectorAll<HTMLElement>(
      ".smc-top-bar button, .smc-top-bar a[href]",
    ),
  ];
  // keep the first candidate that actually takes focus
  for (const el of candidates) {
    if (tryFocus(el)) return;
  }
}
