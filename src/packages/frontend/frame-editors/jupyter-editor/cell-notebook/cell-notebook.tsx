/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Frame that display a Jupyter notebook in the traditional way with input and output cells.
*/

import { Map } from "immutable";

import { Rendered, useRedux, useEffect } from "@cocalc/frontend/app-framework";
import { hasNbgraderMetadata } from "../nbgrader-layout";
import { EditorState } from "@cocalc/frontend/frame-editors/frame-tree/types";
import { JupyterActions } from "@cocalc/frontend/jupyter/browser-actions";
import { JupyterEditor } from "@cocalc/frontend/jupyter/main";
import { JupyterEditorActions } from "../actions";

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

export function CellNotebook(props: Props): Rendered {
  function data(key: string, def?: any): any {
    return props.desc.get("data-" + key, def);
  }

  // Actions for the underlying Jupyter notebook state, kernel state, etc.
  const jupyter_actions: JupyterActions = props.actions.jupyter_actions;
  const cells = useRedux([jupyter_actions.name, "cells"]);
  const blocked = hasNbgraderMetadata(cells);
  useEffect(() => {
    if (blocked && props.desc.get("type") === "jupyter_studio") {
      props.actions.set_frame_type(props.id, "jupyter_cell_notebook");
    }
  }, [blocked, props.desc, props.actions, props.id]);
  const cellViewMode =
    props.desc.get("type") === "jupyter_studio" && cells != null && !blocked
      ? "studio"
      : "default";

  return (
    <JupyterEditor
      actions={jupyter_actions}
      editor_actions={props.actions}
      name={jupyter_actions.name}
      is_focused={props.is_current}
      is_visible={props.is_visible}
      is_fullscreen={props.is_fullscreen}
      font_size={props.font_size}
      mode={data("mode", "escape")}
      cur_id={data("cur_id")}
      sel_ids={data("sel_ids")}
      md_edit_ids={data("md_edit_ids")}
      scroll={data("scroll")}
      scroll_seq={data("scroll_seq")}
      scrollTop={data("scrollTop")}
      hook_offset={data("hook_offset")}
      cellViewMode={cellViewMode}
      studioLayout={data("studioLayout", "comfortable")}
      readingMode={data("readingMode", false)}
    />
  );
}
