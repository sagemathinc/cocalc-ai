/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Dropdown,
  Input,
  Modal,
  Popconfirm,
  Space,
  Typography,
} from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { AvatarStack } from "@cocalc/frontend/account/avatar/avatar-stack";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import { ChatEmbeddingOptionsProvider } from "@cocalc/frontend/chat/embedding-options";
import { initChat, removeWithInstance } from "@cocalc/frontend/chat/register";
import SideChat from "@cocalc/frontend/chat/side-chat";
import { ChatFontSizeControls } from "@cocalc/frontend/chat/chat-font-size-controls";
import { useAgentChatFontSize } from "@cocalc/frontend/project/page/agent-chat-font-size";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import {
  ProjectContext,
  useProjectContextProvider,
} from "@cocalc/frontend/project/context";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { ListedConversation } from "@cocalc/util/people";
import { peopleApi, conversationsChanged } from "./api";
import { waitForChatReady } from "./create";
import { ReferencePicker } from "./reference-picker";
import type { ChatInputControl } from "@cocalc/frontend/chat/input";
import { serializePeopleReference } from "@cocalc/util/people-references";
import { PageHeader } from "@cocalc/frontend/components/page-header";
import { autoThemeColor } from "@cocalc/frontend/components/identity-color";

export function ConversationView({
  conversation,
  conversations = [],
  onClose,
}: {
  conversation: ListedConversation;
  // Candidates for links inserted into a message.
  conversations?: ListedConversation[];
  onClose: () => void;
}) {
  const composer = useRef<ChatInputControl | null>(null);
  const [picking, setPicking] = useState(false);
  const { project_id, path, conversation_id } = conversation;
  const [actions, setActions] = useState<ChatActions>();
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [retry, setRetry] = useState(0);
  // The chat's own tools (artifacts, search, ...) live in our header row
  // rather than in a second bar above the messages.
  const [toolsPortal, setToolsPortal] = useState<HTMLElement | null>(null);

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
    void peopleApi()
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
      <ConversationHeader
        conversation={conversation}
        identityColor={
          conversationThreadColor(actions) ??
          autoThemeColor(conversation.conversation_id)
        }
        onClose={onClose}
        onInsertLink={actions ? () => setPicking(true) : undefined}
        toolsRef={setToolsPortal}
      />
      <ReferencePicker
        open={picking}
        project_id={project_id}
        conversations={conversations.filter(
          (c) => c.conversation_id !== conversation_id,
        )}
        onClose={() => setPicking(false)}
        onPick={(reference) => {
          composer.current?.insertText(
            `${serializePeopleReference(reference)} `,
          );
          composer.current?.focus();
        }}
      />
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
        <MountedChat
          actions={actions}
          project_id={project_id}
          path={path}
          toolsPortal={toolsPortal}
          onComposerReady={(control) => {
            composer.current = control;
          }}
        />
      )}
    </div>
  );
}

function MountedChat({
  actions,
  project_id,
  path,
  toolsPortal,
  onComposerReady,
}: {
  actions: ChatActions;
  project_id: string;
  path: string;
  toolsPortal: HTMLElement | null;
  onComposerReady?: (control: ChatInputControl | null) => void;
}) {
  // Same text size preference as agent chats.
  const accountFontSize = useTypedRedux("account", "font_size") ?? 13;
  const {
    fontSize,
    increaseFontSize,
    decreaseFontSize,
    canIncreaseFontSize,
    canDecreaseFontSize,
  } = useAgentChatFontSize(accountFontSize);
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
          // The conversation title is already in our header.
          hideCompactThreadHeader: true,
          sidebarHiddenByDefault: true,
          sidebarPreferenceKey: "people-conversation-sidebar",
        }}
      >
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <SideChat
            project_id={project_id}
            path={path}
            actions={actions}
            onComposerReady={onComposerReady}
            fontSize={fontSize}
            onIncreaseFontSize={increaseFontSize}
            onDecreaseFontSize={decreaseFontSize}
            threadPanelTopRightControlsPrefix={
              <ChatFontSizeControls
                fontSize={fontSize}
                onDecreaseFontSize={decreaseFontSize}
                onIncreaseFontSize={increaseFontSize}
                canDecreaseFontSize={canDecreaseFontSize}
                canIncreaseFontSize={canIncreaseFontSize}
                embedded
                label="Conversation text size"
                tooltipLabel="Conversation"
              />
            }
            threadPanelCompactTopRightControls
            threadPanelTopRightControlsPortal={toolsPortal}
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

// A conversation is one chat thread; its theme color, if set, identifies it.
function conversationThreadColor(actions?: ChatActions): string | undefined {
  try {
    const key = actions?.getThreadIndex?.()?.keys().next().value;
    if (!key) return undefined;
    const meta = actions?.getThreadMetadata?.(key, { threadId: key });
    return (
      meta?.thread_color?.trim() ||
      meta?.thread_accent_color?.trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}

function ConversationHeader({
  conversation,
  identityColor,
  onClose,
  onInsertLink,
  toolsRef,
}: {
  conversation: ListedConversation;
  identityColor?: string;
  onClose: () => void;
  onInsertLink?: () => void;
  toolsRef?: (element: HTMLElement | null) => void;
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
      await peopleApi().renameConversation({
        project_id,
        conversation_id,
        title,
      });
      setEditing(false);
      setError("");
      conversationsChanged();
    } catch (err) {
      setError(`${err}`);
    }
  }

  async function togglePin() {
    try {
      await peopleApi().setState({
        kind: "conversation",
        target_id: conversation_id,
        project_id,
        patch: { pinned: !conversation.pinned },
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

  function confirmRemove() {
    Modal.confirm({
      title: "Remove from the conversation list?",
      content: "The chat file and its messages are kept in the project.",
      okText: "Remove",
      okButtonProps: { danger: true },
      onOk: async () => {
        await removeConversation(conversation);
        onClose();
      },
    });
  }

  const pinLabel = conversation.pinned ? "Unpin" : "Pin";

  // One row: identity on the left, then the chat's tools and ours.
  return (
    <div>
      <PageHeader identityColor={identityColor}>
        <Button
          type="text"
          aria-label="Back to conversations"
          icon={<Icon name="arrow-left" />}
          onClick={onClose}
        />
        {editing ? (
          <Space.Compact style={{ flex: "1 1 auto", minWidth: 0 }}>
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
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              minWidth: 0,
              flex: "1 1 auto",
            }}
          >
            <Typography.Title
              level={5}
              ellipsis
              style={{ margin: 0, minWidth: 0, flex: "0 1 auto" }}
            >
              {conversation.title}
            </Typography.Title>
            <Typography.Text
              type="secondary"
              ellipsis
              style={{ minWidth: 0, flex: "0 1 auto" }}
            >
              {projectTitle ?? ""}
            </Typography.Text>
          </div>
        )}
        <AvatarStack
          entries={conversation.participant_ids.map((account_id) => ({
            account_id,
          }))}
          size={22}
        />
        <div
          ref={toolsRef}
          style={{
            display: "inline-flex",
            alignItems: "center",
            flex: "0 0 auto",
          }}
        />
        {onInsertLink && (
          <Tooltip title="Insert a link to a file, conversation or person">
            <Button
              size="small"
              aria-label="Insert link"
              icon={<Icon name="link" />}
              onClick={onInsertLink}
            />
          </Tooltip>
        )}
        <Tooltip title={pinLabel}>
          <Button
            size="small"
            aria-label={pinLabel}
            aria-pressed={conversation.pinned}
            type={conversation.pinned ? "primary" : "default"}
            ghost={conversation.pinned}
            icon={<Icon name="pushpin" />}
            onClick={togglePin}
          />
        </Tooltip>
        <Dropdown
          trigger={["click"]}
          menu={{
            items: [
              { key: "rename", label: "Rename..." },
              { key: "open", label: "Open in project" },
              { type: "divider" },
              { key: "remove", label: "Remove from list...", danger: true },
            ],
            onClick: ({ key }) => {
              if (key === "rename") {
                setTitle(conversation.title);
                setEditing(true);
              } else if (key === "open") {
                openInProject();
              } else if (key === "remove") {
                confirmRemove();
              }
            },
          }}
        >
          <Button
            size="small"
            aria-label="Conversation options"
            icon={<Icon name="ellipsis" />}
          />
        </Dropdown>
      </PageHeader>
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

async function removeConversation(conversation: ListedConversation) {
  await peopleApi().removeConversation({
    project_id: conversation.project_id,
    conversation_id: conversation.conversation_id,
  });
  conversationsChanged();
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
        await removeConversation(conversation);
        onDone();
      }}
    >
      <Button danger>Remove</Button>
    </Popconfirm>
  );
}
