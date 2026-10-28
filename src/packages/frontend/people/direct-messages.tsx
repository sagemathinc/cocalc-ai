/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The Messages tab on People: direct conversations, in no project.

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Popconfirm, Space, Tag } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { Icon, TimeAgo, Tooltip } from "@cocalc/frontend/components";
import { MarkdownInput } from "@cocalc/frontend/editors/markdown-input";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { User } from "@cocalc/frontend/users/user";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  DIRECT_MESSAGES_PAGE,
  isDirectRequest,
  isDirectUnread,
  type DirectMessage,
  type DirectResponse,
  type MemberDirectConversation,
} from "@cocalc/util/direct-conversations";
import { peopleApi } from "./api";
import { directChanged, useDirectConversations } from "./use-direct";

// The other people in a conversation, by name.
export function DirectNames({
  conversation,
  account_id,
}: {
  conversation: Pick<MemberDirectConversation, "member_ids" | "title">;
  account_id?: string;
}) {
  const others = conversation.member_ids.filter((id) => id !== account_id);
  if (conversation.title) return <>{conversation.title}</>;
  return (
    <>
      {others.map((id, i) => (
        <span key={id}>
          {i > 0 && ", "}
          <User account_id={id} />
        </span>
      ))}
    </>
  );
}

function DirectRow({
  conversation,
  account_id,
  selected,
  onSelect,
}: {
  conversation: MemberDirectConversation;
  account_id?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const unread = isDirectUnread(conversation, account_id);
  const request = isDirectRequest(conversation);
  const first = conversation.member_ids.find((id) => id !== account_id);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        width: "100%",
        textAlign: "left",
        padding: "10px 12px",
        border: "none",
        borderBottom: `1px solid ${UI_COLORS.border}`,
        background: selected ? UI_COLORS.selected : "transparent",
        cursor: "pointer",
        color: UI_COLORS.text,
        fontWeight: unread || request ? 600 : undefined,
      }}
    >
      {first && <Avatar account_id={first} size={32} no_tooltip />}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "flex",
            gap: 8,
            alignItems: "baseline",
            justifyContent: "space-between",
          }}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <DirectNames conversation={conversation} account_id={account_id} />
          </span>
          <span
            style={{ fontSize: 12, color: UI_COLORS.secondary, flex: "none" }}
          >
            <TimeAgo date={conversation.last_activity} />
          </span>
        </span>
        <span
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            fontWeight: 400,
            color: UI_COLORS.secondary,
            fontSize: 13,
          }}
        >
          {request && <Tag color="blue">Request</Tag>}
          {unread && (
            <span
              aria-label="unread"
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                background: UI_COLORS.primary,
                flex: "none",
              }}
            />
          )}
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {conversation.preview || "No messages yet"}
          </span>
        </span>
      </span>
    </button>
  );
}

export function DirectList({
  conversations,
  selected,
  onSelect,
  search,
}: {
  conversations: MemberDirectConversation[];
  selected?: string;
  onSelect: (c: MemberDirectConversation) => void;
  search?: string;
}) {
  const account_id = useTypedRedux("account", "account_id");
  const user_map = useTypedRedux("users", "user_map");
  const q = (search ?? "").trim().toLowerCase();
  const matches = (c: MemberDirectConversation) =>
    !q ||
    `${c.title ?? ""} ${c.preview}`.toLowerCase().includes(q) ||
    c.member_ids.some((id) =>
      `${user_map?.getIn([id, "first_name"]) ?? ""} ${user_map?.getIn([id, "last_name"]) ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  const requests = conversations.filter(
    (c) => isDirectRequest(c) && matches(c),
  );
  const others = conversations.filter((c) => !isDirectRequest(c) && matches(c));
  const row = (c: MemberDirectConversation) => (
    <DirectRow
      key={c.conversation_id}
      conversation={c}
      account_id={account_id}
      selected={c.conversation_id === selected}
      onSelect={() => onSelect(c)}
    />
  );
  return (
    <div>
      {requests.length > 0 && (
        <section aria-label="Message requests">
          <h3
            style={{
              fontSize: 13,
              color: UI_COLORS.secondary,
              margin: "8px 12px",
            }}
          >
            Requests ({requests.length})
          </h3>
          {requests.map(row)}
        </section>
      )}
      <section aria-label="Direct conversations">
        {requests.length > 0 && others.length > 0 && (
          <h3
            style={{
              fontSize: 13,
              color: UI_COLORS.secondary,
              margin: "8px 12px",
            }}
          >
            Conversations
          </h3>
        )}
        {others.map(row)}
      </section>
      {requests.length + others.length === 0 && (
        <p style={{ color: UI_COLORS.secondary, padding: 12 }}>
          {q
            ? "No matching messages."
            : "No messages yet. Message anyone you work with; you don't need a shared project."}
        </p>
      )}
    </div>
  );
}

export function mergeMessages(
  current: DirectMessage[],
  page: DirectMessage[],
): DirectMessage[] {
  const byId = new Map(current.map((m) => [m.message_id, m]));
  for (const m of page) byId.set(m.message_id, m);
  return [...byId.values()].sort((a, b) => a.sent - b.sent);
}

function RequestBanner({
  conversation,
  onRespond,
}: {
  conversation: MemberDirectConversation;
  onRespond: (action: DirectResponse) => void;
}) {
  return (
    <Alert
      type="info"
      role="status"
      title={
        <>
          <User account_id={conversation.created_by} /> wants to message you.
        </>
      }
      description="You aren't collaborators. Messages show as plain text until you accept. Reply or accept to continue; they won't be told if you decline."
      action={
        <Space direction="vertical">
          <Button
            type="primary"
            size="small"
            onClick={() => onRespond("accept")}
          >
            Accept
          </Button>
          <Button size="small" onClick={() => onRespond("decline")}>
            Decline
          </Button>
          <Popconfirm
            title="Block this person?"
            description="They won't be able to message you again."
            okText="Block"
            onConfirm={() => onRespond("block")}
          >
            <Button size="small" danger>
              Block
            </Button>
          </Popconfirm>
        </Space>
      }
      style={{ margin: 12 }}
    />
  );
}

function MessageItem({
  message,
  account_id,
  plain,
}: {
  message: DirectMessage;
  account_id?: string;
  // Not yet accepted: shown as text, so nothing in it loads (an image could
  // tell the sender you looked).
  plain?: boolean;
}) {
  const mine = message.sender_id === account_id;
  return (
    <article
      aria-label={mine ? "Your message" : "Message"}
      style={{ display: "flex", gap: 10, padding: "8px 12px" }}
    >
      <Avatar account_id={message.sender_id} size={28} no_tooltip />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: UI_COLORS.secondary }}>
          <strong style={{ color: UI_COLORS.text }}>
            {mine ? "You" : <User account_id={message.sender_id} />}
          </strong>{" "}
          <TimeAgo date={message.sent} />
        </div>
        {plain ? (
          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {message.body}
          </div>
        ) : (
          <StaticMarkdown value={message.body} />
        )}
      </div>
    </article>
  );
}

export function DirectConversationView({
  conversation_id,
  onClose,
}: {
  conversation_id: string;
  onClose: () => void;
}) {
  const account_id = useTypedRedux("account", "account_id");
  const { conversations } = useDirectConversations(true);
  const listed = conversations.find(
    (c) => c.conversation_id === conversation_id,
  );
  const [conversation, setConversation] = useState<MemberDirectConversation>();
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [uploads, setUploads] = useState(0);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const result = await peopleApi().getDirect({ conversation_id });
      setConversation(result.conversation);
      // Everything loaded so far (earlier pages, a message just sent),
      // updated by this page.
      setMessages((current) => mergeMessages(current, result.messages));
      setMore(
        (current) => current || result.messages.length >= DIRECT_MESSAGES_PAGE,
      );
      setError("");
      if (result.conversation.state === "active") {
        void peopleApi()
          .markDirectRead({
            conversation_id,
            read_through: result.conversation.last_activity,
          })
          .then(directChanged)
          .catch(() => {});
      }
    } catch (err) {
      setError(`${err}`);
    }
  }, [conversation_id]);

  // Load when opened and whenever the list says something new arrived.
  useEffect(() => {
    void load();
  }, [load, listed?.last_activity]);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length]);

  async function loadEarlier() {
    const before = messages[0]?.sent;
    if (before == null) return;
    const result = await peopleApi().getDirect({ conversation_id, before });
    setMessages((current) => mergeMessages(current, result.messages));
    setMore(result.messages.length >= DIRECT_MESSAGES_PAGE);
  }

  async function send(value = draft) {
    if (!value.trim() || sending || uploads > 0) return;
    setSending(true);
    try {
      const message = await peopleApi().sendDirect({
        conversation_id,
        body: value,
      });
      setMessages((current) => mergeMessages(current, [message]));
      setDraft("");
      setError("");
      directChanged();
      void load();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSending(false);
    }
  }

  async function respond(action: DirectResponse) {
    try {
      await peopleApi().respondDirect({ conversation_id, action });
      directChanged();
      if (action === "accept") void load();
      else onClose();
    } catch (err) {
      setError(`${err}`);
    }
  }

  async function toggleMute() {
    if (!conversation) return;
    await peopleApi().setDirectMuted({
      conversation_id,
      muted: !conversation.muted,
    });
    setConversation({ ...conversation, muted: !conversation.muted });
    directChanged();
  }

  const shown = conversation ?? listed;
  return (
    <section
      aria-label="Direct conversation"
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: `1px solid ${UI_COLORS.border}`,
        }}
      >
        <Button
          type="text"
          icon={<Icon name="arrow-left" />}
          aria-label="Back to messages"
          onClick={onClose}
        />
        <h2 style={{ margin: 0, fontSize: 16, flex: 1, minWidth: 0 }}>
          {shown ? (
            <DirectNames conversation={shown} account_id={account_id} />
          ) : (
            "Conversation"
          )}
        </h2>
        {shown?.state === "active" && (
          <Tooltip
            title={
              shown.muted
                ? "Notify me of new messages again"
                : "Stop notifying me of new messages"
            }
          >
            <Button
              type="text"
              aria-pressed={!!shown.muted}
              icon={<Icon name="bell" />}
              onClick={toggleMute}
            >
              {shown.muted ? "Unmute" : "Mute"}
            </Button>
          </Tooltip>
        )}
      </header>
      {error && (
        <Alert type="error" role="alert" title={error} style={{ margin: 12 }} />
      )}
      {shown?.state === "requested" && (
        <RequestBanner conversation={shown} onRespond={respond} />
      )}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {more && (
          <div style={{ textAlign: "center", padding: 8 }}>
            <Button size="small" onClick={loadEarlier}>
              Load earlier messages
            </Button>
          </div>
        )}
        {messages.map((m) => (
          <MessageItem
            key={m.message_id}
            message={m}
            account_id={account_id}
            plain={shown?.state === "requested"}
          />
        ))}
        {messages.length === 0 && !error && (
          <p style={{ color: UI_COLORS.secondary, padding: 12 }}>
            No messages yet. Say hello.
          </p>
        )}
        <div ref={bottom} />
      </div>
      <div
        style={{ borderTop: `1px solid ${UI_COLORS.border}`, padding: 8 }}
        aria-label="Write a message"
      >
        <MarkdownInput
          value={draft}
          onChange={setDraft}
          enableUpload
          onUploadStart={() => setUploads((n) => n + 1)}
          onUploadEnd={() => setUploads((n) => Math.max(0, n - 1))}
          onShiftEnter={(value) => void send(value)}
          placeholder="Write a message (Shift+Enter to send)"
          autoGrow
          autoGrowMaxHeight={240}
          compact
        />
        <div
          style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}
        >
          <Button
            type="primary"
            onClick={() => void send()}
            loading={sending}
            disabled={!draft.trim() || uploads > 0}
          >
            Send
          </Button>
        </div>
      </div>
    </section>
  );
}

// The Messages tab: the list, and the open conversation beside it.
export function DirectMessagesTab({
  conversation_id,
  search,
  onOpen,
  onClose,
}: {
  conversation_id?: string;
  search?: string;
  onOpen: (conversation_id: string) => void;
  onClose: () => void;
}) {
  const { conversations, error, loading } = useDirectConversations(true);
  const open = conversation_id != null;
  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, gap: 12 }}>
      <div
        style={{
          width: open ? 340 : "100%",
          maxWidth: open ? 340 : 820,
          flex: "0 0 auto",
          overflowY: "auto",
        }}
        className={open ? "people-list-with-detail" : undefined}
      >
        {error && <Alert role="alert" type="error" title={error} />}
        {loading && conversations.length === 0 ? (
          <p role="status">Loading messages...</p>
        ) : (
          <DirectList
            conversations={conversations}
            selected={conversation_id}
            onSelect={(c) => onOpen(c.conversation_id)}
            search={search}
          />
        )}
      </div>
      {open && (
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            border: `1px solid ${UI_COLORS.border}`,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <DirectConversationView
            key={conversation_id}
            conversation_id={conversation_id}
            onClose={onClose}
          />
        </div>
      )}
    </div>
  );
}
