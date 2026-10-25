/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { set } from "@cocalc/util/misc";
import { CodemirrorEditor } from "../code-editor/codemirror-editor";
import { createEditor } from "../frame-tree/editor";
import { EditorDescription } from "../frame-tree/types";
import { time_travel } from "../time-travel-editor/editor";
import { CalendarViewer, TodoViewer } from "./viewer";

const VIEW_COMMANDS = set(["decrease_font_size", "increase_font_size"]);

const cm: EditorDescription = {
  type: "cm",
  short: "JSON",
  name: "JSON",
  icon: "code",
  component: CodemirrorEditor,
  commands: set([
    "codex",
    "print",
    "decrease_font_size",
    "increase_font_size",
    "save",
    "time_travel",
    "replace",
    "find",
    "goto_line",
    "cut",
    "paste",
    "copy",
    "undo",
    "redo",
  ]),
} as const;

const calendar: EditorDescription = {
  type: "calendar",
  short: "Calendar",
  name: "Calendar",
  icon: "calendar",
  component: CalendarViewer,
  commands: VIEW_COMMANDS,
} as const;

const todo: EditorDescription = {
  type: "todo",
  short: "Todo list",
  name: "Todo list",
  icon: "check-square",
  component: TodoViewer,
  commands: VIEW_COMMANDS,
} as const;

export const CalendarEditor = createEditor({
  format_bar: false,
  editor_spec: { calendar, cm, time_travel },
  display_name: "Calendar",
});

export const TodoEditor = createEditor({
  format_bar: false,
  editor_spec: { todo, cm, time_travel },
  display_name: "Todo list",
});
