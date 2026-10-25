/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { TextEditorActions } from "../base-editor/actions-text";

// Which view a file opens in comes from the editor it was opened with, not
// from this.path: that is the sync identity, which need not keep the
// .cal.json or .todo.json name the user opened.
class ListViewActions extends TextEditorActions {
  _init2(): void {
    this._init_syncstring_value();
  }

  print(id: string): void {
    // Only the JSON prints; the viewer has nothing printable of its own.
    if (this._get_frame_node(id)?.get("type") === "cm") super.print(id);
  }
}

export class CalendarActions extends ListViewActions {
  _raw_default_frame_tree() {
    return { type: "calendar" } as const;
  }
}

export class TodoActions extends ListViewActions {
  _raw_default_frame_tree() {
    return { type: "todo" } as const;
  }
}
