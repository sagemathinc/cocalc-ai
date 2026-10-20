/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Shown in place of the cell list while a notebook has no cells. Nothing is
// stored until the user starts editing: clicking it, pressing Enter or typing
// creates the first cell (typed text becomes its input) and puts the cursor
// in it. A blank cell stored as soon as an empty notebook opened used to win
// over, or be saved on top of, a notebook file that was still being written
// (support ticket 21023).
//
// It is a real text field, so whatever the browser inserts counts as typing:
// IME and dead-key composition (taken when it ends), emoji and AltGr
// characters. Command keys such as Ctrl+S insert nothing and are ignored.

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
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const started = useRef(false);
  // Whether this placeholder turned the command shortcuts off; only then
  // does it turn them back on (another frame may own the handler).
  const disabledKeys = useRef(false);
  const restoreKeys = () => {
    if (!disabledKeys.current) return;
    disabledKeys.current = false;
    frameActions.current?.enable_key_handler();
  };

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  useEffect(() => restoreKeys, []);

  const start = (input: string = "") => {
    if (started.current) return;
    started.current = true;
    const id = actions.createFirstCell(input);
    const frame = frameActions.current;
    if (frame == null) return;
    restoreKeys();
    frame.set_cur_id(id);
    frame.set_mode("edit");
    if (input) {
      // Put the cursor after the typed text once the editor exists, and
      // only then: a later reset would move the cursor the user has since
      // moved by typing on.
      const lines = input.split("\n");
      const pos = { x: lines[lines.length - 1].length, y: lines.length - 1 };
      const place = (delays: number[]) => {
        if (delays.length == 0) return;
        setTimeout(() => {
          if (!frame.set_input_editor_cursor(id, pos)) place(delays.slice(1));
        }, delays[0]);
      };
      place([0, 50, 200]);
    }
  };

  const takeText = () => {
    const text = ref.current?.value ?? "";
    if (text) start(text);
  };

  return (
    <textarea
      ref={ref}
      rows={1}
      aria-label="Empty notebook: click or start typing to add the first cell"
      placeholder="In [ ]:  Click here or start typing to add the first cell."
      data-testid="jupyter-empty-notebook-placeholder"
      onFocus={() => {
        disabledKeys.current = true;
        frameActions.current?.disable_key_handler();
      }}
      onBlur={restoreKeys}
      onClick={() => start()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !composing.current) {
          e.preventDefault();
          start();
        }
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        takeText();
      }}
      onInput={() => {
        if (!composing.current) takeText();
      }}
      style={{
        display: "block",
        boxSizing: "border-box",
        width: "calc(100% - 30px)",
        margin: "15px 15px 0 15px",
        padding: "10px 12px",
        border: `1px dashed ${UI_COLORS.muted}`,
        borderRadius: "4px",
        resize: "none",
        background: "transparent",
        fontFamily: "monospace",
        fontSize: fontSize ?? 14,
        cursor: "text",
      }}
    />
  );
}
