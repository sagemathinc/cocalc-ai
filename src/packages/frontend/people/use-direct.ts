/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useSyncExternalStore } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  isDirectRequest,
  isDirectUnread,
  type MemberDirectConversation,
} from "@cocalc/util/direct-conversations";
import { peopleApi } from "./api";

const POLL_MS = 30_000;
const NOTIFICATION_REFRESH_DELAY_MS = 500;

interface Snapshot {
  // Whose list this is: nothing is shown or kept across accounts.
  account_id?: string;
  conversations: MemberDirectConversation[];
  loading: boolean;
  error?: string;
}

const NONE: MemberDirectConversation[] = [];
function empty(account_id?: string): Snapshot {
  return { account_id, conversations: NONE, loading: true };
}

// One list of direct conversations for the page (the Messages tab, the
// sidebar count), like the conversation list: shared, for one account, and
// refreshed on a poll, on focus, after this browser changes something, and
// as soon as a direct-message notification arrives.
let snapshot: Snapshot = empty();
const listeners = new Set<() => void>();
const users = new Map<string, number>();
let watching: { account_id: string; stop: () => void } | undefined;
let generation = 0;

function update(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Snapshot {
  return snapshot;
}

export function refreshDirect(): void {
  const account_id = watching?.account_id;
  if (account_id == null) return;
  const current = ++generation;
  const stale = () =>
    current !== generation || watching?.account_id !== account_id;
  void (async () => {
    try {
      const { conversations } = await peopleApi().listDirect({});
      if (stale()) return;
      update({ conversations, error: undefined, loading: false });
    } catch (err) {
      if (stale()) return;
      update({ error: `${err}`, loading: false });
    }
  })();
}

// Something in this browser changed a direct conversation.
export function directChanged(): void {
  refreshDirect();
}

// New notifications about direct messages mean the list changed.
export function hasNewDirectNotification(
  previous: { has: (id: string) => boolean } | undefined,
  current:
    | { some: (f: (mention: any, id: string) => boolean) => boolean }
    | undefined,
): boolean {
  if (previous == null || current == null) return false;
  return current.some(
    (mention, id) =>
      !previous.has(id) && mention?.get?.("notice_type") === "direct_message",
  );
}

function watch(): () => void {
  refreshDirect();
  const timer = setInterval(refreshDirect, POLL_MS);
  const onFocus = () => refreshDirect();
  window.addEventListener("focus", onFocus);
  let pending: ReturnType<typeof setTimeout> | undefined;
  let mentions = redux.getStore("mentions")?.get("mentions");
  const unsubscribe = redux.reduxStore.subscribe(() => {
    const next = redux.getStore("mentions")?.get("mentions");
    if (next === mentions) return;
    const previous = mentions;
    mentions = next;
    if (pending != null || !hasNewDirectNotification(previous, next)) return;
    pending = setTimeout(() => {
      pending = undefined;
      refreshDirect();
    }, NOTIFICATION_REFRESH_DELAY_MS);
  });
  return () => {
    clearInterval(timer);
    if (pending != null) clearTimeout(pending);
    window.removeEventListener("focus", onFocus);
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

export function useDirectConversations(active: boolean): Snapshot & {
  refresh: () => void;
} {
  const account_id = useTypedRedux("account", "account_id");
  const current = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(
    () => (active && account_id ? acquire(account_id) : undefined),
    [active, account_id],
  );
  const mine =
    account_id != null && current.account_id === account_id
      ? current
      : empty(account_id);
  return { ...mine, refresh: refreshDirect };
}

// Direct conversations needing this account: unread ones and requests.
export function directAttentionCount(
  conversations: MemberDirectConversation[],
  account_id?: string,
): number {
  return conversations.filter(
    (c) => isDirectUnread(c, account_id) || isDirectRequest(c),
  ).length;
}

export function useDirectAttentionCount(): number {
  const account_id = useTypedRedux("account", "account_id");
  const { conversations } = useDirectConversations(true);
  return directAttentionCount(conversations, account_id);
}

// For tests.
export function setDirectSnapshotForTests(next: Partial<Snapshot>): void {
  update(next);
}
export function resetDirectForTests(): void {
  stopWatching();
  users.clear();
  snapshot = empty();
  listeners.clear();
}
