/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Frame for working with a Jupyter notebook in a single non-block Slate editor.
This is a bridge mode: canonical cell model remains source of truth.
*/

import { List, Map } from "immutable";
import React from "react";
import { useRedux } from "@cocalc/frontend/app-framework";
import { EditableMarkdown } from "@cocalc/frontend/editors/slate/editable-markdown";
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

function toCodeFence({
  input,
  kernel,
}: {
  input: string;
  kernel?: string | null;
}): string {
  let fence = "```";
  while (input.includes(fence)) {
    fence += "`";
  }
  const info = `${kernel ?? ""}`.trim().replace(/\s+/g, "");
  const head = info ? `${fence}${info}` : fence;
  return `${head}\n${input}\n${fence}`;
}

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

function toTopLevelNotebookMarkdown({
  cell_list,
  cells,
  kernel,
}: {
  cell_list: List<string>;
  cells: Map<string, Map<string, any>>;
  kernel?: string;
}): string {
  const parts: string[] = [];
  for (const id of cell_list.toArray()) {
    const cell = cells.get(id);
    if (cell == null) continue;
    const cellType = `${cell.get("cell_type") ?? "code"}`;
    const input = `${cell.get("input") ?? ""}`;
    if (cellType === "markdown") {
      parts.push(input);
      continue;
    }
    if (cellType === "raw") {
      parts.push(toCodeFence({ input, kernel: "raw" }));
      continue;
    }
    parts.push(toCodeFence({ input, kernel: `${cell.get("kernel") ?? kernel ?? ""}` }));
  }
  return `${parts.join("\n\n")}\n`;
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
          <div key={`single-doc-output-${id}`} style={{ margin: "0 0 8px -15px" }}>
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

  const value = React.useMemo(() => {
    if (cell_list == null || cells == null) return "";
    return toTopLevelNotebookMarkdown({ cell_list, cells, kernel });
  }, [cell_list, cells, kernel]);

  const runCellAtCursor = React.useCallback(
    ({ markdown, insertBelow }: { markdown: string; insertBelow: boolean }) => {
      if (frameActions == null || cell_list == null) {
        return;
      }
      const pos = controlRef.current?.getMarkdownPositionForSelection?.();
      const idx = positionToIndex({ markdown, pos }) ?? 0;
      const parsed = parseTopLevelNotebookMarkdown(markdown);
      let cellIndex = parsed.findIndex((cell) => idx >= cell.start && idx <= cell.end);
      if (cellIndex === -1) {
        cellIndex = Math.max(0, Math.min(parsed.length - 1, cell_list.size - 1));
      }
      const targetId = cell_list.get(Math.min(cellIndex, cell_list.size - 1));
      if (targetId == null) {
        return;
      }
      frameActions.set_cur_id(targetId);
      if (insertBelow) {
        frameActions.run_cell(targetId);
        const newId = frameActions.insert_cell(1);
        frameActions.set_cur_id(newId);
      } else {
        frameActions.shift_enter_run_current_cell();
      }
    },
    [frameActions, cell_list],
  );

  const applyNotebookMarkdown = React.useCallback(
    (markdown: string) => {
      if (read_only || cell_list == null || cells == null) {
        return;
      }
      const parsed = parseTopLevelNotebookMarkdown(markdown);
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
    const proxy = Object.create(props.actions) as SlateActions;
    proxy.set_value = (markdown: string) => {
      try {
        applyNotebookMarkdown(markdown);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Failed to apply single-doc notebook markdown", err);
        setError("Could not apply edits to notebook cells.");
      }
    };
    proxy.shiftEnter = (markdown: string) =>
      runCellAtCursor({ markdown, insertBelow: false });
    proxy.altEnter = (markdown: string) =>
      runCellAtCursor({ markdown, insertBelow: true });
    return proxy;
  }, [props.actions, read_only, cell_list, cells, applyNotebookMarkdown, runCellAtCursor]);

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
        value={value}
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
