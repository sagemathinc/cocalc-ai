/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useState } from "react";
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
    <div data-view={view}>
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
          const mentioned = isMentioned(c);
          const current = c.conversation_id === selected;
          return (
            <div
              style={{
                display: "flex",
                flexDirection: view === "grid" ? "column" : "row",
                alignItems: view === "grid" ? "stretch" : "center",
                gap: 4,
                padding: view === "grid" ? 12 : "4px 8px",
                margin: view === "grid" ? 0 : "2px 0",
                border:
                  view === "grid" ? `1px solid ${UI_COLORS.border}` : undefined,
                borderRadius: 8,
                background: current ? UI_COLORS.selected : UI_COLORS.surface,
                boxShadow: current
                  ? `inset 3px 0 ${UI_COLORS.link}`
                  : undefined,
                minWidth: 0,
                height: view === "grid" ? "100%" : undefined,
                boxSizing: "border-box",
              }}
            >
              <button
                type="button"
                aria-current={current ? "true" : undefined}
                onClick={() => onSelect(c)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  textAlign: "left",
                  border: "none",
                  background: "transparent",
                  color: UI_COLORS.text,
                  cursor: "pointer",
                  padding: 4,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    minWidth: 0,
                  }}
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
                  <span
                    style={{
                      fontWeight: unread ? 600 : 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.title}
                  </span>
                  {c.alias && (
                    <span style={{ color: UI_COLORS.link, flex: "0 0 auto" }}>
                      @{c.alias}
                    </span>
                  )}
                  {unread && <span style={VISUALLY_HIDDEN}> (unread)</span>}
                  {mentioned && (
                    <span
                      title="You were mentioned"
                      style={{ color: UI_COLORS.warning, fontWeight: 600 }}
                    >
                      @<span style={VISUALLY_HIDDEN}> you were mentioned</span>
                    </span>
                  )}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 8,
                    color: UI_COLORS.secondary,
                    fontSize: "90%",
                    marginTop: 4,
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 220,
                    }}
                  >
                    {projectTitle(c)}
                  </span>
                  <AvatarStack
                    entries={c.participant_ids.map((id) => ({
                      account_id: id,
                    }))}
                    size={18}
                    maxAvatars={4}
                  />
                  <span style={{ marginLeft: "auto" }}>
                    <TimeAgo date={new Date(c.last_activity)} />
                  </span>
                </div>
              </button>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: view === "grid" ? "flex-end" : undefined,
                  gap: 2,
                  flexShrink: 0,
                }}
              >
                {controls.dragHandle}
                {controls.pinButton}
                {controls.menu(
                  [
                    {
                      key: "alias",
                      label: c.alias
                        ? `Alias @${c.alias}...`
                        : "Personal alias...",
                      onClick: () => setAliasFor(c),
                    },
                    {
                      key: "follow",
                      label: c.following ? "Unfollow" : "Follow",
                      onClick: () =>
                        void update(c, { following: !c.following }),
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
                )}
              </div>
            </div>
          );
        }}
      />
      <AliasDialog
        open={aliasFor != null}
        title={aliasFor?.title ?? ""}
        alias={aliasFor?.alias}
        onClose={() => setAliasFor(undefined)}
        onSave={async (alias) => {
          if (!aliasFor) return;
          await setConversationState(aliasFor, { alias });
        }}
      />
    </div>
  );
}
