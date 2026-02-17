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
      viewportWidth >= (minimapOptIn ? 280 : 700);
    if (!showMinimap) return null;

    const rows: {
      id: string;
      top: number;
      height: number;
      isCurrent: boolean;
      fill: string;
      edge: string;
      hasOutput: boolean;
      title: string;
    }[] = [];
    let y = 0;
    let rawY = 0;
    const rawRows: Array<
      Omit<(typeof rows)[number], "top" | "height"> & {
        rawTop: number;
        rawHeight: number;
      }
    > = [];
    for (let i = 0; i < cell_list.size; i += 1) {
      const id = cell_list.get(i);
      if (id == null) continue;
      const cell = cells.get(id);
      const cellType = (cell?.get?.("cell_type") as string | undefined) ?? "code";
      const input = cell?.get?.("input");
      const inputLen = typeof input === "string" ? input.length : 0;
      const output = cell?.get?.("output");
      const outputWeight =
        typeof output === "string"
          ? output.length
          : output?.size != null
            ? output.size * 24
            : 0;
      const hasOutput = outputWeight > 0;
      const density = Math.min(
        1,
        Math.log1p(inputLen + outputWeight + 1) / Math.log(2500),
      );
      let fill = "rgba(71,85,105,0.45)";
      let edge = "rgba(226,232,240,0.35)";
      if (cellType === "markdown") {
        fill = `rgba(16,185,129,${0.35 + 0.5 * density})`;
        edge = "rgba(110,231,183,0.7)";
      } else if (cellType === "raw") {
        fill = `rgba(168,85,247,${0.35 + 0.45 * density})`;
        edge = "rgba(221,214,254,0.7)";
      } else {
        fill = `rgba(71,85,105,${0.35 + 0.45 * density})`;
        edge = "rgba(226,232,240,0.35)";
      }
      const rawHeight = Math.max(
        24,
        lazyHeightsRef.current[id] ?? LAZY_RENDER_PLACEHOLDER_MIN_HEIGHT,
      );
      rawRows.push({
        id,
        isCurrent: id === cur_id,
        fill,
        edge,
        hasOutput,
        title: `${cellType} #${i + 1}`,
        rawTop: rawY,
        rawHeight,
      });
      rawY += rawHeight + 10;
    }

    const rawTotalHeight = Math.max(1, rawY + 1);
    // Keep minimap scrollable for large notebooks while avoiding enormous tracks.
    const targetTrackHeight = Math.max(
      viewportHeight * 1.25,
      Math.min(viewportHeight * 3.5, rawTotalHeight * 0.06),
    );
    const scale = Math.max(0.02, Math.min(1, targetTrackHeight / rawTotalHeight));

    for (const row of rawRows) {
      const h = Math.max(2, row.rawHeight * scale);
      rows.push({
        id: row.id,
        top: y,
        height: h,
        isCurrent: row.isCurrent,
        fill: row.fill,
        edge: row.edge,
        hasOutput: row.hasOutput,
        title: row.title,
      });
      y += h + 1;
    }
    const totalContentHeight = Math.max(1, y + 1);
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

  const updateMinimapViewport = useCallback(() => {
    if (minimapData == null) return;
    const scroller = cellListDivRef.current as HTMLElement | null;
    const viewport = minimapViewportRef.current;
    const rail = minimapRailRef.current;
    const track = minimapTrackRef.current;
    if (scroller == null || viewport == null || track == null || rail == null) return;

    const maxNotebookScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    const notebookRatio = Math.min(1, Math.max(0, scroller.scrollTop / maxNotebookScroll));
    const maxMiniScroll = Math.max(0, minimapData.totalContentHeight - minimapData.railHeight);
    const miniScrollTop = notebookRatio * maxMiniScroll;

    rail.scrollTop = miniScrollTop;
    track.style.transform = "translateY(0px)";

    const thumbHeight = Math.max(
      12,
      (scroller.clientHeight / Math.max(scroller.scrollHeight, 1)) *
        minimapData.railHeight,
    );
    const thumbTravel = Math.max(0, minimapData.totalContentHeight - thumbHeight);
    const thumbTopInTrack = notebookRatio * thumbTravel;
    viewport.style.top = `${thumbTopInTrack - miniScrollTop}px`;
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
      const rail = minimapRailRef.current;
      if (scroller == null || minimapData == null || rail == null) return;
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      if (rect.height <= 0) return;
      const y = Math.min(Math.max(0, e.clientY - rect.top), rect.height);
      const maxNotebookScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
      const miniScrollTop = rail.scrollTop;
      const yContent = Math.min(
        minimapData.totalContentHeight,
        Math.max(0, miniScrollTop + y),
      );
      const targetRatio = yContent / Math.max(1, minimapData.totalContentHeight);
      scroller.scrollTop = targetRatio * maxNotebookScroll;
      hydrateVisibleCells();
      updateMinimapViewport();
      saveScrollDebounce();
      e.preventDefault();
    },
    [hydrateVisibleCells, minimapData, saveScrollDebounce, updateMinimapViewport],
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
                background: "rgba(148,163,184,0.18)",
                border: "1px solid rgba(148,163,184,0.5)",
                cursor: "pointer",
                overflowY: "auto",
                overflowX: "hidden",
              }}
            >
              <div
                ref={minimapTrackRef}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: 0,
                  height: `${minimapData.totalContentHeight}px`,
                  transform: "translateY(0px)",
                  willChange: "transform",
                }}
              >
                {minimapData.rows.map((row) => (
                  <div
                    key={`minimap-${row.id}`}
                    title={row.title}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      scrollToCellById(row.id);
                    }}
                    style={{
                      position: "absolute",
                      left: "2px",
                      right: "2px",
                      top: `${row.top}px`,
                      height: `${Math.max(2.2, row.height - 0.2)}px`,
                      borderRadius: "1px",
                      background: row.isCurrent
                        ? "rgba(59,130,246,0.92)"
                        : row.fill,
                      borderTop: row.isCurrent ? "none" : `1px solid ${row.edge}`,
                      boxShadow: row.hasOutput
                        ? "inset -2px 0 0 rgba(245,158,11,0.8)"
                        : undefined,
                    }}
                  />
                ))}
              </div>
              <div
                ref={minimapViewportRef}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: 0,
                  height: "10px",
                  border: "1px solid rgba(14,116,144,0.75)",
                  background: "rgba(56,189,248,0.2)",
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
