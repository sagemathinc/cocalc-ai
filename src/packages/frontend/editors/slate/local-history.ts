/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createEditor, Editor, Operation, type BaseEditor } from "slate";
import { HistoryEditor } from "slate-history";
import { cloneDeep } from "lodash";

interface UndoKeyboardEvent {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

function historyBatchApplies(
  editor: HistoryEditor,
  direction: "undo" | "redo",
): boolean {
  const batches =
    direction === "undo" ? editor.history.undos : editor.history.redos;
  const batch = batches[batches.length - 1];
  if (batch == null) {
    return true;
  }

  const operations =
    direction === "undo"
      ? batch.operations.map(Operation.inverse).reverse()
      : batch.operations;
  const probe = createEditor();
  probe.children = cloneDeep(editor.children);
  probe.selection = cloneDeep(editor.selection);
  try {
    Editor.withoutNormalizing(probe, () => {
      for (const operation of operations) {
        probe.apply(operation);
      }
    });
    return true;
  } catch {
    return false;
  }
}

export function handleLocalHistoryHotkey(
  event: UndoKeyboardEvent,
  editor: BaseEditor,
  enabled: boolean,
): boolean {
  if (
    !enabled ||
    !HistoryEditor.isHistoryEditor(editor) ||
    event.altKey ||
    (!event.ctrlKey && !event.metaKey) ||
    event.key.toLowerCase() !== "z"
  ) {
    return false;
  }
  const direction = event.shiftKey ? "redo" : "undo";
  if (!historyBatchApplies(editor, direction)) {
    // Remote collaborative edits can invalidate Slate's local path-based history.
    // Discard it before Slate partially applies a stale operation batch.
    editor.history = { undos: [], redos: [] };
    return true;
  }
  HistoryEditor[direction](editor);
  return true;
}
