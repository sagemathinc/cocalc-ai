/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { Alert, Button, Input, Popconfirm, Space, Typography } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { AvatarStack } from "@cocalc/frontend/account/avatar/avatar-stack";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import { ChatEmbeddingOptionsProvider } from "@cocalc/frontend/chat/embedding-options";
import { initChat, removeWithInstance } from "@cocalc/frontend/chat/register";
import SideChat from "@cocalc/frontend/chat/side-chat";
import { Icon } from "@cocalc/frontend/components";
import {
  ProjectContext,
  useProjectContextProvider,
} from "@cocalc/frontend/project/context";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { ListedConversation } from "@cocalc/util/conversations";
import { conversationsApi, conversationsChanged } from "./api";
import { waitForChatReady } from "./create";

export function ConversationView({
  conversation,
  onClose,
}: {
  conversation: ListedConversation;
  onClose: () => void;
}) {
  const { project_id, path, conversation_id } = conversation;
  const [actions, setActions] = useState<ChatActions>();
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let canceled = false;
    let initialized = false;
    const instanceKey = `people-${conversation_id}`;
    setActions(undefined);
    setError("");
    setMissing(false);
    void (async () => {
      await ensureProjectReduxRuntime();
      const project = redux.getProjectActions(project_id);
      if (project == null) throw Error("This project is not available.");
      // Never silently recreate a chat file that was deleted or moved.
      try {
        await project.fs().stat(path);
      } catch {
        if (!canceled) setMissing(true);
        return;
      }
      if (canceled) return;
      const chat = initChat(project_id, path, { instanceKey });
      initialized = true;
      await waitForChatReady(chat);
      if (!canceled) setActions(chat);
    })().catch((err) => {
      if (!canceled) setError(`${err}`);
    });
    return () => {
      canceled = true;
      if (initialized) {
        removeWithInstance(path, redux, project_id, { instanceKey });
      }
    };
  }, [project_id, path, conversation_id, retry]);

  // Opening (and staying on) a conversation reads it through its activity.
  useEffect(() => {
    void conversationsApi()
      .markRead({
        project_id,
        conversation_id,
        read_through: conversation.last_activity,
      })
      .then(conversationsChanged)
      .catch(() => {});
  }, [project_id, conversation_id, conversation.last_activity]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
    >
      <ConversationHeader conversation={conversation} onClose={onClose} />
      {missing ? (
        <Alert
          role="alert"
          type="warning"
          showIcon
          title="The chat file for this conversation is missing"
          description={`It was expected at ${path}. It may have been moved or deleted outside this page. Removing the conversation from the list does not delete anything.`}
          action={<RemoveButton conversation={conversation} onDone={onClose} />}
        />
      ) : error ? (
        <Alert
          role="alert"
          type="error"
          showIcon
          title="Conversation unavailable"
          description={error}
          action={<Button onClick={() => setRetry((n) => n + 1)}>Retry</Button>}
        />
      ) : actions == null ? (
        <p role="status" style={{ padding: 16 }}>
          Opening conversation...
        </p>
      ) : (
        <MountedChat actions={actions} project_id={project_id} path={path} />
      )}
    </div>
  );
}

function MountedChat({
  actions,
  project_id,
  path,
}: {
  actions: ChatActions;
  project_id: string;
  path: string;
}) {
  const context = useProjectContextProvider({
    project_id,
    is_active: true,
    mainWidthPx: 700,
    manageWorkspaceSelection: false,
  });
  return (
    <ProjectContext.Provider value={context}>
      <ChatEmbeddingOptionsProvider
        value={{
          disableConversationFocus: true,
          sidebarHiddenByDefault: true,
          sidebarPreferenceKey: "people-conversation-sidebar",
        }}
      >
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <SideChat
            project_id={project_id}
            path={path}
            actions={actions}
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

function ConversationHeader({
  conversation,
  onClose,
}: {
  conversation: ListedConversation;
  onClose: () => void;
}) {
  const projectTitle = useTypedRedux("projects", "project_map")?.getIn([
    conversation.project_id,
    "title",
  ]) as string | undefined;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  const [error, setError] = useState("");
  const { project_id, conversation_id } = conversation;

  async function rename() {
    try {
      await conversationsApi().rename({ project_id, conversation_id, title });
      setEditing(false);
      setError("");
      conversationsChanged();
    } catch (err) {
      setError(`${err}`);
    }
  }

  async function togglePin() {
    try {
      await conversationsApi().setPinned({
        project_id,
        conversation_id,
        pinned: !conversation.pinned,
      });
      conversationsChanged();
    } catch (err) {
      setError(`${err}`);
    }
  }

  function openInProject() {
    void (async () => {
      await ensureProjectReduxRuntime();
      await redux
        .getProjectActions(project_id)
        ?.open_file({ path: conversation.path, foreground: true });
      redux.getActions("page").set_active_tab(project_id);
    })();
  }

  return (
    <div
      style={{
        borderBottom: `1px solid ${UI_COLORS.border}`,
        padding: "8px 12px",
      }}
    >
      <Space wrap align="center" style={{ width: "100%" }}>
        <Button
          type="text"
          aria-label="Back to conversations"
          icon={<Icon name="arrow-left" />}
          onClick={onClose}
        />
        {editing ? (
          <Space.Compact>
            <Input
              aria-label="Conversation title"
              value={title}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              onPressEnter={rename}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
              }}
            />
            <Button type="primary" onClick={rename}>
              Save
            </Button>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
          </Space.Compact>
        ) : (
          <Typography.Title level={4} style={{ margin: 0 }}>
            {conversation.title}
          </Typography.Title>
        )}
        <Typography.Text type="secondary">{projectTitle ?? ""}</Typography.Text>
        <AvatarStack
          entries={conversation.participant_ids.map((account_id) => ({
            account_id,
          }))}
          size={22}
        />
        <span style={{ flex: 1 }} />
        <Button
          aria-pressed={conversation.pinned}
          icon={<Icon name="pushpin" />}
          onClick={togglePin}
        >
          {conversation.pinned ? "Unpin" : "Pin"}
        </Button>
        {!editing && (
          <Button
            onClick={() => {
              setTitle(conversation.title);
              setEditing(true);
            }}
          >
            Rename
          </Button>
        )}
        <Button onClick={openInProject}>Open in project</Button>
        <RemoveButton conversation={conversation} onDone={onClose} />
      </Space>
      {error && (
        <Alert
          role="alert"
          type="error"
          title={error}
          style={{ marginTop: 8 }}
        />
      )}
    </div>
  );
}

function RemoveButton({
  conversation,
  onDone,
}: {
  conversation: ListedConversation;
  onDone: () => void;
}) {
  return (
    <Popconfirm
      title="Remove from the conversation list?"
      description="The chat file and its messages are kept in the project."
      okText="Remove"
      onConfirm={async () => {
        await conversationsApi().remove({
          project_id: conversation.project_id,
          conversation_id: conversation.conversation_id,
        });
        conversationsChanged();
        onDone();
      }}
    >
      <Button danger>Remove</Button>
    </Popconfirm>
  );
}
