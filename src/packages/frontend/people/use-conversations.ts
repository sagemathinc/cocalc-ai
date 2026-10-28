/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useSyncExternalStore } from "react";
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

type Snapshot = Omit<ConversationsState, "refresh"> & {
  // Whose list this is: nothing is shown or kept across accounts.
  account_id?: string;
};

const NONE: ListedConversation[] = [];

function empty(account_id?: string): Snapshot {
  return { conversations: NONE, loading: true, unavailableBays: 0, account_id };
}

// One conversation list for the whole page: the People page, its sidebar and
// the unread count share it, so they agree and ask the server once. It is one
// request to the account's home bay, which asks each owning bay once.
//
// It refreshes on a poll, on window focus, when this browser changes a
// conversation, and as soon as a chat notification arrives (someone wrote in
// a thread this account follows or mentioned it), so a reply shows without
// waiting for the poll. The list belongs to one account: switching accounts
// starts over, and a response for another account is dropped.
let snapshot: Snapshot = empty();
const listeners = new Set<() => void>();
// Users per account; the watched account is the one most recently acquired.
const users = new Map<string, number>();
let watching: { account_id: string; stop: () => void } | undefined;
let generation = 0;

function update(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

export function subscribeConversations(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getConversationsSnapshot(): Snapshot {
  return snapshot;
}

export function refreshConversations(): void {
  const account_id = watching?.account_id;
  if (account_id == null) return;
  const current = ++generation;
  const stale = () =>
    current !== generation || watching?.account_id !== account_id;
  void (async () => {
    try {
      const result = await peopleApi().listConversations({});
      if (stale()) return;
      update({
        conversations: result.conversations,
        unavailableBays: result.unavailable_bays,
        error: undefined,
        loading: false,
      });
    } catch (err) {
      if (stale()) return;
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
    clearInterval(timer);
    if (pending != null) clearTimeout(pending);
    window.removeEventListener("focus", onFocus);
    conversationEvents.off("changed", refreshConversations);
    unsubscribe();
  };
}

function stopWatching(): void {
  generation++;
  watching?.stop();
  watching = undefined;
}

function acquire(account_id: string): () => void {
  users.set(account_id, (users.get(account_id) ?? 0) + 1);
  if (watching?.account_id !== account_id) {
    // A different account: start over with an empty list.
    stopWatching();
    update(empty(account_id));
    watching = { account_id, stop: () => {} };
    watching.stop = watch();
  }
  return () => {
    const count = (users.get(account_id) ?? 1) - 1;
    if (count > 0) {
      users.set(account_id, count);
      return;
    }
    users.delete(account_id);
    if (watching?.account_id === account_id) stopWatching();
  };
}

export function useConversations(active: boolean): ConversationsState {
  const account_id = useTypedRedux("account", "account_id");
  const current = useSyncExternalStore(
    subscribeConversations,
    getConversationsSnapshot,
  );
  useEffect(
    () => (active && account_id ? acquire(account_id) : undefined),
    [active, account_id],
  );
  // Never another account's list, even for a moment.
  const mine =
    account_id != null && current.account_id === account_id
      ? current
      : empty(account_id);
  return {
    conversations: mine.conversations,
    loading: mine.loading,
    error: mine.error,
    unavailableBays: mine.unavailableBays,
    refresh: refreshConversations,
  };
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
  const { conversations } = useConversations(true);
  return unreadConversationCount(conversations, account_id);
}

// For tests: replace the shared list at once.
export function setConversationsSnapshotForTests(next: Partial<Snapshot>) {
  update(next);
}

// For tests: forget the shared list and who uses it.
export function resetConversationsForTests(): void {
  stopWatching();
  users.clear();
  snapshot = empty();
  listeners.clear();
}
