/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// React component that renders the ordered list of cells

declare const $: any;
import useResizeObserver from "use-resize-observer";
import { delay } from "awaiting";
import * as immutable from "immutable";
import { debounce } from "lodash";
import {
  MutableRefObject,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CSS, React, useIsMountedRef } from "@cocalc/frontend/app-framework";
import { Loading } from "@cocalc/frontend/components";
import {
  DragHandle,
  SortableItem,
  SortableList,
} from "@cocalc/frontend/components/sortable-list";
import useNotebookFrameActions from "@cocalc/frontend/frame-editors/jupyter-editor/cell-notebook/hook";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import { LLMTools, NotebookMode, Scroll } from "@cocalc/jupyter/types";
import { JupyterActions } from "./browser-actions";
import { Cell } from "./cell";
import HeadingTagComponent from "./heading-tag";

interface StableHtmlContextType {
  enabled?: boolean;
  cellListDivRef?: MutableRefObject<any>;
  scrollOrResize?: { [key: string]: () => void };
}
export const StableHtmlContext = createContext<StableHtmlContextType>({});
export const useStableHtmlContext: () => StableHtmlContextType = () => {
  return useContext(StableHtmlContext);
};

const LAZY_RENDER_INITIAL_CELLS = 24;
const LAZY_RENDER_PLACEHOLDER_MIN_HEIGHT = 96;
const MINIMAP_DEFAULT_MIN_CELL_COUNT = 1;
const MINIMAP_DEFAULT_WIDTH = 84;
const MINIMAP_MIN_WIDTH = 48;
const MINIMAP_MAX_WIDTH = 220;
const MINIMAP_BASE_SCALE = 0.11;
const MINIMAP_MIN_SCALE = 0.02;
const MINIMAP_MAX_SCALE = 0.36;
const MINIMAP_MAX_TRACK_HEIGHT = 32_000;
const MINIMAP_MIN_TRACK_VIEWPORT_MULTIPLIER = 1.2;
const MINIMAP_TEXT_LEFT_PADDING = 3;
const MINIMAP_TEXT_RIGHT_PADDING = 4;
const MINIMAP_FONT_SIZE = 3.8;
const MINIMAP_LINE_HEIGHT = 4.4;
const MINIMAP_MAX_PREVIEW_LINES_PER_CELL = 180;
const MINIMAP_MAX_DRAWN_LINES = 12_000;

const MINIMAP_CODE_TOKEN_RE =
  /(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\b)/g;

const MINIMAP_OVERRIDE_STORAGE_KEYS = [
  "cocalc_jupyter_minimap",
  "jupyter_minimap",
] as const;
const MINIMAP_WIDTH_OVERRIDE_STORAGE_KEYS = [
  "cocalc_jupyter_minimap_width",
  "jupyter_minimap_width",
] as const;

function parseBooleanOverride(raw: string | null): boolean | undefined {
  if (raw == null) return;
  const value = raw.trim().toLowerCase();
  if (
    value === "1" ||
    value === "true" ||
    value === "on" ||
    value === "yes"
  ) {
    return true;
  }
  if (
    value === "0" ||
    value === "false" ||
    value === "off" ||
    value === "no"
  ) {
    return false;
  }
}

function forceMinimapEnabled(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const urlOverride = parseBooleanOverride(
      new URLSearchParams(window.location.search).get("jupyter_minimap"),
    );
    if (urlOverride != null) return urlOverride;
    const storage = window.localStorage;
    if (storage != null) {
      for (const key of MINIMAP_OVERRIDE_STORAGE_KEYS) {
        const override = parseBooleanOverride(storage.getItem(key));
        if (override != null) return override;
      }
    }
  } catch {
    // ignore malformed URL/localStorage access failures
  }
  return false;
}

function parseNumberOverride(raw: string | null): number | undefined {
  if (raw == null) return;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return;
  return Math.max(MINIMAP_MIN_WIDTH, Math.min(MINIMAP_MAX_WIDTH, Math.round(n)));
}

function forceMinimapWidth(): number | undefined {
  try {
    if (typeof window === "undefined") return;
    const urlOverride = parseNumberOverride(
      new URLSearchParams(window.location.search).get("jupyter_minimap_width"),
    );
    if (urlOverride != null) return urlOverride;
    const storage = window.localStorage;
    if (storage != null) {
      for (const key of MINIMAP_WIDTH_OVERRIDE_STORAGE_KEYS) {
        const override = parseNumberOverride(storage.getItem(key));
        if (override != null) return override;
      }
    }
  } catch {
    // ignore malformed URL/localStorage access failures
  }
}

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

// the extra bottom cell at the very end
// See https://github.com/sagemathinc/cocalc/issues/6141 for a discussion
// of why this.  It's the best I could come up with that was very simple
// to understand and a mix of other options.
const BOTTOM_PADDING_CELL = (
  <div
    key="bottom-padding"
    style={{ height: "50vh", minHeight: "400px" }}
  ></div>
);

interface CellListProps {
  actions?: JupyterActions; // if not defined, then everything is read only
  cell_list: immutable.List<string>; // list of ids of cells in order
  stdin?;
  cell_toolbar?: string;
  cells: immutable.Map<string, any>;
  cm_options: immutable.Map<string, any>;
  complete?: immutable.Map<string, any>; // status of tab completion
  cur_id?: string; // cell with the green cursor around it; i.e., the cursor cell
  directory?: string;
  font_size: number;
  hook_offset?: number;
  is_focused?: boolean;
  is_visible?: boolean;
  md_edit_ids?: immutable.Set<string>;
  mode: NotebookMode;
  more_output?: immutable.Map<string, any>;
  name?: string;
  project_id?: string;
  scroll?: Scroll; // scroll as described by this, e.g., cecll visible'
  scroll_seq?: number; // indicates
  scrollTop?: any;
  sel_ids?: immutable.Set<string>; // set of selected cells
  trust?: boolean;
  llmTools?: LLMTools;
  read_only?: boolean;
  pendingCells?: immutable.Set<string>;
}

export const CellList: React.FC<CellListProps> = (props: CellListProps) => {
  const {
    actions,
    cell_list,
    stdin,
    cell_toolbar,
    cells,
    cm_options,
    complete,
    cur_id,
    directory,
    font_size,
    hook_offset,
    is_focused,
    is_visible,
    md_edit_ids,
    mode,
    more_output,
    name,
    project_id,
    scroll,
    scroll_seq,
    scrollTop,
    sel_ids,
    trust,
    llmTools,
    read_only,
    pendingCells,
  } = props;

  const cellListDivRef = useRef<any>(null);
  const is_mounted = useIsMountedRef();
  const frameActions = useNotebookFrameActions();

  useEffect(() => {
    restore_scroll();
    const frame_actions = frameActions.current;
    if (frame_actions == null) return;
    // Enable keyboard handler if necessary
    if (is_focused) {
      frame_actions.enable_key_handler();
    }
    // Also since just mounted, set this to be focused.
    // When we have multiple editors on the same page, we will
    // have to set the focus at a higher level (in the project store?).
    frame_actions.focus(true);
    // setup a click handler so we can manage focus
    $(window).on("click", window_click);
    frame_actions.cell_list_div = $(cellListDivRef.current);

    return () => {
      saveScroll();
      // handle focus via an event handler on window.
      // We have to do this since, e.g., codemirror editors
      // involve spans that aren't even children, etc...
      $(window).unbind("click", window_click);
      frameActions.current?.disable_key_handler();
    };
  }, []);

  useEffect(() => {
    // the focus state changed.
    if (is_focused) {
      frameActions.current?.enable_key_handler();
    } else {
      frameActions.current?.disable_key_handler();
    }
  }, [is_focused]);

  const lastScrollSeqRef = useRef<number>(-1);
  useEffect(() => {
    if (scroll_seq == null) return;
    // scroll state may have changed
    if (scroll != null && lastScrollSeqRef.current < scroll_seq) {
      lastScrollSeqRef.current = scroll_seq;
      scrollCellList(scroll);
    }
  }, [cur_id, scroll, scroll_seq]);

  const handleCellListRef = useCallback((node: any) => {
    cellListDivRef.current = node;
    frameActions.current?.set_cell_list_div(node);
  }, []);

  if (cell_list == null) {
    return render_loading();
  }

  const lazyRenderEnabled = true;
  const minimapOptIn = forceMinimapEnabled();
  const minimapWidth = forceMinimapWidth() ?? MINIMAP_DEFAULT_WIDTH;
  const lazyHydratedIdsRef = useRef<Set<string>>(new Set());
  const lazyHeightsRef = useRef<Record<string, number>>({});
  const [lazyHydrationVersion, setLazyHydrationVersion] = useState<number>(0);

  useEffect(() => {
    if (!lazyRenderEnabled) return;
    let changed = false;
    const add = (id?: string) => {
      if (id == null || lazyHydratedIdsRef.current.has(id)) return;
      lazyHydratedIdsRef.current.add(id);
      changed = true;
    };
    for (let i = 0; i < Math.min(LAZY_RENDER_INITIAL_CELLS, cell_list.size); i += 1) {
      add(cell_list.get(i));
    }
    add(cur_id);
    sel_ids?.forEach((id) => add(id));
    md_edit_ids?.forEach((id) => add(id));
    pendingCells?.forEach((id) => add(id));
    if (changed) {
      setLazyHydrationVersion((n) => n + 1);
    }
  }, [
    lazyRenderEnabled,
    cell_list,
    cur_id,
    sel_ids,
    md_edit_ids,
    pendingCells,
  ]);

  const saveScroll = useCallback(() => {
    if (cellListDivRef.current != null) {
      frameActions.current?.set_scrollTop(cellListDivRef.current.scrollTop);
    }
  }, []);

  const saveScrollDebounce = useMemo(() => {
    return debounce(saveScroll, 2000);
  }, [saveScroll]);

  const fileContext = useFileContext();

  async function restore_scroll(): Promise<void> {
    if (scrollTop == null) return;
    /* restore scroll state -- as rendering happens dynamically
       and asynchronously, and I have no idea how to know when
       we are done, we can't just do this once.  Instead, we
       keep resetting scrollTop a few times.
    */
    let scrollHeight: number = 0;
    for (const tm of [0, 1, 100, 250, 500, 1000]) {
      if (!is_mounted.current) return;
      const elt = cellListDivRef.current;
      if (elt != null && elt.scrollHeight !== scrollHeight) {
        // dynamically rendering actually changed something
        elt.scrollTop = scrollTop;
        scrollHeight = elt.scrollHeight;
      }
      await delay(tm);
    }
  }

  function window_click(event: any): void {
    // if click in the cell list, focus the cell list; otherwise, blur it.
    const elt = $(cellListDivRef.current);
    // list no longer exists, nothing left to do
    // Maybe elt can be null? https://github.com/sagemathinc/cocalc/issues/3580
    if (elt.length == 0) return;

    const offset = elt.offset();
    if (offset == null) {
      // offset can definitely be null -- https://github.com/sagemathinc/cocalc/issues/3580
      return;
    }

    const x = event.pageX - offset.left;
    const y = event.pageY - offset.top;
    const outerH = elt.outerHeight();
    const outerW = elt.outerWidth();
    if (outerW != null && outerH != null) {
      if (x >= 0 && y >= 0 && x <= outerW && y <= outerH) {
        frameActions.current?.focus();
      } else {
        frameActions.current?.blur();
      }
    }
  }

  async function scrollCellList(scroll: Scroll): Promise<void> {
    const node = $(cellListDivRef.current);
    if (node.length == 0) return;
    if (typeof scroll === "number") {
      node.scrollTop(node.scrollTop() + scroll);
      return;
    }

    // supported scroll positions are in types.ts
    if (scroll.startsWith("cell ")) {
      // Handle "cell visible" and "cell top"
      const cell = $(node).find(`#${cur_id}`);
      if (cell.length == 0) return;
      if (scroll.startsWith("cell visible")) {
        cell.scrollintoview();
      } else if (scroll == "cell top") {
        // Make it so the top of the cell is at the top of
        // the visible area.
        const s = cell.offset().top - node.offset().top;
        node.scrollTop(node.scrollTop() + s);
      }
      return;
    }

    switch (scroll) {
      case "list up":
        // move scroll position of list up one page
        node.scrollTop(node.scrollTop() - node.height() * 0.9);
        break;
      case "list down":
        // move scroll position of list up one page
        node.scrollTop(node.scrollTop() + node.height() * 0.9);
        break;
    }
  }

  function render_loading() {
    return (
      <div
        style={{
          fontSize: "32pt",
          color: "#888",
          textAlign: "center",
          marginTop: "15px",
        }}
      >
        <Loading />
      </div>
    );
  }

  function on_click(e): void {
    if (actions) actions.clear_complete();
    if ($(e.target).hasClass("cocalc-complete")) {
      // Bootstrap simulates a click even when user presses escape; can't catch there.
      // See the complete component in codemirror-static.
      frameActions.current?.set_mode("edit");
    }
  }

  function renderCell({
    id,
    isScrolling,
    index,
    delayRendering, // seems not used anywhere!
    isFirst,
    isLast,
    isDragging,
  }: {
    id: string;
    isScrolling?: boolean;
    index?: number;
    delayRendering?: number;
    isFirst?: boolean;
    isLast?: boolean;
    isDragging?: boolean;
  }) {
    const cell = cells.get(id);
    if (cell == null) return null;
    if (index == null) {
      index = cell_list.indexOf(id) ?? 0;
    }
    const dragHandle = actions?.store?.is_cell_editable(id) ? (
      <DragHandle
        id={id}
        style={{
          position: "relative",
          left: 0,
          top: 0,
          color: "#aaa",
        }}
      />
    ) : undefined;

    return (
      <div key={id}>
        <Cell
          id={id}
          stdin={stdin?.get("id") == id ? stdin : undefined}
          index={index}
          actions={actions}
          name={name}
          cm_options={cm_options}
          cell={cell}
          is_current={id === cur_id}
          hook_offset={hook_offset}
          is_selected={sel_ids?.contains(id)}
          is_markdown_edit={md_edit_ids?.contains(id)}
          mode={mode}
          font_size={font_size}
          project_id={project_id}
          directory={directory}
          complete={complete}
          is_focused={is_focused}
          is_visible={is_visible}
          more_output={more_output?.get(id)}
          cell_toolbar={cell_toolbar}
          trust={trust}
          is_scrolling={isScrolling}
          delayRendering={delayRendering}
          llmTools={llmTools}
          isFirst={isFirst}
          isLast={isLast}
          dragHandle={dragHandle}
          read_only={read_only}
          isDragging={isDragging}
          isPending={pendingCells?.has(id)}
        />
      </div>
    );
  }

  function placeholderTextForCell(id: string, index: number): string {
    const cell = cells.get(id);
    const input = cell?.get?.("input");
    if (typeof input === "string" && input.trim()) {
      return input.trim().split("\n")[0].slice(0, 160);
    }
    const cellType = cell?.get?.("cell_type");
    if (typeof cellType === "string") {
      return `${cellType} cell ${index + 1}`;
    }
    return `cell ${index + 1}`;
  }

  function renderLazyCell({
    id,
    index,
    isFirst,
    isLast,
  }: {
    id: string;
    index: number;
    isFirst: boolean;
    isLast: boolean;
  }): React.JSX.Element | null {
    if (!lazyRenderEnabled) {
      return renderCell({
        id,
        isScrolling: false,
        index,
        isFirst,
        isLast,
      });
    }

    const hydrated = lazyHydratedIdsRef.current.has(id);
    if (hydrated) {
      return (
        <div
          data-jupyter-lazy-cell-id={id}
          data-jupyter-lazy-cell-hydrated="1"
          ref={(node) => {
            if (node == null) return;
            const h = node.getBoundingClientRect().height;
            if (h > 0) {
              lazyHeightsRef.current[id] = h;
            }
          }}
        >
          {renderCell({
            id,
            isScrolling: false,
            index,
            isFirst,
            isLast,
          })}
        </div>
      );
    }

    const h = lazyHeightsRef.current[id] ?? LAZY_RENDER_PLACEHOLDER_MIN_HEIGHT;
    return (
      <div
        id={id}
        data-jupyter-lazy-cell-id={id}
        data-jupyter-lazy-placeholder="1"
        style={{
          minHeight: `${h}px`,
          marginBottom: "10px",
          borderLeft: "2px solid #e2e8f0",
          padding: "8px 10px",
          color: "#64748b",
          background: "#f8fafc",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
          fontSize: `${Math.max(11, Math.floor(font_size * 0.85))}px`,
          lineHeight: 1.35,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {placeholderTextForCell(id, index)}
      </div>
    );
  }

  const hydrateVisibleCells = useCallback(() => {
    if (!lazyRenderEnabled) return;
    const scroller = cellListDivRef.current as HTMLElement | null;
    if (scroller == null) return;
    const minY = scroller.scrollTop - 1200;
    const maxY = scroller.scrollTop + scroller.clientHeight + 1200;
    let changed = false;
    for (const node of Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-jupyter-lazy-cell-id]"),
    )) {
      const id = node.getAttribute("data-jupyter-lazy-cell-id");
      if (id == null || lazyHydratedIdsRef.current.has(id)) continue;
      const top = node.offsetTop;
      const bottom = top + Math.max(node.offsetHeight, 1);
      if (bottom < minY || top > maxY) continue;
      lazyHydratedIdsRef.current.add(id);
      changed = true;
    }
    if (changed) {
      setLazyHydrationVersion((n) => n + 1);
    }
  }, [lazyRenderEnabled]);

  const scrollOrResize = useMemo(() => {
    return {};
  }, []);
  const updateScrollOrResize = useCallback(() => {
    for (const key in scrollOrResize) {
      scrollOrResize[key]();
    }
  }, []);

  useEffect(updateScrollOrResize, [cells]);

  let body;

  const cellListResize = useResizeObserver({ ref: cellListDivRef });
  useEffect(() => {
    for (const key in scrollOrResize) {
      scrollOrResize[key]();
    }
  }, [cellListResize]);

  useEffect(() => {
    if (!lazyRenderEnabled) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const schedule = (ms: number) => {
      timers.push(
        setTimeout(() => {
          hydrateVisibleCells();
        }, ms),
      );
    };
    // Hydrate what's initially visible plus a small overscan window.
    schedule(0);
    schedule(120);
    schedule(500);
    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [
    lazyRenderEnabled,
    lazyHydrationVersion,
    cell_list,
    cur_id,
    cellListResize.width,
    cellListResize.height,
    hydrateVisibleCells,
  ]);

  const minimapViewportRef = useRef<HTMLDivElement>(null);
  const minimapTrackRef = useRef<HTMLDivElement>(null);
  const minimapRailRef = useRef<HTMLDivElement>(null);
  const minimapScrollRef = useRef<HTMLDivElement>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);

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

  const minimapData = useMemo(() => {
    const viewportHeight = cellListResize.height ?? 0;
    const viewportWidth = cellListResize.width ?? 0;
    const showMinimap =
      (minimapOptIn || cell_list.size >= MINIMAP_DEFAULT_MIN_CELL_COUNT) &&
      viewportHeight >= 140 &&
      viewportWidth >= (minimapOptIn ? 220 : 520);
    if (!showMinimap) return null;

    const rows: {
      id: string;
      top: number;
      height: number;
      isCurrent: boolean;
      hasOutput: boolean;
      title: string;
      kind: MinimapCellKind;
      previewLines: string[];
    }[] = [];
    const rawRows: Array<{
      id: string;
      rawHeight: number;
      isCurrent: boolean;
      hasOutput: boolean;
      title: string;
      kind: MinimapCellKind;
      previewLines: string[];
    }> = [];
    let rawY = 0;
    for (let i = 0; i < cell_list.size; i += 1) {
      const id = cell_list.get(i);
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
      const rawHeight = Math.max(
        24,
        lazyHeightsRef.current[id] ?? LAZY_RENDER_PLACEHOLDER_MIN_HEIGHT,
      );
      rawRows.push({
        id,
        rawHeight,
        isCurrent: id === cur_id,
        hasOutput,
        title: `${cellType} #${i + 1}`,
        kind,
        previewLines: getMinimapPreviewLines(input, hasOutput),
      });
      rawY += rawHeight + 10;
    }

    const rawTotalHeight = Math.max(1, rawY + 1);
    let scale = MINIMAP_BASE_SCALE;
    const minScaleForViewport =
      (viewportHeight * MINIMAP_MIN_TRACK_VIEWPORT_MULTIPLIER) / rawTotalHeight;
    const maxScaleForTrack = MINIMAP_MAX_TRACK_HEIGHT / rawTotalHeight;
    scale = Math.max(scale, minScaleForViewport);
    scale = Math.min(scale, maxScaleForTrack);
    const minScaleBound = Math.min(MINIMAP_MIN_SCALE, maxScaleForTrack);
    scale = Math.max(minScaleBound, Math.min(MINIMAP_MAX_SCALE, scale));

    let y = 0;
    for (const row of rawRows) {
      const h = Math.max(7, row.rawHeight * scale);
      rows.push({
        id: row.id,
        top: y,
        height: h,
        isCurrent: row.isCurrent,
        hasOutput: row.hasOutput,
        title: row.title,
        kind: row.kind,
        previewLines: row.previewLines,
      });
      const gap = Math.max(1, Math.min(6, h * 0.12));
      y += h + gap;
    }
    const totalContentHeight = Math.max(1, Math.min(MINIMAP_MAX_TRACK_HEIGHT, y + 1));
    const railHeight = Math.max(180, viewportHeight - 16);

    return {
      railHeight,
      totalContentHeight,
      rows,
    };
  }, [
    cell_list,
    cellListResize.height,
    cellListResize.width,
    cells,
    cur_id,
    lazyHydrationVersion,
    minimapOptIn,
  ]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute(
      "data-cocalc-jupyter-minimap-visible",
      minimapData == null ? "0" : "1",
    );
    document.documentElement.setAttribute(
      "data-cocalc-jupyter-minimap-cell-count",
      String(cell_list.size),
    );
  }, [minimapData, cell_list.size]);

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

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = "rgba(248,250,252,0.96)";
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    ctx.font = `${MINIMAP_FONT_SIZE}px Menlo, Monaco, "Courier New", monospace`;
    ctx.textBaseline = "top";
    ctx.imageSmoothingEnabled = false;
    const charWidth = Math.max(1, ctx.measureText("M").width);
    const maxChars = Math.max(
      8,
      Math.floor(
        (cssWidth - MINIMAP_TEXT_LEFT_PADDING - MINIMAP_TEXT_RIGHT_PADDING) /
          charWidth,
      ),
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
        Math.max(1, Math.floor((row.height - 2) / MINIMAP_LINE_HEIGHT)),
      );
      let lineY = row.top + 1;
      for (let i = 0; i < visibleLineCount; i += 1) {
        drawMinimapTextLine(
          ctx,
          row.previewLines[i],
          MINIMAP_TEXT_LEFT_PADDING,
          lineY,
          charWidth,
          maxChars,
          theme,
        );
        drawnLines += 1;
        if (drawnLines >= MINIMAP_MAX_DRAWN_LINES) {
          return;
        }
        lineY += MINIMAP_LINE_HEIGHT;
      }
    }
  }, [minimapData]);

  const updateMinimapViewport = useCallback(() => {
    if (minimapData == null) return;
    const scroller = cellListDivRef.current as HTMLElement | null;
    const viewport = minimapViewportRef.current;
    const rail = minimapRailRef.current;
    const miniScroll = minimapScrollRef.current;
    if (scroller == null || viewport == null || rail == null || miniScroll == null) {
      return;
    }

    const notebookScrollHeight = Math.max(1, scroller.scrollHeight);
    const maxNotebookScroll = Math.max(1, notebookScrollHeight - scroller.clientHeight);
    const notebookRatio = Math.min(1, Math.max(0, scroller.scrollTop / maxNotebookScroll));
    // Keep viewport mapping stable even when minimap content is shorter than the rail.
    const contentHeight = Math.max(
      minimapData.totalContentHeight,
      minimapData.railHeight,
    );
    const maxMiniScroll = Math.max(0, contentHeight - minimapData.railHeight);
    const miniScrollTop = notebookRatio * maxMiniScroll;

    miniScroll.scrollTop = miniScrollTop;

    const thumbHeight = Math.max(
      16,
      (scroller.clientHeight / notebookScrollHeight) * minimapData.railHeight,
    );
    const thumbTravel = Math.max(0, contentHeight - thumbHeight);
    const thumbTopInTrack = notebookRatio * thumbTravel;
    const thumbTopInRail = Math.min(
      Math.max(0, thumbTopInTrack - miniScrollTop),
      Math.max(0, minimapData.railHeight - thumbHeight),
    );
    viewport.style.top = `${thumbTopInRail}px`;
    viewport.style.height = `${thumbHeight}px`;
  }, [minimapData]);

  useEffect(() => {
    updateMinimapViewport();
  }, [updateMinimapViewport]);

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
    [hydrateVisibleCells, saveScrollDebounce, updateMinimapViewport],
  );

  const onMinimapTrackMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const scroller = cellListDivRef.current as HTMLElement | null;
      const miniScroll = minimapScrollRef.current;
      if (scroller == null || minimapData == null || miniScroll == null) return;
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      if (rect.height <= 0) return;
      const y = Math.min(Math.max(0, e.clientY - rect.top), rect.height);
      const maxNotebookScroll = Math.max(
        1,
        scroller.scrollHeight - scroller.clientHeight,
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
      hydrateVisibleCells,
      minimapData,
      saveScrollDebounce,
      scrollToCellById,
      updateMinimapViewport,
    ],
  );

  const v: (React.JSX.Element | null)[] = [];
  let index: number = 0;
  let isFirst = true;
  cell_list.forEach((id: string) => {
    v.push(
      <SortableItem id={id} key={id}>
        {renderLazyCell({
          id,
          index,
          isFirst,
          isLast: cell_list.get(-1) == id,
        })}
      </SortableItem>,
    );
    isFirst = false;
    index += 1;
  });
  v.push(BOTTOM_PADDING_CELL);

  body = (
    <StableHtmlContext.Provider value={{ cellListDivRef, scrollOrResize }}>
      <div
        className="smc-vfill"
        cocalc-test="jupyter-cell-list-mode"
        data-jupyter-windowed-list="0"
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "stretch",
          minHeight: 0,
        }}
      >
        <div
          key="cells"
          className="smc-vfill"
          style={{
            fontSize: `${font_size}px`,
            paddingLeft: "5px",
            flex: 1,
            minWidth: 0,
            overflowY: "auto",
            overflowX: "hidden",
          }}
          ref={handleCellListRef}
          onClick={actions != null && complete != null ? on_click : undefined}
          onScroll={() => {
            updateScrollOrResize();
            hydrateVisibleCells();
            updateMinimapViewport();
            saveScrollDebounce();
          }}
        >
          {v}
        </div>
        {minimapData != null && (
          <div
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
                style={{
                  position: "absolute",
                  inset: 0,
                  overflowY: "auto",
                  overflowX: "hidden",
                }}
              >
                <div
                  ref={minimapTrackRef}
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
        )}
      </div>
    </StableHtmlContext.Provider>
  );

  if (actions != null) {
    // only make sortable if not read only.
    body = (
      <SortableList
        disabled={actions == null}
        items={cell_list.toJS()}
        Item={({ id }) => (
          /* This is what is displayed when dragging the given cell. */
          <div
            style={{
              background: "white",
              boxShadow: "8px 8px 4px 4px #ccc",
              fontSize: `${font_size}px`,
            }}
          >
            {renderCell({ id, isDragging: true })}
          </div>
        )}
        onDragStart={(id) => {
          frameActions.current?.set_cur_id(id);
        }}
        onDragStop={(oldIndex, newIndex) => {
          const delta = newIndex - oldIndex;
          frameActions.current?.move_selected_cells(delta);
          setTimeout(() => {
            frameActions.current?.scroll("cell visible");
          }, 0);
          setTimeout(() => {
            frameActions.current?.scroll("cell visible");
          }, 50);
        }}
      >
        {body}
      </SortableList>
    );
  }

  return (
    <FileContext.Provider
      value={{
        ...fileContext,
        noSanitize: !!trust,
        HeadingTagComponent,
        disableMarkdownCodebar: true,
      }}
    >
      {body}
    </FileContext.Provider>
  );
};

/*
DivTempHeight:

This component renders a div with an specified height
then **after the render  is committed to the screen** immediately
removes the height style. This is needed because when codemirror
editors are getting rendered, they have small initially, then
full height only after the first render... and that causes
a major problem with virtuoso.  To reproduce without this:

1. Create a notebook whose first cell has a large amount of code,
so its spans several page, and with a couple more smaller cells.
2. Scroll the first one off the screen entirely.
3. Scroll back up -- as soon as the large cell scrolls into view
there's a horrible jump to the middle of it.  This is because
the big div is temporarily tiny, and virtuoso does NOT use
absolute positioning, and when the div gets big again, everything
gets pushed down.

The easiest hack to deal with this, seems to be to record
the last measured height, then set it for the initial render
of each item, then remove it.
*/
export function DivTempHeight({ children, height }) {
  const divRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (divRef.current != null) {
      divRef.current.style.minHeight = "";
    }
  });

  const style: CSS = {
    minHeight: height,
  };

  return (
    <div ref={divRef} style={style}>
      {children}
    </div>
  );
}
