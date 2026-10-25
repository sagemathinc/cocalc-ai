/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { TextEditorActions } from "../base-editor/actions-text";

export class Actions extends TextEditorActions {
  _raw_default_frame_tree() {
    return {
      type: this.path.toLowerCase().endsWith(".cal.json") ? "calendar" : "todo",
    } as const;
  }

  _init2(): void {
    this._init_syncstring_value();
  }

  print(id: string): void {
    // Only the JSON prints; the viewer has nothing printable of its own.
    if (this._get_frame_node(id)?.get("type") === "cm") super.print(id);
  }
}
