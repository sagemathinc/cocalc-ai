import { Range } from "slate";
import type { Descendant } from "slate";

import type { SyncString } from "@cocalc/sync/editor/string/sync";
import { ReactEditor } from "./slate-react";

export interface SlateEditor extends ReactEditor {
  ignoreNextOnChange?: boolean;
  syncCausedUpdate?: boolean;
  saveValue: (force?) => void;
  applyingOperations?: boolean;
  lastSelection?: Range;
  curSelection?: Range;
  selectionIsCollapsed: () => boolean;
  inverseSearch: (boolean?) => Promise<void>;
  hasUnsavedChanges: () => boolean;
  _hasUnsavedChanges: any;
  resetHasUnsavedChanges: () => void;
  markdownValue?: string;
  getMarkdownValue: () => string;
  getPlainValue: () => string;
  getSourceValue: (fragment?) => string;
  syncCache?: any;
  windowedListRef: any;
  onCursorBottom?: () => void;
  onCursorTop?: () => void;
  isComposing?: boolean;
  preserveBlankLines?: boolean;
  cancelPendingUploads?: () => void;
}

/*
Actions: This is what you need to provide for editing to be possible.
One class that implements this is frame-tree/mmarkdown-editor/actions.ts
*/

export interface Actions {
  name?: string;
  setState?: (state: any) => void;
  getSlateEditor?: (id?: string) => SlateEditor | undefined;
  registerSlateEditor?: (id: string, editor: SlateEditor) => void;
  ensure_syncstring_is_saved?: () => Promise<void>;
  save_editor_state?: (id: string, new_editor_state?: any) => void;
  set_cursor_locs?: (locs: any[]) => void;
  set_value?: (value: string) => void;
  set_slate_value?: (value: Descendant[]) => void;
  syncstring_commit?: () => void;
  get_syncstring?: () => SyncString;
  get_matching_frame?: (obj: object) => string | undefined;
  programmatical_goto_line?: (
    line: number,
    cursor?: boolean,
    focus?: boolean,
    id?: string,
    ch?: number,
  ) => Promise<void>;
  save?: (explicit: boolean) => Promise<void>;
  change_font_size?: (delta?: number, id?: string, zoom?: number) => void;
  undo?: (id: string) => void;
  redo?: (id: string) => void;
  shiftEnter?: (
    value: string,
    context?: { selection?: Range | null; slateValue?: Descendant[] },
  ) => void;
  altEnter?: (
    value: string,
    id?: string,
    context?: { selection?: Range | null; slateValue?: Descendant[] },
  ) => void;
  registerBlockEditorControl?: (id: string, control: any) => void;
  unregisterBlockEditorControl?: (id: string) => void;
  _syncstring?: any;
}
