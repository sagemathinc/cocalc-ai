/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The TimeTravel editor -- this is a whole frame tree devoted to exploring
the history of a file.

Components in this directory may also be used to provide a frame in other editors with
TimeTravel for them.
*/

import { labels } from "@cocalc/frontend/i18n";
import { AsyncComponent } from "@cocalc/frontend/misc/async-component";
import { set } from "@cocalc/util/misc";
import { addEditorMenus } from "../frame-tree/commands";
import { createEditor } from "../frame-tree/editor";
import { EditorDescription } from "../frame-tree/types";

const TimeTravel = AsyncComponent(
  async () => (await import("./time-travel")).TimeTravel,
);

const timeTravelCommands = set([
  "decrease_font_size",
  "increase_font_size",
  "set_zoom",
  "help",
  "-file",
  "copy",
]);

const TIME_TRAVEL_MENUS = {
  history: {
    label: "History",
    pos: 0.75,
    entries: {
      actions: ["export_history", "purge_history"],
    },
  },
};

function initMenus(): void {
  const names = addEditorMenus({
    prefix: "timetravel",
    editorMenus: TIME_TRAVEL_MENUS,
    getCommand: (name) => {
      if (name === "export_history") {
        return {
          icon: "file-export",
          label: "Export...",
          title: "Export information about this file's edit history to JSON.",
          onClick: async ({ props }) => {
            await props.actions.export_history?.();
          },
        };
      }
      if (name === "purge_history") {
        return {
          icon: "trash",
          label: "Purge Edit History...",
          title:
            "Permanently delete TimeTravel edit history for this file and close open tabs.",
          popconfirm: {
            title: "Purge edit history?",
            description:
              "This permanently deletes TimeTravel history for this file. The current file contents will be kept.",
            okText: "Purge History",
            cancelText: "Cancel",
          },
          onClick: async ({ props }) => {
            await props.actions.purge_history?.();
          },
        };
      }
      throw Error(`invalid TimeTravel command name "${name}"`);
    },
  });
  for (const name of names) {
    timeTravelCommands[name] = true;
  }
}

initMenus();

export const time_travel: EditorDescription = {
  type: "timetravel",
  short: labels.timetravel,
  name: labels.timetravel,
  icon: "history",
  component: TimeTravel,
  commands: timeTravelCommands,
  hide_file_menu: true,
  hide_public: true,
} as const;

const EDITOR_SPEC = {
  time_travel,
} as const;

export const Editor = createEditor({
  format_bar: false,
  editor_spec: EDITOR_SPEC,
  display_name: "TimeTravel",
});
