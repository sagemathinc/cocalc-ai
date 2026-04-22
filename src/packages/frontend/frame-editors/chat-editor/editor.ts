/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Top-level react component for editing chat
*/

import { createElement } from "react";

import { ChatRoom } from "@cocalc/frontend/chat/chatroom";
import { Loading } from "@cocalc/frontend/components";
import { createEditor } from "@cocalc/frontend/frame-editors/frame-tree/editor";
import type {
  EditorComponentProps,
  EditorDescription,
} from "@cocalc/frontend/frame-editors/frame-tree/types";
import { terminal } from "@cocalc/frontend/frame-editors/terminal-editor/editor";
import { time_travel } from "@cocalc/frontend/frame-editors/time-travel-editor/editor";
import { set } from "@cocalc/util/misc";
import { search } from "./search";

export const chatroom: EditorDescription = {
  type: "chatroom",
  short: "Chatroom",
  name: "Chatroom",
  icon: "comment",
  component: (props: EditorComponentProps) => {
    const actions = props.actions.getChatActions(props.id);
    if (actions == null) {
      return createElement(Loading, { theme: "medium" });
    }
    return createElement(ChatRoom, {
      ...props,
      actions,
    });
  },
  commands: set([
    "decrease_font_size",
    "increase_font_size",
    "time_travel",
    "undo",
    "redo",
    "save",
    "help",
    "export_document",
    "chatgpt",
    "scrollToBottom",
    "scrollToTop",
    "show_search",
    "terminal",
  ]),
  customizeCommands: {
    scrollToTop: {
      label: "Scroll to Old",
      button: "Oldest",
      title: "Scroll to oldest message in chat",
    },
    scrollToBottom: {
      label: "Scroll to Newest",
      button: "Newest",
      title: "Scroll to newest message in chat",
    },
  },
  buttons: set([
    "undo",
    "redo",
    "decrease_font_size",
    "increase_font_size",
    "scrollToTop",
    "scrollToBottom",
    "show_search",
  ]),
} as const;

const EDITOR_SPEC = {
  chatroom,
  terminal,
  time_travel,
  search,
} as const;

export const Editor = createEditor({
  editor_spec: EDITOR_SPEC,
  display_name: "ChatEditor",
});
