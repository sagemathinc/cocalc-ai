/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Suspense, useEffect, useState } from "react";
import { CocalcErrorBoundary } from "@cocalc/frontend/app/error-boundary";
import { lazyWithRetry } from "@cocalc/frontend/app/lazy-with-retry";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import { getChatActions, initChat } from "@cocalc/frontend/chat/register";
import { Loading } from "@cocalc/frontend/components/loading";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { labels } from "@cocalc/frontend/i18n";
import { chatMetaFile } from "@cocalc/frontend/chat/paths";
import { EditorComponentProps, EditorDescription } from "../frame-tree/types";
import { CHATROOM_COMMANDS } from "@cocalc/frontend/frame-editors/chat-editor/commands";

const SideChat = lazyWithRetry(
  async () => ({
    default: (await import("@cocalc/frontend/chat/side-chat")).default,
  }),
  "side chat editor",
);

export function chatFile(path: string): string {
  return chatMetaFile(path);
}

function Chat({
  font_size,
  desc,
  is_visible,
  tab_is_visible,
}: EditorComponentProps) {
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
    <CocalcErrorBoundary
      scope="frame-editor.side-chat"
      resetKeys={[project_id, path]}
    >
      <Suspense fallback={<Loading theme="medium" />}>
        <SideChat
          actions={sideChatActions}
          project_id={project_id}
          path={path}
          fontSize={font_size}
          desc={desc}
          isVisible={is_visible && tab_is_visible}
        />
      </Suspense>
    </CocalcErrorBoundary>
  );
}

const commands: any = {};
for (const x of CHATROOM_COMMANDS) {
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
