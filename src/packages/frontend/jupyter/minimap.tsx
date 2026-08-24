/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The notebook "text" minimap: a tiny rendering of the actual notebook content.

Design / algorithm overview:

1. Build a compact "row model" from notebook cells. Each row tracks cell id, type,
   estimated height, and short input preview lines.
2. Scale row heights into a bounded minimap track height so very large notebooks stay
   responsive while preserving relative cell size.
3. Draw the row model onto one canvas:
   - background tint by cell type,
   - tiny syntax-highlighted text preview for input lines,
   - markers for current cell and output-heavy cells.
4. Keep a separate viewport overlay synced to notebook scroll position.
5. Clicking the minimap jumps to the corresponding cell; dragging the viewport
   rectangle scrolls continuously and the wheel scrolls the notebook itself.
6. Settings (enabled + width + kind) are persisted in localStorage and synced through
   custom events.

The canvas is taller than the rail for long notebooks, so it scrolls inside the rail;
that inner scroller is `overflow: hidden` and only ever moved programmatically, so the
minimap never grows a scrollbar of its own.  Geometry and pointer handling are shared
with the CodeMirror minimap (components/minimap/text-rail).

The minimap is intentionally read-only and lightweight: no cell mounts/unmounts, only one
canvas repaint per data change.
*/

import useResizeObserver from "use-resize-observer";
import * as immutable from "immutable";
import {
  MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { React } from "@cocalc/frontend/app-framework";
import type { MinimapCellTheme } from "@cocalc/frontend/components/minimap/colors";
import { MinimapControls } from "@cocalc/frontend/components/minimap/controls";
import { canvasBackingStoreSize } from "@cocalc/frontend/components/canvas-backing-store";
import {
  MINIMAP_CELL_THEME,
  MINIMAP_COLORS,
  type MinimapCellKind,
} from "@cocalc/frontend/components/minimap/colors";
import {
  MinimapContextMenu,
  useMinimapSettingsModal,
} from "@cocalc/frontend/components/minimap/settings-ui";
import {
  MINIMAP_HIDE_SCROLLBAR_CLASS,
  MINIMAP_SCROLLBAR_ARIA,
  computeTextMinimapGeometry,
  useTextMinimapRail,
  type TextMinimapGeometry,
} from "@cocalc/frontend/components/minimap/text-rail";
import { useMinimapSettings } from "@cocalc/frontend/components/minimap/settings";
import type {
  MinimapKind,
  MinimapSettingsApi,
} from "@cocalc/frontend/components/minimap/settings";
import { NOTEBOOK_MINIMAP_LABELS } from "./minimap-settings";

const MINIMAP_BASE_SCALE = 0.11;
const MINIMAP_MIN_SCALE = 0.02;
const MINIMAP_MAX_SCALE = 0.36;
const MINIMAP_MAX_TRACK_HEIGHT = 32_000;
const MINIMAP_MIN_TRACK_VIEWPORT_MULTIPLIER = 1.2;
const MINIMAP_MIN_LAYOUT_HEIGHT = 140;
const MINIMAP_MIN_CELL_VIEWPORT_WIDTH = 220;
const MINIMAP_HORIZONTAL_CHROME = 14;
const MINIMAP_TEXT_LEFT_PADDING_NARROW = 3;
const MINIMAP_TEXT_RIGHT_PADDING_NARROW = 4;
const MINIMAP_MAX_PREVIEW_LINES_PER_CELL = 180;
const MINIMAP_MAX_DRAWN_LINES = 12_000;

const MINIMAP_CODE_TOKEN_RE =
  /(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\b)/g;

function getMinimapCellKind(cellType: string | undefined): MinimapCellKind {
  if (cellType === "code" || cellType === "markdown" || cellType === "raw") {
    return cellType;
  }
  return "unknown";
}

function getMinimapPreviewLines(input: unknown, hasOutput: boolean): string[] {
  const raw =
    typeof input === "string" && input.length > 0
      ? input
      : hasOutput
        ? " "
        : "";
  const lines = raw
    .replace(/\t/g, "  ")
    .split("\n")
    .slice(0, MINIMAP_MAX_PREVIEW_LINES_PER_CELL);
  if (lines.length === 0) lines.push("");
  return lines;
}

function getMinimapTextMetrics(width: number): {
  fontSize: number;
  lineHeight: number;
  leftPadding: number;
  rightPadding: number;
} {
  if (width >= 190) {
    return { fontSize: 8.2, lineHeight: 9.2, leftPadding: 5, rightPadding: 5 };
  }
  if (width >= 160) {
    return { fontSize: 7.2, lineHeight: 8.2, leftPadding: 5, rightPadding: 5 };
  }
  if (width >= 132) {
    return { fontSize: 6.2, lineHeight: 7.2, leftPadding: 5, rightPadding: 5 };
  }
  if (width >= 108) {
    return { fontSize: 5.2, lineHeight: 6.2, leftPadding: 4, rightPadding: 4 };
  }
  if (width >= 84) {
    return { fontSize: 4.4, lineHeight: 5.4, leftPadding: 4, rightPadding: 4 };
  }
  return {
    fontSize: 3.9,
    lineHeight: 4.8,
    leftPadding: MINIMAP_TEXT_LEFT_PADDING_NARROW,
    rightPadding: MINIMAP_TEXT_RIGHT_PADDING_NARROW,
  };
}

function drawMinimapTextLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  charWidth: number,
  maxChars: number,
  theme: MinimapCellTheme,
): void {
  const line = text.slice(0, maxChars);
  if (line.length === 0) return;
  ctx.fillStyle = theme.textColor;
  ctx.fillText(line, x, y);

  MINIMAP_CODE_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null = MINIMAP_CODE_TOKEN_RE.exec(line);
  while (match != null) {
    const token = match[0];
    let color = "";
    if (match[1]) color = theme.commentColor;
    else if (match[2]) color = theme.stringColor;
    else if (match[3]) color = theme.numberColor;
    else if (match[4]) color = theme.keywordColor;
    if (color.length > 0) {
      const index = match.index ?? 0;
      ctx.fillStyle = color;
      ctx.fillText(token, x + index * charWidth, y);
    }
    match = MINIMAP_CODE_TOKEN_RE.exec(line);
  }
}

interface MinimapRow {
  id: string;
  top: number;
  height: number;
  isCurrent: boolean;
  hasOutput: boolean;
  kind: MinimapCellKind;
  previewLines: string[];
}

interface MinimapData {
  railHeight: number;
  totalContentHeight: number;
  notebookContentHeight: number;
  rows: MinimapRow[];
}

interface UseNotebookMinimapArgs {
  // preferences of the notebook view this minimap belongs to
  settingsApi: MinimapSettingsApi;
  cellList: immutable.List<string>;
  cells: immutable.Map<string, any>;
  curId?: string;
  cellListDivRef: MutableRefObject<any>;
  cellListWidth?: number;
  cellListHeight?: number;
  lazyLayoutVersion: number;
  lazyHeightsRef: MutableRefObject<Record<string, number>>;
  placeholderMinHeight: number;
  hydrateVisibleCells: () => void;
  saveScrollDebounce: () => void;
}

interface UseNotebookMinimapResult {
  enabled: boolean;
  // opens this pane's settings dialog, rather than whichever pane happens to
  // claim the shared "open settings" window event first
  openSettings: () => void;
  kind: MinimapKind;
  // width of the currently selected kind
  width: number;
  layoutRef: MutableRefObject<any>;
  minimapNode: React.JSX.Element | null;
  settingsModal: React.JSX.Element;
  onNotebookScroll: () => void;
}

function isScrollableElement(el: HTMLElement | null | undefined): boolean {
  if (el == null) return false;
  const style = window.getComputedStyle(el);
  if (!["auto", "scroll", "overlay"].includes(style.overflowY)) return false;
  return el.scrollHeight - el.clientHeight > 1;
}

function resolveNotebookScroller(base: HTMLElement | null): HTMLElement | null {
  if (base == null) return null;
  if (isScrollableElement(base)) return base;
  let best: HTMLElement | null = null;
  let bestScrollable = 0;
  for (const el of Array.from(base.querySelectorAll<HTMLElement>("*"))) {
    if (!isScrollableElement(el)) continue;
    const scrollable = el.scrollHeight - el.clientHeight;
    if (scrollable > bestScrollable) {
      best = el;
      bestScrollable = scrollable;
    }
  }
  return best ?? base;
}

export function useNotebookMinimap({
  settingsApi,
  cellList,
  cells,
  curId,
  cellListDivRef,
  cellListWidth,
  cellListHeight,
  lazyLayoutVersion,
  lazyHeightsRef,
  placeholderMinHeight,
  hydrateVisibleCells,
  saveScrollDebounce,
}: UseNotebookMinimapArgs): UseNotebookMinimapResult {
  const settings = useMinimapSettings(settingsApi);
  const minimapOptIn = settings.enabled;
  const minimapWidth = settings.width;
  const minimapKind = settings.kind;
  const { modal: settingsModal, open: openSettingsModal } =
    useMinimapSettingsModal({
      api: settingsApi,
      labels: NOTEBOOK_MINIMAP_LABELS,
    });

  const layoutRef = useRef<any>(null);
  const layoutResize = useResizeObserver({ ref: layoutRef });

  const minimapViewportRef = useRef<HTMLDivElement>(null);
  const minimapTrackRef = useRef<HTMLDivElement>(null);
  const minimapRailRef = useRef<HTMLDivElement | null>(null);
  const minimapScrollRef = useRef<HTMLDivElement>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const minimapViewportRafRef = useRef<number | null>(null);
  // false while the whole notebook fits on screen: then the map is just an
  // outline, with no viewport rectangle to drag
  const [scrollable, setScrollable] = useState<boolean>(true);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute(
      "data-cocalc-jupyter-minimap",
      minimapOptIn ? "1" : "0",
    );
    document.documentElement.setAttribute(
      "data-cocalc-jupyter-minimap-width",
      String(minimapWidth),
    );
  }, [minimapOptIn, minimapWidth]);

  const minimapData = useMemo<MinimapData | null>(() => {
    const layoutNode = layoutRef.current;
    const layoutHeight = layoutResize.height ?? layoutNode?.clientHeight ?? 0;
    const viewportHeightRaw = cellListHeight ?? 0;
    const viewportHeight =
      layoutHeight > 0
        ? viewportHeightRaw > 0
          ? Math.min(viewportHeightRaw, layoutHeight)
          : layoutHeight
        : viewportHeightRaw;
    const measuredLayoutWidth =
      layoutResize.width ?? layoutNode?.clientWidth ?? 0;
    const layoutWidth =
      measuredLayoutWidth > 0
        ? measuredLayoutWidth
        : (cellListWidth ?? 0) + minimapWidth + MINIMAP_HORIZONTAL_CHROME;
    const showMinimap =
      minimapOptIn &&
      minimapKind === "text" &&
      viewportHeight >= MINIMAP_MIN_LAYOUT_HEIGHT &&
      layoutWidth >=
        minimapWidth +
          MINIMAP_MIN_CELL_VIEWPORT_WIDTH +
          MINIMAP_HORIZONTAL_CHROME;
    if (!showMinimap) return null;

    const scroller = resolveNotebookScroller(
      cellListDivRef.current as HTMLElement | null,
    );
    const geometryById = new Map<string, { top: number; height: number }>();
    if (scroller != null) {
      const scrollerRect = scroller.getBoundingClientRect();
      const scrollerScrollTop = scroller.scrollTop;
      for (const node of Array.from(
        scroller.querySelectorAll<HTMLElement>("[data-jupyter-lazy-cell-id]"),
      )) {
        const id = node.getAttribute("data-jupyter-lazy-cell-id");
        if (id == null) continue;
        const rect = node.getBoundingClientRect();
        const top = rect.top - scrollerRect.top + scrollerScrollTop;
        const height = rect.height;
        if (!Number.isFinite(top) || !Number.isFinite(height)) continue;
        geometryById.set(id, {
          top: Math.max(0, top),
          height: Math.max(1, height),
        });
      }
    }

    const rows: MinimapRow[] = [];
    const rawRows: Array<{
      id: string;
      rawTop: number;
      rawHeight: number;
      isCurrent: boolean;
      hasOutput: boolean;
      kind: MinimapCellKind;
      previewLines: string[];
    }> = [];

    let fallbackTop = 0;
    for (let i = 0; i < cellList.size; i += 1) {
      const id = cellList.get(i);
      if (id == null) continue;
      const cell = cells.get(id);
      const cellType =
        (cell?.get?.("cell_type") as string | undefined) ?? "code";
      const kind = getMinimapCellKind(cellType);
      const input = cell?.get?.("input");
      const output = cell?.get?.("output");
      const outputWeight =
        typeof output === "string"
          ? output.length
          : output?.size != null
            ? output.size * 24
            : 0;
      const hasOutput = outputWeight > 0;
      const fallbackHeight = Math.max(
        24,
        lazyHeightsRef.current[id] ?? placeholderMinHeight,
      );
      const geometry = geometryById.get(id);
      const rawTop = geometry?.top ?? fallbackTop;
      const rawHeight = Math.max(geometry?.height ?? fallbackHeight, 1);
      rawRows.push({
        id,
        rawTop,
        rawHeight,
        isCurrent: id === curId,
        hasOutput,
        kind,
        previewLines: getMinimapPreviewLines(input, hasOutput),
      });
      fallbackTop = rawTop + rawHeight + 10;
    }

    for (let i = 0; i < rawRows.length; i += 1) {
      const curr = rawRows[i];
      const next = rawRows[i + 1];
      if (next == null) continue;
      const span = next.rawTop - curr.rawTop;
      if (span > curr.rawHeight) curr.rawHeight = span;
    }

    const maxRawBottom =
      rawRows.length === 0
        ? 1
        : Math.max(
            ...rawRows.map((row) => Math.max(1, row.rawTop + row.rawHeight)),
          );
    // Use the actual scroll container height as the authoritative notebook
    // content height. Lazy placeholders can temporarily overestimate raw row
    // bottoms; clamping to scrollHeight keeps viewport math stable.
    const measuredScrollHeight = Math.max(1, scroller?.scrollHeight ?? 0);
    // Be defensive: some containers can report an undersized non-zero
    // scrollHeight while row geometry/fallback estimates are much larger.
    // Taking the max prevents minimap collapse/no-scroll regressions.
    const rawTotalHeight = Math.max(1, measuredScrollHeight, maxRawBottom + 1);
    let scale = MINIMAP_BASE_SCALE;
    const minScaleForViewport =
      (viewportHeight * MINIMAP_MIN_TRACK_VIEWPORT_MULTIPLIER) / rawTotalHeight;
    const maxScaleForTrack = MINIMAP_MAX_TRACK_HEIGHT / rawTotalHeight;
    scale = Math.max(scale, minScaleForViewport);
    scale = Math.min(scale, maxScaleForTrack);
    const minScaleBound = Math.min(MINIMAP_MIN_SCALE, maxScaleForTrack);
    scale = Math.max(minScaleBound, Math.min(MINIMAP_MAX_SCALE, scale));

    for (const row of rawRows) {
      const topRaw = Math.min(
        Math.max(0, row.rawTop),
        Math.max(0, rawTotalHeight - 1),
      );
      const bottomRaw = Math.min(
        rawTotalHeight,
        Math.max(topRaw + 1, row.rawTop + row.rawHeight),
      );
      const clampedHeight = Math.max(1, bottomRaw - topRaw);
      const top = topRaw * scale;
      const h = Math.max(7, clampedHeight * scale);
      rows.push({
        id: row.id,
        top,
        height: h,
        isCurrent: row.isCurrent,
        hasOutput: row.hasOutput,
        kind: row.kind,
        previewLines: row.previewLines,
      });
    }
    const scaledTotalContentHeight = rawTotalHeight * scale;
    const totalContentHeight = Math.max(
      1,
      Math.min(MINIMAP_MAX_TRACK_HEIGHT, scaledTotalContentHeight + 1),
    );
    // never taller than the frame: a floor here would hang off the bottom
    const railHeight = Math.max(24, viewportHeight - 16);
    const notebookContentHeight = rawTotalHeight;
    return { railHeight, totalContentHeight, notebookContentHeight, rows };
  }, [
    cellList,
    cellListHeight,
    cellListWidth,
    cellListDivRef,
    layoutResize.width,
    cells,
    curId,
    lazyHeightsRef,
    lazyLayoutVersion,
    minimapWidth,
    minimapOptIn,
    minimapKind,
    placeholderMinHeight,
  ]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute(
      "data-cocalc-jupyter-minimap-visible",
      minimapData == null ? "0" : "1",
    );
    document.documentElement.setAttribute(
      "data-cocalc-jupyter-minimap-cell-count",
      String(cellList.size),
    );
  }, [minimapData, cellList.size]);

  useEffect(() => {
    if (minimapData == null) return;
    const canvas = minimapCanvasRef.current;
    const track = minimapTrackRef.current;
    if (canvas == null || track == null) return;

    const cssWidth = Math.max(1, track.clientWidth);
    const cssHeight = Math.max(1, minimapData.totalContentHeight);
    const dpr =
      typeof window === "undefined"
        ? 1
        : Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const backingStore = canvasBackingStoreSize({
      cssWidth,
      cssHeight,
      devicePixelRatio: dpr,
    });
    if (canvas.width !== backingStore.width) canvas.width = backingStore.width;
    if (canvas.height !== backingStore.height)
      canvas.height = backingStore.height;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext("2d");
    if (ctx == null) return;

    const metrics = getMinimapTextMetrics(cssWidth);
    ctx.setTransform(backingStore.scaleX, 0, 0, backingStore.scaleY, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = MINIMAP_COLORS.canvasBackground;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    ctx.font = `${metrics.fontSize}px Menlo, Monaco, "Courier New", monospace`;
    ctx.textBaseline = "top";
    ctx.imageSmoothingEnabled = false;
    const charWidth = Math.max(1, ctx.measureText("M").width);
    const maxChars = Math.max(
      8,
      Math.floor(
        (cssWidth - metrics.leftPadding - metrics.rightPadding) / charWidth,
      ),
    );

    let drawnLines = 0;
    for (const row of minimapData.rows) {
      const theme = MINIMAP_CELL_THEME[row.kind];
      ctx.fillStyle = row.isCurrent
        ? MINIMAP_COLORS.canvasCurrentRow
        : theme.cellBackground;
      ctx.fillRect(0, row.top, cssWidth, row.height);

      if (row.hasOutput) {
        ctx.fillStyle = MINIMAP_COLORS.canvasOutputMarker;
        ctx.fillRect(cssWidth - 2, row.top, 2, row.height);
      }

      if (row.isCurrent) {
        ctx.strokeStyle = MINIMAP_COLORS.canvasCurrentRowStroke;
        ctx.lineWidth = 0.9;
        ctx.strokeRect(
          0.5,
          row.top + 0.5,
          cssWidth - 1,
          Math.max(1, row.height - 1),
        );
      }

      const visibleLineCount = Math.min(
        row.previewLines.length,
        Math.max(1, Math.floor((row.height - 2) / metrics.lineHeight)),
      );
      let lineY = row.top + 1;
      for (let i = 0; i < visibleLineCount; i += 1) {
        drawMinimapTextLine(
          ctx,
          row.previewLines[i],
          metrics.leftPadding,
          lineY,
          charWidth,
          maxChars,
          theme,
        );
        drawnLines += 1;
        if (drawnLines >= MINIMAP_MAX_DRAWN_LINES) {
          return;
        }
        lineY += metrics.lineHeight;
      }
    }
  }, [minimapData]);

  const getGeometry = useCallback((): TextMinimapGeometry | null => {
    if (minimapData == null) return null;
    const scroller = resolveNotebookScroller(
      cellListDivRef.current as HTMLElement | null,
    );
    const rail = minimapRailRef.current;
    const track = minimapTrackRef.current;
    if (scroller == null || rail == null || track == null) return null;
    return computeTextMinimapGeometry({
      trackHeight: Math.max(
        track.scrollHeight,
        minimapData.totalContentHeight,
        minimapData.railHeight,
      ),
      railHeight: Math.max(1, rail.clientHeight || minimapData.railHeight),
      docContentHeight: Math.max(
        1,
        scroller.scrollHeight,
        minimapData.notebookContentHeight,
      ),
      docClientHeight: scroller.clientHeight,
      docScrollTop: scroller.scrollTop,
    });
  }, [cellListDivRef, minimapData]);

  const updateMinimapViewportNow = useCallback(() => {
    const geo = getGeometry();
    const viewport = minimapViewportRef.current;
    const rail = minimapRailRef.current;
    const miniScroll = minimapScrollRef.current;
    if (geo == null || viewport == null || rail == null || miniScroll == null) {
      return;
    }

    // The track scrolls in lockstep with the notebook; nothing else ever
    // moves it, so there is no user scroll to fight with here.
    if (Math.abs(miniScroll.scrollTop - geo.miniScrollTop) > 0.5) {
      miniScroll.scrollTop = geo.miniScrollTop;
    }

    setScrollable(geo.scrollable);
    viewport.style.top = `${geo.thumbTop}px`;
    viewport.style.height = `${geo.thumbHeight}px`;
    rail.setAttribute("aria-valuenow", String(Math.round(geo.ratio * 100)));

    rail.setAttribute(
      "data-cocalc-jupyter-minimap-content-height",
      String(geo.trackHeight),
    );
    rail.setAttribute(
      "data-cocalc-jupyter-minimap-scroll-ratio",
      String(geo.ratio),
    );
    rail.setAttribute(
      "data-cocalc-jupyter-minimap-mini-scroll-top",
      String(geo.miniScrollTop),
    );
    rail.setAttribute(
      "data-cocalc-jupyter-minimap-thumb-top",
      String(geo.thumbTop),
    );
    rail.setAttribute(
      "data-cocalc-jupyter-minimap-thumb-height",
      String(geo.thumbHeight),
    );
  }, [getGeometry]);

  const updateMinimapViewportNowRef = useRef(updateMinimapViewportNow);
  useEffect(() => {
    updateMinimapViewportNowRef.current = updateMinimapViewportNow;
  }, [updateMinimapViewportNow]);

  const updateMinimapViewport = useCallback(() => {
    if (typeof window === "undefined") {
      updateMinimapViewportNowRef.current();
      return;
    }
    if (minimapViewportRafRef.current != null) return;
    minimapViewportRafRef.current = window.requestAnimationFrame(() => {
      minimapViewportRafRef.current = null;
      updateMinimapViewportNowRef.current();
    });
  }, []);

  useEffect(() => {
    return () => {
      const rafId = minimapViewportRafRef.current;
      if (rafId == null || typeof window === "undefined") return;
      minimapViewportRafRef.current = null;
      window.cancelAnimationFrame(rafId);
    };
  }, []);

  useEffect(() => {
    updateMinimapViewport();
  }, [updateMinimapViewport, minimapData, cellListHeight, cellListWidth]);

  const scrollNotebookTo = useCallback(
    (top: number) => {
      const scroller = resolveNotebookScroller(
        cellListDivRef.current as HTMLElement | null,
      );
      if (scroller == null) return;
      scroller.scrollTop = top;
      hydrateVisibleCells();
      updateMinimapViewport();
      saveScrollDebounce();
    },
    [
      cellListDivRef,
      hydrateVisibleCells,
      saveScrollDebounce,
      updateMinimapViewport,
    ],
  );

  const scrollNotebookBy = useCallback(
    (delta: number) => {
      const scroller = resolveNotebookScroller(
        cellListDivRef.current as HTMLElement | null,
      );
      if (scroller == null) return;
      scrollNotebookTo(scroller.scrollTop + delta);
    },
    [cellListDivRef, scrollNotebookTo],
  );

  const scrollToCellById = useCallback(
    (id: string): boolean => {
      const scroller = resolveNotebookScroller(
        cellListDivRef.current as HTMLElement | null,
      );
      if (scroller == null) return false;
      const escapedId = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const node = scroller.querySelector<HTMLElement>(
        `[data-jupyter-lazy-cell-id="${escapedId}"]`,
      );
      if (node == null) return false;
      const scrollerRect = scroller.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const nodeTop = nodeRect.top - scrollerRect.top + scroller.scrollTop;
      scrollNotebookTo(Math.max(0, nodeTop - 24));
      return true;
    },
    [cellListDivRef, scrollNotebookTo],
  );

  // A plain click on the map jumps to the cell under the pointer; dragging
  // from there falls back to smooth proportional scrolling.
  const onTrackClick = useCallback(
    (yInTrack: number): boolean => {
      if (minimapData == null) return false;
      const row = minimapData.rows.find(
        (r) => yInTrack >= r.top && yInTrack <= r.top + r.height,
      );
      return row != null ? scrollToCellById(row.id) : false;
    },
    [minimapData, scrollToCellById],
  );

  const rail = useTextMinimapRail({
    railRef: minimapRailRef,
    getGeometry,
    scrollDocTo: scrollNotebookTo,
    scrollDocBy: scrollNotebookBy,
    onTrackClick,
    // The rail only exists once there is minimap data to draw.
    attachKey: minimapData,
  });

  const minimapNode =
    minimapData == null || minimapKind !== "text" ? null : (
      <MinimapContextMenu
        api={settingsApi}
        labels={NOTEBOOK_MINIMAP_LABELS}
        onOpenSettings={openSettingsModal}
        style={{ alignItems: "center" }}
      >
        <div
          data-cocalc-jupyter-minimap-wrapper="1"
          style={{
            width: `${minimapWidth}px`,
            flex: `0 0 ${minimapWidth}px`,
            marginLeft: "8px",
            marginRight: "6px",
            display: "flex",
            height: "100%",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            ref={minimapRailRef}
            data-cocalc-jupyter-minimap-rail="1"
            {...MINIMAP_SCROLLBAR_ARIA}
            aria-label="Notebook minimap scrollbar"
            onKeyDown={rail.onKeyDown}
            onPointerDown={rail.onPointerDown}
            onPointerMove={rail.onPointerMove}
            onPointerUp={rail.onPointerUp}
            onPointerCancel={rail.onPointerUp}
            style={{
              position: "relative",
              width: "100%",
              height: `${minimapData.railHeight}px`,
              borderRadius: "4px",
              background: MINIMAP_COLORS.railBackground,
              border: `1px solid ${MINIMAP_COLORS.railBorder}`,
              cursor: !scrollable
                ? "default"
                : rail.dragging
                  ? "grabbing"
                  : "grab",
              overflow: "hidden",
              touchAction: "none",
            }}
          >
            <MinimapControls
              api={settingsApi}
              labels={NOTEBOOK_MINIMAP_LABELS}
              onOpenSettings={openSettingsModal}
            />
            <div
              ref={minimapScrollRef}
              data-cocalc-jupyter-minimap-scroll="1"
              className={MINIMAP_HIDE_SCROLLBAR_CLASS}
              style={{
                position: "absolute",
                inset: 0,
                // Scrolled programmatically only: `hidden` keeps scrollTop
                // working while removing the second scrollbar.
                overflow: "hidden",
              }}
            >
              <div
                ref={minimapTrackRef}
                data-cocalc-jupyter-minimap-track="1"
                style={{
                  position: "relative",
                  height: `${minimapData.totalContentHeight}px`,
                }}
              >
                <canvas
                  ref={minimapCanvasRef}
                  style={{
                    display: "block",
                    width: "100%",
                    height: `${minimapData.totalContentHeight}px`,
                  }}
                />
              </div>
            </div>
            <div
              ref={minimapViewportRef}
              data-cocalc-jupyter-minimap-viewport="1"
              style={{
                position: "absolute",
                display: scrollable ? "block" : "none",
                left: 0,
                right: 0,
                top: 0,
                height: "10px",
                border: `1px solid ${MINIMAP_COLORS.viewportBorder}`,
                background: MINIMAP_COLORS.viewportFill,
                borderRadius: "3px",
                pointerEvents: "none",
              }}
            />
          </div>
        </div>
      </MinimapContextMenu>
    );

  return {
    enabled: minimapOptIn,
    openSettings: openSettingsModal,
    kind: minimapKind,
    width: minimapWidth,
    layoutRef,
    minimapNode,
    settingsModal,
    onNotebookScroll: updateMinimapViewport,
  };
}
