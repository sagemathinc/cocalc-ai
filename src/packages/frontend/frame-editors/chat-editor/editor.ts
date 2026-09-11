/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Top-level react component for editing chat
*/

import { createElement, Suspense } from "react";

import { CocalcErrorBoundary } from "@cocalc/frontend/app/error-boundary";
import { lazyWithRetry } from "@cocalc/frontend/app/lazy-with-retry";
import { Loading } from "@cocalc/frontend/components/loading";
import { createEditor } from "@cocalc/frontend/frame-editors/frame-tree/editor";
import type {
  EditorComponentProps,
  EditorDescription,
} from "@cocalc/frontend/frame-editors/frame-tree/types";
import { terminal } from "@cocalc/frontend/frame-editors/terminal-editor/editor";
import { time_travel } from "@cocalc/frontend/frame-editors/time-travel-editor/editor";
import { set } from "@cocalc/util/misc";
import { CHATROOM_COMMANDS } from "./commands";
import { search } from "./search";
import { workbench } from "./workbench";

const ChatRoom = lazyWithRetry(
  async () => ({
    default: (await import("@cocalc/frontend/chat/chatroom")).ChatRoom,
  }),
  "chat editor",
);

export const chatroom: EditorDescription = {
  type: "chatroom",
  short: "Chatroom",
  name: "Chatroom",
  icon: "comment",
  component: (props: EditorComponentProps) => {
    const actions = props.actions.getChatActions(props.id, {
      allowMissingFrameType: true,
    });
    if (actions == null) {
      return createElement(Loading, { theme: "medium" });
    }
    return createElement(CocalcErrorBoundary, {
      scope: "frame-editor.chat",
      resetKeys: [props.project_id, props.path],
      children: createElement(
        Suspense,
        { fallback: createElement(Loading, { theme: "medium" }) },
        createElement(ChatRoom, {
          ...props,
          actions,
        }),
      ),
    });
  },
  commands: set([...CHATROOM_COMMANDS]),
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
  buttons: set(["undo", "redo", "show_search"]),
} as const;

const EDITOR_SPEC = {
  chatroom,
  terminal,
  time_travel,
  search,
  workbench,
} as const;

export const Editor = createEditor({
  editor_spec: EDITOR_SPEC,
  display_name: "ChatEditor",
});
