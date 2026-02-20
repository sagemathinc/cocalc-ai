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
import { useRedux } from "@cocalc/frontend/app-framework";
import { EditableMarkdown } from "@cocalc/frontend/editors/slate/editable-markdown";
import { getCodeBlockText, toCodeLines } from "@cocalc/frontend/editors/slate/elements/code-block/utils";
import { markdown_to_slate } from "@cocalc/frontend/editors/slate/markdown-to-slate";
import { slate_to_markdown } from "@cocalc/frontend/editors/slate/slate-to-markdown";
import type { Actions as SlateActions } from "@cocalc/frontend/editors/slate/types";
import { JupyterCellContext } from "@cocalc/frontend/editors/slate/jupyter-cell-context";
import { CellOutput } from "@cocalc/frontend/jupyter/cell-output";
import type { JupyterActions } from "@cocalc/frontend/jupyter/browser-actions";
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

// Keep this noticeably higher than per-keystroke cadence so focus is not
// disrupted by immediate round-trips back through canonical notebook state.
const SAVE_DEBOUNCE_MS = 800;

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

export function SingleDocNotebook(props: Props): React.JSX.Element {
  const jupyter_actions: JupyterActions = props.actions.jupyter_actions;
  const name = jupyter_actions.name;
  const cell_list: List<string> | undefined = useRedux([name, "cell_list"]);
  const cells: Map<string, Map<string, any>> | undefined = useRedux([name, "cells"]);
  const trust: boolean | undefined = useRedux([name, "trust"]);
  const read_only: boolean | undefined = useRedux([name, "read_only"]);
  const more_output: Map<string, any> | undefined = useRedux([name, "more_output"]);
  const kernel: string | undefined = useRedux([name, "kernel"]);
  const directory: string | undefined = useRedux([name, "directory"]);
  const controlRef = React.useRef<any>(null);
  const [error, setError] = React.useState<string>("");
  const applyNotebookSlateRef = React.useRef<(doc: Descendant[]) => void>(() => {});
  const pendingSlateSyncTimerRef = React.useRef<number | null>(null);
  const pendingSlateDocRef = React.useRef<Descendant[] | null>(null);
  const transientIdMapRef = React.useRef<globalThis.Map<string, string>>(
    new globalThis.Map(),
  );
  const debugCountersRef = React.useRef({
    applyNotebookSlateCalls: 0,
    applyNotebookSlateMutations: 0,
    onSlateChangeCalls: 0,
  });

  const slateValue = React.useMemo(() => {
    if (cell_list == null || cells == null) return [] as Descendant[];
    return cellsToSlateDocument({ cell_list, cells, kernel });
  }, [cell_list, cells, kernel]);

  const runCellAtCursor = React.useCallback(
    ({
      insertBelow,
      context,
    }: {
      insertBelow: boolean;
      context?: RunContext;
    }) => {
      if (cell_list == null) {
        return;
      }
      if (pendingSlateSyncTimerRef.current != null) {
        window.clearTimeout(pendingSlateSyncTimerRef.current);
        pendingSlateSyncTimerRef.current = null;
      }
      if (context?.slateValue != null) {
        pendingSlateDocRef.current = null;
        applyNotebookSlateRef.current(context.slateValue);
      } else if (pendingSlateDocRef.current != null) {
        const pending = pendingSlateDocRef.current;
        pendingSlateDocRef.current = null;
        applyNotebookSlateRef.current(pending);
      }
      const frameActions = props.actions.get_frame_actions(props.id);
      const fromSlate = findCellIdFromSlateContext({
        context,
        cell_list,
        idMap: transientIdMapRef.current,
      });
      let targetId = fromSlate;
      if (targetId == null) {
        const currentId = `${frameActions?.store?.get("cur_id") ?? ""}`.trim();
        if (currentId && cell_list.includes(currentId)) {
          targetId = currentId;
        }
      }
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
      // eslint-disable-next-line no-console
      console.log("jupyter-singledoc: run dispatch", {
        targetId,
        insertBelow,
        fromSlate,
        hasFrameActions: frameActions != null,
      });
      if (frameActions != null) {
        frameActions.set_cur_id(targetId);
      }
      const runTarget = () => {
        if (frameActions != null) {
          frameActions.run_cell(targetId);
        } else {
          jupyter_actions.runCells([targetId]);
        }
      };
      if (insertBelow) {
        runTarget();
        const newId =
          frameActions != null
            ? frameActions.insert_cell(1)
            : jupyter_actions.insert_cell_adjacent(targetId, 1);
        if (frameActions != null) {
          frameActions.set_cur_id(newId);
        }
      } else {
        runTarget();
        const idx = cell_list.indexOf(targetId);
        if (idx >= 0 && idx < cell_list.size - 1) {
          const nextId = cell_list.get(idx + 1);
          if (frameActions != null && nextId != null) {
            frameActions.set_cur_id(nextId);
          }
        } else {
          const newId =
            frameActions != null
              ? frameActions.insert_cell(1)
              : jupyter_actions.insert_cell_adjacent(targetId, 1);
          if (frameActions != null) {
            frameActions.set_cur_id(newId);
          }
        }
      }
    },
    [props.actions, props.id, jupyter_actions, cell_list, cells],
  );

  const applyNotebookSlate = React.useCallback(
    (doc: Descendant[]) => {
      debugCountersRef.current.applyNotebookSlateCalls += 1;
      if (read_only || cell_list == null || cells == null) {
        return;
      }
      const parsed = slateDocumentToCells(doc);
      const originalIds = cell_list.toArray();
      const ids = [...originalIds];
      let didMutate = false;
      const used = new Set<string>();
      const resolvedIds: string[] = [];
      const transientIdMap = transientIdMapRef.current;
      const existingIdSet = new Set(ids);

      // Drop stale temporary id mappings that no longer point to existing cells.
      for (const [tempId, mappedId] of transientIdMap) {
        if (!existingIdSet.has(mappedId)) {
          transientIdMap.delete(tempId);
        }
      }

      const getCellType = (id: string): string => `${cells.getIn([id, "cell_type"]) ?? "code"}`;
      const takeExistingIdByType = (cellType: ParsedSlateCell["cell_type"]): string | undefined => {
        for (const id of ids) {
          if (used.has(id)) continue;
          if (getCellType(id) !== cellType) continue;
          used.add(id);
          return id;
        }
        return;
      };

      const makeNewCell = (cellType: ParsedSlateCell["cell_type"]): string => {
        const prev = resolvedIds[resolvedIds.length - 1];
        const newId =
          prev == null
            ? jupyter_actions.insert_cell_at(0, false)
            : jupyter_actions.insert_cell_adjacent(prev, 1, false);
        ids.push(newId);
        existingIdSet.add(newId);
        used.add(newId);
        resolvedIds.push(newId);
        if (cellType !== "code") {
          jupyter_actions.set_cell_type(newId, cellType, false);
        }
        didMutate = true;
        return newId;
      };

      for (const cell of parsed) {
        const rawId = `${cell.cell_id ?? ""}`.trim();
        const mappedFromTemp = rawId ? transientIdMap.get(rawId) : undefined;
        const requestedId = mappedFromTemp ?? rawId;
        if (requestedId && existingIdSet.has(requestedId) && !used.has(requestedId)) {
          used.add(requestedId);
          resolvedIds.push(requestedId);
          continue;
        }
        if (rawId) {
          // Explicit/duplicated/temporary code cell id: allocate a fresh canonical cell id.
          const newId = makeNewCell(cell.cell_type);
          transientIdMap.set(rawId, newId);
          continue;
        }
        const reused = takeExistingIdByType(cell.cell_type);
        if (reused != null) {
          resolvedIds.push(reused);
          continue;
        }
        makeNewCell(cell.cell_type);
      }

      for (let i = 0; i < parsed.length; i++) {
        const id = resolvedIds[i];
        const currentCell = cells.get(id) ?? jupyter_actions.store.getIn(["cells", id]);
        const currentType = `${currentCell?.get("cell_type") ?? "code"}`;
        const nextType = parsed[i].cell_type;
        if (currentType !== nextType) {
          jupyter_actions.set_cell_type(id, nextType, false);
          didMutate = true;
        }
        const currentInput = `${currentCell?.get("input") ?? ""}`;
        if (currentInput !== parsed[i].input) {
          jupyter_actions.set_cell_input(id, parsed[i].input, false);
          didMutate = true;
        }
      }

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
      if (pendingSlateSyncTimerRef.current != null) {
        window.clearTimeout(pendingSlateSyncTimerRef.current);
      }
      pendingSlateSyncTimerRef.current = window.setTimeout(() => {
        pendingSlateSyncTimerRef.current = null;
        const pending = pendingSlateDocRef.current;
        pendingSlateDocRef.current = null;
        if (pending != null) {
          applyNotebookSlateRef.current(pending);
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
          style={{ margin: "2px 0 10px -15px" }}
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
          />
        </div>
      );
    },
    [cells, more_output, jupyter_actions, props.project_id, directory, trust],
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
      get_single_doc_debug_for_test: () => ({ ...debugCountersRef.current }),
    };
  }, [slateValue]);

  if (cell_list == null || cells == null) {
    return <div style={{ padding: "12px" }}>Loading notebook...</div>;
  }

  return (
    <div
      style={{
        padding: "8px 12px 24px 12px",
        overflow: "auto",
        height: "100%",
        minHeight: 0,
      }}
      data-cocalc-jupyter-slate-single-doc="1"
    >
      <div style={{ color: "#888", fontSize: "11px", marginBottom: "8px" }}>
        Single-document Slate notebook editor (experimental)
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
      <JupyterCellContext.Provider value={{ renderOutput: renderInlineOutput }}>
        <EditableMarkdown
          value_slate={slateValue}
          actions={editorActions}
          onSlateChange={(doc, opts) => {
            if (opts.onlySelectionOps || opts.syncCausedUpdate) {
              return;
            }
            debugCountersRef.current.onSlateChangeCalls += 1;
            scheduleApplyNotebookSlate(doc);
          }}
          is_current={true}
          read_only={!!read_only}
          hidePath
          minimal
          noVfill
          saveDebounceMs={SAVE_DEBOUNCE_MS}
          height="auto"
          ignoreRemoteMergesWhileFocused
          style={{ backgroundColor: "transparent" }}
          controlRef={controlRef}
        />
      </JupyterCellContext.Provider>
    </div>
  );
}
