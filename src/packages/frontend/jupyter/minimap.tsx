/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
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
5. Clicking the minimap jumps to the corresponding cell (or proportional scroll position).
6. Settings (enabled + width) are persisted in localStorage and synced through custom events.

The minimap is intentionally read-only and lightweight: no cell mounts/unmounts, only one
canvas repaint per data change.
*/

import useResizeObserver from "use-resize-observer";
import { InputNumber, Modal, Slider, Switch } from "antd";
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
import {
  MINIMAP_MAX_WIDTH,
  MINIMAP_MIN_WIDTH,
  MINIMAP_OPEN_SETTINGS_EVENT,
  MINIMAP_SETTINGS_CHANGED_EVENT,
  MinimapSettings,
  clampMinimapWidth,
  readMinimapSettings,
  setMinimapEnabled,
  setMinimapWidth,
} from "./minimap-settings";

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

type MinimapCellKind = "code" | "markdown" | "raw" | "unknown";

type MinimapTheme = {
  cellBackground: string;
  textColor: string;
  keywordColor: string;
  numberColor: string;
  stringColor: string;
  commentColor: string;
};

const MINIMAP_THEME: Record<MinimapCellKind, MinimapTheme> = {
  code: {
    cellBackground: "rgba(226,232,240,0.78)",
    textColor: "rgba(15,23,42,0.92)",
    keywordColor: "rgba(79,70,229,0.96)",
    numberColor: "rgba(37,99,235,0.96)",
    stringColor: "rgba(180,83,9,0.96)",
    commentColor: "rgba(21,128,61,0.96)",
  },
  markdown: {
    cellBackground: "rgba(220,252,231,0.82)",
    textColor: "rgba(17,24,39,0.9)",
    keywordColor: "rgba(5,150,105,0.96)",
    numberColor: "rgba(4,120,87,0.96)",
    stringColor: "rgba(180,83,9,0.96)",
    commentColor: "rgba(21,128,61,0.96)",
  },
  raw: {
    cellBackground: "rgba(243,232,255,0.82)",
    textColor: "rgba(30,27,75,0.92)",
    keywordColor: "rgba(109,40,217,0.96)",
    numberColor: "rgba(124,58,237,0.96)",
    stringColor: "rgba(180,83,9,0.96)",
    commentColor: "rgba(126,34,206,0.9)",
  },
  unknown: {
    cellBackground: "rgba(241,245,249,0.82)",
    textColor: "rgba(30,41,59,0.9)",
    keywordColor: "rgba(71,85,105,0.92)",
    numberColor: "rgba(71,85,105,0.92)",
    stringColor: "rgba(71,85,105,0.92)",
    commentColor: "rgba(71,85,105,0.92)",
  },
};

function getMinimapCellKind(cellType: string | undefined): MinimapCellKind {
  if (cellType === "code" || cellType === "markdown" || cellType === "raw") {
    return cellType;
  }
  return "unknown";
}

function getMinimapPreviewLines(
  input: unknown,
  hasOutput: boolean,
): string[] {
  const raw =
    typeof input === "string" && input.length > 0 ? input : hasOutput ? " " : "";
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
  theme: MinimapTheme,
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
  cellList: immutable.List<string>;
  cells: immutable.Map<string, any>;
  curId?: string;
  cellListDivRef: MutableRefObject<any>;
  cellListWidth?: number;
  cellListHeight?: number;
  lazyHydrationVersion: number;
  lazyHeightsRef: MutableRefObject<Record<string, number>>;
  placeholderMinHeight: number;
  hydrateVisibleCells: () => void;
  saveScrollDebounce: () => void;
}

interface UseNotebookMinimapResult {
  layoutRef: MutableRefObject<any>;
  minimapNode: React.JSX.Element | null;
  settingsModal: React.JSX.Element;
  onNotebookScroll: () => void;
}

let minimapSettingsModalOwner: symbol | null = null;
// Shared listener registry: multiple notebook panes can mount minimaps, but
// we keep exactly one browser listener per minimap event type.
const minimapSettingsChangedCallbacks = new Set<() => void>();
const minimapOpenSettingsCallbacks = new Set<() => void>();
let minimapWindowListenersAttached = false;

function claimMinimapSettingsModal(owner: symbol): boolean {
  if (minimapSettingsModalOwner == null || minimapSettingsModalOwner === owner) {
    minimapSettingsModalOwner = owner;
    return true;
  }
  return false;
}

function releaseMinimapSettingsModal(owner: symbol): void {
  if (minimapSettingsModalOwner === owner) {
    minimapSettingsModalOwner = null;
  }
}

function emitMinimapCallbacks(callbacks: Set<() => void>): void {
  for (const cb of Array.from(callbacks)) {
    try {
      cb();
    } catch {
      // avoid one broken subscriber preventing others from updating
    }
  }
}

function onWindowMinimapSettingsChanged(): void {
  emitMinimapCallbacks(minimapSettingsChangedCallbacks);
}

function onWindowOpenMinimapSettings(): void {
  emitMinimapCallbacks(minimapOpenSettingsCallbacks);
}

function attachMinimapWindowListeners(): void {
  if (minimapWindowListenersAttached) return;
  if (typeof window === "undefined") return;
  window.addEventListener(
    MINIMAP_SETTINGS_CHANGED_EVENT,
    onWindowMinimapSettingsChanged,
  );
  window.addEventListener(MINIMAP_OPEN_SETTINGS_EVENT, onWindowOpenMinimapSettings);
  minimapWindowListenersAttached = true;
}

function detachMinimapWindowListenersIfUnused(): void {
  if (!minimapWindowListenersAttached) return;
  if (
    minimapSettingsChangedCallbacks.size > 0 ||
    minimapOpenSettingsCallbacks.size > 0
  ) {
    return;
  }
  if (typeof window === "undefined") return;
  window.removeEventListener(
    MINIMAP_SETTINGS_CHANGED_EVENT,
    onWindowMinimapSettingsChanged,
  );
  window.removeEventListener(MINIMAP_OPEN_SETTINGS_EVENT, onWindowOpenMinimapSettings);
  minimapWindowListenersAttached = false;
}

function registerMinimapWindowCallbacks({
  onSettingsChanged,
  onOpenSettings,
}: {
  onSettingsChanged: () => void;
  onOpenSettings: () => void;
}): () => void {
  minimapSettingsChangedCallbacks.add(onSettingsChanged);
  minimapOpenSettingsCallbacks.add(onOpenSettings);
  attachMinimapWindowListeners();
  return () => {
    minimapSettingsChangedCallbacks.delete(onSettingsChanged);
    minimapOpenSettingsCallbacks.delete(onOpenSettings);
    detachMinimapWindowListenersIfUnused();
  };
}

export function useNotebookMinimap({
  cellList,
  cells,
  curId,
  cellListDivRef,
  cellListWidth,
  cellListHeight,
  lazyHydrationVersion,
  lazyHeightsRef,
  placeholderMinHeight,
  hydrateVisibleCells,
  saveScrollDebounce,
}: UseNotebookMinimapArgs): UseNotebookMinimapResult {
  const [minimapSettings, setMinimapSettings] = useState<MinimapSettings>(() =>
    readMinimapSettings(),
  );
  const minimapOptIn = minimapSettings.enabled;
  const minimapWidth = minimapSettings.width;
  const [showMinimapSettingsModal, setShowMinimapSettingsModal] =
    useState<boolean>(false);
  const [minimapDraftEnabled, setMinimapDraftEnabled] =
    useState<boolean>(minimapOptIn);
  const [minimapDraftWidth, setMinimapDraftWidth] =
    useState<number>(minimapWidth);
  const minimapModalOwnerRef = useRef<symbol>(Symbol("jupyter-minimap-modal-owner"));

  const closeMinimapSettingsModal = useCallback(() => {
    releaseMinimapSettingsModal(minimapModalOwnerRef.current);
    setShowMinimapSettingsModal(false);
  }, []);

  useEffect(() => {
    const syncSettings = () => setMinimapSettings(readMinimapSettings());
    syncSettings();
    if (typeof window === "undefined") return;
    const onSettingsChanged = () => syncSettings();
    const onOpenSettings = () => {
      if (!claimMinimapSettingsModal(minimapModalOwnerRef.current)) return;
      const current = readMinimapSettings();
      setMinimapDraftEnabled(current.enabled);
      setMinimapDraftWidth(current.width);
      setShowMinimapSettingsModal(true);
    };
    const unregister = registerMinimapWindowCallbacks({
      onSettingsChanged,
      onOpenSettings,
    });
    return () => {
      unregister();
      releaseMinimapSettingsModal(minimapModalOwnerRef.current);
    };
  }, []);

  useEffect(() => {
    if (showMinimapSettingsModal) return;
    setMinimapDraftEnabled(minimapOptIn);
    setMinimapDraftWidth(minimapWidth);
  }, [minimapOptIn, minimapWidth, showMinimapSettingsModal]);

  const applyMinimapSettings = useCallback(() => {
    setMinimapEnabled(minimapDraftEnabled);
    setMinimapWidth(minimapDraftWidth);
    closeMinimapSettingsModal();
  }, [closeMinimapSettingsModal, minimapDraftEnabled, minimapDraftWidth]);

  const layoutRef = useRef<any>(null);
  const layoutResize = useResizeObserver({ ref: layoutRef });

  const minimapViewportRef = useRef<HTMLDivElement>(null);
  const minimapTrackRef = useRef<HTMLDivElement>(null);
  const minimapRailRef = useRef<HTMLDivElement>(null);
  const minimapScrollRef = useRef<HTMLDivElement>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const minimapViewportRafRef = useRef<number | null>(null);

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
    const viewportHeight = cellListHeight ?? 0;
    const layoutWidth =
      layoutResize.width ??
      (cellListWidth ?? 0) + minimapWidth + MINIMAP_HORIZONTAL_CHROME;
    const showMinimap =
      minimapOptIn &&
      viewportHeight >= MINIMAP_MIN_LAYOUT_HEIGHT &&
      layoutWidth >=
        minimapWidth + MINIMAP_MIN_CELL_VIEWPORT_WIDTH + MINIMAP_HORIZONTAL_CHROME;
    if (!showMinimap) return null;

    const scroller = cellListDivRef.current as HTMLElement | null;
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
      const cellType = (cell?.get?.("cell_type") as string | undefined) ?? "code";
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
    const rawTotalHeight =
      measuredScrollHeight > 1
        ? measuredScrollHeight
        : Math.max(1, maxRawBottom + 1);
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
    const railHeight = Math.max(180, viewportHeight - 16);
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
    lazyHydrationVersion,
    minimapWidth,
    minimapOptIn,
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
    const targetWidth = Math.max(1, Math.round(cssWidth * dpr));
    const targetHeight = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext("2d");
    if (ctx == null) return;

    const metrics = getMinimapTextMetrics(cssWidth);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = "rgba(248,250,252,0.96)";
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    ctx.font = `${metrics.fontSize}px Menlo, Monaco, "Courier New", monospace`;
    ctx.textBaseline = "top";
    ctx.imageSmoothingEnabled = false;
    const charWidth = Math.max(1, ctx.measureText("M").width);
    const maxChars = Math.max(
      8,
      Math.floor((cssWidth - metrics.leftPadding - metrics.rightPadding) / charWidth),
    );

    let drawnLines = 0;
    for (const row of minimapData.rows) {
      const theme = MINIMAP_THEME[row.kind];
      ctx.fillStyle = row.isCurrent
        ? "rgba(59,130,246,0.22)"
        : theme.cellBackground;
      ctx.fillRect(0, row.top, cssWidth, row.height);

      if (row.hasOutput) {
        ctx.fillStyle = "rgba(245,158,11,0.8)";
        ctx.fillRect(cssWidth - 2, row.top, 2, row.height);
      }

      if (row.isCurrent) {
        ctx.strokeStyle = "rgba(37,99,235,0.8)";
        ctx.lineWidth = 0.9;
        ctx.strokeRect(0.5, row.top + 0.5, cssWidth - 1, Math.max(1, row.height - 1));
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

  const updateMinimapViewportNow = useCallback(() => {
    if (minimapData == null) return;
    const scroller = cellListDivRef.current as HTMLElement | null;
    const viewport = minimapViewportRef.current;
    const rail = minimapRailRef.current;
    const miniScroll = minimapScrollRef.current;
    const track = minimapTrackRef.current;
    if (
      scroller == null ||
      viewport == null ||
      rail == null ||
      miniScroll == null ||
      track == null
    ) {
      return;
    }

    const notebookContentHeight = Math.max(
      1,
      scroller.scrollHeight || minimapData.notebookContentHeight,
    );
    const maxNotebookScroll = Math.max(1, notebookContentHeight - scroller.clientHeight);
    const clampedNotebookScrollTop = Math.min(
      Math.max(0, scroller.scrollTop),
      maxNotebookScroll,
    );
    const notebookRatio = Math.min(
      1,
      Math.max(0, clampedNotebookScrollTop / maxNotebookScroll),
    );

    const contentHeight = Math.max(
      track.scrollHeight,
      minimapData.totalContentHeight,
      minimapData.railHeight,
    );
    const maxMiniScroll = Math.max(0, contentHeight - minimapData.railHeight);
    const miniScrollTop = notebookRatio * maxMiniScroll;
    miniScroll.scrollTop = miniScrollTop;

    // Compute viewport size in track-space, then project it into the visible rail
    // window. Using rail-height directly underestimates the thumb for long tracks.
    const viewportHeightInTrack = Math.min(
      contentHeight,
      Math.max(
        16,
        (scroller.clientHeight / notebookContentHeight) * contentHeight,
      ),
    );
    const viewportTravelInTrack = Math.max(0, contentHeight - viewportHeightInTrack);
    const viewportTopInTrack = notebookRatio * viewportTravelInTrack;

    const thumbHeight = Math.min(minimapData.railHeight, viewportHeightInTrack);
    const thumbTopInRail = Math.min(
      Math.max(0, viewportTopInTrack - miniScrollTop),
      Math.max(0, minimapData.railHeight - thumbHeight),
    );
    viewport.style.top = `${thumbTopInRail}px`;
    viewport.style.height = `${thumbHeight}px`;

    rail.setAttribute(
      "data-cocalc-jupyter-minimap-notebook-content-height",
      String(notebookContentHeight),
    );
    rail.setAttribute(
      "data-cocalc-jupyter-minimap-content-height",
      String(contentHeight),
    );
    rail.setAttribute(
      "data-cocalc-jupyter-minimap-notebook-client-height",
      String(scroller.clientHeight),
    );
    rail.setAttribute(
      "data-cocalc-jupyter-minimap-scroll-top",
      String(clampedNotebookScrollTop),
    );
    rail.setAttribute(
      "data-cocalc-jupyter-minimap-scroll-ratio",
      String(notebookRatio),
    );
    rail.setAttribute(
      "data-cocalc-jupyter-minimap-mini-scroll-top",
      String(miniScrollTop),
    );
    rail.setAttribute(
      "data-cocalc-jupyter-minimap-thumb-top",
      String(thumbTopInRail),
    );
    rail.setAttribute(
      "data-cocalc-jupyter-minimap-thumb-height",
      String(thumbHeight),
    );
  }, [cellListDivRef, minimapData]);

  const updateMinimapViewportNowRef = useRef(updateMinimapViewportNow);
  useEffect(() => {
    updateMinimapViewportNowRef.current = updateMinimapViewportNow;
  }, [updateMinimapViewportNow]);

  const updateMinimapViewport = useCallback(() => {
    if (typeof window === "undefined") {
      updateMinimapViewportNow();
      return;
    }
    if (minimapViewportRafRef.current != null) return;
    minimapViewportRafRef.current = window.requestAnimationFrame(() => {
      minimapViewportRafRef.current = null;
      updateMinimapViewportNowRef.current();
    });
  }, [updateMinimapViewportNow]);

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
  }, [updateMinimapViewport, cellListHeight, cellListWidth]);

  const scrollToCellById = useCallback(
    (id: string) => {
      const scroller = cellListDivRef.current as HTMLElement | null;
      if (scroller == null) return;
      const escapedId = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const node = scroller.querySelector<HTMLElement>(
        `[data-jupyter-lazy-cell-id="${escapedId}"]`,
      );
      if (node == null) return;
      scroller.scrollTop = Math.max(0, node.offsetTop - 24);
      hydrateVisibleCells();
      updateMinimapViewport();
      saveScrollDebounce();
    },
    [cellListDivRef, hydrateVisibleCells, saveScrollDebounce, updateMinimapViewport],
  );

  const onMinimapTrackMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const scroller = cellListDivRef.current as HTMLElement | null;
      const miniScroll = minimapScrollRef.current;
      if (scroller == null || minimapData == null || miniScroll == null) return;
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      if (rect.height <= 0) return;
      const y = Math.min(Math.max(0, e.clientY - rect.top), rect.height);
      const notebookContentHeight = Math.max(
        1,
        scroller.scrollHeight || minimapData.notebookContentHeight,
      );
      const maxNotebookScroll = Math.max(
        1,
        notebookContentHeight - scroller.clientHeight,
      );
      const miniScrollTop = miniScroll.scrollTop;
      const yContent = Math.min(
        minimapData.totalContentHeight,
        Math.max(0, miniScrollTop + y),
      );
      const row = minimapData.rows.find(
        (r) => yContent >= r.top && yContent <= r.top + r.height,
      );
      if (row != null) {
        scrollToCellById(row.id);
      } else {
        const targetRatio = yContent / Math.max(1, minimapData.totalContentHeight);
        scroller.scrollTop = targetRatio * maxNotebookScroll;
        hydrateVisibleCells();
        updateMinimapViewport();
        saveScrollDebounce();
      }
      e.preventDefault();
    },
    [
      cellListDivRef,
      hydrateVisibleCells,
      minimapData,
      saveScrollDebounce,
      scrollToCellById,
      updateMinimapViewport,
    ],
  );

  const minimapNode = minimapData == null ? null : (
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
        onMouseDown={onMinimapTrackMouseDown}
        style={{
          position: "relative",
          width: "100%",
          height: `${minimapData.railHeight}px`,
          borderRadius: "4px",
          background: "rgba(255,255,255,0.92)",
          border: "1px solid rgba(148,163,184,0.68)",
          cursor: "pointer",
          overflow: "hidden",
        }}
      >
        <div
          ref={minimapScrollRef}
          data-cocalc-jupyter-minimap-scroll="1"
          style={{
            position: "absolute",
            inset: 0,
            overflowY: "auto",
            overflowX: "hidden",
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
            left: 0,
            right: 0,
            top: 0,
            height: "10px",
            border: "1px solid rgba(37,99,235,0.75)",
            background: "rgba(59,130,246,0.12)",
            borderRadius: "3px",
            pointerEvents: "none",
          }}
        />
      </div>
    </div>
  );

  const settingsModal = (
    <Modal
      title="Notebook Minimap"
      open={showMinimapSettingsModal}
      okText="Apply"
      onOk={applyMinimapSettings}
      onCancel={closeMinimapSettingsModal}
    >
      <div style={{ display: "grid", rowGap: "14px" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>Show minimap</span>
          <Switch
            checked={minimapDraftEnabled}
            onChange={(checked) => setMinimapDraftEnabled(checked)}
          />
        </div>
        <div style={{ display: "grid", rowGap: "8px" }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Minimap width</span>
            <InputNumber
              min={MINIMAP_MIN_WIDTH}
              max={MINIMAP_MAX_WIDTH}
              value={minimapDraftWidth}
              onChange={(value) => {
                if (typeof value !== "number" || !Number.isFinite(value)) return;
                setMinimapDraftWidth(clampMinimapWidth(value));
              }}
            />
          </div>
          <Slider
            min={MINIMAP_MIN_WIDTH}
            max={MINIMAP_MAX_WIDTH}
            value={minimapDraftWidth}
            onChange={(value) =>
              setMinimapDraftWidth(clampMinimapWidth(Number(value)))
            }
          />
        </div>
      </div>
    </Modal>
  );

  return {
    layoutRef,
    minimapNode,
    settingsModal,
    onNotebookScroll: updateMinimapViewport,
  };
}
