/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Generic "block" minimap: one bar per logical block of a scrollable document.

This started life as the Jupyter Studio notebook minimap and was generalized so
that any scrollable document can use it:

  - Jupyter (studio and classic): one block per cell, colored by execution
    status, so the map doubles as an activity indicator.
  - CodeMirror text editors: one block per paragraph (text delimited by blank
    lines); there is no activity to show, so all bars use the neutral color.

The component itself is deliberately dumb: the caller decides the color,
opacity and blinking of every block, and supplies a `MinimapDocAdapter` that
knows how to measure and scroll the underlying document.  Nothing notebook- or
CodeMirror-specific is left in here.
*/

import React, { useCallback, useEffect, useRef, useState } from "react";

import { COLORS } from "@cocalc/util/theme";
import { MINIMAP_SCROLLBAR_ARIA, scrollDeltaForKey } from "./text-rail";

export const BLOCK_MINIMAP_DEFAULT_WIDTH = 40;
const VIEWPORT_MIN_HEIGHT = 12;
const BLOCK_GAP = 2; // visible gap between blocks
const MIN_BLOCK_HEIGHT = 2;

export interface MinimapBlock {
  id: string;
  // height of the block in document pixels; relative sizes are what matter
  pixelHeight: number;
  color: string;
  opacity?: number;
  // blink the bar (used for the actively running notebook cell)
  blink?: boolean;
}

export interface MinimapBarSegment {
  block: MinimapBlock;
  top: number;
  height: number;
}

/** First/last block visible in the scroller, with the fraction of each. */
export interface MinimapVisibleRange {
  firstId: string;
  firstFrac: number; // fraction of the first block hidden above the top edge
  lastId: string;
  lastFrac: number; // fraction of the last block above the bottom edge
}

/**
 * How the minimap talks to the document it maps.  The DOM implementation below
 * covers anything that lays its blocks out as real elements; CodeMirror
 * provides its own, computed from line heights.
 */
export interface MinimapDocAdapter {
  visibleRange(): MinimapVisibleRange | null;
  /**
   * Center the viewport on `frac` through block `id`.  Returns false when the
   * block cannot be located, so the caller can fall back to ratio scrolling.
   */
  scrollToBlock(id: string, frac: number): boolean;
  metrics(): { scrollTop: number; scrollHeight: number; clientHeight: number };
  scrollToPosition(top: number): void;
  scrollBy(delta: number): void;
  /** Called whenever the document scrolls or is resized. */
  subscribe(onChange: () => void): () => void;
}

/**
 * Lay the blocks out over exactly `height` pixels: proportional to their
 * document pixel heights, with a small gap and a minimum bar height.  The
 * clamps would make the stack overflow the minimap for documents with many
 * blocks (and undershoot for few), so the result is renormalized to always
 * span the full height — otherwise bar positions drift against the viewport
 * rectangle.
 */
export function computeMinimapLayout(
  blocks: MinimapBlock[],
  height: number,
): MinimapBarSegment[] {
  if (blocks.length === 0 || height <= 0) return [];
  const totalPixels = blocks.reduce((s, b) => s + b.pixelHeight, 0) || 1;
  const scale = height / totalPixels;
  const raw = blocks.map((b) =>
    Math.max(MIN_BLOCK_HEIGHT, b.pixelHeight * scale - BLOCK_GAP),
  );
  const rawTotal = raw.reduce((s, h) => s + h + BLOCK_GAP, 0);
  const factor = height / rawTotal;
  const segments: MinimapBarSegment[] = [];
  let y = 0;
  blocks.forEach((block, i) => {
    // no extra floor here: raw is already clamped, and flooring again after
    // scaling would break the normalization for documents with many blocks
    const h = raw[i] * factor;
    segments.push({ block, top: y, height: h });
    y += h + BLOCK_GAP * factor;
  });
  return segments;
}

/**
 * Map the visible block range into minimap bar coordinates.  Computing the
 * viewport from the actually visible blocks (instead of scrollTop ratios)
 * keeps the rectangle aligned with the bars even when per-block height
 * estimates are off.
 */
export function viewportFromSegments(
  segments: MinimapBarSegment[],
  range: MinimapVisibleRange | null,
): { top: number; bottom: number } | null {
  if (range == null) return null;
  let first: MinimapBarSegment | undefined;
  let last: MinimapBarSegment | undefined;
  for (const seg of segments) {
    if (seg.block.id === range.firstId) first = seg;
    if (seg.block.id === range.lastId) last = seg;
  }
  if (first == null || last == null) return null;
  const top = first.top + range.firstFrac * first.height;
  const bottom = last.top + range.lastFrac * last.height;
  if (bottom <= top) return null;
  return { top, bottom };
}

/**
 * Adapter for documents whose blocks are real DOM nodes inside a scrolling
 * element, tagged with `blockAttribute`.
 */
export function createDomMinimapAdapter({
  getScroller,
  blockAttribute,
}: {
  getScroller: () => HTMLElement | null;
  blockAttribute: string;
}): MinimapDocAdapter {
  function findNode(id: string): HTMLElement | null {
    const el = getScroller();
    if (el == null) return null;
    const escaped = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return el.querySelector<HTMLElement>(`[${blockAttribute}="${escaped}"]`);
  }

  return {
    visibleRange() {
      const el = getScroller();
      if (el == null) return null;
      const elRect = el.getBoundingClientRect();
      let first: { id: string; frac: number } | null = null;
      let last: { id: string; frac: number } | null = null;
      for (const node of el.querySelectorAll<HTMLElement>(
        `[${blockAttribute}]`,
      )) {
        const r = node.getBoundingClientRect();
        if (r.height <= 0 || r.bottom <= elRect.top) continue;
        if (r.top >= elRect.bottom) break;
        const id = node.getAttribute(blockAttribute);
        if (id == null) continue;
        if (first == null) {
          first = {
            id,
            frac: Math.max(0, Math.min(1, (elRect.top - r.top) / r.height)),
          };
        }
        last = {
          id,
          frac: Math.max(0, Math.min(1, (elRect.bottom - r.top) / r.height)),
        };
      }
      if (first == null || last == null) return null;
      return {
        firstId: first.id,
        firstFrac: first.frac,
        lastId: last.id,
        lastFrac: last.frac,
      };
    },
    scrollToBlock(id, frac) {
      const el = getScroller();
      const node = findNode(id);
      if (el == null || node == null) return false;
      const nodeRect = node.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const blockTop = nodeRect.top - elRect.top + el.scrollTop;
      el.scrollTop = blockTop + frac * nodeRect.height - el.clientHeight / 2;
      return true;
    },
    metrics() {
      const el = getScroller();
      if (el == null) return { scrollTop: 0, scrollHeight: 1, clientHeight: 1 };
      return {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
    },
    scrollToPosition(top) {
      const el = getScroller();
      if (el != null) el.scrollTop = top;
    },
    scrollBy(delta) {
      const el = getScroller();
      if (el != null) el.scrollTop += delta;
    },
    subscribe(onChange) {
      const el = getScroller();
      if (el == null) return () => {};
      el.addEventListener("scroll", onChange, { passive: true });
      const observer = new ResizeObserver(onChange);
      observer.observe(el);
      return () => {
        el.removeEventListener("scroll", onChange);
        observer.disconnect();
      };
    },
  };
}

interface BlockMinimapProps {
  blocks: MinimapBlock[];
  height: number;
  width?: number;
  adapter: MinimapDocAdapter;
  /** Accessible name, e.g. "Notebook minimap scrollbar". */
  label: string;
  // Bump to force the viewport rectangle to be recomputed (e.g. after the
  // scroller element is mounted or swapped out).
  resubscribeKey?: unknown;
  // Rendered inside the minimap (typically the hide button).
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export const BlockMinimap: React.FC<BlockMinimapProps> = React.memo(
  ({
    blocks,
    height,
    width = BLOCK_MINIMAP_DEFAULT_WIDTH,
    adapter,
    label,
    resubscribeKey,
    children,
    style,
  }) => {
    const [scrollRatio, setScrollRatio] = useState(0);
    const [viewportRatio, setViewportRatio] = useState(1);
    const [clientHeight, setClientHeight] = useState(0);
    const [scrollable, setScrollable] = useState(false);
    const [visibleRange, setVisibleRange] =
      useState<MinimapVisibleRange | null>(null);
    const minimapRef = useRef<HTMLDivElement>(null);
    const segmentsRef = useRef<MinimapBarSegment[]>([]);
    const layoutHeightRef = useRef<number>(0);
    const draggingRef = useRef(false);
    const [dragging, setDragging] = useState(false);
    // read from the pointer handler, which is memoized on other deps
    const scrollableRef = useRef(false);
    const rafRef = useRef<number | null>(null);

    const update = useCallback(() => {
      const { scrollTop, scrollHeight, clientHeight } = adapter.metrics();
      const maxScroll = scrollHeight - clientHeight;
      setClientHeight(clientHeight);
      scrollableRef.current = maxScroll > 1;
      setScrollable(maxScroll > 1);
      if (maxScroll <= 0) {
        setScrollRatio(0);
        setViewportRatio(1);
      } else {
        setScrollRatio(scrollTop / maxScroll);
        setViewportRatio(Math.min(1, clientHeight / scrollHeight));
      }
      setVisibleRange(adapter.visibleRange());
    }, [adapter]);

    const scheduleUpdate = useCallback(() => {
      if (typeof window === "undefined") {
        update();
        return;
      }
      if (rafRef.current != null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        update();
      });
    }, [update]);

    useEffect(() => {
      update();
      return adapter.subscribe(scheduleUpdate);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [adapter, scheduleUpdate, update, resubscribeKey]);

    // Blocks can change on any render (cells added, heights remeasured); a
    // coalesced update keeps the viewport rectangle in sync without paying for
    // a measurement pass per render.
    useEffect(() => {
      scheduleUpdate();
    });

    useEffect(() => {
      return () => {
        if (rafRef.current != null && typeof window !== "undefined") {
          window.cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      };
    }, []);

    // Offset of the pointer inside the viewport rectangle while dragging it,
    // or null when the drag centers on the pointer instead.
    const grabOffsetRef = useRef<number | null>(null);
    // Viewport rectangle in minimap coordinates, for hit-testing pointer-down.
    const viewportRef = useRef<{ top: number; height: number }>({
      top: 0,
      height: 0,
    });

    /** Scroll so the viewport rectangle's top sits at `top`. */
    const scrollToViewportTop = useCallback(
      (top: number, layoutHeight: number) => {
        const { scrollHeight, clientHeight } = adapter.metrics();
        const travel = Math.max(1, layoutHeight - viewportRef.current.height);
        const ratio = Math.max(0, Math.min(1, top / travel));
        adapter.scrollToPosition(ratio * (scrollHeight - clientHeight));
      },
      [adapter],
    );

    const scrollTo = useCallback(
      (clientY: number) => {
        const map = minimapRef.current;
        if (!map) return;
        const rect = map.getBoundingClientRect();
        const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
        // Map the clicked bar position to a block + fraction and center the
        // scroller on the corresponding document position — the inverse of
        // how the viewport rectangle is drawn, so clicking inside the
        // rectangle doesn't jump.
        const segments = segmentsRef.current;
        const seg =
          segments.find((s) => y <= s.top + s.height) ??
          segments[segments.length - 1];
        if (seg != null) {
          const frac =
            seg.height > 0
              ? Math.max(0, Math.min(1, (y - seg.top) / seg.height))
              : 0;
          if (adapter.scrollToBlock(seg.block.id, frac)) return;
        }
        // Fallback: linear ratio mapping.
        const ratio = rect.height > 0 ? y / rect.height : 0;
        const vpHalf = viewportRatio / 2;
        const targetRatio = Math.max(
          0,
          Math.min(1, (ratio - vpHalf) / Math.max(0.001, 1 - viewportRatio)),
        );
        const { scrollHeight, clientHeight } = adapter.metrics();
        adapter.scrollToPosition(targetRatio * (scrollHeight - clientHeight));
      },
      [adapter, viewportRatio],
    );

    const handlePointerDown = useCallback(
      (e: React.PointerEvent) => {
        // let right-click open the context menu instead of scrolling
        if (e.button !== 0 || !scrollableRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        draggingRef.current = true;
        setDragging(true);
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const map = minimapRef.current;
        const y =
          map == null ? null : e.clientY - map.getBoundingClientRect().top;
        const { top, height: vpHeight } = viewportRef.current;
        if (y != null && y >= top && y <= top + vpHeight) {
          // grabbed the rectangle itself: keep that point under the cursor
          grabOffsetRef.current = y - top;
        } else {
          grabOffsetRef.current = null;
          scrollTo(e.clientY);
        }
      },
      [scrollTo],
    );
    const handlePointerMove = useCallback(
      (e: React.PointerEvent) => {
        if (!draggingRef.current) return;
        const offset = grabOffsetRef.current;
        const map = minimapRef.current;
        if (offset == null || map == null) {
          scrollTo(e.clientY);
          return;
        }
        const y = e.clientY - map.getBoundingClientRect().top;
        scrollToViewportTop(y - offset, layoutHeightRef.current);
      },
      [scrollTo, scrollToViewportTop],
    );
    const handlePointerUp = useCallback(() => {
      draggingRef.current = false;
      grabOffsetRef.current = null;
      setDragging(false);
    }, []);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        const { scrollHeight, clientHeight } = adapter.metrics();
        const delta = scrollDeltaForKey(e.key, clientHeight);
        if (delta == null) return;
        e.preventDefault();
        if (delta === "start") {
          adapter.scrollToPosition(0);
        } else if (delta === "end") {
          adapter.scrollToPosition(Math.max(0, scrollHeight - clientHeight));
        } else {
          adapter.scrollBy(delta);
        }
      },
      [adapter],
    );

    const minimapHeight = height - 16;
    if (minimapHeight <= 0) return null;

    // A document that fits on screen gets an outline of its real size instead
    // of one stretched over the whole rail: the map is a scaled picture of the
    // viewport, so a short file occupies only the top of it.
    const totalBlockPixels = blocks.reduce((s, b) => s + b.pixelHeight, 0);
    const contentFraction = scrollable
      ? 1
      : Math.min(1, totalBlockPixels / Math.max(1, clientHeight));
    const layoutHeight = Math.max(4, minimapHeight * contentFraction);

    layoutHeightRef.current = layoutHeight;
    const segments = computeMinimapLayout(blocks, layoutHeight);
    segmentsRef.current = segments;

    // Viewport rectangle: anchored to the visible block range when known,
    // otherwise fall back to plain scroll ratios.
    const rangeVp = viewportFromSegments(segments, visibleRange);
    let vpTop: number;
    let vpHeight: number;
    if (rangeVp != null) {
      vpTop = rangeVp.top;
      vpHeight = rangeVp.bottom - rangeVp.top;
    } else {
      vpTop = scrollRatio * (1 - viewportRatio) * minimapHeight;
      vpHeight = viewportRatio * minimapHeight;
    }
    if (vpHeight < VIEWPORT_MIN_HEIGHT) {
      vpTop -= (VIEWPORT_MIN_HEIGHT - vpHeight) / 2;
      vpHeight = VIEWPORT_MIN_HEIGHT;
    }
    vpTop = Math.max(0, Math.min(layoutHeight - vpHeight, vpTop));
    viewportRef.current = { top: vpTop, height: vpHeight };

    return (
      <div
        ref={minimapRef}
        data-cocalc-minimap="blocks"
        {...(scrollable
          ? { ...MINIMAP_SCROLLBAR_ARIA, "aria-label": label }
          : { role: "presentation" })}
        aria-valuenow={scrollable ? Math.round(scrollRatio * 100) : undefined}
        style={{
          position: "relative",
          width,
          minWidth: width,
          height: minimapHeight,
          marginTop: 8,
          cursor: !scrollable ? "default" : dragging ? "grabbing" : "grab",
          userSelect: "none",
          ...style,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
        onWheel={(e) => adapter.scrollBy(e.deltaY)}
      >
        {children}
        {segments.map(({ block, top, height: h }) => (
          <div
            key={block.id}
            className={block.blink ? "minimap-cell-running" : undefined}
            style={{
              position: "absolute",
              top,
              left: 4,
              right: 4,
              height: h,
              backgroundColor: block.color,
              opacity: block.opacity ?? 0.8,
              borderRadius: "1px",
            }}
          />
        ))}

        {/* Viewport rectangle: only when there is something to scroll */}
        {scrollable && (
          <div
            style={{
              position: "absolute",
              top: vpTop,
              left: 0,
              right: 0,
              height: vpHeight,
              border: `1.5px solid ${COLORS.GRAY_M}`,
              borderRadius: "2px",
              backgroundColor: "rgba(0,0,0,0.04)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>
    );
  },
);
