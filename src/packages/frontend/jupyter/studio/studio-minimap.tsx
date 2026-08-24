/*
 *  This file is part of CoCalc: Copyright © 2020-2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Notebook "blocks" minimap: one bar per cell, colored by execution status.

The generic bar rendering, viewport rectangle, drag and wheel handling live in
@cocalc/frontend/components/minimap/block-minimap — this module only turns
notebook cells into blocks, which is where all the Jupyter-specific knowledge
(cell status, collapsed sections, height measurement) sits.
*/

import type { List, Map, Set as ImmutableSet } from "immutable";
import React, { MutableRefObject, useMemo, useRef } from "react";

import { hash_string } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { MinimapControls } from "@cocalc/frontend/components/minimap/controls";
import { MinimapContextMenu } from "@cocalc/frontend/components/minimap/settings-ui";
import { NOTEBOOK_MINIMAP_LABELS } from "../minimap-settings";
import {
  BLOCK_MINIMAP_DEFAULT_WIDTH,
  BlockMinimap,
  createDomMinimapAdapter,
  type MinimapBlock,
} from "@cocalc/frontend/components/minimap/block-minimap";
import type { MinimapSettingsApi } from "@cocalc/frontend/components/minimap/settings";

export const JUPYTER_MINIMAP_CELL_ATTRIBUTE = "data-jupyter-lazy-cell-id";

const CURRENT_COLOR = "#42a5f5"; // blue — matches gutter

export type CellStatus =
  | "running"
  | "queued"
  | "error"
  | "stale"
  | "idle"
  | "dirty"
  | "markdown";

export function getCellStatus(
  cell: Map<string, any>,
  lastExecInputHash: { [id: string]: number },
): CellStatus {
  const cellType = cell.get("cell_type") || "code";
  if (cellType !== "code") return "markdown";
  const state = cell.get("state");
  if (state === "busy") return "running";
  if (state === "run" || state === "start") return "queued";
  const output = cell.get("output");
  if (output) {
    for (const [, msg] of output) {
      if (msg?.get?.("traceback")) return "error";
    }
  }
  // Cell has been executed — check if input changed since last run
  const id = cell.get("id");
  const snapshotHash = lastExecInputHash[id];
  // Unexecuted or modified cells are "dirty" (darker gray)
  if (!cell.get("exec_count") && !output) return "dirty";
  if (
    snapshotHash !== undefined &&
    snapshotHash !== hash_string(cell.get("input") ?? "")
  ) {
    return "dirty";
  }
  return "idle";
}

const STATUS_COLORS: Record<CellStatus, string> = {
  running: "#5cb85c",
  queued: "#2e7d32",
  error: COLORS.ANTD_RED,
  stale: COLORS.GRAY_L, // kept for type completeness
  dirty: COLORS.GRAY_L, // edited since last run / unexecuted — darker
  idle: COLORS.GRAY_L0, // clean (executed, unchanged) — lighter, same as markdown
  markdown: COLORS.GRAY_L0,
};

// Estimate for cells that were never rendered/measured: the lazy-render
// placeholder box is min-height 96 plus padding and margin.
const DEFAULT_CELL_HEIGHT = 120;

export interface StudioMinimapEntry {
  id: string;
  pixelHeight: number;
  status: CellStatus;
  isCode: boolean;
  isCurrent: boolean;
  isSelected: boolean;
}

// Priority for surfacing hidden-cell activity on a collapsed-section entry;
// anything not listed never overrides the section's default "markdown".
const COLLAPSED_STATUS_RANK: Partial<Record<CellStatus, number>> = {
  error: 1,
  queued: 2,
  running: 3,
};

export function buildStudioMinimapEntries({
  cellList,
  cells,
  collapsedSections,
  heightCache,
  lastExecInputHash,
  curId,
  selIds,
}: {
  cellList: List<string>;
  cells: Map<string, any>;
  collapsedSections: Set<string>;
  heightCache: Record<string, number>;
  lastExecInputHash: Record<string, number>;
  curId?: string;
  selIds?: ImmutableSet<string>;
}): StudioMinimapEntry[] {
  const entries: StudioMinimapEntry[] = [];
  let inCollapsed = false;
  let collapsedEntryIdx: number | null = null;

  cellList.forEach((id: string) => {
    const cell = cells.get(id);
    if (!cell) return;

    const cellType = cell.get("cell_type") || "code";
    let headingLevel = 0;
    if (cellType === "markdown") {
      const input = (cell.get("input") || "").trimStart();
      const match = input.match(/^(#{1,4})\s/);
      if (match) headingLevel = match[1].length;
    }

    if (headingLevel > 0) {
      if (collapsedSections.has(id)) {
        inCollapsed = true;
        collapsedEntryIdx = entries.length;
        entries.push({
          id,
          pixelHeight: 24,
          status: "markdown",
          isCode: false,
          isCurrent: id === curId,
          isSelected: selIds?.has(id) ?? false,
        });
        return;
      } else if (inCollapsed) {
        // Any heading ends the collapsed run: section blocks are flat
        // (computeSectionBlocks starts a new block at every heading, so
        // collapsing hides only the cells up to the next heading of ANY
        // level) — the minimap must mirror that, not a nested hierarchy.
        inCollapsed = false;
        collapsedEntryIdx = null;
      }
    }

    if (inCollapsed) {
      // Surface running/queued/error activity of hidden cells on the
      // collapsed section's single minimap entry, so a folded section still
      // shows execution feedback.
      if (collapsedEntryIdx != null && cellType === "code") {
        const status = getCellStatus(cell, lastExecInputHash);
        const rank = COLLAPSED_STATUS_RANK[status] ?? 0;
        const current =
          COLLAPSED_STATUS_RANK[entries[collapsedEntryIdx].status] ?? 0;
        if (rank > current) {
          entries[collapsedEntryIdx].status = status;
        }
      }
      return;
    }

    entries.push({
      id,
      pixelHeight: heightCache[id] ?? DEFAULT_CELL_HEIGHT,
      status: getCellStatus(cell, lastExecInputHash),
      isCode: cellType === "code",
      isCurrent: id === curId,
      isSelected: selIds?.has(id) ?? false,
    });
  });

  return entries;
}

/**
 * Colour the entries for the generic block minimap.  Running/queued takes
 * precedence over the selection highlight so users can watch execution sweep
 * through the notebook.
 */
export function minimapBlocksFromEntries(
  entries: StudioMinimapEntry[],
): MinimapBlock[] {
  return entries.map((entry) => {
    const { id, status, isCode, isCurrent, isSelected } = entry;
    const isEval = status === "running" || status === "queued";
    if (!isEval && (isCurrent || isSelected)) {
      return {
        id,
        pixelHeight: entry.pixelHeight,
        color: CURRENT_COLOR,
        opacity: isCurrent ? 0.8 : 0.5,
      };
    }
    return {
      id,
      pixelHeight: entry.pixelHeight,
      color: STATUS_COLORS[status],
      opacity: isCode ? 0.8 : 0.5,
      blink: status === "running",
    };
  });
}

interface StudioMinimapProps {
  // preferences of the notebook view this minimap belongs to
  settingsApi: MinimapSettingsApi;
  cellList: List<string>;
  cells: Map<string, any>;
  collapsedSections: Set<string>;
  scrollerRef: MutableRefObject<HTMLElement | null>;
  /**
   * Last measured pixel height of a cell, if known.  Studio measures through
   * Virtuoso (by index), the classic notebook through its lazy-render height
   * cache (by id) — hence the getter instead of one concrete container.
   */
  getMeasuredHeight: (id: string, index: number) => number | undefined;
  height: number;
  width?: number;
  curId?: string;
  selIds?: ImmutableSet<string>;
}

export const StudioMinimap: React.FC<StudioMinimapProps> = React.memo(
  ({
    settingsApi,
    cellList,
    cells,
    collapsedSections,
    scrollerRef,
    getMeasuredHeight,
    height,
    width = BLOCK_MINIMAP_DEFAULT_WIDTH,
    curId,
    selIds,
  }) => {
    // Persistent height cache: cellId → last known pixel height
    const heightCacheRef = useRef<{ [id: string]: number }>({});
    // Track cells that were evaluating in the previous render
    const prevEvaluatingRef = useRef<Set<string>>(new Set());
    // Hash of cell input at time of last execution (for dirty detection)
    const lastExecInputHashRef = useRef<{ [id: string]: number }>({});
    const prevExecCountRef = useRef<{ [id: string]: number }>({});

    const adapter = useMemo(
      () =>
        createDomMinimapAdapter({
          getScroller: () => scrollerRef.current,
          blockAttribute: JUPYTER_MINIMAP_CELL_ATTRIBUTE,
        }),
      [scrollerRef],
    );

    // Update persistent height cache from Virtuoso measurements.
    // Skip cells that are running/queued or just finished evaluating —
    // Virtuoso may still have a stale mid-evaluation measurement.
    const cache = heightCacheRef.current;
    const prevEval = prevEvaluatingRef.current;
    const currentlyEvaluating = new Set<string>();
    cellList.forEach((id: string, index: number) => {
      const cell = cells.get(id);
      const state = cell?.get("state");
      const isEvaluating =
        state === "busy" || state === "run" || state === "start";
      if (isEvaluating) {
        currentlyEvaluating.add(id);
      }
      const measured = getMeasuredHeight(id, index);
      if (measured != null && measured > 0) {
        // Don't update if cell is evaluating, or just finished (stale measurement)
        const justFinished = prevEval.has(id) && !isEvaluating;
        if (!isEvaluating && !justFinished) {
          cache[id] = measured;
        } else if (!cache[id]) {
          // No cached value at all — use whatever we have
          cache[id] = measured;
        }
      }
    });
    prevEvaluatingRef.current = currentlyEvaluating;

    // Track exec_count changes to snapshot input hash at execution time
    const lastExecInputHash = lastExecInputHashRef.current;
    const prevExecCounts = prevExecCountRef.current;
    cellList.forEach((id: string) => {
      const cell = cells.get(id);
      if (!cell) return;
      const execCount = cell.get("exec_count");
      if (execCount != null && execCount !== prevExecCounts[id]) {
        // Cell was just executed — snapshot the input hash
        lastExecInputHash[id] = hash_string(cell.get("input") ?? "");
        prevExecCounts[id] = execCount;
      }
    });

    // Build visible cell entries, respecting collapsed sections
    const entries = buildStudioMinimapEntries({
      cellList,
      cells,
      collapsedSections,
      heightCache: cache,
      lastExecInputHash,
      curId,
      selIds,
    });

    return (
      <MinimapContextMenu
        api={settingsApi}
        labels={NOTEBOOK_MINIMAP_LABELS}
        style={{ alignItems: "flex-start" }}
      >
        <BlockMinimap
          blocks={minimapBlocksFromEntries(entries)}
          height={height}
          width={width}
          adapter={adapter}
          label="Notebook minimap scrollbar"
          resubscribeKey={scrollerRef.current}
        >
          <MinimapControls api={settingsApi} labels={NOTEBOOK_MINIMAP_LABELS} />
        </BlockMinimap>
      </MinimapContextMenu>
    );
  },
);
