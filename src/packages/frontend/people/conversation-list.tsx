/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Typography } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { AvatarStack } from "@cocalc/frontend/account/avatar/avatar-stack";
import { TimeAgo } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  isConversationUnread,
  type ListedConversation,
} from "@cocalc/util/conversations";

const VISUALLY_HIDDEN = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

export function ConversationList({
  conversations,
  selected,
  onSelect,
  emptyText = "No conversations yet.",
}: {
  conversations: ListedConversation[];
  selected?: string;
  onSelect: (conversation: ListedConversation) => void;
  emptyText?: string;
}) {
  const pinned = conversations.filter((c) => c.pinned);
  const recent = conversations.filter((c) => !c.pinned);
  if (conversations.length === 0) {
    return (
      <Typography.Paragraph type="secondary">{emptyText}</Typography.Paragraph>
    );
  }
  return (
    <div>
      {pinned.length > 0 && (
        <Section
          title="Pinned"
          conversations={pinned}
          selected={selected}
          onSelect={onSelect}
        />
      )}
      <Section
        title={pinned.length > 0 ? "Recent" : undefined}
        conversations={recent}
        selected={selected}
        onSelect={onSelect}
      />
    </div>
  );
}

function Section({
  title,
  conversations,
  selected,
  onSelect,
}: {
  title?: string;
  conversations: ListedConversation[];
  selected?: string;
  onSelect: (conversation: ListedConversation) => void;
}) {
  if (conversations.length === 0) return null;
  return (
    <section aria-label={title ?? "Conversations"}>
      {title && (
        <Typography.Text
          type="secondary"
          style={{ display: "block", margin: "12px 0 4px" }}
        >
          {title}
        </Typography.Text>
      )}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {conversations.map((c) => (
          <li key={c.conversation_id}>
            <ConversationItem
              conversation={c}
              selected={c.conversation_id === selected}
              onSelect={onSelect}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConversationItem({
  conversation,
  selected,
  onSelect,
}: {
  conversation: ListedConversation;
  selected: boolean;
  onSelect: (conversation: ListedConversation) => void;
}) {
  const projectTitle = useTypedRedux("projects", "project_map")?.getIn([
    conversation.project_id,
    "title",
  ]) as string | undefined;
  const unread = isConversationUnread(conversation);
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(conversation)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        border: "none",
        borderRadius: 6,
        padding: "8px 10px",
        margin: "2px 0",
        cursor: "pointer",
        color: UI_COLORS.text,
        background: selected ? UI_COLORS.selected : "transparent",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {unread && (
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              flex: "0 0 auto",
              background: UI_COLORS.primary,
            }}
          />
        )}
        <span
          style={{
            fontWeight: unread ? 600 : 400,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {conversation.title}
        </span>
        {unread && <span style={VISUALLY_HIDDEN}> (unread)</span>}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: UI_COLORS.secondary,
          fontSize: "90%",
          marginTop: 2,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {projectTitle ?? ""}
        </span>
        <AvatarStack
          entries={conversation.participant_ids.map((account_id) => ({
            account_id,
          }))}
          size={18}
          maxAvatars={4}
        />
        <span style={{ flex: 1 }} />
        <TimeAgo date={new Date(conversation.last_activity)} />
      </div>
    </button>
  );
}
