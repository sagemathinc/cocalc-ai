/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The workspace sidebar on People (sidebar navigation): pinned and recent
// conversations, with the same pins and order as the People page.

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { moveVisibleCollectionPin } from "@cocalc/frontend/components/collection-order";
import {
  SidebarDot,
  SidebarList,
  type SidebarListItem,
} from "@cocalc/frontend/components/sidebar-list";
import { useCollectionPreferences } from "@cocalc/frontend/components/use-collection-preferences";
import { newConversationRequest } from "@cocalc/frontend/app/sidebar-search-requests";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { ListedConversation } from "@cocalc/util/people";
import { setConversationState } from "./conversation-collection";
import { isUnread, matchesSearch } from "./scope";
import { useConversations } from "./use-conversations";

const RECENT = 15;
const MATCHES = 50;

function open(route?: string) {
  const page = redux.getActions("page");
  page.setState({ people_route: route || undefined });
  void page.set_active_tab("people", true);
}

// Pinned conversations in the saved order (newly pinned last), then the rest
// by last activity.
export function sidebarConversations(
  conversations: ListedConversation[],
  order: string[],
  matches: (c: ListedConversation) => boolean,
  limit: number,
) {
  const pinnedIds = conversations
    .filter((c) => c.pinned)
    .map((c) => c.conversation_id);
  const fullOrder = [
    ...order,
    ...pinnedIds.filter((id) => !order.includes(id)),
  ];
  const byId = new Map(conversations.map((c) => [c.conversation_id, c]));
  const pinned = fullOrder
    .filter((id) => pinnedIds.includes(id))
    .map((id) => byId.get(id)!)
    .filter(matches);
  const others = conversations
    .filter((c) => !c.pinned && matches(c))
    .sort((a, b) => b.last_activity - a.last_activity);
  return {
    fullOrder,
    pinned,
    recent: others.slice(0, limit),
    more: Math.max(0, others.length - limit),
  };
}

export function PeopleSidebar({
  search,
  onNavigate,
}: {
  // From the sidebar's search box.
  search: string;
  onNavigate?: () => void;
}) {
  const state = useConversations(true);
  const preferences = useCollectionPreferences("conversations");
  const account_id = useTypedRedux("account", "account_id");
  const project_map = useTypedRedux("projects", "project_map");
  const route = `${useTypedRedux("page", "people_route") ?? ""}`;
  const projectTitle = (c: ListedConversation) =>
    (project_map?.getIn([c.project_id, "title"]) as string | undefined) ?? "";
  const { fullOrder, pinned, recent, more } = sidebarConversations(
    state.conversations,
    preferences.value.order,
    (c) => matchesSearch(c, search, projectTitle(c)),
    search.trim() ? MATCHES : RECENT,
  );
  const byId = new Map(state.conversations.map((c) => [c.conversation_id, c]));

  const item = (c: ListedConversation): SidebarListItem => {
    const unread = isUnread(c, account_id);
    return {
      id: c.conversation_id,
      title: c.title,
      bold: unread,
      tooltip: `${c.title} · ${projectTitle(c)}`,
      current: route.endsWith(`/${c.conversation_id}`),
      avatar: (
        <Icon
          name="comment"
          style={{
            width: 26,
            fontSize: 16,
            textAlign: "center",
            color: UI_COLORS.secondary,
          }}
        />
      ),
      extra: unread ? (
        <SidebarDot color={UI_COLORS.primary} label="Unread" />
      ) : undefined,
    };
  };

  return (
    <SidebarList
      label="People"
      itemLabel="conversation"
      newLabel="New Conversation"
      onNew={() => {
        newConversationRequest.request();
        open();
        onNavigate?.();
      }}
      search={search}
      pinned={pinned.map(item)}
      recent={recent.map(item)}
      more={more}
      onOpen={(id) => {
        const c = byId.get(id);
        if (!c) return;
        open(`conversations/${c.project_id}/${c.conversation_id}`);
        onNavigate?.();
      }}
      onPin={(id, pin) => {
        const c = byId.get(id);
        if (!c) return;
        if (pin)
          preferences.setOrder([...fullOrder.filter((x) => x !== id), id]);
        void setConversationState(c, { pinned: pin });
      }}
      onMovePin={(visible, id, index) =>
        preferences.setOrder(
          moveVisibleCollectionPin(fullOrder, visible, id, index),
        )
      }
      onAll={() => {
        open();
        onNavigate?.();
      }}
      emptyText={
        state.loading ? "Loading conversations..." : "No conversations yet."
      }
    />
  );
}
