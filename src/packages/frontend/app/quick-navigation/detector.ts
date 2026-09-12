/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";
import { getKeyboardBoundaryElement } from "@cocalc/frontend/keyboard/boundary";
import type { Shortcut } from "./preferences";

// A complete tap means keydown followed by keyup. Chords, auto-repeat,
// composition, window blur, and other keys break the sequence.
export function createTapDetector(delay: number, trigger: () => void) {
  let down = false;
  let last: number | undefined;
  const reset = () => {
    down = false;
    last = undefined;
  };
  return {
    reset,
    event(event: KeyboardEvent) {
      if (
        event.key !== "Shift" ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.isComposing
      ) {
        reset();
        return;
      }
      if (event.repeat) {
        reset();
        return;
      }
      if (event.type === "keydown") {
        if (down) {
          reset();
          return;
        }
        down = true;
      } else if (down) {
        down = false;
        const now = performance.now();
        if (last != null && now - last <= delay) {
          reset();
          trigger();
        } else last = now;
      }
    },
  };
}
export function useNavigationShortcut(
  shortcut: Shortcut,
  delay: number,
  trigger: () => void,
  enabled: boolean,
  mac: boolean,
) {
  useEffect(() => {
    if (!enabled || shortcut === "disabled") return;
    const detector = createTapDetector(delay, trigger);
    const handle = (event: KeyboardEvent) => {
      // The explicit navigation shortcut works in editors, but respects modal
      // overlays and the shortcut tester. Bare characters never act globally.
      const boundary = getKeyboardBoundaryElement(event);
      if (
        event.defaultPrevented ||
        event.isComposing ||
        boundary?.closest(
          '[role="dialog"], [role="alertdialog"], [data-quick-navigation-config]',
        ) ||
        (event.target instanceof Element &&
          event.target.closest('[role="dialog"], [role="alertdialog"]'))
      ) {
        detector.reset();
        return;
      }
      if (shortcut === "shift+shift") detector.event(event);
      else if (
        event.type === "keydown" &&
        !event.repeat &&
        !event.altKey &&
        (mac
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey) &&
        (shortcut === "ctrl+k"
          ? !event.shiftKey && event.key.toLowerCase() === "k"
          : event.shiftKey && (event.key === " " || event.code === "Space"))
      ) {
        event.preventDefault();
        event.stopPropagation();
        trigger();
      }
    };
    window.addEventListener("keydown", handle, true);
    window.addEventListener("keyup", handle, true);
    window.addEventListener("blur", detector.reset);
    return () => {
      window.removeEventListener("keydown", handle, true);
      window.removeEventListener("keyup", handle, true);
      window.removeEventListener("blur", detector.reset);
    };
  }, [shortcut, delay, trigger, enabled, mac]);
}
