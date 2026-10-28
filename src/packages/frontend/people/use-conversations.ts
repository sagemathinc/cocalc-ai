/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useReducer } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import type { ListedConversation } from "@cocalc/util/people";
import { conversationEvents, peopleApi } from "./api";
import { isUnread, matchesScope } from "./scope";

const POLL_MS = 30_000;
// Notifications for several messages arrive together; one refresh covers them.
const NOTIFICATION_REFRESH_DELAY_MS = 500;

export interface ConversationsState {
  conversations: ListedConversation[];
  loading: boolean;
  error?: string;
  unavailableBays: number;
  refresh: () => void;
}

type Snapshot = Omit<ConversationsState, "refresh">;

// One conversation list for the whole page: the People page, its sidebar and
// the unread count share it, so they agree and ask the server once. It is one
// request to the account's home bay, which asks each owning bay once.
//
// It refreshes on a poll, on window focus, when this browser changes a
// conversation, and as soon as a chat notification arrives (someone wrote in
// a thread this account follows or mentioned it), so a reply shows without
// waiting for the poll.
let snapshot: Snapshot = {
  conversations: [],
  loading: true,
  unavailableBays: 0,
};
const listeners = new Set<() => void>();
let users = 0;
let generation = 0;
let stopWatching: (() => void) | undefined;

function update(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

export function refreshConversations(): void {
  const current = ++generation;
  void (async () => {
    try {
      const result = await peopleApi().listConversations({});
      if (current !== generation) return;
      update({
        conversations: result.conversations,
        unavailableBays: result.unavailable_bays,
        error: undefined,
        loading: false,
      });
    } catch (err) {
      if (current !== generation) return;
      update({ error: `${err}`, loading: false });
    }
  })();
}

// New notifications about a chat file mean the list may have changed.
export function hasNewChatNotification(
  previous: { has: (id: string) => boolean } | undefined,
  current:
    | { some: (f: (mention: any, id: string) => boolean) => boolean }
    | undefined,
): boolean {
  if (previous == null || current == null) return false;
  return current.some(
    (mention, id) =>
      !previous.has(id) && `${mention?.get?.("path") ?? ""}`.endsWith(".chat"),
  );
}

function watch(): () => void {
  refreshConversations();
  const timer = setInterval(refreshConversations, POLL_MS);
  const onFocus = () => refreshConversations();
  window.addEventListener("focus", onFocus);
  conversationEvents.on("changed", refreshConversations);
  let pending: ReturnType<typeof setTimeout> | undefined;
  let mentions = redux.getStore("mentions")?.get("mentions");
  const unsubscribe = redux.reduxStore.subscribe(() => {
    const next = redux.getStore("mentions")?.get("mentions");
    if (next === mentions) return;
    const previous = mentions;
    mentions = next;
    if (pending != null || !hasNewChatNotification(previous, next)) return;
    pending = setTimeout(() => {
      pending = undefined;
      refreshConversations();
    }, NOTIFICATION_REFRESH_DELAY_MS);
  });
  return () => {
    generation++;
    clearInterval(timer);
    if (pending != null) clearTimeout(pending);
    window.removeEventListener("focus", onFocus);
    conversationEvents.off("changed", refreshConversations);
    unsubscribe();
  };
}

function acquire(): () => void {
  users += 1;
  if (users === 1) stopWatching = watch();
  return () => {
    users -= 1;
    if (users === 0) {
      stopWatching?.();
      stopWatching = undefined;
    }
  };
}

export function useConversations(active: boolean): ConversationsState {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, []);
  useEffect(() => (active ? acquire() : undefined), [active]);
  return { ...snapshot, refresh: refreshConversations };
}

// Conversations for this account (For you) with something it hasn't read.
export function unreadConversationCount(
  conversations: ListedConversation[],
  account_id?: string,
): number {
  return conversations.filter(
    (c) => matchesScope(c, "for-you", account_id) && isUnread(c, account_id),
  ).length;
}

export function useUnreadConversationCount(): number {
  const account_id = useTypedRedux("account", "account_id");
  const { conversations } = useConversations(!!account_id);
  return unreadConversationCount(conversations, account_id);
}

// For tests: forget the shared list.
export function resetConversationsForTests(): void {
  snapshot = { conversations: [], loading: true, unavailableBays: 0 };
  generation++;
}
