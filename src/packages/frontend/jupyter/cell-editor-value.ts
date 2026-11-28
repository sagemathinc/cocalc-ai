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
