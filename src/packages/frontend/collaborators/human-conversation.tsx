/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useId, useState } from "react";
import { Alert, Button } from "antd";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import { initChat, removeWithInstance } from "@cocalc/frontend/chat/register";
import SideChat from "@cocalc/frontend/chat/side-chat";
import { ChatEmbeddingOptionsProvider } from "@cocalc/frontend/chat/embedding-options";
import {
  ProjectContext,
  useProjectContextProvider,
} from "@cocalc/frontend/project/context";
import { waitForCollaborationChat } from "./chat-runtime";

export function HumanConversation({
  accountId,
  resource,
  onOpenOriginal,
}: {
  accountId: string;
  resource: CollaborationResource;
  onOpenOriginal?: () => void;
}) {
  const id = useId();
  const [actions, setActions] = useState<ChatActions>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    const instanceKey = `collaborators:${accountId}:${id}`;
    let initialized = false;
    setActions(undefined);
    setError("");
    const current = () =>
      !abort.signal.aborted &&
      redux.getStore("account")?.get("account_id") === accountId;
    void (async () => {
      await ensureProjectReduxRuntime();
      if (!current()) return;
      const project = redux.getProjectActions(resource.project_id);
      if (!project) throw Error("This project is unavailable.");
      // Opening a deleted locator must not silently recreate an empty chat.
      await project.fs().stat(resource.chat_path);
      if (!current()) return;
      const chat = initChat(resource.project_id, resource.chat_path, {
        instanceKey,
        workbenchEnabled: false,
      });
      initialized = true;
      await waitForCollaborationChat(chat, abort.signal);
      if (!current()) return;
      const metadata = chat.getThreadMetadata(resource.thread_id, {
        threadId: resource.thread_id,
      });
      if (
        !metadata ||
        metadata.agent_kind !== "none" ||
        metadata.acp_config ||
        metadata.agent_model
      )
        throw Error(
          "This is not an available human-only conversation. Refresh the directory or open its original chat.",
        );
      chat.setSelectedThread(resource.thread_id);
      setActions(chat);
    })().catch((error) => {
      if (current()) setError(String(error));
    });
    return () => {
      abort.abort();
      if (initialized)
        removeWithInstance(resource.chat_path, redux, resource.project_id, {
          instanceKey,
        });
    };
  }, [
    accountId,
    resource.project_id,
    resource.chat_path,
    resource.thread_id,
    retry,
    id,
  ]);
  if (error)
    return (
      <Alert
        role="alert"
        type="error"
        title="Conversation unavailable"
        description={error}
        action={
          <div className="collaborators-actions">
            <Button onClick={() => setRetry((n) => n + 1)}>
              Retry conversation
            </Button>
            {onOpenOriginal && (
              <Button onClick={onOpenOriginal}>
                Open original conversation
              </Button>
            )}
          </div>
        }
      />
    );
  if (!actions)
    return <p role="status">Connecting to the project's conversation...</p>;
  return (
    <MountedConversation
      actions={actions}
      resource={resource}
      accountId={accountId}
    />
  );
}

function MountedConversation({
  actions,
  resource,
  accountId,
}: {
  actions: ChatActions;
  resource: CollaborationResource;
  accountId: string;
}) {
  const context = useProjectContextProvider({
    project_id: resource.project_id,
    is_active: true,
    mainWidthPx: 700,
    manageWorkspaceSelection: false,
  });
  return (
    <ProjectContext.Provider value={context}>
      <ChatEmbeddingOptionsProvider
        value={{
          humanOnly: true,
          agentWorkspace: true,
          agentWorkspaceActive: true,
          disableConversationFocus: true,
          hideSingleFrameToolbar: true,
          hideCompactThreadHeader: true,
          sidebarHiddenByDefault: true,
        }}
      >
        <div className="collaborators-chat">
          <SideChat
            project_id={resource.project_id}
            path={resource.chat_path}
            actions={actions}
            hideSidebar
            desc={{ "data-selectedThreadKey": resource.thread_id }}
            scrollCacheId={`collaborators:${accountId}:${resource.project_id}:${resource.thread_id}`}
            style={{
              backgroundColor: UI_COLORS.surface,
              color: UI_COLORS.text,
              flex: 1,
            }}
          />
        </div>
      </ChatEmbeddingOptionsProvider>
    </ProjectContext.Provider>
  );
}
