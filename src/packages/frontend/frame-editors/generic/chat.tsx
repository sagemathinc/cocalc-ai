/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import { getChatActions, initChat } from "@cocalc/frontend/chat/register";
import SideChat from "@cocalc/frontend/chat/side-chat";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { labels } from "@cocalc/frontend/i18n";
import { chatMetaFile } from "@cocalc/frontend/chat/paths";
import { EditorComponentProps, EditorDescription } from "../frame-tree/types";
import { chatroom } from "@cocalc/frontend/frame-editors/chat-editor/editor";

export function chatFile(path: string): string {
  return chatMetaFile(path);
}

function Chat({ font_size, desc }: EditorComponentProps) {
  const { project_id, path: path0, actions, id: frameId } = useFrameContext();
  const path = chatFile(path0);
  const [sideChatActions, setSideChatActions] = useState<ChatActions | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    const attachChatActions = (): ChatActions => {
      const nextActions =
        getChatActions(project_id, path) ?? initChat(project_id, path);
      nextActions.frameTreeActions = actions;
      nextActions.frameId = frameId;
      if (!cancelled) {
        setSideChatActions(nextActions);
      }
      return nextActions;
    };
    attachChatActions();
    return () => {
      cancelled = true;
    };
  }, [actions, frameId, path, project_id]);

  useEffect(() => {
    if (!sideChatActions) return;
    const syncdb = (sideChatActions as any)?.syncdb;
    let cancelled = false;
    const reconnect = () => {
      if (cancelled) return;
      const nextActions = initChat(project_id, path);
      nextActions.frameTreeActions = actions;
      nextActions.frameId = frameId;
      setSideChatActions((current) =>
        current === sideChatActions ? nextActions : current,
      );
    };
    if (syncdb?.get_state?.() === "closed") {
      reconnect();
      return;
    }
    const onClose = () => {
      reconnect();
    };
    syncdb?.once?.("close", onClose);
    return () => {
      cancelled = true;
      syncdb?.removeListener?.("close", onClose);
    };
  }, [actions, frameId, path, project_id, sideChatActions]);

  if (sideChatActions == null) {
    return null;
  }
  return (
    <SideChat
      actions={sideChatActions}
      project_id={project_id}
      path={path}
      fontSize={font_size}
      desc={desc}
    />
  );
}

const commands: any = {};
for (const x in chatroom.commands) {
  if (x == "time_travel" || x == "show_search") {
    continue;
  }
  commands[x] = true;
}
export const chat: EditorDescription = {
  type: "chat",
  short: labels.chat,
  name: labels.chat,
  icon: "comment",
  commands,
  component: Chat,
} as const;

export function getSideChatActions({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}): ChatActions | null {
  return getChatActions(project_id, chatFile(path)) ?? null;
}

// TODO: this is an ugly special case for now to make the title bar buttons work.
// TODO: but wait -- those buttons are gone now, so maybe this can be deleted?!
export function undo(project_id, path) {
  return getSideChatActions({ project_id, path })?.undo();
}
export function redo(project_id, path) {
  return getSideChatActions({ project_id, path })?.redo();
}
