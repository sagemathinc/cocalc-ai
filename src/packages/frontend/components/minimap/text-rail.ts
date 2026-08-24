/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Geometry and pointer handling shared by the two "text" minimaps (the notebook
one and the CodeMirror one).

Both render the document onto a tall canvas inside a shorter rail, so the
canvas itself has to scroll as the document does.  That inner scroller used to
be `overflow: auto`, which produced a second, useless scrollbar next to the
editor's own and let the wheel desynchronize the map from the document.  It is
now `overflow: hidden` and only ever moved programmatically; the wheel and the
drag handle are implemented here instead:

  - wheel over the minimap scrolls the *document*, exactly like the block
    minimap does,
  - pressing anywhere on the rail jumps there and starts a drag,
  - pressing on the viewport rectangle drags it relative to the grab point.

`computeTextMinimapGeometry` is the single source of truth for where the
viewport rectangle sits, so dragging it can be inverted exactly.
*/

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Applied to scrollers that should not show a scrollbar: the minimap's inner
 * track, and the document itself while a minimap is standing in for its
 * scrollbar.  Defined in styles/minimap.css.
 */
export const MINIMAP_HIDE_SCROLLBAR_CLASS = "minimap-hide-scrollbar";

/**
 * Applied to a CodeMirror wrapper whose vertical scrollbar the minimap
 * replaces.  Defined in styles/minimap.css.
 */
export const MINIMAP_NO_VSCROLLBAR_CLASS = "minimap-no-vscrollbar";

export interface TextMinimapGeometryInput {
  // total height of the minimap canvas/track
  trackHeight: number;
  // visible height of the rail (the window onto the track)
  railHeight: number;
  // scroll geometry of the document being mapped
  docContentHeight: number;
  docClientHeight: number;
  docScrollTop: number;
}

export interface TextMinimapGeometry {
  trackHeight: number;
  railHeight: number;
  // fraction of the document scrolled, in [0, 1]
  ratio: number;
  docMax: number;
  // how far the track is scrolled inside the rail
  miniScrollTop: number;
  // viewport rectangle, in rail coordinates
  thumbTop: number;
  thumbHeight: number;
  // how far the rectangle can travel inside the rail
  thumbTravel: number;
  // false when the document fits on screen: nothing scrolls, so there is no
  // point drawing (or dragging) a viewport rectangle
  scrollable: boolean;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function computeTextMinimapGeometry({
  trackHeight,
  railHeight,
  docContentHeight,
  docClientHeight,
  docScrollTop,
}: TextMinimapGeometryInput): TextMinimapGeometry {
  const track = Math.max(1, trackHeight);
  const rail = Math.max(1, railHeight);
  const content = Math.max(1, docContentHeight);
  const client = Math.max(1, docClientHeight);
  const docMax = Math.max(1, content - client);
  const ratio = clamp(docScrollTop / docMax, 0, 1);
  const viewportInTrack = clamp((client / content) * track, 16, track);
  const miniScrollTop = ratio * Math.max(0, track - rail);
  const thumbHeight = Math.min(rail, viewportInTrack);
  // The rectangle's travel is what is left after the track itself scrolls.
  const thumbTravel = Math.max(0, Math.min(track, rail) - viewportInTrack);
  const thumbTop = clamp(
    ratio * thumbTravel,
    0,
    Math.max(0, rail - thumbHeight),
  );
  return {
    trackHeight: track,
    railHeight: rail,
    ratio,
    docMax,
    miniScrollTop,
    thumbTop,
    thumbHeight,
    thumbTravel,
    scrollable: content > client + 1,
  };
}

export interface UseTextMinimapRailOptions {
  railRef: React.MutableRefObject<HTMLDivElement | null>;
  /** Current geometry, or null while the minimap is not laid out yet. */
  getGeometry: () => TextMinimapGeometry | null;
  /** Scroll the document to an absolute position. */
  scrollDocTo: (top: number) => void;
  /** Scroll the document by a delta (wheel). */
  scrollDocBy: (delta: number) => void;
  /**
   * Optional snap target for a plain click on the track (not on the viewport
   * rectangle): given the y position in track coordinates, scroll to the
   * corresponding cell/block and return true to skip ratio scrolling.
   */
  onTrackClick?: (yInTrack: number) => boolean;
  /**
   * Bump when the rail element appears or is replaced.  The wheel listener is
   * native (React registers `wheel` passively, so it could not preventDefault),
   * and a plain ref gives the effect nothing to react to — without this the
   * listener is never attached for minimaps that mount their rail lazily.
   */
  attachKey?: unknown;
}

export interface TextMinimapRailHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  dragging: boolean;
}

/**
 * The minimap stands in for the document's scrollbar, so it exposes itself as
 * one: focusable, with a role, an orientation and (set imperatively alongside
 * the viewport rectangle) a value.
 */
export const MINIMAP_SCROLLBAR_ARIA = {
  role: "scrollbar",
  tabIndex: 0,
  "aria-orientation": "vertical",
  "aria-valuemin": 0,
  "aria-valuemax": 100,
} as const;

/** Scroll delta for a key press, or null if the key is not a scrolling key. */
export function scrollDeltaForKey(
  key: string,
  clientHeight: number,
): number | "start" | "end" | null {
  switch (key) {
    case "ArrowUp":
      return -40;
    case "ArrowDown":
      return 40;
    case "PageUp":
      return -Math.max(40, clientHeight * 0.9);
    case "PageDown":
      return Math.max(40, clientHeight * 0.9);
    case "Home":
      return "start";
    case "End":
      return "end";
    default:
      return null;
  }
}

export function useTextMinimapRail({
  railRef,
  getGeometry,
  scrollDocTo,
  scrollDocBy,
  onTrackClick,
  attachKey,
}: UseTextMinimapRailOptions): TextMinimapRailHandlers {
  const [dragging, setDragging] = useState<boolean>(false);
  const draggingRef = useRef<boolean>(false);
  const grabOffsetRef = useRef<number>(0);

  // A native, non-passive listener: React's onWheel is registered passively,
  // so preventDefault there would not stop the wheel from bubbling out to
  // whatever scrollable ancestor happens to be around.
  const scrollDocByRef = useRef(scrollDocBy);
  scrollDocByRef.current = scrollDocBy;
  useEffect(() => {
    const rail = railRef.current;
    if (rail == null) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      scrollDocByRef.current(e.deltaY);
    };
    rail.addEventListener("wheel", onWheel, { passive: false });
    return () => rail.removeEventListener("wheel", onWheel);
  }, [railRef, attachKey]);

  const scrollToRailY = useCallback(
    (y: number, geo: TextMinimapGeometry) => {
      const thumbTop = clamp(
        y - grabOffsetRef.current,
        0,
        Math.max(0, geo.railHeight - geo.thumbHeight),
      );
      const ratio = geo.thumbTravel > 0 ? thumbTop / geo.thumbTravel : 0;
      scrollDocTo(clamp(ratio, 0, 1) * geo.docMax);
    },
    [scrollDocTo],
  );

  const railY = (e: React.PointerEvent<HTMLDivElement>): number | null => {
    const rail = railRef.current;
    if (rail == null) return null;
    const rect = rail.getBoundingClientRect();
    if (rect.height <= 0) return null;
    return clamp(e.clientY - rect.top, 0, rect.height);
  };

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // leave right-click to the context menu
      if (e.button !== 0) return;
      const geo = getGeometry();
      const y = railY(e);
      if (geo == null || y == null || !geo.scrollable) return;
      e.preventDefault();
      const onThumb = y >= geo.thumbTop && y <= geo.thumbTop + geo.thumbHeight;
      if (onThumb) {
        // relative drag: keep the point the user grabbed under the cursor
        grabOffsetRef.current = y - geo.thumbTop;
      } else {
        grabOffsetRef.current = geo.thumbHeight / 2;
        const handled =
          onTrackClick?.(geo.miniScrollTop + y) === true ? true : false;
        if (!handled) scrollToRailY(y, geo);
      }
      draggingRef.current = true;
      setDragging(true);
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture can throw if the pointer is already gone
      }
    },
    [getGeometry, onTrackClick, scrollToRailY],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      const geo = getGeometry();
      const y = railY(e);
      if (geo == null || y == null) return;
      scrollToRailY(y, geo);
    },
    [getGeometry, scrollToRailY],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore: capture may already have been lost
    }
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const geo = getGeometry();
      if (geo == null) return;
      const delta = scrollDeltaForKey(e.key, geo.railHeight);
      if (delta == null) return;
      e.preventDefault();
      if (delta === "start") {
        scrollDocTo(0);
      } else if (delta === "end") {
        scrollDocTo(geo.docMax);
      } else {
        scrollDocBy(delta);
      }
    },
    [getGeometry, scrollDocBy, scrollDocTo],
  );

  return { onPointerDown, onPointerMove, onPointerUp, onKeyDown, dragging };
}
