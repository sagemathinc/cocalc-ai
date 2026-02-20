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
import { positionToIndex } from "@cocalc/frontend/editors/slate/sync";
import type { Actions as SlateActions } from "@cocalc/frontend/editors/slate/types";
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

type ParsedTopLevelCell = {
  cell_type: "markdown" | "code" | "raw";
  input: string;
  start: number;
  end: number;
};

type ParsedSlateCell = {
  cell_type: "markdown" | "code" | "raw";
  input: string;
  cell_id?: string;
};

type RunContext = {
  selection?: { focus?: { path?: number[] } } | null;
  slateValue?: Descendant[];
};

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

function parseTopLevelNotebookMarkdown(markdown: string): ParsedTopLevelCell[] {
  const ret: ParsedTopLevelCell[] = [];
  const lines = markdown.split("\n");
  let cell_type: "markdown" | "code" = "markdown";
  let info = "";
  let source: string[] = [];
  let offset = 0;
  let start = 0;

  const pushCell = (end: number) => {
    const input = normalizeCellSource(source.join(""));
    if (!input.trim()) {
      source = [];
      start = end;
      return;
    }
    let parsedType: "markdown" | "code" | "raw" = cell_type;
    if (cell_type === "code" && info.toLowerCase() === "raw") {
      parsedType = "raw";
    }
    ret.push({
      cell_type: parsedType,
      input,
      start,
      end,
    });
    source = [];
    start = end;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const withNewline = i < lines.length - 1 ? `${line}\n` : line;
    if (line.startsWith("```")) {
      if (cell_type === "markdown") {
        pushCell(offset);
        cell_type = "code";
        info = line.slice(3).trim();
        start = offset;
      } else {
        pushCell(offset + withNewline.length);
        cell_type = "markdown";
        info = "";
        start = offset + withNewline.length;
      }
    } else {
      source.push(withNewline);
    }
    offset += withNewline.length;
  }
  pushCell(offset);

  if (ret.length === 0) {
    ret.push({
      cell_type: "markdown",
      input: "",
      start: 0,
      end: markdown.length,
    });
  }
  return ret;
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
    if (cellType === "code" || cellType === "raw") {
      out.push({
        type: "jupyter_code_cell",
        fence: true,
        info:
          cellType === "raw"
            ? "raw"
            : `${cell.get("kernel") ?? kernel ?? ""}`,
        cell_id: id,
        cell_meta: { cell_type: cellType },
        children: toCodeLines(input),
      } as any);
      continue;
    }
    const doc = markdown_to_slate(input, false, {});
    for (const node of doc) {
      out.push(node as Descendant);
    }
  }
  if (out.length === 0) {
    return [{ type: "paragraph", children: [{ text: "" }] } as any];
  }
  return out;
}

function slateDocumentToCells(doc: Descendant[]): ParsedSlateCell[] {
  const ret: ParsedSlateCell[] = [];
  let markdownBuffer: Descendant[] = [];

  const flushMarkdown = () => {
    const markdown = normalizeCellSource(
      slate_to_markdown(markdownBuffer, {
        preserveBlankLines: false,
      }),
    );
    markdownBuffer = [];
    if (!markdown.trim()) {
      return;
    }
    ret.push({
      cell_type: "markdown",
      input: markdown,
    });
  };

  for (const node of doc) {
    if (
      SlateElement.isElement(node as any) &&
      (node as any).type === "jupyter_code_cell"
    ) {
      flushMarkdown();
      const input = getCodeBlockText(node as any);
      const metaCellType = `${(node as any).cell_meta?.cell_type ?? ""}`;
      const info = `${(node as any).info ?? ""}`.toLowerCase();
      const cell_type: "code" | "raw" =
        metaCellType === "raw" || info === "raw" ? "raw" : "code";
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
    ret.push({ cell_type: "markdown", input: "" });
  }
  return ret;
}

function findCellIdFromSlateContext({
  context,
  cell_list,
}: {
  context?: RunContext;
  cell_list: List<string>;
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
    const id = `${node.cell_id ?? ""}`.trim();
    if (!id || !ids.has(id)) {
      return;
    }
    return id;
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

function SingleDocOutputs({
  cell_list,
  cells,
  jupyter_actions,
  more_output,
  project_id,
  directory,
  trust,
}: {
  cell_list: List<string>;
  cells: Map<string, Map<string, any>>;
  jupyter_actions: JupyterActions;
  more_output?: Map<string, any>;
  project_id: string;
  directory?: string;
  trust: boolean;
}) {
  const visible = cell_list
    .toArray()
    .filter((id) => {
      const cell = cells.get(id);
      if (cell == null || `${cell.get("cell_type") ?? "code"}` !== "code") {
        return false;
      }
      return (
        cell.get("output") != null ||
        cell.get("state") != null ||
        more_output?.get(id) != null
      );
    });
  if (visible.length === 0) {
    return null;
  }
  return (
    <div style={{ marginTop: "8px" }}>
      {visible.map((id) => {
        const cell = cells.get(id);
        if (cell == null) return null;
        return (
          <div
            key={`single-doc-output-${id}`}
            style={{ margin: "0 0 8px -15px" }}
            data-cocalc-test="jupyter-singledoc-output"
            data-cocalc-cell-id={id}
          >
            <CellOutput
              actions={jupyter_actions}
              id={id}
              cell={cell}
              project_id={project_id}
              directory={directory}
              more_output={more_output?.get(id)}
              trust={trust}
            />
          </div>
        );
      })}
    </div>
  );
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
  const frameActions = props.actions.get_frame_actions(props.id);
  const controlRef = React.useRef<any>(null);
  const [error, setError] = React.useState<string>("");

  const slateValue = React.useMemo(() => {
    if (cell_list == null || cells == null) return [] as Descendant[];
    return cellsToSlateDocument({ cell_list, cells, kernel });
  }, [cell_list, cells, kernel]);

  const runCellAtCursor = React.useCallback(
    ({
      markdown,
      insertBelow,
      context,
    }: {
      markdown: string;
      insertBelow: boolean;
      context?: RunContext;
    }) => {
      if (frameActions == null || cell_list == null) {
        return;
      }
      const fromSlate = findCellIdFromSlateContext({ context, cell_list });
      let targetId = fromSlate;
      if (targetId == null) {
        const pos = controlRef.current?.getMarkdownPositionForSelection?.();
        const idx = positionToIndex({ markdown, pos }) ?? 0;
        const parsed = parseTopLevelNotebookMarkdown(markdown);
        let cellIndex = parsed.findIndex((cell) => idx >= cell.start && idx <= cell.end);
        if (cellIndex === -1) {
          cellIndex = Math.max(0, Math.min(parsed.length - 1, cell_list.size - 1));
        }
        targetId = cell_list.get(Math.min(cellIndex, cell_list.size - 1));
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
      });
      frameActions.set_cur_id(targetId);
      if (insertBelow) {
        frameActions.run_cell(targetId);
        const newId = frameActions.insert_cell(1);
        frameActions.set_cur_id(newId);
      } else {
        frameActions.run_cell(targetId);
        const idx = cell_list.indexOf(targetId);
        if (idx >= 0 && idx < cell_list.size - 1) {
          const nextId = cell_list.get(idx + 1);
          if (nextId != null) {
            frameActions.set_cur_id(nextId);
          }
        } else {
          const newId = frameActions.insert_cell(1);
          frameActions.set_cur_id(newId);
        }
      }
    },
    [frameActions, cell_list],
  );

  const applyNotebookSlate = React.useCallback(
    (doc: Descendant[]) => {
      if (read_only || cell_list == null || cells == null) {
        return;
      }
      const parsed = slateDocumentToCells(doc);
      const ids = cell_list.toArray();

      while (ids.length < parsed.length) {
        if (ids.length === 0) {
          ids.push(jupyter_actions.insert_cell_at(0));
          continue;
        }
        ids.push(jupyter_actions.insert_cell_adjacent(ids[ids.length - 1], 1));
      }

      for (let i = 0; i < parsed.length; i++) {
        const id = ids[i];
        const currentCell = cells.get(id);
        if (currentCell == null) continue;
        const currentType = `${currentCell.get("cell_type") ?? "code"}`;
        const nextType = parsed[i].cell_type;
        if (currentType !== nextType) {
          jupyter_actions.set_cell_type(id, nextType, true);
        }
        jupyter_actions.set_cell_input(id, parsed[i].input, true);
      }

      if (ids.length > parsed.length) {
        jupyter_actions.delete_cells(ids.slice(parsed.length), true);
      }
      setError("");
    },
    [read_only, cell_list, cells, jupyter_actions],
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
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Failed to apply single-doc notebook slate", err);
        setError("Could not apply edits to notebook cells.");
      }
    };
    proxy.shiftEnter = (markdown: string, context?: RunContext) =>
      runCellAtCursor({ markdown, insertBelow: false, context });
    proxy.altEnter = (
      markdown: string,
      _id?: string,
      context?: RunContext,
    ) => runCellAtCursor({ markdown, insertBelow: true, context });
    return proxy;
  }, [props.actions, read_only, cell_list, cells, applyNotebookSlate, runCellAtCursor]);

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
      <EditableMarkdown
        value_slate={slateValue}
        actions={editorActions}
        read_only={!!read_only}
        hidePath
        minimal
        noVfill
        height="auto"
        ignoreRemoteMergesWhileFocused
        style={{ backgroundColor: "transparent" }}
        controlRef={controlRef}
      />
      <SingleDocOutputs
        cell_list={cell_list}
        cells={cells}
        jupyter_actions={jupyter_actions}
        more_output={more_output}
        project_id={props.project_id}
        directory={directory}
        trust={!!trust}
      />
    </div>
  );
}
