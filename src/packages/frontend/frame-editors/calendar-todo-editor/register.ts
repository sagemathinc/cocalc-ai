/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Calendars (foo.cal.json) and agents' todo lists (foo.todo.json) open in a
viewer, the same one their chat artifacts show, with the JSON beside it on
request. Other .json files stay in the code editor.
*/

import { register_file_editor } from "../frame-tree/register";

register_file_editor({
  ext: "cal.json",
  icon: "calendar",
  codemirror: true,
  editor: async () => ({ Editor: (await import("./editor")).CalendarEditor }),
  actions: async () => ({
    Actions: (await import("./actions")).CalendarActions,
  }),
});

register_file_editor({
  ext: "todo.json",
  icon: "check-square",
  codemirror: true,
  editor: async () => ({ Editor: (await import("./editor")).TodoEditor }),
  actions: async () => ({ Actions: (await import("./actions")).TodoActions }),
});
