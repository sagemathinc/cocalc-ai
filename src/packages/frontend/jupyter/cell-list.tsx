/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// React component that renders the ordered list of cells

import jquery from "jquery";
import useResizeObserver from "use-resize-observer";
import { delay } from "awaiting";
import * as immutable from "immutable";
import { debounce } from "lodash";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { React, useIsMountedRef } from "@cocalc/frontend/app-framework";
import { Loading } from "@cocalc/frontend/components";
import {
  SortableItem,
  SortableList,
} from "@cocalc/frontend/components/sortable-list";
import useNotebookFrameActions from "@cocalc/frontend/frame-editors/jupyter-editor/cell-notebook/hook";
import {
  eventTargetsElement,
  isInsideKeyboardBoundary,
} from "@cocalc/frontend/keyboard/boundary";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import { AITools, NotebookMode, Scroll } from "@cocalc/jupyter/types";
import { COLORS } from "@cocalc/util/theme";
import { JupyterActions } from "./browser-actions";
import { Cell } from "./cell";
import HeadingTagComponent from "./heading-tag";
import { MINIMAP_HIDE_SCROLLBAR_CLASS } from "@cocalc/frontend/components/minimap/text-rail";
import { useNotebookMinimap } from "./minimap";
import { minimapSettingsFor } from "./minimap-settings";
import { StudioMinimap } from "./studio/studio-minimap";
import {
  computeSectionBlocks,
  computeSectionRunState,
  buildBlockLookup,
  sectionBlocksEqual,
} from "./studio/section-blocks";
import { StickyMiniTOC } from "./studio/sticky-mini-toc";
import type { StudioLayout, SectionBlock } from "./studio/types";
import { INPUT_PROMPT_COLOR, OUTPUT_STYLE } from "./prompt/base";
import { getDisplayedCellExecCount } from "./run-cell-overlay";

// This module still uses CoCalc's legacy jQuery plugins, which are not fully
// represented by the upstream jQuery types.
const $: any = jquery;

/** Extract the section title from a section block's heading cell. */
function getSectionTitle(
  block: SectionBlock | undefined,
  cells: immutable.Map<string, any>,
): string {
  if (!block || block.headingLevel === 0) return "";
  const startCell = cells.get(block.startCellId);
  const input = startCell?.get("input") ?? "";
  const firstLine = input
    .split("\n")
    .find((l: string) => /^#{1,4}\s/.test(l.trimStart()));
  return firstLine?.replace(/^#+\s*/, "").trim() ?? "";
}

const LAZY_RENDER_INITIAL_CELLS = 24;
const LAZY_RENDER_PLACEHOLDER_MIN_HEIGHT = 96;

// The classic notebook view has no collapsible sections.
const EMPTY_SECTIONS: Set<string> = new Set();

export function updateLazyCellHeights(
  container: ParentNode,
  heights: Record<string, number>,
): boolean {
  let changed = false;
  container
    .querySelectorAll<HTMLElement>(
      '[data-jupyter-lazy-cell-hydrated="1"][data-jupyter-lazy-cell-id]',
    )
    .forEach((node) => {
      const id = node.getAttribute("data-jupyter-lazy-cell-id");
      const height = node.getBoundingClientRect().height;
      if (id == null || height <= 0) return;
      const previous = heights[id] ?? 0;
      if (Math.abs(previous - height) <= 1) return;
      heights[id] = height;
      changed = true;
    });
  return changed;
}

function scheduleFrame(callback: () => void): () => void {
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
  ) {
    const frame = window.requestAnimationFrame(callback);
    return () => window.cancelAnimationFrame(frame);
  }
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
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

interface RestoreNotebookScrollOptions {
  scrollTop: any;
  getElement: () => HTMLElement | null;
  isMounted: () => boolean;
  shouldCancel?: () => boolean;
  wait?: (ms: number) => Promise<unknown>;
}

export async function restoreNotebookScroll({
  scrollTop,
  getElement,
  isMounted,
  shouldCancel,
  wait = delay,
}: RestoreNotebookScrollOptions): Promise<void> {
  const targetScrollTop = Number(scrollTop);
  if (!Number.isFinite(targetScrollTop)) return;
  /* Restore scroll state while rendering settles.  Large cells can change the
     scroll height asynchronously, but this must not fight explicit user scrolls.
  */
  let scrollHeight = 0;
  for (const tm of [0, 1, 100, 250, 500, 1000]) {
    if (!isMounted() || shouldCancel?.()) return;
    const elt = getElement();
    if (elt != null && elt.scrollHeight !== scrollHeight) {
      // dynamically rendering actually changed something
      elt.scrollTop = targetScrollTop;
      scrollHeight = elt.scrollHeight;
    }
    await wait(tm);
  }
}

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
  aiTools?: AITools;
  read_only?: boolean;
  pendingCells?: immutable.Set<string>;
  runCellOverlays?: immutable.Map<string, immutable.Map<string, any>>;
  cellViewMode?: "default" | "studio";
  studioLayout?: StudioLayout;
  readingMode?: boolean;
  frameHeight?: number;
}

function renderLoading() {
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

type LoadedCellListProps = CellListProps & {
  cell_list: immutable.List<string>;
};

export function canShowCellDragHandle(
  actions: JupyterActions | undefined,
  id: string,
): boolean {
  // Closing actions deletes their store before React necessarily unmounts.
  return actions?.store?.is_cell_editable?.(id) === true;
}

export const CellList: React.FC<CellListProps> = (props: CellListProps) => {
  if (props.cell_list == null) {
    return renderLoading();
  }
  return <LoadedCellList {...props} cell_list={props.cell_list} />;
};

const LoadedCellList: React.FC<LoadedCellListProps> = (
  props: LoadedCellListProps,
) => {
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
    aiTools,
    read_only,
    pendingCells,
    runCellOverlays,
    cellViewMode = "default",
    studioLayout,
    readingMode,
    frameHeight,
  } = props;

  const cellListDivRef = useRef<any>(null);
  const is_mounted = useIsMountedRef();
  const frameActions = useNotebookFrameActions();
  const restoreScrollActiveRef = useRef<boolean>(false);
  const restoreScrollCancelledRef = useRef<boolean>(false);
  const restoreScrollTargetRef = useRef<number | null>(null);

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

  const lazyRenderEnabled = true;
  const lazyHydratedIdsRef = useRef<Set<string>>(new Set());
  const lazyHeightsRef = useRef<Record<string, number>>({});
  const [lazyHydrationVersion, setLazyHydrationVersion] = useState<number>(0);
  const [lazyHeightVersion, setLazyHeightVersion] = useState<number>(0);

  useEffect(() => {
    if (!lazyRenderEnabled) return;
    let changed = false;
    const add = (id?: string) => {
      if (id == null || lazyHydratedIdsRef.current.has(id)) return;
      lazyHydratedIdsRef.current.add(id);
      changed = true;
    };
    for (
      let i = 0;
      i < Math.min(LAZY_RENDER_INITIAL_CELLS, cell_list.size);
      i += 1
    ) {
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

  const cellListResize = useResizeObserver({ ref: cellListDivRef });

  useEffect(() => {
    if (!lazyRenderEnabled) return;
    const container = cellListDivRef.current;
    if (container == null) return;
    return scheduleFrame(() => {
      if (updateLazyCellHeights(container, lazyHeightsRef.current)) {
        setLazyHeightVersion((version) => version + 1);
      }
    });
  }, [
    lazyRenderEnabled,
    lazyHydrationVersion,
    cell_list,
    cells,
    cm_options,
    font_size,
    is_visible,
    more_output,
    cellViewMode,
    cellListResize.width,
  ]);

  const fileContext = useFileContext();

  // Keep the blocks array referentially stable across unrelated cell changes
  // (edits, execution results): recompute, but reuse the previous array when
  // the section structure is unchanged, so blockLookup/blockInfo/blockCellIds
  // stay stable and memoized cells don't all rerender.
  const prevSectionBlocksRef = useRef<SectionBlock[] | null>(null);
  const sectionBlocks = useMemo(() => {
    if (cellViewMode !== "studio" || cell_list == null || cells == null) {
      prevSectionBlocksRef.current = null;
      return null;
    }
    const next = computeSectionBlocks(cell_list, cells);
    const prev = prevSectionBlocksRef.current;
    if (prev != null && sectionBlocksEqual(prev, next)) {
      return prev;
    }
    prevSectionBlocksRef.current = next;
    return next;
  }, [cellViewMode, cell_list, cells]);

  const blockLookup = useMemo(() => {
    if (sectionBlocks == null) return null;
    return buildBlockLookup(sectionBlocks);
  }, [sectionBlocks]);

  // Track which sections are collapsed by their heading cell ID (stable across edits)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    new Set(),
  );
  const [hoveredBlockIndex, setHoveredBlockIndex] = useState<number | null>(
    null,
  );
  // Current block index for mini TOC — always set when sections exist
  const [currentBlockIndex, setCurrentBlockIndex] = useState<number>(0);
  const toggleSection = useCallback((startCellId: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(startCellId)) {
        next.delete(startCellId);
      } else {
        next.add(startCellId);
      }
      return next;
    });
  }, []);

  // Update current block index on scroll (for mini TOC)
  useEffect(() => {
    if (cellViewMode !== "studio" || !sectionBlocks || !blockLookup) return;
    const el = cellListDivRef.current;
    if (!el) return;
    const update = () => {
      // Find the first visible cell by checking DOM elements
      const items = el.querySelectorAll("[data-jupyter-lazy-cell-id]");
      let topId: string | null = null;
      const elRect = el.getBoundingClientRect();
      for (const item of items) {
        const rect = (item as HTMLElement).getBoundingClientRect();
        if (rect.bottom > elRect.top + 2) {
          topId = (item as HTMLElement).getAttribute(
            "data-jupyter-lazy-cell-id",
          );
          break;
        }
      }
      if (!topId) return;
      const info = blockLookup.get(topId);
      if (!info) return;
      setCurrentBlockIndex(info.blockIndex);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, [cellViewMode, sectionBlocks, blockLookup, cellListDivRef.current]);

  // StudioMinimap expects cell heights keyed by index; our lazy-render
  // bookkeeping is keyed by cell id, so adapt via a derived ref.
  const studioCellHeightsRef = useRef<{ [index: number]: number }>({});
  if (cellViewMode === "studio") {
    const byIndex: { [index: number]: number } = {};
    cell_list.forEach((id: string, i: number) => {
      const h = lazyHeightsRef.current[id];
      if (h != null) {
        byIndex[i] = h;
      }
    });
    studioCellHeightsRef.current = byIndex;
  }

  async function restore_scroll(): Promise<void> {
    const targetScrollTop = Number(scrollTop);
    if (!Number.isFinite(targetScrollTop)) return;
    restoreScrollCancelledRef.current = false;
    restoreScrollActiveRef.current = true;
    restoreScrollTargetRef.current = targetScrollTop;
    try {
      await restoreNotebookScroll({
        scrollTop: targetScrollTop,
        getElement: () => cellListDivRef.current,
        isMounted: () => is_mounted.current,
        shouldCancel: () => restoreScrollCancelledRef.current,
      });
    } finally {
      restoreScrollActiveRef.current = false;
      restoreScrollTargetRef.current = null;
    }
  }

  function cancelScrollRestoreIfUserScrolled(): void {
    if (!restoreScrollActiveRef.current) return;
    const elt = cellListDivRef.current as HTMLElement | null;
    const targetScrollTop = restoreScrollTargetRef.current;
    if (elt == null || targetScrollTop == null) return;
    if (Math.abs(elt.scrollTop - targetScrollTop) > 1) {
      restoreScrollCancelledRef.current = true;
    }
  }

  function window_click(event: any): void {
    // if click in the cell list, focus the cell list; otherwise, blur it.
    const cellListElement = cellListDivRef.current;
    if (cellListElement == null) return;
    // If the clicked element was unmounted by React before this window-level
    // handler ran (e.g. clicking the studio code preview replaces it with
    // the editor), it can't be located in the DOM anymore.  Treating that as
    // "outside" would blur and disable the keyboard handler right after the
    // editor opened, silently killing Shift+Enter.  Do nothing instead.
    if (event?.target != null && event.target.isConnected === false) {
      return;
    }
    if (isInsideKeyboardBoundary(event)) {
      frameActions.current?.blur();
      return;
    }
    if (eventTargetsElement(event, cellListElement)) {
      frameActions.current?.focus();
      return;
    }
    if (event?.target != null) {
      frameActions.current?.blur();
      return;
    }

    const elt = $(cellListElement);
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
        cell[0]?.scrollIntoView({ block: "nearest" });
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
          aiTools={aiTools}
          isFirst={isFirst}
          isLast={isLast}
          showDragHandle={canShowCellDragHandle(actions, id)}
          read_only={read_only}
          isDragging={isDragging}
          isPending={pendingCells?.has(id)}
          runOverlay={runCellOverlays?.get(id)}
          cellViewMode={cellViewMode}
          blockInfo={blockLookup?.get(id)}
          blockCellIds={
            sectionBlocks && blockLookup?.has(id)
              ? sectionBlocks[blockLookup.get(id)!.blockIndex]?.cellIds
              : undefined
          }
          headingLevel={
            sectionBlocks && blockLookup?.has(id)
              ? (sectionBlocks[blockLookup.get(id)!.blockIndex]?.headingLevel ??
                0)
              : 0
          }
          isLastBlock={
            sectionBlocks && blockLookup?.has(id)
              ? blockLookup.get(id)!.blockIndex === sectionBlocks.length - 1
              : false
          }
          sectionCollapsed={
            sectionBlocks != null && blockLookup?.has(id)
              ? collapsedSections.has(
                  sectionBlocks[blockLookup.get(id)!.blockIndex]?.startCellId,
                )
              : false
          }
          collapsedRunState={
            sectionBlocks != null &&
            blockLookup?.has(id) &&
            blockLookup.get(id)!.positionInBlock === 0 &&
            collapsedSections.has(
              sectionBlocks[blockLookup.get(id)!.blockIndex]?.startCellId,
            )
              ? computeSectionRunState(
                  sectionBlocks[blockLookup.get(id)!.blockIndex]!.cellIds,
                  cells,
                )
              : undefined
          }
          onToggleSection={
            sectionBlocks != null && blockLookup?.has(id)
              ? () =>
                  toggleSection(
                    sectionBlocks[blockLookup.get(id)!.blockIndex]?.startCellId,
                  )
              : undefined
          }
          sectionTitle={
            sectionBlocks && blockLookup?.has(id)
              ? getSectionTitle(
                  sectionBlocks[blockLookup.get(id)!.blockIndex],
                  cells,
                )
              : undefined
          }
          blockHighlighted={
            blockLookup?.has(id)
              ? hoveredBlockIndex === blockLookup.get(id)!.blockIndex
              : false
          }
          onHoverBlock={
            blockLookup?.has(id)
              ? (hover: boolean) =>
                  setHoveredBlockIndex(
                    hover ? blockLookup.get(id)!.blockIndex : null,
                  )
              : undefined
          }
          studioLayout={studioLayout}
          readingMode={readingMode}
          frameHeight={frameHeight}
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

  function dragPreviewLinesForCell(id: string, index: number): string[] {
    const cell = cells.get(id);
    const input = cell?.get?.("input");
    if (typeof input === "string" && input.trim()) {
      const lines = input.split("\n").slice(0, 8);
      if (input.split("\n").length > lines.length) {
        lines.push("...");
      }
      return lines;
    }
    return [placeholderTextForCell(id, index)];
  }

  function dragPreviewPromptForCell(id: string): string {
    const cell = cells.get(id);
    if (cell?.get?.("cell_type") !== "code") {
      return "";
    }
    const execCount = getDisplayedCellExecCount(cell, runCellOverlays?.get(id));
    return `In [${execCount ?? " "}]:`;
  }

  function dragPreviewHasOutput(id: string): boolean {
    const cell = cells.get(id);
    const output = cell?.get?.("output");
    if (output == null) return false;
    return typeof output?.size === "number" ? output.size > 0 : true;
  }

  function renderDragPreview(id: string): React.JSX.Element {
    const index = cell_list.indexOf(id);
    const cell = cells.get(id);
    const cellType =
      typeof cell?.get?.("cell_type") === "string" ? cell.get("cell_type") : "";
    const prompt = dragPreviewPromptForCell(id);
    const inputLines = dragPreviewLinesForCell(id, Math.max(index, 0));
    const hasOutput = dragPreviewHasOutput(id);
    const inputBackground = cellType === "markdown" ? "white" : COLORS.GRAY_LLL;
    return (
      <div
        style={{
          width: "min(720px, calc(100vw - 48px))",
          maxHeight: "70vh",
          overflow: "hidden",
          borderLeft: `5px solid ${COLORS.BS_BLUE_TEXT}`,
          borderRadius: "5px",
          padding: "2px 2px 5px 2px",
          background: "white",
          boxShadow: `0 0 0 2px ${COLORS.BS_BLUE_TEXT}, 0 12px 32px rgba(0, 0, 0, 0.22)`,
          color: COLORS.GRAY_D,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
          }}
        >
          <div
            style={{
              color: INPUT_PROMPT_COLOR,
              minWidth: "7em",
              fontFamily: "monospace",
              textAlign: "right",
              paddingRight: "5px",
              marginTop: "8.5px",
              flex: "0 0 auto",
            }}
          >
            {prompt}
          </div>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              border: `1px solid ${COLORS.GRAY_L0}`,
              borderRadius: "2px",
              background: inputBackground,
              padding: cellType === "markdown" ? "8px 10px" : "7px 10px",
              fontFamily:
                cellType === "markdown"
                  ? undefined
                  : "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
              fontSize: `${font_size}px`,
              lineHeight: 1.35,
              whiteSpace: "pre-wrap",
              overflow: "hidden",
            }}
          >
            {inputLines.map((line, i) => (
              <div key={i}>{line || " "}</div>
            ))}
          </div>
        </div>
        {hasOutput && (
          <div
            style={{
              display: "flex",
              alignItems: "stretch",
              marginTop: "3px",
            }}
          >
            <div style={{ ...OUTPUT_STYLE, flex: "0 0 auto" }}>Out:</div>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                borderTop: `1px solid ${COLORS.GRAY_LL}`,
                color: COLORS.GRAY,
                fontSize: "12px",
                padding: "3px 10px",
              }}
            >
              output
            </div>
          </div>
        )}
      </div>
    );
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
        <div data-jupyter-lazy-cell-id={id} data-jupyter-lazy-cell-hydrated="1">
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

  let body;

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

  // Classic and Studio keep separate minimap preferences, matching how each
  // view has always looked by default.
  const minimapApi = minimapSettingsFor(cellViewMode);
  const minimap = useNotebookMinimap({
    settingsApi: minimapApi,
    cellList: cell_list,
    cells,
    curId: cur_id,
    cellListDivRef,
    cellListWidth: cellListResize.width,
    cellListHeight: cellListResize.height,
    lazyLayoutVersion: lazyHydrationVersion + lazyHeightVersion,
    lazyHeightsRef,
    placeholderMinHeight: LAZY_RENDER_PLACEHOLDER_MIN_HEIGHT,
    hydrateVisibleCells,
    saveScrollDebounce,
  });

  // Height available to a stylized minimap.  frameHeight is optional (the
  // history viewer does not pass it), so fall back to the measured scroller —
  // and hide the native scrollbar only when a map is actually there to replace
  // it, or that view would end up with no way to scroll at all.
  const stylizedMinimapHeight = cellListResize.height ?? frameHeight;
  const showStylizedMinimap =
    minimap.enabled &&
    minimap.kind === "stylized" &&
    stylizedMinimapHeight != null;

  // The stylized minimap maps the whole notebook, so it replaces the native
  // scrollbar; the text minimap is only a window onto a longer track, so there
  // the native scrollbar stays.  Both notebook views share the preference.
  const hideNativeScrollbar = showStylizedMinimap;
  useEffect(() => {
    const node = cellListDivRef.current;
    if (!node) return;
    if (hideNativeScrollbar) {
      node.classList.add(MINIMAP_HIDE_SCROLLBAR_CLASS);
    } else {
      node.classList.remove(MINIMAP_HIDE_SCROLLBAR_CLASS);
    }
  }, [hideNativeScrollbar]);

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
    <div
      className="smc-vfill"
      cocalc-test="jupyter-cell-list-mode"
      data-jupyter-windowed-list="0"
      ref={minimap.layoutRef}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minWidth: 0,
          position: "relative",
        }}
      >
        <div
          key="cells"
          className={`smc-vfill${
            hideNativeScrollbar ? ` ${MINIMAP_HIDE_SCROLLBAR_CLASS}` : ""
          }`}
          style={{
            fontSize: `${font_size}px`,
            paddingLeft: "5px",
            flex: 1,
            minWidth: 0,
            overflowY: "auto",
            overflowX: "hidden",
          }}
          ref={handleCellListRef}
          tabIndex={-1}
          onClick={actions != null && complete != null ? on_click : undefined}
          onScroll={() => {
            cancelScrollRestoreIfUserScrolled();
            hydrateVisibleCells();
            minimap.onNotebookScroll();
            saveScrollDebounce();
          }}
        >
          {v}
        </div>
        {cellViewMode === "studio" &&
          !readingMode &&
          studioLayout !== "wide" &&
          sectionBlocks != null && (
            <StickyMiniTOC
              sectionBlocks={sectionBlocks}
              currentBlockIndex={currentBlockIndex}
              cells={cells}
              studioLayout={studioLayout}
              fontSize={font_size}
              actions={!read_only ? actions : undefined}
            />
          )}
      </div>
      {showStylizedMinimap
        ? stylizedMinimapHeight != null && (
            <StudioMinimap
              settingsApi={minimapApi}
              cellList={cell_list}
              cells={cells}
              collapsedSections={
                cellViewMode === "studio" ? collapsedSections : EMPTY_SECTIONS
              }
              scrollerRef={cellListDivRef}
              // Studio measures cells through Virtuoso (by index); the classic
              // view has the lazy-render height cache (by id).
              getMeasuredHeight={
                cellViewMode === "studio"
                  ? (_id, index) => studioCellHeightsRef.current[index]
                  : (id) => lazyHeightsRef.current[id]
              }
              // the actual scroller height (the minimap's flex row), not
              // frameHeight, which includes the status bar above and would
              // make the minimap overflow the bottom of the frame
              height={stylizedMinimapHeight}
              width={minimap.width}
              curId={cur_id}
              selIds={sel_ids}
            />
          )
        : minimap.minimapNode}
    </div>
  );

  if (actions != null) {
    // only make sortable if not read only.
    body = (
      <SortableList
        disabled={actions == null}
        items={cell_list.toJS()}
        Item={({ id }) => renderDragPreview(`${id}`)}
        onDragStop={(oldIndex, newIndex, activeId) => {
          actions.moveCell(oldIndex, newIndex);
          if (activeId != null) {
            frameActions.current?.move_cursor_to_cell(`${activeId}`);
          }
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
      {minimap.settingsModal}
    </FileContext.Provider>
  );
};
