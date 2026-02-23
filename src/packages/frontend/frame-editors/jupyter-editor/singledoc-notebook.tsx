/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Frame for working with a Jupyter notebook in a single non-block Slate editor.
Canonical Jupyter cells remain source of truth; Slate is the interaction layer.
*/

import { List, Map } from "immutable";
import React from "react";
import { Element as SlateElement, type Descendant } from "slate";
import { Button } from "antd";
import useResizeObserver from "use-resize-observer";
import { useRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";
import { EditableMarkdown } from "@cocalc/frontend/editors/slate/editable-markdown";
import { getCodeBlockText, toCodeLines } from "@cocalc/frontend/editors/slate/elements/code-block/utils";
import { markdown_to_slate } from "@cocalc/frontend/editors/slate/markdown-to-slate";
import { slate_to_markdown } from "@cocalc/frontend/editors/slate/slate-to-markdown";
import type { Actions as SlateActions } from "@cocalc/frontend/editors/slate/types";
import { JupyterCellContext } from "@cocalc/frontend/editors/slate/jupyter-cell-context";
import type { JupyterGapCursor } from "@cocalc/frontend/editors/slate/jupyter-cell-context";
import { CellOutput } from "@cocalc/frontend/jupyter/cell-output";
import Logo from "@cocalc/frontend/jupyter/logo";
import { useNotebookMinimap } from "@cocalc/frontend/jupyter/minimap";
import type { JupyterActions } from "@cocalc/frontend/jupyter/browser-actions";
import { Kernel } from "@cocalc/frontend/jupyter/status";
import type { EditorState } from "../frame-tree/types";
import { JupyterEditorActions } from "./actions";

interface Props {
  id: string;
  name: string;
  actions: JupyterEditorActions;
  editor_state: EditorState;
  is_fullscreen: boolean;
  project_id: string;
  path: string;
  font_size: number;
  is_current: boolean;
  is_visible: boolean;
  desc: Map<string, any>;
}

type ParsedSlateCell = {
  cell_type: string;
  input: string;
  cell_id?: string;
};

type RunContext = {
  selection?: { focus?: { path?: number[] } } | null;
  slateValue?: Descendant[];
};

type ApplyNotebookSlateOpts = {
  baseSignature?: string;
};

// Keep this noticeably higher than per-keystroke cadence so focus is not
// disrupted by immediate round-trips back through canonical notebook state.
const SAVE_DEBOUNCE_MS = 800;
const MINIMAP_PLACEHOLDER_MIN_HEIGHT = 96;

function normalizeCellSource(text: string): string {
  const source = text.split("\n").map((line) => `${line}\n`);
  let i = source.length - 1;
  while (i >= 0 && !source[i].trim()) {
    i -= 1;
    source.splice(-1);
  }
  if (source.length > 0) {
    source[source.length - 1] = source[source.length - 1].trimRight();
  }
  return source.join("");
}

function runtimeLabelFromMs(ms: number | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return;
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const s = ms / 1000;
  if (s < 10) {
    return `${s.toFixed(1)}s`;
  }
  return `${Math.round(s)}s`;
}

function cellsToSlateDocument({
  cell_list,
  cells,
  kernel,
}: {
  cell_list: List<string>;
  cells: Map<string, Map<string, any>>;
  kernel?: string;
}): Descendant[] {
  const out: Descendant[] = [];
  for (const id of cell_list.toArray()) {
    const cell = cells.get(id);
    if (cell == null) continue;
    const cellType = `${cell.get("cell_type") ?? "code"}`;
    const input = `${cell.get("input") ?? ""}`;
    if (cellType === "markdown") {
      const doc = markdown_to_slate(input, false, {});
      out.push({
        type: "jupyter_markdown_cell",
        cell_id: id,
        cell_meta: { cell_type: "markdown" },
        children:
          doc.length > 0
            ? (doc as Descendant[])
            : ([{ type: "paragraph", children: [{ text: "" }] }] as any),
      } as any);
      continue;
    }
    out.push({
      type: "jupyter_code_cell",
      fence: true,
      info:
        cellType === "raw"
          ? "raw"
          : cellType === "code"
            ? `${cell.get("kernel") ?? kernel ?? ""}`
            : cellType,
      cell_id: id,
      cell_meta: { cell_type: cellType },
      children: toCodeLines(input),
    } as any);
  }
  if (out.length === 0) {
    return [
      {
        type: "jupyter_markdown_cell",
        cell_id: "m0",
        cell_meta: { cell_type: "markdown" },
        children: [{ type: "paragraph", children: [{ text: "" }] }],
      } as any,
    ];
  }
  return out;
}

function slateDocumentToCells(doc: Descendant[]): ParsedSlateCell[] {
  const ret: ParsedSlateCell[] = [];
  let markdownBuffer: Descendant[] = [];
  const pushMarkdown = (input: string, cell_id?: string) => {
    ret.push({
      cell_type: "markdown",
      input,
      cell_id,
    });
  };

  const flushMarkdown = () => {
    const markdown = normalizeCellSource(
      slate_to_markdown(markdownBuffer, {
        preserveBlankLines: false,
      }),
    );
    markdownBuffer = [];
    if (!markdown.trim()) return;
    pushMarkdown(markdown);
  };

  for (const node of doc) {
    if (
      SlateElement.isElement(node as any) &&
      (node as any).type === "jupyter_markdown_cell"
    ) {
      flushMarkdown();
      const children = (node as any).children ?? [];
      const markdown = normalizeCellSource(
        slate_to_markdown(children as Descendant[], {
          preserveBlankLines: false,
        }),
      );
      pushMarkdown(markdown, `${(node as any).cell_id ?? ""}`.trim() || undefined);
      continue;
    }
    if (
      SlateElement.isElement(node as any) &&
      (node as any).type === "jupyter_code_cell"
    ) {
      flushMarkdown();
      const input = getCodeBlockText(node as any);
      const metaCellType = `${(node as any).cell_meta?.cell_type ?? ""}`.trim();
      const info = `${(node as any).info ?? ""}`.toLowerCase();
      const cell_type =
        metaCellType === ""
          ? info === "raw"
            ? "raw"
            : "code"
          : metaCellType;
      ret.push({
        cell_type,
        input,
        cell_id: (node as any).cell_id,
      });
      continue;
    }
    markdownBuffer.push(node);
  }
  flushMarkdown();

  if (ret.length === 0) {
    ret.push({ cell_type: "markdown", input: "", cell_id: undefined });
  }
  return ret;
}

function findCellIdFromSlateContext({
  context,
  cell_list,
  idMap,
}: {
  context?: RunContext;
  cell_list: List<string>;
  idMap?: globalThis.Map<string, string>;
}): string | undefined {
  const topIndex = context?.selection?.focus?.path?.[0];
  const doc = context?.slateValue;
  if (
    !Array.isArray(doc) ||
    typeof topIndex !== "number" ||
    !Number.isInteger(topIndex)
  ) {
    return;
  }
  const ids = new Set(cell_list.toArray());
  const getIdAt = (index: number): string | undefined => {
    const node = doc[index] as any;
    if (!SlateElement.isElement(node) || node.type !== "jupyter_code_cell") {
      return;
    }
    const rawId = `${node.cell_id ?? ""}`.trim();
    if (!rawId) {
      return;
    }
    if (ids.has(rawId)) {
      return rawId;
    }
    const mappedId = idMap?.get(rawId);
    if (mappedId != null && ids.has(mappedId)) {
      return mappedId;
    }
    return;
  };

  const direct = getIdAt(topIndex);
  if (direct != null) {
    return direct;
  }
  for (let i = topIndex - 1; i >= 0; i--) {
    const id = getIdAt(i);
    if (id != null) {
      return id;
    }
  }
  for (let i = topIndex + 1; i < doc.length; i++) {
    const id = getIdAt(i);
    if (id != null) {
      return id;
    }
  }
  return;
}

function cellsSignature(cells: Array<Pick<ParsedSlateCell, "cell_type" | "input">>): string {
  return cells
    .map((cell) => `${cell.cell_type}\u0000${normalizeCellSource(`${cell.input ?? ""}`)}`)
    .join("\u0001");
}

function notebookCellsSignature(
  cell_list: List<string> | undefined,
  cells: Map<string, Map<string, any>> | undefined,
): string {
  if (cell_list == null || cells == null) return "";
  const parsed: Array<{ cell_type: string; input: string }> = [];
  for (const id of cell_list.toArray()) {
    const cellType = `${cells.getIn([id, "cell_type"]) ?? "code"}`;
    const input = `${cells.getIn([id, "input"]) ?? ""}`;
    parsed.push({ cell_type: cellType, input });
  }
  return cellsSignature(parsed);
}

function isTransientCellId(id: string): boolean {
  return /^tmp[-_]/.test(id);
}

function firstTextPath(node: any, pathPrefix: number[]): number[] | undefined {
  if (node == null) return;
  if (typeof node.text === "string") {
    return pathPrefix;
  }
  const children = node.children;
  if (!Array.isArray(children)) return;
  for (let i = 0; i < children.length; i++) {
    const found = firstTextPath(children[i], pathPrefix.concat(i));
    if (found != null) return found;
  }
  return;
}

function findCellStartPathInSlateDoc(doc: Descendant[], cellId: string): number[] | undefined {
  if (!cellId) return;
  for (let i = 0; i < doc.length; i++) {
    const node = doc[i] as any;
    if (!SlateElement.isElement(node)) continue;
    if (`${(node as any).cell_id ?? ""}`.trim() !== cellId) continue;
    return firstTextPath(node, [i]);
  }
  return;
}

function selectedTopCellIdInSlateDoc(doc: Descendant[], selection: any): string | undefined {
  if (!selection) return;
  const focusPath = selection?.focus?.path;
  const anchorPath = selection?.anchor?.path;
  const path = Array.isArray(focusPath) ? focusPath : anchorPath;
  const topIndex = Array.isArray(path) ? path[0] : undefined;
  if (!Number.isInteger(topIndex)) return;
  const node = doc[topIndex as number] as any;
  if (!SlateElement.isElement(node)) return;
  const cellId = `${(node as any).cell_id ?? ""}`.trim();
  return cellId || undefined;
}

export function SingleDocNotebook(props: Props): React.JSX.Element {
  const jupyter_actions: JupyterActions = props.actions.jupyter_actions;
  const name = jupyter_actions.name;
  const cell_list: List<string> | undefined = useRedux([name, "cell_list"]);
  const cells: Map<string, Map<string, any>> | undefined = useRedux([name, "cells"]);
  const trust: boolean | undefined = useRedux([name, "trust"]);
  const read_only: boolean | undefined = useRedux([name, "read_only"]);
  const more_output: Map<string, any> | undefined = useRedux([name, "more_output"]);
  const kernel: string | undefined = useRedux([name, "kernel"]);
  const kernelState: string | undefined = useRedux([name, "kernel_state"]);
  const kernelDisplayName: string | undefined = useRedux([
    name,
    "kernel_info",
    "display_name",
  ]);
  const directory: string | undefined = useRedux([name, "directory"]);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const editorViewportRef = React.useRef<HTMLDivElement>(null);
  const editableContainerRef = React.useRef<HTMLDivElement>(null);
  const editableScrollRef = React.useRef<HTMLDivElement>(null);
  const minimapScrollTargetRef = React.useRef<HTMLDivElement | null>(null);
  const controlRef = React.useRef<any>(null);
  const [minimapTargetVersion, setMinimapTargetVersion] = React.useState(0);
  const [error, setError] = React.useState<string>("");
  const [selectedCellId, setSelectedCellId] = React.useState<string | undefined>(
    undefined,
  );
  const [hoveredCellId, setHoveredCellId] = React.useState<string | undefined>(
    undefined,
  );
  const [gapCursor, setGapCursor] = React.useState<JupyterGapCursor | null>(
    null,
  );
  const lazyHeightsRef = React.useRef<Record<string, number>>({});
  const applyNotebookSlateRef = React.useRef<
    (doc: Descendant[], opts?: ApplyNotebookSlateOpts) => void
  >(() => {});
  const pendingSlateSyncTimerRef = React.useRef<number | null>(null);
  const pendingSlateDocRef = React.useRef<Descendant[] | null>(null);
  const pendingSlateBaseSignatureRef = React.useRef<string | undefined>(undefined);
  const pendingFocusCellIdRef = React.useRef<string | undefined>(undefined);
  const recentRunRef = React.useRef<{
    targetId: string;
    insertBelow: boolean;
    signature: string;
    ts: number;
  } | null>(null);
  const transientIdMapRef = React.useRef<globalThis.Map<string, string>>(
    new globalThis.Map(),
  );
  const notebookSignatureRef = React.useRef<string>("");
  const debugCountersRef = React.useRef({
    applyNotebookSlateCalls: 0,
    applyNotebookSlateMutations: 0,
    applyNotebookSlateStaleBase: 0,
    rejectedStaleStructuralApplies: 0,
    rejectedStaleCells: 0,
    pendingFocusSkips: 0,
    onSlateChangeCalls: 0,
    runCellAtCursorCalls: 0,
    runCellAtCursorDroppedDuplicates: 0,
  });

  const slateValue = React.useMemo(() => {
    if (cell_list == null || cells == null) return [] as Descendant[];
    return cellsToSlateDocument({ cell_list, cells, kernel });
  }, [cell_list, cells, kernel]);

  const notebookSignature = React.useMemo(
    () => notebookCellsSignature(cell_list, cells),
    [cell_list, cells],
  );
  const minimapCellList = cell_list ?? List<string>();
  const minimapCells = cells ?? Map<string, Map<string, any>>();
  const editableContainerElementRef =
    editableContainerRef as React.RefObject<HTMLDivElement>;
  const editableScrollElementRef =
    editableScrollRef as React.RefObject<HTMLDivElement>;
  const editorViewportElementRef =
    editorViewportRef as React.RefObject<HTMLDivElement>;
  const pickMinimapScrollTarget = React.useCallback((): HTMLDivElement | null => {
    const root = containerRef.current;
    const outer = editableContainerRef.current;
    const inner = editableScrollRef.current;
    const candidates: HTMLDivElement[] = [];
    const seen = new Set<HTMLDivElement>();
    const push = (el?: HTMLDivElement | null) => {
      if (el == null || seen.has(el)) return;
      seen.add(el);
      candidates.push(el);
    };
    push(inner);
    push(outer);
    if (root != null) {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
        if (!(el instanceof HTMLDivElement)) continue;
        const style = window.getComputedStyle(el);
        if (!["auto", "scroll", "overlay"].includes(style.overflowY)) continue;
        push(el);
      }
    }
    if (candidates.length === 0) return null;

    let best: HTMLDivElement | null = null;
    let bestScrollable = -1;
    for (const candidate of candidates) {
      const scrollable = Math.max(0, candidate.scrollHeight - candidate.clientHeight);
      if (scrollable > bestScrollable) {
        best = candidate;
        bestScrollable = scrollable;
      }
    }
    if (best != null && bestScrollable > 1) {
      return best;
    }
    // If nothing is currently scrollable, prefer a visible container with
    // overflow behavior so later relayout retries can promote it.
    for (const candidate of candidates) {
      if (candidate.clientHeight > 0) return candidate;
    }
    return candidates[0];
  }, []);
  const refreshMinimapScrollTarget = React.useCallback(() => {
    const prev = minimapScrollTargetRef.current;
    const next =
      pickMinimapScrollTarget() ??
      editableContainerRef.current ??
      editableScrollRef.current ??
      null;
    minimapScrollTargetRef.current = next;
    if (prev !== next) {
      setMinimapTargetVersion((n) => n + 1);
    }
  }, [pickMinimapScrollTarget]);
  const cellListResize = useResizeObserver({
    ref: editableContainerElementRef as React.RefObject<Element>,
  });
  const viewportResize = useResizeObserver({
    ref: editorViewportElementRef as React.RefObject<Element>,
  });
  const minimap = useNotebookMinimap({
    cellList: minimapCellList,
    cells: minimapCells as any,
    curId: selectedCellId ?? hoveredCellId,
    cellListDivRef: minimapScrollTargetRef as React.MutableRefObject<any>,
    cellListWidth:
      minimapScrollTargetRef.current?.clientWidth ??
      editorViewportRef.current?.clientWidth ??
      viewportResize.width ??
      cellListResize.width,
    cellListHeight:
      minimapScrollTargetRef.current?.clientHeight ??
      editorViewportRef.current?.clientHeight ??
      viewportResize.height ??
      cellListResize.height,
    lazyHydrationVersion: minimapTargetVersion,
    lazyHeightsRef,
    placeholderMinHeight: MINIMAP_PLACEHOLDER_MIN_HEIGHT,
    hydrateVisibleCells: () => {},
    saveScrollDebounce: () => {},
  });

  React.useEffect(() => {
    notebookSignatureRef.current = notebookSignature;
  }, [notebookSignature]);

  React.useEffect(() => {
    const next: Record<string, number> = {};
    if (cell_list != null && cells != null) {
      for (const id of cell_list.toArray()) {
        const cell = cells.get(id);
        const cellType = `${cell?.get("cell_type") ?? "code"}`;
        const input = `${cell?.get("input") ?? ""}`;
        const lineCount = Math.max(1, input.split("\n").length);
        const base = cellType === "markdown" ? 32 : 38;
        const lineHeight = cellType === "markdown" ? 18 : 16;
        const output = cell?.get("output");
        const outputWeight =
          typeof output === "string"
            ? output.length
            : output?.size != null
              ? output.size * 18
              : 0;
        let estimated =
          base + Math.min(lineCount, 80) * lineHeight + (outputWeight > 0 ? 28 : 0);
        estimated = Math.max(
          MINIMAP_PLACEHOLDER_MIN_HEIGHT,
          Math.min(1200, estimated),
        );
        next[id] = estimated;
      }
    }
    lazyHeightsRef.current = next;
  }, [cell_list, cells]);

  React.useEffect(() => {
    if (!selectedCellId || cell_list == null) return;
    if (!cell_list.includes(selectedCellId)) {
      setSelectedCellId(undefined);
    }
  }, [selectedCellId, cell_list]);

  React.useEffect(() => {
    if (!hoveredCellId || cell_list == null) return;
    if (!cell_list.includes(hoveredCellId)) {
      setHoveredCellId(undefined);
    }
  }, [hoveredCellId, cell_list]);

  React.useEffect(() => {
    refreshMinimapScrollTarget();
  }, [
    refreshMinimapScrollTarget,
    slateValue,
    cellListResize.width,
    cellListResize.height,
    viewportResize.width,
    viewportResize.height,
  ]);

  React.useEffect(() => {
    const root = containerRef.current;
    if (root == null) return;
    const onScroll = () => {
      refreshMinimapScrollTarget();
      minimap.onNotebookScroll();
    };
    root.addEventListener("scroll", onScroll, { capture: true });
    return () => {
      root.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [minimap.onNotebookScroll, refreshMinimapScrollTarget]);

  React.useEffect(() => {
    minimap.onNotebookScroll();
  }, [minimap.onNotebookScroll, slateValue]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    let raf1 = 0;
    let raf2 = 0;
    let settleTimer: number | undefined;
    let settleCount = 0;
    const settleRefresh = () => {
      refreshMinimapScrollTarget();
      minimap.onNotebookScroll();
      settleCount += 1;
      if (settleCount < 12) {
        settleTimer = window.setTimeout(settleRefresh, 150);
      }
    };
    raf1 = window.requestAnimationFrame(() => {
      refreshMinimapScrollTarget();
      minimap.onNotebookScroll();
      raf2 = window.requestAnimationFrame(() => {
        refreshMinimapScrollTarget();
        minimap.onNotebookScroll();
        settleRefresh();
      });
    });
    return () => {
      if (raf1) window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
      if (settleTimer != null) window.clearTimeout(settleTimer);
    };
  }, [minimap.onNotebookScroll, refreshMinimapScrollTarget]);

  React.useEffect(() => {
    const targetId = pendingFocusCellIdRef.current;
    if (!targetId) return;
    const getSelection = controlRef.current?.getSelection;
    const currentSelection =
      typeof getSelection === "function" ? getSelection() : undefined;
    if (selectedTopCellIdInSlateDoc(slateValue, currentSelection) === targetId) {
      pendingFocusCellIdRef.current = undefined;
      debugCountersRef.current.pendingFocusSkips += 1;
      return;
    }
    const path = findCellStartPathInSlateDoc(slateValue, targetId);
    if (path == null) return;
    const setSelection = controlRef.current?.setSelection;
    if (typeof setSelection !== "function") return;
    const ok = setSelection({
      anchor: { path, offset: 0 },
      focus: { path, offset: 0 },
    });
    if (ok) {
      pendingFocusCellIdRef.current = undefined;
    }
  }, [slateValue]);

  const focusCellInSlate = React.useCallback((cellId: string | undefined) => {
    if (!cellId) return;
    pendingFocusCellIdRef.current = cellId;
    setSelectedCellId(cellId);
  }, []);

  const allowNextFocusedSlateMerge = React.useCallback(() => {
    controlRef.current?.allowNextValueUpdateWhileFocused?.();
  }, []);

  const flushPendingSlateSync = React.useCallback(() => {
    if (pendingSlateSyncTimerRef.current != null) {
      window.clearTimeout(pendingSlateSyncTimerRef.current);
      pendingSlateSyncTimerRef.current = null;
      pendingSlateBaseSignatureRef.current = undefined;
    }
    if (pendingSlateDocRef.current != null) {
      const pending = pendingSlateDocRef.current;
      pendingSlateDocRef.current = null;
      pendingSlateBaseSignatureRef.current = undefined;
      applyNotebookSlateRef.current(pending, {
        baseSignature: "__stale__",
      });
    }
  }, []);

  const runCellAtCursor = React.useCallback(
    ({
      insertBelow,
      context,
    }: {
      insertBelow: boolean;
      context?: RunContext;
    }) => {
      debugCountersRef.current.runCellAtCursorCalls += 1;
      if (cell_list == null) {
        return;
      }
      flushPendingSlateSync();
      if (context?.slateValue != null) {
        pendingSlateDocRef.current = null;
        pendingSlateBaseSignatureRef.current = undefined;
        applyNotebookSlateRef.current(context.slateValue, {
          baseSignature: "__stale__",
        });
      }
      const fromSlate = findCellIdFromSlateContext({
        context,
        cell_list,
        idMap: transientIdMapRef.current,
      });
      let targetId = fromSlate;
      if (targetId == null) {
        targetId =
          cell_list.find((id) => {
            const cellType = `${cells?.getIn([id, "cell_type"]) ?? "code"}`;
            return cellType === "code";
          }) ?? cell_list.first();
      }
      if (targetId == null) {
        // Helpful when debugging key-routing issues in this experimental editor.
        // eslint-disable-next-line no-console
        console.log("jupyter-singledoc: no target cell for run", {
          fromSlate,
          hasContext: context != null,
          hasSelection: context?.selection != null,
        });
        return;
      }
      const now = Date.now();
      const signature = notebookSignatureRef.current;
      const recent = recentRunRef.current;
      if (
        recent != null &&
        recent.targetId === targetId &&
        recent.insertBelow === insertBelow &&
        recent.signature === signature &&
        now - recent.ts < 80
      ) {
        debugCountersRef.current.runCellAtCursorDroppedDuplicates += 1;
        return;
      }
      recentRunRef.current = {
        targetId,
        insertBelow,
        signature,
        ts: now,
      };
      // eslint-disable-next-line no-console
      console.log("jupyter-singledoc: run dispatch", {
        targetId,
        insertBelow,
        fromSlate,
      });
      focusCellInSlate(targetId);
      const runTarget = () => {
        jupyter_actions.runCells([targetId]);
      };
      if (insertBelow) {
        allowNextFocusedSlateMerge();
        runTarget();
        const newId = jupyter_actions.insert_cell_adjacent(targetId, 1);
        focusCellInSlate(newId);
      } else {
        runTarget();
        const idx = cell_list.indexOf(targetId);
        if (idx >= 0 && idx < cell_list.size - 1) {
          const nextId = cell_list.get(idx + 1);
          focusCellInSlate(nextId ?? targetId);
        } else {
          allowNextFocusedSlateMerge();
          const newId = jupyter_actions.insert_cell_adjacent(targetId, 1);
          focusCellInSlate(newId);
        }
      }
    },
    [
      jupyter_actions,
      cell_list,
      cells,
      focusCellInSlate,
      flushPendingSlateSync,
      allowNextFocusedSlateMerge,
    ],
  );

  const runCellById = React.useCallback(
    (cellId: string, opts?: { insertBelow?: boolean }) => {
      if (!cellId) return;
      flushPendingSlateSync();
      const runTarget = () => {
        jupyter_actions.runCells([cellId]);
      };
      if (opts?.insertBelow) {
        allowNextFocusedSlateMerge();
        runTarget();
        const newId = jupyter_actions.insert_cell_adjacent(cellId, 1);
        focusCellInSlate(newId);
      } else {
        runTarget();
        focusCellInSlate(cellId);
      }
    },
    [
      jupyter_actions,
      focusCellInSlate,
      flushPendingSlateSync,
      allowNextFocusedSlateMerge,
    ],
  );

  const insertCellAbove = React.useCallback(
    (cellId: string, kind: "code" | "markdown") => {
      flushPendingSlateSync();
      allowNextFocusedSlateMerge();
      const ids = cell_list?.toArray() ?? [];
      const targetId = ids.includes(cellId) ? cellId : ids[0];
      let newId: string | undefined;
      if (!targetId) {
        newId = jupyter_actions.insert_cell_at(0);
      } else {
        const idx = ids.indexOf(targetId);
        if (idx <= 0) {
          newId = jupyter_actions.insert_cell_at(0);
        } else {
          const prev = ids[idx - 1];
          newId = prev
            ? jupyter_actions.insert_cell_adjacent(prev, 1)
            : jupyter_actions.insert_cell_at(0);
        }
      }
      if (!newId) return;
      if (kind === "markdown") {
        jupyter_actions.set_cell_type(newId, "markdown");
      }
      focusCellInSlate(newId);
    },
    [
      cell_list,
      flushPendingSlateSync,
      jupyter_actions,
      focusCellInSlate,
      allowNextFocusedSlateMerge,
    ],
  );

  const insertCellAtEnd = React.useCallback(
    (kind: "code" | "markdown") => {
      flushPendingSlateSync();
      allowNextFocusedSlateMerge();
      const lastId = cell_list?.last();
      const newId =
        lastId == null
          ? jupyter_actions.insert_cell_at(0)
          : jupyter_actions.insert_cell_adjacent(lastId, 1);
      if (kind === "markdown") {
        jupyter_actions.set_cell_type(newId, "markdown");
      }
      focusCellInSlate(newId);
    },
    [
      cell_list,
      flushPendingSlateSync,
      jupyter_actions,
      focusCellInSlate,
      allowNextFocusedSlateMerge,
    ],
  );

  const stopCellById = React.useCallback(
    (_cellId: string) => {
      void jupyter_actions.signal("SIGINT");
    },
    [jupyter_actions],
  );

  const openAssistantForCell = React.useCallback(
    async (cellId: string) => {
      if (!cellId) return;
      setSelectedCellId(cellId);
      const frameActions = props.actions.get_frame_actions(props.id) as any;
      await frameActions?.command?.("chatgpt");
    },
    [props.actions, props.id],
  );

  const openKernelMenu = React.useCallback(async () => {
    await jupyter_actions.show_select_kernel("user request");
  }, [jupyter_actions]);

  const openClassicFrame = React.useCallback(() => {
    props.actions.set_frame_type(props.id, "jupyter_cell_notebook");
  }, [props.actions, props.id]);

  const applyNotebookSlate = React.useCallback(
    (doc: Descendant[], opts?: ApplyNotebookSlateOpts) => {
      debugCountersRef.current.applyNotebookSlateCalls += 1;
      if (read_only || cell_list == null || cells == null) {
        return;
      }
      const parsed = slateDocumentToCells(doc);
      if (cellsSignature(parsed) === notebookSignatureRef.current) {
        return;
      }
      const originalIds = cell_list.toArray();
      const staleBase =
        opts?.baseSignature != null &&
        opts.baseSignature !== notebookSignatureRef.current;
      if (staleBase) {
        // Canonical notebook changed since this local snapshot was taken.
        // In stale mode, only apply edits to currently-existing ids and
        // reject all structural transforms (create/delete/reorder).
        debugCountersRef.current.applyNotebookSlateStaleBase += 1;
        const transientIdMap = transientIdMapRef.current;
        const existingIds = new Set(originalIds);
        const parsedById = new globalThis.Map<string, ParsedSlateCell>();
        let rejectedCells = 0;

        for (const cell of parsed) {
          const rawId = `${cell.cell_id ?? ""}`.trim();
          if (!rawId) {
            const meaningful = cell.cell_type !== "markdown" || cell.input.trim() !== "";
            if (meaningful) rejectedCells += 1;
            continue;
          }
          const mappedId = transientIdMap.get(rawId) ?? rawId;
          if (!existingIds.has(mappedId) || parsedById.has(mappedId)) {
            rejectedCells += 1;
            continue;
          }
          parsedById.set(mappedId, cell);
          if (mappedId !== rawId) {
            transientIdMap.set(rawId, mappedId);
          }
        }

        let didMutate = false;
        for (const id of originalIds) {
          const cell = parsedById.get(id);
          if (cell == null) continue;
          const currentCell = cells.get(id) ?? jupyter_actions.store.getIn(["cells", id]);
          const currentType = `${currentCell?.get("cell_type") ?? "code"}`;
          const nextType = cell.cell_type;
          if (currentType !== nextType) {
            jupyter_actions.set_cell_type(id, nextType, false);
            didMutate = true;
          }
          const currentInput = `${currentCell?.get("input") ?? ""}`;
          if (currentInput !== cell.input) {
            jupyter_actions.set_cell_input(id, cell.input, false);
            didMutate = true;
          }
        }

        if (rejectedCells > 0) {
          debugCountersRef.current.rejectedStaleStructuralApplies += 1;
          debugCountersRef.current.rejectedStaleCells += rejectedCells;
        }

        if (didMutate) {
          debugCountersRef.current.applyNotebookSlateMutations += 1;
          (jupyter_actions as any)._sync?.();
          (jupyter_actions as any).save_asap?.();
        }
        setError("");
        return;
      }
      const parsedToApply: ParsedSlateCell[] = [];
      const ids = [...originalIds];
      let didMutate = false;
      const used = new Set<string>();
      const resolvedIds: string[] = [];
      const transientIdMap = transientIdMapRef.current;
      const existingIdSet = new Set(ids);
      let ambiguousStructure = false;

      const makeNewCell = (cellType: ParsedSlateCell["cell_type"]): string => {
        const prev = resolvedIds[resolvedIds.length - 1];
        const newId =
          prev == null
            ? jupyter_actions.insert_cell_at(0, false)
            : jupyter_actions.insert_cell_adjacent(prev, 1, false);
        ids.push(newId);
        existingIdSet.add(newId);
        if (cellType !== "code") {
          jupyter_actions.set_cell_type(newId, cellType, false);
        }
        didMutate = true;
        return newId;
      };

      const allowDropBlankMarkdown = parsed.length > 1;
      for (const cell of parsed) {
        const rawId = `${cell.cell_id ?? ""}`.trim();
        const mappedFromTemp = rawId ? transientIdMap.get(rawId) : undefined;
        const requestedId = mappedFromTemp ?? rawId;
        const emptyMarkdown = cell.cell_type === "markdown" && !cell.input.trim();
        let resolvedId: string | undefined;

        if (requestedId && existingIdSet.has(requestedId) && !used.has(requestedId)) {
          resolvedId = requestedId;
          if (rawId && requestedId !== rawId) {
            transientIdMap.set(rawId, requestedId);
          }
        } else if (rawId && isTransientCellId(rawId)) {
          // Structural creation is only allowed for explicit transient ids that
          // are introduced by single-doc editing actions (insert/split/paste).
          resolvedId = makeNewCell(cell.cell_type);
          transientIdMap.set(rawId, resolvedId);
        } else if (!rawId) {
          if (allowDropBlankMarkdown && emptyMarkdown) {
            // Ignore transient blank wrappers that can appear around boundaries.
            continue;
          }
          ambiguousStructure = true;
          continue;
        } else if (!existingIdSet.has(rawId)) {
          // Unknown non-transient ids are ambiguous.  Do not remap them onto
          // canonical ids, since that can duplicate content across cells.
          ambiguousStructure = true;
          continue;
        } else {
          // Duplicate use of an existing canonical id is ambiguous; skip this
          // node and avoid structural mutations in this apply.
          ambiguousStructure = true;
          continue;
        }

        if (resolvedId == null) continue;
        used.add(resolvedId);
        resolvedIds.push(resolvedId);
        parsedToApply.push(cell);
      }

      for (let i = 0; i < parsedToApply.length; i++) {
        const id = resolvedIds[i];
        const cell = parsedToApply[i];
        const currentCell = cells.get(id) ?? jupyter_actions.store.getIn(["cells", id]);
        const currentType = `${currentCell?.get("cell_type") ?? "code"}`;
        const nextType = cell.cell_type;
        if (currentType !== nextType) {
          jupyter_actions.set_cell_type(id, nextType, false);
          didMutate = true;
        }
        const currentInput = `${currentCell?.get("input") ?? ""}`;
        if (currentInput !== cell.input) {
          jupyter_actions.set_cell_input(id, cell.input, false);
          didMutate = true;
        }
      }

      if (!ambiguousStructure) {
        const idsToDelete = originalIds.filter((id) => !used.has(id));
        if (idsToDelete.length > 0) {
          jupyter_actions.delete_cells(idsToDelete, false);
          didMutate = true;
        }

        // Keep notebook order aligned with top-level Slate order.
        const orderChanged =
          resolvedIds.length !== originalIds.length ||
          resolvedIds.some((id, i) => originalIds[i] !== id);
        if (orderChanged) {
          for (let i = 0; i < resolvedIds.length; i++) {
            const id = resolvedIds[i];
            const currentPos = Number(cells.getIn([id, "pos"]));
            const nextPos = i + 1;
            if (!Number.isFinite(currentPos) || currentPos !== nextPos) {
              jupyter_actions.set_cell_pos(id, nextPos, false);
              didMutate = true;
            }
          }
        }
      }

      // Keep temporary mapping table bounded to ids still present in the document.
      const resolvedSet = new Set(resolvedIds);
      for (const [tempId, mappedId] of transientIdMap) {
        if (!resolvedSet.has(mappedId)) {
          transientIdMap.delete(tempId);
        }
      }

      if (didMutate) {
        debugCountersRef.current.applyNotebookSlateMutations += 1;
        (jupyter_actions as any)._sync?.();
        (jupyter_actions as any).save_asap?.();
      }
      setError("");
    },
    [read_only, cell_list, cells, jupyter_actions],
  );
  applyNotebookSlateRef.current = applyNotebookSlate;

  const scheduleApplyNotebookSlate = React.useCallback(
    (doc: Descendant[]) => {
      if (read_only) return;
      pendingSlateDocRef.current = doc;
      pendingSlateBaseSignatureRef.current = notebookSignatureRef.current;
      if (pendingSlateSyncTimerRef.current != null) {
        window.clearTimeout(pendingSlateSyncTimerRef.current);
      }
      pendingSlateSyncTimerRef.current = window.setTimeout(() => {
        pendingSlateSyncTimerRef.current = null;
        const pending = pendingSlateDocRef.current;
        const baseSignature = pendingSlateBaseSignatureRef.current;
        pendingSlateDocRef.current = null;
        pendingSlateBaseSignatureRef.current = undefined;
        if (pending != null) {
          applyNotebookSlateRef.current(pending, { baseSignature });
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [read_only],
  );

  React.useEffect(() => {
    return () => {
      if (pendingSlateSyncTimerRef.current != null) {
        window.clearTimeout(pendingSlateSyncTimerRef.current);
      }
      pendingSlateSyncTimerRef.current = null;
      pendingSlateDocRef.current = null;
      pendingSlateBaseSignatureRef.current = undefined;
    };
  }, []);

  const renderInlineOutput = React.useCallback(
    (cellId: string) => {
      if (cells == null) return null;
      const cell = cells.get(cellId);
      if (cell == null || `${cell.get("cell_type") ?? "code"}` !== "code") {
        return null;
      }
      if (
        cell.get("output") == null &&
        cell.get("state") == null &&
        more_output?.get(cellId) == null
      ) {
        return null;
      }
      return (
        <div
          style={{ margin: "2px 0 10px 0" }}
          data-cocalc-test="jupyter-singledoc-output"
          data-cocalc-cell-id={cellId}
        >
          <CellOutput
            actions={jupyter_actions}
            id={cellId}
            cell={cell}
            project_id={props.project_id}
            directory={directory}
            more_output={more_output?.get(cellId)}
            trust={!!trust}
            hidePrompt
          />
        </div>
      );
    },
    [cells, more_output, jupyter_actions, props.project_id, directory, trust],
  );

  const getCellChromeInfo = React.useCallback(
    (cellId: string) => {
      const cell = cells?.get(cellId);
      if (cell == null) {
        return {};
      }
      const execCountRaw = cell.get("exec_count");
      const execCount =
        execCountRaw == null || execCountRaw === ""
          ? undefined
          : `${execCountRaw}`;
      const runtimeMs =
        Number(cell.getIn(["metadata", "cocalc", "last_runtime_ms"])) ||
        Number(cell.get("last_runtime_ms")) ||
        undefined;
      const runtimeLabel = runtimeLabelFromMs(runtimeMs);
      const stateRaw = `${cell.get("state") ?? ""}`.toLowerCase();
      const state = stateRaw === "running" ? "busy" : stateRaw;
      const running = state === "busy" || state === "run" || state === "start";
      const start = Number(cell.get("start"));
      const end = Number(cell.get("end"));
      const last = Number(cell.get("last"));
      const kernel = `${cell.get("kernel") ?? ""}`.trim() || undefined;
      return {
        execCount,
        runtimeLabel,
        running,
        state,
        start: Number.isFinite(start) ? start : undefined,
        end: Number.isFinite(end) ? end : undefined,
        last: Number.isFinite(last) ? last : undefined,
        kernel,
      };
    },
    [cells],
  );

  const editorActions = React.useMemo<SlateActions | undefined>(() => {
    if (read_only || cell_list == null || cells == null) {
      return;
    }
    const proxy = Object.create(props.actions) as SlateActions & {
      _syncstring?: any;
    };
    proxy._syncstring = undefined;
    proxy.set_slate_value = (doc: Descendant[]) => {
      try {
        applyNotebookSlate(doc);
        // eslint-disable-next-line no-console
        console.log("jupyter-singledoc: applied slate changes");
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Failed to apply single-doc notebook slate", err);
        setError("Could not apply edits to notebook cells.");
      }
    };
    proxy.shiftEnter = (_markdown: string, context?: RunContext) =>
      runCellAtCursor({ insertBelow: false, context });
    proxy.altEnter = (
      _markdown: string,
      _id?: string,
      context?: RunContext,
    ) => runCellAtCursor({ insertBelow: true, context });
    return proxy;
  }, [props.actions, read_only, cell_list, cells, applyNotebookSlate, runCellAtCursor]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const runtime = (window as any).__cocalcJupyterRuntime ?? {};
    (window as any).__cocalcJupyterRuntime = {
      ...runtime,
      set_single_doc_cell_input_for_test: (cellIndex: number, input: string) => {
        if (!Number.isInteger(cellIndex) || cellIndex < 0) {
          throw new Error(`invalid cellIndex: ${cellIndex}`);
        }
        const next = JSON.parse(JSON.stringify(slateValue)) as Descendant[];
        let seen = -1;
        let updated = false;
        for (const node of next as any[]) {
          if (
            SlateElement.isElement(node) &&
            (node as any).type === "jupyter_code_cell"
          ) {
            seen += 1;
            if (seen === cellIndex) {
              (node as any).children = toCodeLines(input);
              updated = true;
              break;
            }
          }
        }
        if (!updated) {
          throw new Error(`single-doc code cell ${cellIndex} not found`);
        }
        applyNotebookSlateRef.current(next);
      },
      set_single_doc_selection_for_test: (
        cellIndex: number,
        where: "start" | "end" = "start",
      ) => {
        if (!Number.isInteger(cellIndex) || cellIndex < 0) {
          throw new Error(`invalid cellIndex: ${cellIndex}`);
        }
        const setSelection = controlRef.current?.setSelection;
        if (typeof setSelection !== "function") {
          throw new Error("single-doc setSelection helper unavailable");
        }
        let topIndex = -1;
        let codeCell: any = null;
        let seen = -1;
        for (let i = 0; i < slateValue.length; i++) {
          const node = slateValue[i] as any;
          if (SlateElement.isElement(node) && node.type === "jupyter_code_cell") {
            seen += 1;
            if (seen === cellIndex) {
              topIndex = i;
              codeCell = node;
              break;
            }
          }
        }
        if (topIndex < 0 || codeCell == null) {
          throw new Error(`single-doc code cell ${cellIndex} not found`);
        }
        const lines = Array.isArray(codeCell.children) ? codeCell.children : [];
        const lastLineIndex = Math.max(0, lines.length - 1);
        const lineForEnd = lines[lastLineIndex] as any;
        const textChildren = Array.isArray(lineForEnd?.children)
          ? lineForEnd.children
          : [];
        const lastText = textChildren[textChildren.length - 1] as any;
        const endOffset =
          typeof lastText?.text === "string" ? lastText.text.length : 0;
        const selection =
          where === "start"
            ? {
                anchor: { path: [topIndex, 0, 0], offset: 0 },
                focus: { path: [topIndex, 0, 0], offset: 0 },
              }
            : {
                anchor: { path: [topIndex, lastLineIndex, 0], offset: endOffset },
                focus: { path: [topIndex, lastLineIndex, 0], offset: endOffset },
              };
        const ok = setSelection(selection);
        if (!ok) {
          throw new Error("setSelection rejected requested selection");
        }
      },
      apply_single_doc_stale_structural_for_test: (input = "print('stale')") => {
        const next = JSON.parse(JSON.stringify(slateValue)) as Descendant[];
        next.push({
          type: "jupyter_code_cell",
          fence: true,
          info: `${kernel ?? ""}`,
          cell_id: `tmp-stale-${Date.now().toString(36)}`,
          cell_meta: { cell_type: "code" },
          children: toCodeLines(input),
        } as any);
        applyNotebookSlateRef.current(next, { baseSignature: "__stale__" });
      },
      duplicate_single_doc_code_cell_with_same_id_for_test: (cellIndex: number = 0) => {
        if (!Number.isInteger(cellIndex) || cellIndex < 0) {
          throw new Error(`invalid cellIndex: ${cellIndex}`);
        }
        const next = JSON.parse(JSON.stringify(slateValue)) as Descendant[];
        const codeTopLevelIndexes: number[] = [];
        for (let i = 0; i < next.length; i++) {
          const node = next[i] as any;
          if (SlateElement.isElement(node) && node.type === "jupyter_code_cell") {
            codeTopLevelIndexes.push(i);
          }
        }
        const topLevelIndex = codeTopLevelIndexes[cellIndex];
        if (!Number.isInteger(topLevelIndex)) {
          throw new Error(`single-doc code cell ${cellIndex} not found`);
        }
        const copy = JSON.parse(JSON.stringify(next[topLevelIndex])) as Descendant;
        next.splice(topLevelIndex + 1, 0, copy);
        applyNotebookSlateRef.current(next);
      },
      get_single_doc_canonical_cell_ids_for_test: () =>
        cell_list != null ? cell_list.toArray() : [],
      get_single_doc_selection_for_test: () => {
        const getSelection = controlRef.current?.getSelection;
        const selection = typeof getSelection === "function" ? getSelection() : null;
        const topCellId = selectedTopCellIdInSlateDoc(slateValue, selection);
        const focus = selection?.focus;
        const anchor = selection?.anchor;
        const offset = Number.isFinite(focus?.offset)
          ? focus.offset
          : Number.isFinite(anchor?.offset)
            ? anchor.offset
            : null;
        const active =
          typeof document === "undefined" ? null : document.activeElement;
        const focusedInRoot =
          containerRef.current != null &&
          active != null &&
          containerRef.current.contains(active);
        return {
          cellId: topCellId ?? null,
          offset,
          focusedInRoot,
        };
      },
      get_single_doc_debug_for_test: () => ({ ...debugCountersRef.current }),
    };
  }, [slateValue, kernel, cell_list]);

  React.useEffect(() => {
    const frameActions = props.actions.get_frame_actions(props.id) as any;
    frameActions?.disable_key_handler?.();
    return () => {
      frameActions?.enable_key_handler?.(true);
    };
  }, [props.actions, props.id, cell_list]);

  if (cell_list == null || cells == null) {
    return <div style={{ padding: "12px" }}>Loading notebook...</div>;
  }

  return (
    <div
      ref={containerRef}
      className="smc-vfill"
      style={{
        padding: "8px 12px 8px 12px",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
      data-cocalc-jupyter-slate-single-doc="1"
    >
      <Kernel actions={jupyter_actions} hideHeader />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "8px",
          minHeight: "24px",
        }}
      >
        <Button
          size="small"
          type="text"
          onClick={() => void openKernelMenu()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            color: "#555",
            padding: 0,
            height: "24px",
          }}
        >
          <Logo kernel={kernel ?? null} size={18} style={{ marginRight: "2px" }} />
          <span>{kernelDisplayName ?? kernel ?? "No Kernel"}</span>
          <span
            style={{
              color:
                kernelState === "busy"
                  ? "#d46b08"
                  : kernelState === "idle"
                    ? "#389e0d"
                    : "#999",
            }}
          >
            {kernelState ?? ""}
          </span>
          <span style={{ color: trust ? "#389e0d" : "#999" }}>
            {trust ? "Trusted" : "Untrusted"}
          </span>
        </Button>
        <Button
          size="small"
          type="text"
          onClick={openClassicFrame}
          style={{ color: "#555", padding: 0, height: "24px" }}
        >
          <Icon name="table" /> Classic Doc
        </Button>
      </div>
      {error ? (
        <div
          style={{
            border: "1px solid #ffd591",
            background: "#fffbe6",
            borderRadius: "6px",
            padding: "8px 10px",
            color: "#613400",
            marginBottom: "8px",
          }}
        >
          {error}
        </div>
      ) : null}
      <div
        className="smc-vfill"
        ref={minimap.layoutRef}
        style={{
          minHeight: 0,
          display: "flex",
          flexDirection: "row",
          alignItems: "stretch",
        }}
      >
        <div
          ref={editorViewportElementRef}
          className="smc-vfill"
          style={{ minHeight: 0, minWidth: 0, flex: 1 }}
        >
          <JupyterCellContext.Provider
            value={{
              renderOutput: renderInlineOutput,
              selectedCellId,
              setSelectedCellId,
              hoveredCellId,
              setHoveredCellId,
              gapCursor,
              setGapCursor,
              runCell: runCellById,
              stopCell: stopCellById,
              openAssistant: openAssistantForCell,
              insertCellAbove,
              insertCellAtEnd,
              getCellChromeInfo,
            }}
          >
            <EditableMarkdown
              value_slate={slateValue}
              actions={editorActions}
              onSlateChange={(doc, opts) => {
                if (opts.onlySelectionOps || opts.syncCausedUpdate) {
                  return;
                }
                const root = containerRef.current;
                const active =
                  typeof document === "undefined" ? null : document.activeElement;
                if (root != null && active != null && !root.contains(active)) {
                  return;
                }
                debugCountersRef.current.onSlateChangeCalls += 1;
                scheduleApplyNotebookSlate(doc);
              }}
              is_current={true}
              read_only={!!read_only}
              hidePath
              minimal
              saveDebounceMs={SAVE_DEBOUNCE_MS}
              ignoreRemoteMergesWhileFocused
              style={{ backgroundColor: "transparent", minHeight: 0 }}
              controlRef={controlRef}
              divRef={editableContainerElementRef}
              scrollDivRef={editableScrollElementRef as React.MutableRefObject<
                HTMLDivElement | null
              >}
              jupyterGapCursor={gapCursor}
              setJupyterGapCursor={setGapCursor}
            />
          </JupyterCellContext.Provider>
        </div>
        {minimap.minimapNode}
      </div>
      {minimap.settingsModal}
    </div>
  );
}
