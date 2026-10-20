/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Shown in place of the cell list while a notebook has no cells. Nothing is
// stored until the user starts editing: clicking it, pressing Enter or typing
// creates the first cell (a typed character becomes its input) and puts the
// cursor in it. A blank cell stored as soon as an empty notebook opened used
// to win over, or be saved on top of, a notebook file that was still being
// written (support ticket 21023).

import { useEffect, useRef } from "react";
import useNotebookFrameActions from "@cocalc/frontend/frame-editors/jupyter-editor/cell-notebook/hook";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { JupyterActions } from "./browser-actions";

interface Props {
  actions: JupyterActions;
  fontSize?: number;
  autoFocus?: boolean;
}

export function EmptyNotebookPlaceholder({
  actions,
  fontSize,
  autoFocus,
}: Props) {
  const frameActions = useNotebookFrameActions();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // The notebook's command-mode shortcuts must not also act on keys typed
  // here (e.g. "b" would insert a second cell).
  useEffect(() => {
    return () => frameActions.current?.enable_key_handler();
  }, []);

  const start = (input: string = "") => {
    const id = actions.createFirstCell(input);
    const frame = frameActions.current;
    if (frame == null) return;
    frame.enable_key_handler();
    frame.set_cur_id(id);
    frame.set_mode("edit");
    if (input) {
      // Put the cursor after the typed character once the editor exists.
      const pos = { x: input.length, y: 0 };
      for (const ms of [0, 50, 250]) {
        setTimeout(() => frame.set_input_editor_cursor(id, pos), ms);
      }
    }
  };

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label="Empty notebook: click or start typing to add the first cell"
      data-testid="jupyter-empty-notebook-placeholder"
      onFocus={() => frameActions.current?.disable_key_handler()}
      onBlur={() => frameActions.current?.enable_key_handler()}
      onClick={() => start()}
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === "Enter") {
          e.preventDefault();
          start();
        } else if (e.key.length === 1) {
          e.preventDefault();
          start(e.key);
        }
      }}
      style={{
        margin: "15px 15px 0 15px",
        padding: "10px 12px",
        border: `1px dashed ${UI_COLORS.muted}`,
        borderRadius: "4px",
        color: UI_COLORS.muted,
        fontFamily: "monospace",
        fontSize: fontSize ?? 14,
        cursor: "text",
      }}
    >
      <span style={{ marginRight: "10px" }}>In [ ]:</span>
      Click here or start typing to add the first cell.
    </div>
  );
}
