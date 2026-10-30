/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The Messages tab on People: direct conversations, in no project.

import {
  directViewKey,
  useShowingConversation,
} from "@cocalc/frontend/notifications/viewing";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Alert, Button, Popconfirm, Space, Tag } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { Icon, TimeAgo, Tooltip } from "@cocalc/frontend/components";
import { Collection } from "@cocalc/frontend/components/collection";
import { moveVisibleCollectionPin } from "@cocalc/frontend/components/collection-order";
import { useCollectionPreferences } from "@cocalc/frontend/components/use-collection-preferences";
// The same editor as chat (rich text or Markdown, image paste).
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { User } from "@cocalc/frontend/users/user";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  DIRECT_MESSAGES_PAGE,
  isDirectRequest,
  isDirectUnread,
  type DirectMessage,
  type DirectPersonalPatch,
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
  conversation: Pick<MemberDirectConversation, "member_ids"> & {
    title?: string | null;
  };
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

// Who a conversation is with (everyone but you), with small avatars: shown
// under a group's title so it's always clear who reads it.
export function DirectMembers({
  conversation,
  account_id,
}: {
  conversation: Pick<MemberDirectConversation, "member_ids">;
  account_id?: string;
}) {
  const others = conversation.member_ids.filter((id) => id !== account_id);
  return (
    <span
      aria-label="Members"
      style={{
        display: "inline-flex",
        flexWrap: "wrap",
        gap: "4px 10px",
        alignItems: "center",
        fontSize: 13,
        color: UI_COLORS.secondary,
      }}
    >
      {others.map((id) => (
        <span
          key={id}
          style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
        >
          <Avatar account_id={id} size={18} no_tooltip />
          <User account_id={id} />
        </span>
      ))}
    </span>
  );
}

function DirectRow({
  conversation,
  account_id,
  selected,
  onSelect,
  actions,
}: {
  conversation: MemberDirectConversation;
  account_id?: string;
  selected: boolean;
  onSelect: () => void;
  actions?: ReactNode;
}) {
  const unread = isDirectUnread(conversation, account_id);
  const request = isDirectRequest(conversation);
  const first = conversation.member_ids.find((id) => id !== account_id);
  // Archived through its latest message: nothing new to show.
  const archived =
    conversation.archived_through != null &&
    conversation.last_activity <= conversation.archived_through;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "0 4px 0 0",
        border: `1px solid ${UI_COLORS.border}`,
        marginTop: -1,
        background: selected ? UI_COLORS.selected : UI_COLORS.surface,
        boxShadow: selected ? `inset 3px 0 ${UI_COLORS.link}` : undefined,
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          flex: 1,
          minWidth: 0,
          textAlign: "left",
          padding: "10px 8px 10px 12px",
          border: "none",
          background: "transparent",
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
            <span style={ELLIPSIS}>
              <DirectNames
                conversation={conversation}
                account_id={account_id}
              />
              {conversation.title && (
                // A group: who it's with, after its title.
                <span
                  style={{
                    fontWeight: 400,
                    color: UI_COLORS.secondary,
                    marginLeft: 6,
                  }}
                >
                  ·{" "}
                  <DirectNames
                    conversation={{ member_ids: conversation.member_ids }}
                    account_id={account_id}
                  />
                </span>
              )}
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
            <span style={{ ...ELLIPSIS, flex: 1 }}>
              {archived
                ? "Archived"
                : conversation.preview || "No messages yet"}
            </span>
            {/* On the preview line, so the name gets the whole first line. */}
            <span style={{ fontSize: 12, flex: "none" }}>
              <TimeAgo date={conversation.last_activity} />
            </span>
          </span>
        </span>
      </button>
      {actions}
    </div>
  );
}

const ELLIPSIS: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

// Your own settings for a conversation; the list refreshes after.
async function setDirectState(
  conversation_id: string,
  patch: DirectPersonalPatch,
): Promise<void> {
  await peopleApi().setDirectState({ conversation_id, patch });
  directChanged();
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
  const preferences = useCollectionPreferences("direct-messages");
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [error, setError] = useState("");
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

  // Pinned in your saved order (newly pinned last), as on Project
  // Conversations; the rest are Recent.
  const order = preferences.value.order ?? [];
  const pinnedIds = others
    .filter((c) => c.pinned)
    .map((c) => c.conversation_id);
  const fullOrder = [
    ...order,
    ...pinnedIds.filter((id) => !order.includes(id)),
  ];
  const pins = fullOrder.filter((id) => pinnedIds.includes(id));

  async function update(
    c: MemberDirectConversation,
    patch: DirectPersonalPatch,
  ) {
    setError("");
    setBusyIds((ids) => [...ids, c.conversation_id]);
    try {
      await setDirectState(c.conversation_id, patch);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusyIds((ids) => ids.filter((id) => id !== c.conversation_id));
    }
  }

  const title = (c: MemberDirectConversation) =>
    c.title ??
    c.member_ids
      .filter((id) => id !== account_id)
      .map(
        (id) =>
          `${user_map?.getIn([id, "first_name"]) ?? ""} ${user_map?.getIn([id, "last_name"]) ?? ""}`.trim() ||
          "Someone",
      )
      .join(", ");

  return (
    <div>
      {error && <Alert role="alert" type="error" title={error} />}
      {requests.length > 0 && (
        <section aria-label="Message requests" style={{ marginBottom: 12 }}>
          <h3 style={SECTION_HEADING}>Requests ({requests.length})</h3>
          {requests.map((c) => (
            <DirectRow
              key={c.conversation_id}
              conversation={c}
              account_id={account_id}
              selected={c.conversation_id === selected}
              onSelect={() => onSelect(c)}
            />
          ))}
        </section>
      )}
      {others.length > 0 && (
        <section aria-label="Direct conversations">
          <Collection<MemberDirectConversation>
            items={others}
            itemId={(c) => c.conversation_id}
            itemTitle={title}
            pins={pins}
            view="list"
            otherTitle="Recent"
            busyIds={busyIds}
            onPin={(c, pinned) => {
              if (pinned) {
                preferences.setOrder([
                  ...fullOrder.filter((id) => id !== c.conversation_id),
                  c.conversation_id,
                ]);
              }
              void update(c, { pinned });
            }}
            onMove={(visible, id, index) =>
              preferences.setOrder(
                moveVisibleCollectionPin(fullOrder, visible, id, index),
              )
            }
            renderItem={(c, controls) => {
              const menu = controls.menu(
                [
                  {
                    key: "mute",
                    label: c.muted ? "Unmute" : "Mute",
                    onClick: () => void update(c, { muted: !c.muted }),
                  },
                  {
                    key: "archive",
                    label: "Archive messages so far",
                    onClick: () =>
                      void update(c, { archived_through: c.last_activity }),
                  },
                ],
                `Options for ${title(c)}`,
              );
              return (
                <DirectRow
                  conversation={c}
                  account_id={account_id}
                  selected={c.conversation_id === selected}
                  onSelect={() => onSelect(c)}
                  actions={
                    <div style={CONTROLS_STYLE}>
                      <span style={{ width: 28, display: "inline-flex" }}>
                        {controls.dragHandle}
                      </span>
                      {controls.pinButton}
                      {menu}
                    </div>
                  }
                />
              );
            }}
          />
        </section>
      )}
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

const SECTION_HEADING: CSSProperties = {
  fontSize: 13,
  color: UI_COLORS.secondary,
  margin: "8px 12px",
};

const CONTROLS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 2,
  flexShrink: 0,
};

// What was loaded, replaced by a fresh fetch of the same range: anything
// missing from it is gone (deleted), except a message just sent that is
// newer than the fetch.
export function replaceLoaded(
  shown: DirectMessage[],
  fetched: DirectMessage[],
): DirectMessage[] {
  const newest = fetched[fetched.length - 1]?.sent ?? -Infinity;
  return mergeMessages(
    shown.filter((m) => m.sent > newest),
    fetched,
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
  onDelete,
}: {
  message: DirectMessage;
  account_id?: string;
  // Not yet accepted: shown as text, so nothing in it loads (an image could
  // tell the sender you looked).
  plain?: boolean;
  // Your own message: delete it for everyone.
  onDelete?: () => void;
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
          {mine && onDelete && !message.deleted && (
            <Popconfirm
              title="Delete this message for everyone?"
              description="It's removed from the conversation and from notifications, and email about it that wasn't sent yet is cancelled. Email already sent, or being sent, can't be recalled."
              okText="Delete"
              okButtonProps={{ danger: true }}
              onConfirm={onDelete}
            >
              <Button
                type="link"
                size="small"
                aria-label="Delete message"
                style={{ padding: "0 4px", height: "auto", fontSize: 12 }}
              >
                Delete
              </Button>
            </Popconfirm>
          )}
        </div>
        {message.deleted ? (
          <div style={{ color: UI_COLORS.secondary, fontStyle: "italic" }}>
            Message deleted
          </div>
        ) : plain ? (
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
  // Notifications about this conversation aren't counted while it is shown.
  useShowingConversation(directViewKey(conversation_id));
  const { conversations } = useDirectConversations(true);
  const listed = conversations.find(
    (c) => c.conversation_id === conversation_id,
  );
  const [conversation, setConversation] = useState<MemberDirectConversation>();
  const [messages, setMessagesState] = useState<DirectMessage[]>([]);
  const setMessages = useCallback(
    (update: (shown: DirectMessage[]) => DirectMessage[]) =>
      setMessagesState((shown) => {
        const next = update(shown);
        messagesRef.current = next;
        return next;
      }),
    [],
  );
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [uploads, setUploads] = useState(0);
  // Archived messages are hidden until you choose to see them again.
  const [showArchived, setShowArchived] = useState(false);
  // A new editor after each send clears it (as chat does).
  const [editorEpoch, setEditorEpoch] = useState(0);
  const bottom = useRef<HTMLDivElement>(null);
  // Responses for an earlier load (or after unmounting) are dropped; the
  // view is also keyed by account, so another account starts empty.
  const generation = useRef(0);
  const alive = useRef(true);
  // The messages shown, for load to know how far back to fetch again.
  const messagesRef = useRef<DirectMessage[]>([]);
  useEffect(
    () => () => {
      alive.current = false;
      generation.current++;
    },
    [],
  );

  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const result = await peopleApi().getDirect({ conversation_id });
      if (current !== generation.current) return;
      // Everything loaded so far is fetched again, back to the oldest message
      // shown: one deleted in an earlier page must disappear too.
      const oldestShown = messagesRef.current[0]?.sent;
      let fetched = result.messages;
      let older = fetched.length >= DIRECT_MESSAGES_PAGE;
      while (
        older &&
        oldestShown != null &&
        fetched.length > 0 &&
        fetched[0].sent > oldestShown
      ) {
        const page = await peopleApi().getDirect({
          conversation_id,
          before: fetched[0].sent,
        });
        if (current !== generation.current) return;
        fetched = [...page.messages, ...fetched];
        older = page.messages.length >= DIRECT_MESSAGES_PAGE;
      }
      setConversation(result.conversation);
      setMessages((shown) => replaceLoaded(shown, fetched));
      setMore(older);
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
      if (current !== generation.current) return;
      setError(`${err}`);
    }
  }, [conversation_id]);

  // Load when opened and whenever the list says the messages changed: one
  // added, or one deleted (which changes nothing else you can see).
  useEffect(() => {
    void load();
  }, [load, listed?.last_activity, listed?.messages_version]);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length]);

  async function loadEarlier() {
    const before = messages[0]?.sent;
    if (before == null) return;
    const result = await peopleApi().getDirect({ conversation_id, before });
    if (!alive.current) return;
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
      if (!alive.current) return;
      setMessages((current) => mergeMessages(current, [message]));
      setDraft("");
      setEditorEpoch((n) => n + 1);
      setError("");
      directChanged();
      void load();
    } catch (err) {
      if (alive.current) setError(`${err}`);
    } finally {
      if (alive.current) setSending(false);
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

  async function setPersonal(patch: DirectPersonalPatch) {
    if (!conversation) return;
    try {
      await setDirectState(conversation_id, patch);
      setConversation({
        ...conversation,
        ...patch,
      } as MemberDirectConversation);
      if (patch.archived_through !== undefined) setShowArchived(false);
    } catch (err) {
      setError(`${err}`);
    }
  }

  async function deleteMessage(message_id: string) {
    try {
      await peopleApi().deleteDirectMessage({ conversation_id, message_id });
      setMessages((current) =>
        current.map((m) =>
          m.message_id === message_id ? { ...m, body: "", deleted: true } : m,
        ),
      );
      directChanged();
    } catch (err) {
      setError(`${err}`);
    }
  }

  const shown = conversation ?? listed;
  const archivedThrough = shown?.archived_through ?? null;
  const visible =
    archivedThrough == null || showArchived
      ? messages
      : messages.filter((m) => m.sent > archivedThrough);
  const hiddenCount = messages.length - visible.length;
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
          flex: "none",
        }}
      >
        <Button
          type="text"
          icon={<Icon name="arrow-left" />}
          aria-label="Back to messages"
          onClick={onClose}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>
            {shown ? (
              <DirectNames conversation={shown} account_id={account_id} />
            ) : (
              "Conversation"
            )}
          </h2>
          {shown?.title && (
            <DirectMembers conversation={shown} account_id={account_id} />
          )}
        </div>
        {shown?.state === "active" && (
          <Tooltip title="Hide the messages so far, for you only. Nothing is deleted; you can show them again.">
            <Button
              type="text"
              icon={<Icon name="container" />}
              onClick={() =>
                void setPersonal({ archived_through: shown.last_activity })
              }
            >
              Archive
            </Button>
          </Tooltip>
        )}
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
              onClick={() => void setPersonal({ muted: !shown.muted })}
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
        {archivedThrough != null && (
          <div
            role="status"
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 8,
              padding: 8,
              color: UI_COLORS.secondary,
              fontSize: 13,
            }}
          >
            {showArchived ? (
              <>
                Showing archived messages.
                <Button size="small" onClick={() => setShowArchived(false)}>
                  Hide them
                </Button>
                <Button
                  size="small"
                  type="link"
                  onClick={() => void setPersonal({ archived_through: null })}
                >
                  Unarchive
                </Button>
              </>
            ) : (
              <>
                {hiddenCount > 0 || more
                  ? "Earlier messages are archived."
                  : "Messages so far are archived."}
                <Button size="small" onClick={() => setShowArchived(true)}>
                  Show them
                </Button>
              </>
            )}
          </div>
        )}
        {more && (archivedThrough == null || showArchived) && (
          <div style={{ textAlign: "center", padding: 8 }}>
            <Button size="small" onClick={loadEarlier}>
              Load earlier messages
            </Button>
          </div>
        )}
        {visible.map((m) => (
          <MessageItem
            key={m.message_id}
            message={m}
            account_id={account_id}
            plain={shown?.state === "requested"}
            onDelete={() => void deleteMessage(m.message_id)}
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
        // The composer never shrinks (Send stays visible); the messages
        // above scroll instead.
        style={{
          borderTop: `1px solid ${UI_COLORS.border}`,
          padding: 8,
          flex: "none",
        }}
        aria-label="Write a message"
      >
        {/* The upload drop zone is height: 100%; inside the composer (a
            flex item) that resolved to the whole composer and pushed Send
            out of view. An auto-height block makes it size to the editor. */}
        <div>
          <MarkdownInput
            key={editorEpoch}
            cacheId={`direct-${conversation_id}`}
            value={draft}
            onChange={setDraft}
            enableUpload
            onUploadStart={() => setUploads((n) => n + 1)}
            onUploadEnd={() => setUploads((n) => Math.max(0, n - 1))}
            onShiftEnter={(value) => void send(value)}
            placeholder="Write a message (Shift+Enter to send)"
            height="auto"
            autoGrowMaxHeight={240}
            compact
          />
        </div>
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

// On a narrow screen (a phone, or high zoom) there is no room for the list
// beside an open conversation: show the conversation alone. Its "Back to
// messages" button returns to the list.
const NARROW_CSS = `
@media (max-width: 767px) {
  .direct-list-with-detail {
    display: none;
  }
}
`;

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
  const account_id = useTypedRedux("account", "account_id");
  const open = conversation_id != null;
  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, gap: 12 }}>
      <style>{NARROW_CSS}</style>
      <div
        style={{
          width: open ? 340 : "100%",
          maxWidth: open ? 340 : 820,
          flex: "0 0 auto",
          overflowY: "auto",
        }}
        className={
          open ? "people-list-with-detail direct-list-with-detail" : undefined
        }
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
            key={`${account_id}:${conversation_id}`}
            conversation_id={conversation_id}
            onClose={onClose}
          />
        </div>
      )}
    </div>
  );
}
