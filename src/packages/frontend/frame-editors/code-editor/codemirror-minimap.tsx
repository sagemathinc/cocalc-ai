/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Minimap for CodeMirror text editors.

Two renderings, switched from the minimap's right-click menu and persisted in
localStorage:

  - "text": a tiny syntax-tinted rendering of the document on a canvas, like
    the one in VS Code.  For long files the canvas is taller than the rail, so
    it scrolls inside it — programmatically only, so the minimap never grows a
    scrollbar of its own.
  - "blocks": one bar per paragraph (a run of non-blank lines), the text-editor
    analogue of the notebook minimap's one-bar-per-cell view.  The bar holding
    the cursor is highlighted; there is no execution state to show here, so
    everything else is neutral.

Geometry, dragging and wheel handling are shared with the notebook minimap; see
components/minimap/.
*/

import * as CodeMirror from "codemirror";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { throttle } from "lodash";

import { canvasBackingStoreSize } from "@cocalc/frontend/components/canvas-backing-store";
import {
  MINIMAP_COLORS,
  MINIMAP_SYNTAX,
} from "@cocalc/frontend/components/minimap/colors";
import { MinimapControls } from "@cocalc/frontend/components/minimap/controls";
import {
  BlockMinimap,
  type MinimapBlock,
  type MinimapDocAdapter,
} from "@cocalc/frontend/components/minimap/block-minimap";
import { useMinimapSettings } from "@cocalc/frontend/components/minimap/settings";
import {
  MinimapContextMenu,
  useMinimapSettingsModal,
} from "@cocalc/frontend/components/minimap/settings-ui";
import {
  MINIMAP_HIDE_SCROLLBAR_CLASS,
  MINIMAP_NO_VSCROLLBAR_CLASS,
  MINIMAP_SCROLLBAR_ARIA,
  computeTextMinimapGeometry,
  useTextMinimapRail,
  type TextMinimapGeometry,
} from "@cocalc/frontend/components/minimap/text-rail";
import {
  computeTextBlocks,
  findTextBlockIndex,
  nearestTextBlockIndex,
  type TextBlock,
} from "@cocalc/frontend/components/minimap/text-blocks";
import {
  CODEMIRROR_MINIMAP_LABELS,
  codeMirrorMinimapSettings,
} from "./minimap-settings";

const CODEMIRROR_MINIMAP_MAX_TRACK_HEIGHT = 32_000;
const CODEMIRROR_MINIMAP_MAX_SAMPLED_LINES = 8_000;
const CODEMIRROR_MINIMAP_BASE_LINE_SCALE = 1.45;
const CODEMIRROR_MINIMAP_RECOMPUTE_MS = 150;
// smallest bar + gap that still reads as a bar
const MIN_BLOCK_PITCH = 5;

const CODEMIRROR_MINIMAP_TOKEN_RE =
  /(#.*$)|(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(\b(?:abstract|and|as|assert|async|await|break|case|catch|class|const|continue|def|default|del|elif|else|enum|except|export|extends|False|finally|for|from|function|global|if|implements|import|in|interface|is|lambda|let|new|None|nonlocal|not|null|or|package|pass|private|protected|public|raise|return|static|switch|this|throw|True|try|type|typeof|var|void|while|with|yield)\b)/g;

function getCodeMirrorMinimapTextMetrics(width: number): {
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
  return { fontSize: 3.9, lineHeight: 4.8, leftPadding: 3, rightPadding: 3 };
}

function drawCodeMirrorMinimapTextLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  charWidth: number,
  maxChars: number,
): void {
  const line = text.slice(0, maxChars);
  if (line.length === 0) return;
  ctx.fillStyle = MINIMAP_SYNTAX.text;
  ctx.fillText(line, x, y);

  CODEMIRROR_MINIMAP_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null = CODEMIRROR_MINIMAP_TOKEN_RE.exec(line);
  while (match != null) {
    let color = "";
    if (match[1] || match[2]) {
      color = MINIMAP_SYNTAX.comment;
    } else if (match[3]) {
      color = MINIMAP_SYNTAX.string;
    } else if (match[4]) {
      color = MINIMAP_SYNTAX.number;
    } else if (match[5]) {
      color = MINIMAP_SYNTAX.keyword;
    }
    if (color.length > 0) {
      const index = match.index ?? 0;
      ctx.fillStyle = color;
      ctx.fillText(match[0], x + index * charWidth, y);
    }
    match = CODEMIRROR_MINIMAP_TOKEN_RE.exec(line);
  }
}

/**
 * Visible height of the editor, tracked so the minimap can size itself.
 *
 * Note this is `getScrollInfo().clientHeight` and NOT the scroller element's
 * `clientHeight`: CodeMirror hides the native scrollbars with a negative
 * margin plus matching padding, which inflates the raw DOM value by ~50px.
 * Sizing the minimap from that made it hang off the bottom of the frame.
 */
function useEditorVisibleHeight(cm: CodeMirror.Editor): number {
  const [height, setHeight] = useState<number>(
    () => cm.getScrollInfo().clientHeight,
  );
  useEffect(() => {
    const scroller = cm.getScrollerElement() as HTMLElement | null;
    if (scroller == null) return;
    const update = () => setHeight(cm.getScrollInfo().clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    cm.on("refresh", update as any);
    return () => {
      observer.disconnect();
      cm.off("refresh", update as any);
    };
  }, [cm]);
  return height;
}

// --------------------------------------------------------------------------
// "text" rendering
// --------------------------------------------------------------------------

const CodeMirrorTextMinimap: React.FC<{
  cm: CodeMirror.Editor;
  width: number;
}> = ({ cm, width }) => {
  // false while the whole document fits on screen: then the map is just an
  // outline, with no viewport rectangle to drag
  const [scrollable, setScrollable] = useState(true);
  const railRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawRafRef = useRef<number | null>(null);
  const viewportRafRef = useRef<number | null>(null);

  const drawNow = useCallback(() => {
    const scroller = cm.getScrollerElement() as HTMLElement | null;
    const rail = railRef.current;
    const track = trackRef.current;
    const canvas = canvasRef.current;
    if (scroller == null || rail == null || track == null || canvas == null) {
      return;
    }

    const lineCount = Math.max(1, cm.lineCount());
    const cssWidth = Math.max(1, track.clientWidth || rail.clientWidth);
    const metrics = getCodeMirrorMinimapTextMetrics(cssWidth);
    const lineScale = Math.max(1.5, metrics.lineHeight);
    // scroller.clientHeight is inflated by CodeMirror's scrollbar-hiding
    // padding; getScrollInfo() reports the height actually on screen.
    const railHeight = Math.max(24, cm.getScrollInfo().clientHeight - 10);
    // Keep short files compact; expanding them to rail height makes rows look
    // unnaturally far apart.
    const naturalTrackHeight = Math.max(
      24,
      lineCount * Math.max(CODEMIRROR_MINIMAP_BASE_LINE_SCALE, lineScale),
    );
    const trackHeight = Math.max(
      1,
      Math.min(CODEMIRROR_MINIMAP_MAX_TRACK_HEIGHT, naturalTrackHeight),
    );
    track.style.height = `${trackHeight}px`;
    rail.style.height = `${railHeight}px`;

    const cssHeight = Math.max(1, trackHeight);
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
    if (canvas.height !== backingStore.height) {
      canvas.height = backingStore.height;
    }
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext("2d");
    if (ctx == null) return;
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

    const scrollInfo = cm.getScrollInfo();
    const editorContentHeight = Math.max(1, scrollInfo.height);
    const firstLine = cm.firstLine();
    const lastLine = cm.lastLine();
    const sampledRows = Math.max(
      1,
      Math.min(
        lineCount,
        CODEMIRROR_MINIMAP_MAX_SAMPLED_LINES,
        Math.ceil(cssHeight / Math.max(1, metrics.lineHeight * 0.85)),
      ),
    );
    const rowHeight = cssHeight / sampledRows;
    let previousLineNo: number | null = null;
    let wrappedChunkIndex = 0;
    for (let i = 0; i < sampledRows; i += 1) {
      const y = i * rowHeight;
      const editorY = (y / Math.max(1, cssHeight)) * editorContentHeight;
      const lineNo = Math.min(
        lastLine,
        Math.max(firstLine, cm.lineAtHeight(editorY, "local")),
      );
      if (lineNo === previousLineNo) {
        wrappedChunkIndex += 1;
      } else {
        previousLineNo = lineNo;
        wrappedChunkIndex = 0;
      }
      const fullLine = cm.getLine(lineNo) ?? "";
      const start = wrappedChunkIndex * maxChars;
      const text = fullLine.slice(start, start + maxChars);
      drawCodeMirrorMinimapTextLine(
        ctx,
        text,
        metrics.leftPadding,
        y,
        charWidth,
        maxChars,
      );
    }

    const currentLine = cm.getDoc().getCursor().line;
    const currentLineTopPx = Math.max(0, cm.heightAtLine(currentLine, "local"));
    const currentLineBottomPx =
      currentLine + 1 < lineCount
        ? Math.max(
            currentLineTopPx + 1,
            cm.heightAtLine(currentLine + 1, "local"),
          )
        : editorContentHeight;
    const currentY = Math.max(
      0,
      Math.min(cssHeight, (currentLineTopPx / editorContentHeight) * cssHeight),
    );
    const currentH = Math.max(
      1.5,
      ((currentLineBottomPx - currentLineTopPx) / editorContentHeight) *
        cssHeight,
    );
    ctx.fillStyle = MINIMAP_COLORS.canvasCurrentLine;
    ctx.fillRect(0, currentY, cssWidth, currentH);
  }, [cm]);

  const getGeometry = useCallback((): TextMinimapGeometry | null => {
    const scroller = cm.getScrollerElement() as HTMLElement | null;
    const rail = railRef.current;
    const track = trackRef.current;
    if (scroller == null || rail == null || track == null) return null;
    const scrollInfo = cm.getScrollInfo();
    return computeTextMinimapGeometry({
      trackHeight: Math.max(1, track.scrollHeight),
      railHeight: Math.max(1, rail.clientHeight),
      docContentHeight: Math.max(1, scrollInfo.height),
      docClientHeight: Math.max(1, scrollInfo.clientHeight),
      docScrollTop: scrollInfo.top,
    });
  }, [cm]);

  const updateViewportNow = useCallback(() => {
    const geo = getGeometry();
    const scroll = scrollRef.current;
    const viewport = viewportRef.current;
    if (geo == null || scroll == null || viewport == null) return;
    scroll.scrollTop = geo.miniScrollTop;
    setScrollable(geo.scrollable);
    viewport.style.top = `${geo.thumbTop}px`;
    viewport.style.height = `${geo.thumbHeight}px`;
    railRef.current?.setAttribute(
      "aria-valuenow",
      String(Math.round(geo.ratio * 100)),
    );
  }, [getGeometry]);

  const scheduleDraw = useCallback(() => {
    if (typeof window === "undefined") {
      drawNow();
      updateViewportNow();
      return;
    }
    if (drawRafRef.current != null) return;
    drawRafRef.current = window.requestAnimationFrame(() => {
      drawRafRef.current = null;
      drawNow();
      updateViewportNow();
    });
  }, [drawNow, updateViewportNow]);

  const scheduleViewport = useCallback(() => {
    if (typeof window === "undefined") {
      updateViewportNow();
      return;
    }
    if (viewportRafRef.current != null) return;
    viewportRafRef.current = window.requestAnimationFrame(() => {
      viewportRafRef.current = null;
      updateViewportNow();
    });
  }, [updateViewportNow]);

  useEffect(() => {
    if (typeof window === "undefined") {
      drawNow();
      updateViewportNow();
      return;
    }
    const raf = window.requestAnimationFrame(() => {
      cm.refresh();
      drawNow();
      updateViewportNow();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [cm, drawNow, updateViewportNow, width]);

  useEffect(() => {
    const onScroll = () => scheduleViewport();
    const onChange = throttle(() => scheduleDraw(), 120, {
      leading: true,
      trailing: true,
    });
    const onCursorActivity = throttle(() => scheduleDraw(), 120, {
      leading: true,
      trailing: true,
    });
    const onRefresh = () => scheduleDraw();

    cm.on("scroll", onScroll as any);
    cm.on("change", onChange as any);
    cm.on("cursorActivity", onCursorActivity as any);
    cm.on("refresh", onRefresh as any);
    cm.refresh();
    scheduleDraw();
    scheduleViewport();

    return () => {
      cm.off("scroll", onScroll as any);
      cm.off("change", onChange as any);
      cm.off("cursorActivity", onCursorActivity as any);
      cm.off("refresh", onRefresh as any);
      onChange.cancel();
      onCursorActivity.cancel();
      if (typeof window !== "undefined") {
        if (drawRafRef.current != null) {
          window.cancelAnimationFrame(drawRafRef.current);
          drawRafRef.current = null;
        }
        if (viewportRafRef.current != null) {
          window.cancelAnimationFrame(viewportRafRef.current);
          viewportRafRef.current = null;
        }
      }
    };
  }, [cm, scheduleDraw, scheduleViewport]);

  const scrollDocTo = useCallback(
    (top: number) => {
      cm.scrollTo(null, top);
      scheduleViewport();
    },
    [cm, scheduleViewport],
  );

  const scrollDocBy = useCallback(
    (delta: number) => scrollDocTo(cm.getScrollInfo().top + delta),
    [cm, scrollDocTo],
  );

  const rail = useTextMinimapRail({
    railRef,
    getGeometry,
    scrollDocTo,
    scrollDocBy,
  });

  return (
    <div
      style={{
        width: `${width}px`,
        flex: `0 0 ${width}px`,
        marginLeft: "8px",
        marginRight: "6px",
        display: "flex",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
      }}
    >
      <div
        ref={railRef}
        {...MINIMAP_SCROLLBAR_ARIA}
        aria-label="Editor minimap scrollbar"
        onKeyDown={rail.onKeyDown}
        onPointerDown={rail.onPointerDown}
        onPointerMove={rail.onPointerMove}
        onPointerUp={rail.onPointerUp}
        onPointerCancel={rail.onPointerUp}
        style={{
          position: "relative",
          width: "100%",
          borderRadius: "4px",
          background: MINIMAP_COLORS.railBackground,
          border: `1px solid ${MINIMAP_COLORS.railBorder}`,
          cursor: !scrollable ? "default" : rail.dragging ? "grabbing" : "grab",
          overflow: "hidden",
          touchAction: "none",
        }}
      >
        <MinimapControls
          api={codeMirrorMinimapSettings}
          labels={CODEMIRROR_MINIMAP_LABELS}
        />
        <div
          ref={scrollRef}
          className={MINIMAP_HIDE_SCROLLBAR_CLASS}
          style={{
            position: "absolute",
            inset: 0,
            // Scrolled programmatically only: `hidden` keeps scrollTop working
            // while removing the second scrollbar.
            overflow: "hidden",
            boxSizing: "border-box",
          }}
        >
          <div
            ref={trackRef}
            style={{ position: "relative", width: "100%", height: "100%" }}
          >
            <canvas
              ref={canvasRef}
              style={{ display: "block", width: "100%", height: "100%" }}
            />
          </div>
        </div>
        <div
          ref={viewportRef}
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
  );
};

// --------------------------------------------------------------------------
// "blocks" rendering
// --------------------------------------------------------------------------

/** Top and height of a block, in CodeMirror "local" document coordinates. */
function blockRect(
  cm: CodeMirror.Editor,
  block: TextBlock,
): { top: number; height: number } {
  const top = cm.heightAtLine(block.startLine, "local");
  // heightAtLine past the last line returns the document height, which is
  // exactly the bottom we want for the final block.
  const bottom = cm.heightAtLine(block.endLine + 1, "local");
  return { top, height: Math.max(1, bottom - top) };
}

function createCodeMirrorBlockAdapter(
  cm: CodeMirror.Editor,
  blocksRef: React.MutableRefObject<TextBlock[]>,
): MinimapDocAdapter {
  const rectById = (id: string) => {
    const block = blocksRef.current.find((b) => b.id === id);
    return block == null ? null : blockRect(cm, block);
  };
  return {
    visibleRange() {
      const blocks = blocksRef.current;
      if (blocks.length === 0) return null;
      const info = cm.getScrollInfo();
      const top = info.top;
      const bottom = top + info.clientHeight;
      // Blank separator lines belong to no block, so fall forward/back to the
      // nearest one instead of giving up.
      const lineAtTop = cm.lineAtHeight(top, "local");
      const lineAtBottom = cm.lineAtHeight(bottom, "local");
      let firstIdx = findTextBlockIndex(blocks, lineAtTop);
      if (firstIdx < 0) {
        firstIdx = blocks.findIndex((b) => b.startLine >= lineAtTop);
        if (firstIdx < 0) firstIdx = blocks.length - 1;
      }
      let lastIdx = findTextBlockIndex(blocks, lineAtBottom);
      if (lastIdx < 0) {
        for (let i = blocks.length - 1; i >= 0; i -= 1) {
          if (blocks[i].endLine <= lineAtBottom) {
            lastIdx = i;
            break;
          }
        }
        if (lastIdx < 0) lastIdx = firstIdx;
      }
      if (lastIdx < firstIdx) lastIdx = firstIdx;
      const firstRect = blockRect(cm, blocks[firstIdx]);
      const lastRect = blockRect(cm, blocks[lastIdx]);
      const frac = (value: number, rect: { top: number; height: number }) =>
        Math.max(0, Math.min(1, (value - rect.top) / rect.height));
      return {
        firstId: blocks[firstIdx].id,
        firstFrac: frac(top, firstRect),
        lastId: blocks[lastIdx].id,
        lastFrac: frac(bottom, lastRect),
      };
    },
    scrollToBlock(id, fraction) {
      const rect = rectById(id);
      if (rect == null) return false;
      const info = cm.getScrollInfo();
      cm.scrollTo(
        null,
        rect.top + fraction * rect.height - info.clientHeight / 2,
      );
      return true;
    },
    metrics() {
      const info = cm.getScrollInfo();
      return {
        scrollTop: info.top,
        scrollHeight: Math.max(1, info.height),
        clientHeight: Math.max(1, info.clientHeight),
      };
    },
    scrollToPosition(top) {
      cm.scrollTo(null, top);
    },
    scrollBy(delta) {
      cm.scrollTo(null, cm.getScrollInfo().top + delta);
    },
    subscribe(onChange) {
      cm.on("scroll", onChange as any);
      cm.on("refresh", onChange as any);
      return () => {
        cm.off("scroll", onChange as any);
        cm.off("refresh", onChange as any);
      };
    },
  };
}

const CodeMirrorBlockMinimap: React.FC<{
  cm: CodeMirror.Editor;
  width: number;
}> = ({ cm, width }) => {
  const height = useEditorVisibleHeight(cm);
  const [docVersion, setDocVersion] = useState<number>(0);
  const [cursorLine, setCursorLine] = useState<number>(0);
  const blocksRef = useRef<TextBlock[]>([]);

  const adapter = useMemo(
    () => createCodeMirrorBlockAdapter(cm, blocksRef),
    [cm],
  );

  useEffect(() => {
    const onChange = throttle(
      () => setDocVersion((v) => v + 1),
      CODEMIRROR_MINIMAP_RECOMPUTE_MS,
      { leading: true, trailing: true },
    );
    const onCursor = () => setCursorLine(cm.getDoc().getCursor().line);
    onCursor();
    cm.on("change", onChange as any);
    cm.on("cursorActivity", onCursor as any);
    return () => {
      cm.off("change", onChange as any);
      cm.off("cursorActivity", onCursor as any);
      onChange.cancel();
    };
  }, [cm]);

  // Merge paragraphs until each bar can be a few pixels tall: a 2000-line file
  // has hundreds of them, and sub-pixel bars separated by sub-pixel gaps render
  // as a blank column.
  const blocks = useMemo(
    () =>
      computeTextBlocks({
        lineCount: cm.lineCount(),
        getLine: (n) => cm.getLine(n) ?? "",
        maxBlocks: Math.max(8, Math.floor(height / MIN_BLOCK_PITCH)),
      }),
    // docVersion stands in for the document contents
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cm, docVersion, height],
  );
  blocksRef.current = blocks;

  const minimapBlocks: MinimapBlock[] = useMemo(() => {
    // "nearest" rather than "containing": the caret often rests on a blank
    // line between paragraphs, and the highlight should not vanish there.
    const currentIdx = nearestTextBlockIndex(blocks, cursorLine);
    return blocks.map((block, i) => ({
      id: block.id,
      pixelHeight: blockRect(cm, block).height,
      color: i === currentIdx ? MINIMAP_COLORS.current : MINIMAP_COLORS.block,
      opacity: i === currentIdx ? 0.8 : 0.7,
    }));
  }, [blocks, cm, cursorLine]);

  if (height <= 0) return null;

  return (
    <div
      style={{
        marginLeft: "8px",
        marginRight: "6px",
        display: "flex",
        alignItems: "flex-start",
      }}
    >
      <BlockMinimap
        blocks={minimapBlocks}
        height={height}
        width={width}
        adapter={adapter}
        label="Editor minimap scrollbar"
        resubscribeKey={cm}
      >
        <MinimapControls
          api={codeMirrorMinimapSettings}
          labels={CODEMIRROR_MINIMAP_LABELS}
        />
      </BlockMinimap>
    </div>
  );
};

// --------------------------------------------------------------------------

interface CodeMirrorMinimapProps {
  cm: CodeMirror.Editor;
  isCurrent: boolean;
}

export const CodeMirrorMinimap: React.FC<CodeMirrorMinimapProps> = React.memo(
  ({ cm, isCurrent }: CodeMirrorMinimapProps) => {
    const settings = useMinimapSettings(codeMirrorMinimapSettings);
    const { modal, open } = useMinimapSettingsModal({
      api: codeMirrorMinimapSettings,
      labels: CODEMIRROR_MINIMAP_LABELS,
      isActive: isCurrent,
    });

    // The stylized map covers the whole document, so it replaces CodeMirror's
    // own scrollbar; the text map is only a window onto a longer track, so
    // there the native scrollbar is still useful.
    const stylized = settings.enabled && settings.kind === "stylized";
    useEffect(() => {
      const wrapper = cm.getWrapperElement() as HTMLElement | null;
      if (wrapper == null) return;
      wrapper.classList.toggle(MINIMAP_NO_VSCROLLBAR_CLASS, stylized);
      return () => wrapper.classList.remove(MINIMAP_NO_VSCROLLBAR_CLASS);
    }, [cm, stylized]);

    // Switching style or stepping the width resizes CodeMirror's flex sibling
    // without going through the frame's `resize` prop, so CodeMirror would keep
    // stale wrapping and viewport measurements until some unrelated resize.
    useEffect(() => {
      if (typeof window === "undefined") return;
      const raf = window.requestAnimationFrame(() => cm.refresh());
      return () => window.cancelAnimationFrame(raf);
    }, [cm, settings.enabled, settings.kind, settings.width]);

    if (!settings.enabled) return modal;

    return (
      <>
        <MinimapContextMenu
          api={codeMirrorMinimapSettings}
          labels={CODEMIRROR_MINIMAP_LABELS}
          onOpenSettings={open}
          style={{ alignItems: "stretch" }}
        >
          {stylized ? (
            <CodeMirrorBlockMinimap cm={cm} width={settings.width} />
          ) : (
            <CodeMirrorTextMinimap cm={cm} width={settings.width} />
          )}
        </MinimapContextMenu>
        {modal}
      </>
    );
  },
);
