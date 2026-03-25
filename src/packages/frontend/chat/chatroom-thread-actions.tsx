/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Modal, message as antdMessage } from "antd";
import { useEffect, useMemo, useRef } from "@cocalc/frontend/app-framework";
import { saveNavigatorSelectedThreadKey } from "@cocalc/frontend/project/new/navigator-state";
import type { ChatActions } from "./actions";

export interface ChatRoomThreadActionHandlers {
  confirmDeleteThread: (threadKey: string, label?: string) => void;
  confirmResetThread: (threadKey: string, label?: string) => void;
}

interface ChatRoomThreadActionsProps {
  actions: ChatActions;
  path?: string;
  selectedThreadKey: string | null;
  setSelectedThreadKey: (key: string | null) => void;
  onHandlers?: (handlers: ChatRoomThreadActionHandlers) => void;
}

export function ChatRoomThreadActions({
  actions,
  path,
  selectedThreadKey,
  setSelectedThreadKey,
  onHandlers,
}: ChatRoomThreadActionsProps) {
  const actionsRef = useRef(actions);
  const pathRef = useRef(path);
  const selectedThreadKeyRef = useRef(selectedThreadKey);
  const setSelectedThreadKeyRef = useRef(setSelectedThreadKey);

  useEffect(() => {
    actionsRef.current = actions;
    pathRef.current = path;
    selectedThreadKeyRef.current = selectedThreadKey;
    setSelectedThreadKeyRef.current = setSelectedThreadKey;
  }, [actions, path, selectedThreadKey, setSelectedThreadKey]);

  const handlers = useMemo<ChatRoomThreadActionHandlers>(() => {
    return {
      confirmResetThread: (threadKey: string, label?: string) => {
        const performResetThread = () => {
          const currentActions = actionsRef.current;
          const currentSetSelected = setSelectedThreadKeyRef.current;
          const currentPath = pathRef.current;
          const nextThreadKey = currentActions?.resetThread?.(threadKey);
          if (!nextThreadKey) {
            antdMessage.error("Unable to start a fresh chat thread.");
            return;
          }
          currentSetSelected(nextThreadKey);
          if (currentPath?.trim()) {
            saveNavigatorSelectedThreadKey(nextThreadKey, currentPath);
          }
          antdMessage.success("Started a fresh empty chat thread.");
        };

        const trimmedLabel = (label ?? "").trim();
        const displayLabel =
          trimmedLabel.length > 0
            ? trimmedLabel.length > 120
              ? `${trimmedLabel.slice(0, 117)}...`
              : trimmedLabel
            : null;
        Modal.confirm({
          title: displayLabel ? `Clear chat "${displayLabel}"?` : "Clear chat?",
          content:
            "This starts a fresh empty thread with the same chat settings and selects it. The existing thread and its messages are kept.",
          okText: "Clear",
          cancelText: "Cancel",
          onOk: performResetThread,
        });
      },
      confirmDeleteThread: (threadKey: string, label?: string) => {
        const performDeleteThread = () => {
          const currentActions = actionsRef.current;
          const currentSelected = selectedThreadKeyRef.current;
          const currentSetSelected = setSelectedThreadKeyRef.current;
          if (!currentActions?.deleteThread) {
            antdMessage.error("Deleting chats is not available.");
            return;
          }
          const deleted = currentActions.deleteThread(threadKey);
          if (deleted === 0) {
            antdMessage.info("This chat has no messages to delete.");
            return;
          }
          if (currentSelected === threadKey) {
            currentSetSelected(null);
          }
          antdMessage.success("Chat deleted.");
        };

        const trimmedLabel = (label ?? "").trim();
        const displayLabel =
          trimmedLabel.length > 0
            ? trimmedLabel.length > 120
              ? `${trimmedLabel.slice(0, 117)}...`
              : trimmedLabel
            : null;
        Modal.confirm({
          title: displayLabel
            ? `Delete chat "${displayLabel}"?`
            : "Delete chat?",
          content:
            "This removes all messages in this chat for everyone. This can only be undone using 'Edit --> Undo', or by browsing TimeTravel.",
          okText: "Delete",
          okType: "danger",
          cancelText: "Cancel",
          onOk: performDeleteThread,
        });
      },
    };
  }, []);

  useEffect(() => {
    onHandlers?.(handlers);
  }, [handlers, onHandlers]);

  return null;
}
