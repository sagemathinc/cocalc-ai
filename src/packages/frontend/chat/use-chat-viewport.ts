import { useEffect, useState } from "react";
import type { RefObject } from "react";

let releaseActiveFocus: (() => void) | undefined;

// Keep phone landscape compact too, without treating short desktop windows as
// phones. Use layout dimensions, not the keyboard/pinch-zoom visual viewport.
export function useNarrowChatViewport(): boolean {
  const query =
    "(max-width: 767px), (max-width: 1000px) and (max-height: 500px) and (pointer: coarse)";
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function useChatVisualViewport(enabled: boolean) {
  const read = () => ({
    top: window.visualViewport?.offsetTop ?? 0,
    left: window.visualViewport?.offsetLeft ?? 0,
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  });
  const [viewport, setViewport] = useState({
    top: 0,
    left: 0,
    width: 0,
    height: 0,
  });
  useEffect(() => {
    if (!enabled) return;
    const update = () => setViewport(read());
    const visual = window.visualViewport;
    update();
    window.addEventListener("resize", update);
    visual?.addEventListener("resize", update);
    visual?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      visual?.removeEventListener("resize", update);
      visual?.removeEventListener("scroll", update);
    };
  }, [enabled]);
  return viewport;
}

// Leave body-level dialog portals alone, but remove the covered application
// navigation from keyboard and assistive-technology access while focused.
export function useChatFocusIsolation(
  ref: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled || !ref.current) return;
    // Switching tabs can mount the new focused chat before cleaning up the old
    // one. Restore the previous owner before taking a fresh visibility snapshot.
    releaseActiveFocus?.();
    const saved = new Map<
      HTMLElement,
      { inert: boolean; visibility: string; opacity: string }
    >();
    const overflows = new Map<HTMLElement, string>();
    let child: HTMLElement = ref.current;
    while (child.parentElement && child.parentElement !== document.body) {
      for (const sibling of Array.from(child.parentElement.children)) {
        if (sibling === child || !(sibling instanceof HTMLElement)) continue;
        saved.set(sibling, {
          inert: sibling.inert,
          visibility: sibling.style.visibility,
          opacity: sibling.style.opacity,
        });
        sibling.inert = true;
        sibling.style.visibility = "hidden";
        sibling.style.opacity = "0";
      }
      child = child.parentElement;
      // The full-viewport surface must not be clipped to the editor's bounds.
      overflows.set(child, child.style.overflow);
      child.style.overflow = "visible";
    }
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      for (const [element, previous] of saved) {
        element.inert = previous.inert;
        element.style.visibility = previous.visibility;
        element.style.opacity = previous.opacity;
      }
      if (releaseActiveFocus === release) releaseActiveFocus = undefined;
      for (const [element, overflow] of overflows)
        element.style.overflow = overflow;
    };
    releaseActiveFocus = release;
    return release;
  }, [enabled, ref]);
}
