/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Whether the person using this browser has edited a cell's input.

A cell merges a collaborator's change with what its editor shows, so that
unsaved edits survive. That merge decides what was edited by comparing the
editor's contents with the last value it was given. A rich text (markdown)
editor that is behind, e.g., in a background tab catching up on a burst of
changes, or that shows a value in its own canonical form, then looks edited
when nobody typed, and the merge writes its stale contents over everyone
else's text. So the merge only runs after real editing input in the cell;
otherwise a collaborator's change is simply adopted.

Anything that might edit counts (over-counting only falls back to the merge).
*/

// Input events that edit text in contenteditable, textarea and CodeMirror.
export const LOCAL_EDIT_EVENTS = [
  "beforeinput",
  "input",
  "paste",
  "cut",
  "drop",
  "compositionend",
] as const;

// Keys that may edit: printable characters, deletions, Enter and Tab, and
// shortcuts for undo/redo, paste and cut.
export function isEditingKeyEvent(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): boolean {
  const { key } = event;
  if (event.ctrlKey || event.metaKey) {
    return ["z", "y", "v", "x", "Z", "Y", "V", "X"].includes(key);
  }
  if (key.length === 1) return true;
  return ["Backspace", "Delete", "Enter", "Tab"].includes(key);
}

// Marks `onEdit` on editing input within `element`; returns a cleanup.
export function watchLocalEdits(
  element: HTMLElement,
  onEdit: () => void,
): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (isEditingKeyEvent(event)) onEdit();
  };
  for (const name of LOCAL_EDIT_EVENTS) {
    element.addEventListener(name, onEdit, true);
  }
  element.addEventListener("keydown", onKey, true);
  return () => {
    for (const name of LOCAL_EDIT_EVENTS) {
      element.removeEventListener(name, onEdit, true);
    }
    element.removeEventListener("keydown", onKey, true);
  };
}
