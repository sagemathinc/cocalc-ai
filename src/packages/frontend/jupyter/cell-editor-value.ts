/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Showing a value in a code cell's editor that did not come from typing (a
collaborator's change, a merge, what a save stored).

The editor saves on its "change" event (debounced, with a maximum wait), and
a save writes what the editor shows as an edit of `baseline`, the value it
last loaded or saved. Setting the text fires "change" synchronously, and once
the maximum wait has passed (e.g., in a throttled background tab) the save
runs right then. So the baseline must be the new one before the text is set:
otherwise that save writes the new value as an edit of an old baseline, and
the merge with the current input repeats everything since (duplicated text).
*/

import { mergeText } from "@cocalc/sync/editor/generic/string-merge3";

interface Editor {
  getValue(): string;
  setValueNoJump(value: string): void;
}

export function showValueInEditor({
  editor,
  lastRemote,
  shown,
  baseline = shown,
}: {
  editor: Editor;
  lastRemote: { current: string | null };
  // the text to show
  shown: string;
  // the value it derives from (shown, unless it has unsaved local edits)
  baseline?: string;
}): void {
  lastRemote.current = baseline;
  if (editor.getValue() !== shown) editor.setValueNoJump(shown);
}

// Shows a new value of the cell's input. Edits not saved yet (the save is
// debounced) are merged into it rather than replaced, which would lose what
// was just typed; they stay edits of the new value. Returns what it did.
export function showRemoteValue({
  editor,
  lastRemote,
  value,
}: {
  editor: Editor;
  lastRemote: { current: string | null };
  value: string;
}): { merged: string } | "set" | undefined {
  const local = editor.getValue();
  const base = lastRemote.current;
  if (local === value) return;
  if (base != null && local !== base) {
    if (value === base) return;
    const merged = mergeText({ base, local, remote: value });
    // Showing it may save it right away, which moves the baseline on to what
    // was saved: so nothing may set the baseline after this.
    showValueInEditor({ editor, lastRemote, shown: merged, baseline: value });
    return { merged };
  }
  showValueInEditor({ editor, lastRemote, shown: value });
  return "set";
}
