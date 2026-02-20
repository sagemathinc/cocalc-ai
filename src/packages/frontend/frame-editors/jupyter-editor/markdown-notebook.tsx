/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Slate-oriented notebook frame that keeps the canonical Jupyter cell model
and reuses existing output/runtime components.
*/

import { List, Map } from "immutable";
import React from "react";
import { useRedux } from "@cocalc/frontend/app-framework";
import BlockMarkdownEditor from "@cocalc/frontend/editors/slate/block-markdown-editor";
import MostlyStaticMarkdown from "@cocalc/frontend/editors/slate/mostly-static-markdown";
import type { Actions as SlateActions } from "@cocalc/frontend/editors/slate/types";
import { CellOutput } from "@cocalc/frontend/jupyter/cell-output";
import type { JupyterActions } from "@cocalc/frontend/jupyter/browser-actions";
import { InputPrompt } from "@cocalc/frontend/jupyter/prompt/input";
import { EditorState } from "@cocalc/frontend/frame-editors/frame-tree/types";
import type { NotebookFrameActions } from "./cell-notebook/actions";
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

function inputAsEditorMarkdown({
  cell,
  kernel,
}: {
  cell: Map<string, any>;
  kernel?: string | null;
}): string {
  const cellType = `${cell.get("cell_type") ?? "code"}`;
  const rawInput = `${cell.get("input") ?? ""}`;
  if (cellType === "code") {
    return toCodeFence({ input: rawInput, kernel });
  }
  if (cellType === "markdown") {
    return rawInput;
  }
  return toCodeFence({ input: rawInput, kernel: "text" });
}

function editorMarkdownToCellInput({
  cellType,
  markdown,
}: {
  cellType: string;
  markdown: string;
}): string {
  if (cellType === "markdown") {
    return markdown;
  }
  const fenced = markdown.match(/^(\s*)(`{3,})[^\n]*\n([\s\S]*?)\n\2\s*$/);
  if (fenced != null) {
    return fenced[3];
  }
  return markdown;
}

function Row({
  id,
  index,
  cell,
  actions,
  name,
  kernel,
  project_id,
  directory,
  trust,
  readOnly,
  moreOutput,
  frameActions,
}: {
  id: string;
  index: number;
  cell: Map<string, any>;
  actions: JupyterActions;
  name: string;
  kernel?: string | null;
  project_id: string;
  directory?: string;
  trust?: boolean;
  readOnly: boolean;
  moreOutput?: Map<string, any>;
  frameActions?: NotebookFrameActions;
}) {
  const cellType = `${cell.get("cell_type") ?? "code"}`;
  const markdown = inputAsEditorMarkdown({ cell, kernel });
  const setInputFromMarkdown = React.useCallback(
    (value: string) => {
      if (readOnly) {
        return;
      }
      const input = editorMarkdownToCellInput({ cellType, markdown: value });
      actions.set_cell_input(id, input, true);
    },
    [actions, id, cellType, readOnly],
  );
  const editorActions = React.useMemo<SlateActions | undefined>(() => {
    if (readOnly) {
      return;
    }
    return {
      set_value: setInputFromMarkdown,
      shiftEnter: (value: string) => {
        setInputFromMarkdown(value);
        if (frameActions != null) {
          frameActions.set_cur_id(id);
          frameActions.shift_enter_run_current_cell();
          return;
        }
        if (cellType === "code") {
          actions.runCells([id]);
        }
      },
      altEnter: (value: string) => {
        setInputFromMarkdown(value);
        if (frameActions != null) {
          frameActions.set_cur_id(id);
          if (cellType === "code") {
            frameActions.run_cell(id);
          }
          const newId = frameActions.insert_cell(1);
          frameActions.set_cur_id(newId);
          return;
        }
        if (cellType === "code") {
          actions.runCells([id]);
        }
      },
    };
  }, [readOnly, setInputFromMarkdown, frameActions, id, cellType, actions]);

  return (
    <div
      id={`slate-row-${id}`}
      style={{
        padding: "8px 0 12px 0",
      }}
      data-cocalc-jupyter-slate-row={id}
      data-cocalc-jupyter-slate-cell-type={cellType}
    >
      <div style={{ display: "flex", flexDirection: "row", alignItems: "stretch" }}>
        <InputPrompt
          type={cellType}
          state={cell.get("state")}
          exec_count={cell.get("exec_count")}
          kernel={cell.get("kernel") ?? kernel ?? ""}
          start={cell.get("start")}
          end={cell.get("end")}
          actions={actions}
          id={id}
          read_only={readOnly}
          style={{ marginTop: "4px" }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "#888", fontSize: "11px", marginBottom: "4px" }}>
            Cell {index + 1} ({cellType})
          </div>
          <div style={{ padding: "2px 0 4px 0" }}>
            {readOnly ? (
              <MostlyStaticMarkdown value={markdown} />
            ) : (
              <BlockMarkdownEditor
                key={`slate-cell-editor-${id}-${cellType}`}
                value={markdown}
                actions={editorActions}
                read_only={readOnly}
                hidePath
                minimal
                noVfill
                height="auto"
                disableVirtualization
                style={{ backgroundColor: "transparent" }}
                onFocus={() => {
                  if (frameActions != null) {
                    frameActions.set_cur_id(id);
                  } else {
                    actions.set_cur_id(id);
                  }
                }}
              />
            )}
          </div>
        </div>
      </div>
      {cellType === "code" && (
        <CellOutput
          actions={actions}
          name={name}
          id={id}
          cell={cell}
          project_id={project_id}
          directory={directory}
          more_output={moreOutput}
          trust={trust}
        />
      )}
    </div>
  );
}

export function MarkdownNotebook(props: Props): React.JSX.Element {
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
      data-cocalc-jupyter-slate-notebook="1"
    >
      {cell_list.map((id, index) => {
        const cell = cells.get(id);
        if (cell == null) {
          return null;
        }
        return (
          <Row
            key={id}
            id={id}
            index={index}
            cell={cell}
            actions={jupyter_actions}
            name={name}
            kernel={kernel}
            project_id={props.project_id}
            directory={directory}
            trust={!!trust}
            readOnly={!!read_only}
            moreOutput={more_output?.get(id)}
            frameActions={frameActions}
          />
        );
      })}
    </div>
  );
}
