/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useState, type CSSProperties, type ReactNode } from "react";
import { Alert, Typography } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { AvatarStack } from "@cocalc/frontend/account/avatar/avatar-stack";
import { TimeAgo } from "@cocalc/frontend/components";
import {
  Collection,
  type CollectionView,
} from "@cocalc/frontend/components/collection";
import { moveVisibleCollectionPin } from "@cocalc/frontend/components/collection-order";
import type { useCollectionPreferences } from "@cocalc/frontend/components/use-collection-preferences";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type {
  ListedConversation,
  PersonalStatePatch,
} from "@cocalc/util/people";
import { AliasDialog } from "./alias-dialog";
import { conversationsChanged, peopleApi } from "./api";
import { isMentioned, isUnread } from "./scope";

const VISUALLY_HIDDEN = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

type Preferences = ReturnType<typeof useCollectionPreferences>;

export async function setConversationState(
  c: ListedConversation,
  patch: PersonalStatePatch,
): Promise<void> {
  await peopleApi().setState({
    kind: "conversation",
    target_id: c.conversation_id,
    project_id: c.project_id,
    patch,
  });
  conversationsChanged();
}

// Cards or rows of conversations with pins (drag to reorder), personal
// controls and unread/mention markers.
export function ConversationCollection({
  conversations,
  preferences,
  view,
  selected,
  onSelect,
  emptyText = "No conversations yet.",
}: {
  conversations: ListedConversation[];
  preferences?: Preferences;
  view: CollectionView;
  selected?: string;
  onSelect: (conversation: ListedConversation) => void;
  emptyText?: string;
}) {
  const account_id = useTypedRedux("account", "account_id");
  const project_map = useTypedRedux("projects", "project_map");
  const [error, setError] = useState("");
  const [aliasFor, setAliasFor] = useState<ListedConversation>();
  const [busyIds, setBusyIds] = useState<string[]>([]);

  if (conversations.length === 0) {
    return (
      <Typography.Paragraph type="secondary">{emptyText}</Typography.Paragraph>
    );
  }

  const order = preferences?.value.order ?? [];
  const pinnedIds = conversations
    .filter((c) => c.pinned)
    .map((c) => c.conversation_id);
  // Saved order first; newly pinned items go last. Hidden ids are kept.
  const fullOrder = [
    ...order,
    ...pinnedIds.filter((id) => !order.includes(id)),
  ];
  const pins = fullOrder.filter((id) => pinnedIds.includes(id));

  async function update(c: ListedConversation, patch: PersonalStatePatch) {
    setError("");
    setBusyIds((ids) => [...ids, c.conversation_id]);
    try {
      await setConversationState(c, patch);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusyIds((ids) => ids.filter((id) => id !== c.conversation_id));
    }
  }

  const projectTitle = (c: ListedConversation) =>
    (project_map?.getIn([c.project_id, "title"]) as string | undefined) ?? "";

  return (
    <div
      data-view={view}
      style={
        {
          "--collection-grid-min-width": "260px",
          "--collection-heading-size": "16px",
        } as CSSProperties
      }
    >
      {error && <Alert role="alert" type="error" title={error} />}
      <Collection<ListedConversation>
        items={conversations}
        itemId={(c) => c.conversation_id}
        itemTitle={(c) => c.title}
        pins={pins}
        view={view}
        otherTitle="Recent"
        busyIds={busyIds}
        onPin={(c, pinned) => {
          if (preferences && pinned) {
            preferences.setOrder([
              ...fullOrder.filter((id) => id !== c.conversation_id),
              c.conversation_id,
            ]);
          }
          void update(c, { pinned });
        }}
        onMove={
          preferences
            ? (visible, id, index) =>
                preferences.setOrder(
                  moveVisibleCollectionPin(fullOrder, visible, id, index),
                )
            : undefined
        }
        renderItem={(c, controls) => {
          const unread = isUnread(c, account_id);
          const current = c.conversation_id === selected;
          const menu = controls.menu(
            [
              {
                key: "alias",
                label: c.alias ? `Alias @${c.alias}...` : "Personal alias...",
                onClick: () => setAliasFor(c),
              },
              {
                key: "follow",
                label: c.following ? "Unfollow" : "Follow",
                onClick: () => void update(c, { following: !c.following }),
              },
              {
                key: "mute",
                label: c.muted ? "Unmute" : "Mute",
                onClick: () => void update(c, { muted: !c.muted }),
              },
              ...(unread
                ? [
                    {
                      key: "read",
                      label: "Mark read",
                      onClick: () =>
                        void peopleApi()
                          .markRead({
                            project_id: c.project_id,
                            conversation_id: c.conversation_id,
                            read_through: c.last_activity,
                          })
                          .then(conversationsChanged)
                          .catch((err) => setError(`${err}`)),
                    },
                  ]
                : []),
            ],
            `Options for ${c.title}`,
          );
          // Same width with or without a drag handle, so columns line up.
          const actions = (
            <div style={CONTROLS_STYLE}>
              <span style={{ width: 28, display: "inline-flex" }}>
                {controls.dragHandle}
              </span>
              {controls.pinButton}
              {menu}
            </div>
          );
          const props = {
            c,
            unread,
            mentioned: isMentioned(c),
            current,
            project: projectTitle(c),
            onOpen: () => onSelect(c),
          };
          return view === "grid" ? (
            <GridCard {...props} actions={actions} />
          ) : (
            <ListRow {...props} actions={actions} />
          );
        }}
      />
      <AliasDialog
        open={aliasFor != null}
        title={aliasFor?.title ?? ""}
        alias={aliasFor?.alias}
        urlKind="chats"
        onClose={() => setAliasFor(undefined)}
        onSave={async (alias) => {
          if (!aliasFor) return;
          await setConversationState(aliasFor, { alias });
        }}
      />
    </div>
  );
}

const CONTROLS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 2,
  flexShrink: 0,
};

const ELLIPSIS: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

interface ItemProps {
  c: ListedConversation;
  unread: boolean;
  mentioned: boolean;
  current: boolean;
  project: string;
  onOpen: () => void;
  actions: ReactNode;
}

function Title({ c, unread, mentioned }: ItemProps) {
  return (
    <span
      style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}
    >
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
      <span style={{ ...ELLIPSIS, fontWeight: unread ? 600 : 500 }}>
        {c.title}
      </span>
      {c.alias && (
        <span style={{ ...ELLIPSIS, color: UI_COLORS.link, flex: "0 1 auto" }}>
          @{c.alias}
        </span>
      )}
      {unread && <span style={VISUALLY_HIDDEN}> (unread)</span>}
      {mentioned && (
        <span
          title="You were mentioned"
          style={{
            color: UI_COLORS.warning,
            fontWeight: 600,
            flex: "0 0 auto",
          }}
        >
          @<span style={VISUALLY_HIDDEN}> you were mentioned</span>
        </span>
      )}
    </span>
  );
}

// Always one element (even with no participants) so list columns line up.
function People({ c }: { c: ListedConversation }) {
  return (
    <span style={{ display: "inline-flex", minWidth: 0 }}>
      <AvatarStack
        entries={c.participant_ids.map((id) => ({ account_id: id }))}
        size={20}
        maxAvatars={4}
      />
    </span>
  );
}

const OPEN_BUTTON: CSSProperties = {
  border: "none",
  background: "transparent",
  color: UI_COLORS.text,
  cursor: "pointer",
  textAlign: "left",
  padding: 0,
  font: "inherit",
  minWidth: 0,
};

// Fixed-height card: one line each for title, project and footer, so cards in
// a row always line up.
function GridCard(props: ItemProps) {
  const { c, current, project, onOpen, actions } = props;
  return (
    <div
      style={{
        height: 120,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        padding: "12px 12px 8px",
        border: `1px solid ${current ? UI_COLORS.link : UI_COLORS.border}`,
        borderRadius: 8,
        background: current ? UI_COLORS.selected : UI_COLORS.surface,
      }}
    >
      <button
        type="button"
        aria-current={current ? "true" : undefined}
        onClick={onOpen}
        style={{
          ...OPEN_BUTTON,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <Title {...props} />
        <span style={{ ...ELLIPSIS, color: UI_COLORS.secondary, fontSize: 13 }}>
          {project}
        </span>
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <People c={c} />
        <span
          style={{
            ...ELLIPSIS,
            color: UI_COLORS.secondary,
            fontSize: 12,
            flex: 1,
          }}
        >
          <TimeAgo date={new Date(c.last_activity)} />
        </span>
        {actions}
      </div>
    </div>
  );
}

// One-line row with fixed columns: title, project, people, activity, actions.
function ListRow(props: ItemProps) {
  const { c, current, project, onOpen, actions } = props;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 44,
        padding: "0 8px 0 12px",
        // Adjacent rows share one border line, forming a bordered table.
        border: `1px solid ${UI_COLORS.border}`,
        marginTop: -1,
        background: current ? UI_COLORS.selected : UI_COLORS.surface,
        boxShadow: current ? `inset 3px 0 ${UI_COLORS.link}` : undefined,
      }}
    >
      <button
        type="button"
        aria-current={current ? "true" : undefined}
        onClick={onOpen}
        style={{
          ...OPEN_BUTTON,
          flex: 1,
          alignSelf: "stretch",
          display: "grid",
          gridTemplateColumns:
            "minmax(0, 3fr) minmax(0, 2fr) 96px minmax(88px, 120px)",
          alignItems: "center",
          gap: 12,
        }}
      >
        <Title {...props} />
        <span style={{ ...ELLIPSIS, color: UI_COLORS.secondary, fontSize: 13 }}>
          {project}
        </span>
        <People c={c} />
        <span
          style={{
            ...ELLIPSIS,
            color: UI_COLORS.secondary,
            fontSize: 13,
            textAlign: "right",
          }}
        >
          <TimeAgo date={new Date(c.last_activity)} />
        </span>
      </button>
      {actions}
    </div>
  );
}
