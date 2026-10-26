/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Anchored chat threads: a thread in a document's side chat can be anchored
to a location inside that document.  The anchor id is opaque to chat:

- Jupyter notebooks anchor threads to a cell via the cell's UUID.
- LaTeX documents anchor threads to a "% chat: <hash>" comment in the
  source; the anchor id is the marker hash.

The anchor lives on the thread's chat-thread-config row (see
ChatThreadAnchor in @cocalc/chat).  Resolving a thread moves the anchor
id into resolved.anchorId so stale markers can still be recognized.
*/

import { useEffect, useMemo, useState } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import type { ChatThreadAnchor, ChatThreadResolvedMeta } from "@cocalc/chat";

import type { ChatActions } from "./actions";
import { ensureSideChatActions } from "./unread";
import { isChatPath } from "./paths";

// Editor actions adapter for anchored threads.  Frame editors that
// support anchored side-chat threads implement (a subset of) these
// methods; shared chat UI duck-types on them and hides affordances
// when a method is missing.
export interface AnchorEditorActions {
  // Tri-state availability distinguishes a genuinely deleted anchor from an
  // anchor in a subfile this client has not loaded yet.
  getAnchorState?: (
    anchorId: string,
    anchorPath?: string,
  ) => "available" | "missing" | "unloaded";
  // scroll/focus the document location of the anchor
  jumpToAnchor?: (anchorId: string, anchorPath?: string) => void;
  // whether the target currently exists; false suppresses dead jump links
  canJumpToAnchor?: (anchorId: string, anchorPath?: string) => boolean;
  // tooltip shown beside an unavailable anchor's stored title
  getMissingAnchorMessage?: (anchorId: string) => string;
  // human label for the anchor, e.g. "Cell 3" or "section.tex:12"
  getAnchorLabel?: (
    anchorId: string,
    anchorPath?: string,
  ) => string | undefined;
  // shorter label used for the jump button; falls back to getAnchorLabel
  getAnchorJumpLabel?: (
    anchorId: string,
    anchorPath?: string,
  ) => string | undefined;
  // open the side chat showing the newest thread for this anchor
  // (creating an empty anchored thread when none exists)
  openAnchorChat?: (anchorId: string, path?: string) => void;
  // open the side chat with a fresh anchored thread
  openAnchorChatNewThread?: (anchorId: string, path?: string) => void;
  // open the side chat showing one specific thread
  openAnchorChatThread?: (threadKey: string) => void;
  // LaTeX only: resolve the thread(s) for a marker hash and remove the
  // marker(s) from the source
  resolveChatMarker?: (hash: string, expectsThread?: boolean) => void;
}

function parseNonemptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

// Parse an anchor value from a thread-config row.  Tolerates immutable
// records and malformed data from other clients.
export function parseThreadAnchor(value: any): ChatThreadAnchor | undefined {
  if (value == null) return undefined;
  const obj = typeof value.toJS === "function" ? value.toJS() : value;
  if (typeof obj !== "object") return undefined;
  const id = parseNonemptyString(obj.id);
  if (id == null) return undefined;
  const anchor: ChatThreadAnchor = { id };
  const path = parseNonemptyString(obj.path);
  if (path != null) {
    anchor.path = path;
  }
  return anchor;
}

export function parseThreadResolved(
  value: any,
): ChatThreadResolvedMeta | undefined {
  if (value == null) return undefined;
  const obj = typeof value.toJS === "function" ? value.toJS() : value;
  if (typeof obj !== "object") return undefined;
  const anchorId = parseNonemptyString(obj.anchorId);
  if (anchorId == null) return undefined;
  const resolved: ChatThreadResolvedMeta = {
    account_id: parseNonemptyString(obj.account_id) ?? "",
    at: parseNonemptyString(obj.at) ?? "",
    anchorId,
  };
  const path = parseNonemptyString(obj.path);
  if (path != null) {
    resolved.path = path;
  }
  const label = parseNonemptyString(obj.label);
  if (label != null) {
    resolved.label = label;
  }
  return resolved;
}

export type AnchorThreadChoice =
  | { action: "select"; key: string }
  | { action: "create" };

// Selection policy for opening the chat of an anchor (pure; used by
// ChatActions.findOrCreateAnchorThread):
// - newest *unarchived* live thread wins;
// - if every live match is manually archived, create a fresh thread
//   (archived threads must not silently reopen -- they stay reachable
//   via the sidebar's archive list);
// - a hash whose only matches are *resolved* threads is retired: select
//   the newest resolved thread as a read-only record instead of
//   reviving the hash;
// - otherwise create.
export function chooseAnchorThread({
  rows,
  anchorId,
  recencyTime,
}: {
  rows: any[];
  anchorId: string;
  recencyTime: (threadId: string, row: any) => number;
}): AnchorThreadChoice {
  const id = `${anchorId ?? ""}`.trim();
  if (!id) return { action: "create" };
  const live: { key: string; time: number; archived: boolean }[] = [];
  const resolved: { key: string; time: number }[] = [];
  for (const row of rows) {
    const threadId = `${(row as any)?.thread_id ?? ""}`.trim();
    if (!threadId) continue;
    const rowResolved = parseThreadResolved((row as any)?.resolved);
    if (rowResolved != null) {
      if (rowResolved.anchorId === id) {
        resolved.push({ key: threadId, time: recencyTime(threadId, row) });
      }
      continue;
    }
    const anchor = parseThreadAnchor((row as any)?.anchor);
    if (anchor?.id !== id) continue;
    live.push({
      key: threadId,
      time: recencyTime(threadId, row),
      archived: (row as any)?.archived === true,
    });
  }
  const pick = (candidates: { key: string; time: number }[]) =>
    candidates.sort((a, b) => b.time - a.time)[0].key;
  const unarchived = live.filter((t) => !t.archived);
  if (unarchived.length > 0) {
    return { action: "select", key: pick(unarchived) };
  }
  if (live.length === 0 && resolved.length > 0) {
    return { action: "select", key: pick(resolved) };
  }
  return { action: "create" };
}

export interface AnchoredThreadSummary {
  key: string; // thread key == thread_id
  label: string;
  messageCount: number;
  unreadCount: number;
  newestTime: number;
  anchor?: ChatThreadAnchor;
  resolved?: ChatThreadResolvedMeta;
}

export interface AnchoredThreadsInfo {
  threads: AnchoredThreadSummary[]; // newest first
  totalMessages: number;
  totalUnread: number;
  chatActions?: ChatActions;
}

export function computeAnchoredThreads({
  actions,
  anchorId,
  accountId,
  resolved,
}: {
  actions: ChatActions | undefined;
  anchorId: string;
  accountId: string | undefined;
  resolved: boolean;
}): AnchoredThreadsInfo {
  const info: AnchoredThreadsInfo = {
    threads: [],
    totalMessages: 0,
    totalUnread: 0,
    chatActions: actions,
  };
  const id = `${anchorId ?? ""}`.trim();
  if (!actions || !id) {
    return info;
  }
  const readStateReady = actions.isProjectReadStateReady?.() ?? false;
  const threadIndex = actions.getThreadIndex?.();
  for (const row of actions.listThreadConfigRows?.() ?? []) {
    const threadId = `${(row as any)?.thread_id ?? ""}`.trim();
    if (!threadId) continue;
    const rowResolved = parseThreadResolved((row as any)?.resolved);
    const rowAnchor = parseThreadAnchor((row as any)?.anchor);
    const rowArchived = (row as any)?.archived === true;
    const matches = resolved
      ? rowResolved?.anchorId === id
      : rowResolved == null && !rowArchived && rowAnchor?.id === id;
    if (!matches) continue;
    const entry = threadIndex?.get?.(threadId);
    const messageCount = entry?.messageCount ?? 0;
    let unreadCount = 0;
    if (!resolved && readStateReady && accountId && messageCount > 0) {
      const readCount = Math.max(
        0,
        actions.getThreadReadCount?.(threadId, accountId) ?? 0,
      );
      // Plus what the reader marked unread again before the watermark.
      unreadCount =
        Math.max(messageCount - readCount, 0) +
        (actions.getReaderUnreadBeforeWatermark?.(threadId, accountId) ?? 0);
    }
    const name = parseNonemptyString((row as any)?.name);
    // Config-only threads have no messages yet; fall back to the config
    // row's updated_at so "newest thread" ordering stays meaningful.
    const updatedAt = Date.parse(`${(row as any)?.updated_at ?? ""}`);
    info.threads.push({
      key: threadId,
      label: name ?? "Discussion",
      messageCount,
      unreadCount,
      newestTime: Math.max(
        entry?.newestTime ?? 0,
        Number.isFinite(updatedAt) ? updatedAt : 0,
      ),
      anchor: rowAnchor,
      resolved: rowResolved,
    });
    info.totalMessages += messageCount;
    info.totalUnread += unreadCount;
  }
  info.threads.sort((a, b) => b.newestTime - a.newestTime);
  return info;
}

interface SharedChatSubscription {
  subscribe: (callback: () => void, onClose: () => void) => () => void;
}

// A LaTeX document can render several React roots per marker (gutter, inline
// tail, and TOC). Multiplex them through one store/cache listener per actions
// instance instead of attaching dozens of identical EventEmitter listeners.
const sharedChatSubscriptions = new WeakMap<
  ChatActions,
  SharedChatSubscription
>();

function sharedChatSubscription(actions: ChatActions): SharedChatSubscription {
  const existing = sharedChatSubscriptions.get(actions);
  if (existing != null) return existing;

  const callbacks = new Map<() => void, () => void>();
  let subscribedStore = actions.store;
  let subscribedMessageCache = actions.messageCache;
  let subscribedSyncdb = actions.syncdb;

  function bindCurrentSources() {
    const nextStore = actions.store;
    if (nextStore !== subscribedStore) {
      subscribedStore?.removeListener?.("change", notify);
      subscribedStore = nextStore;
      subscribedStore?.on?.("change", notify);
    }
    const nextCache = actions.messageCache;
    if (nextCache !== subscribedMessageCache) {
      subscribedMessageCache?.removeListener?.("version", notify);
      subscribedMessageCache = nextCache;
      subscribedMessageCache?.on?.("version", notify);
    }
    const nextSyncdb = actions.syncdb;
    if (nextSyncdb !== subscribedSyncdb) {
      subscribedSyncdb?.removeListener?.("close", notifyClose);
      subscribedSyncdb = nextSyncdb;
      subscribedSyncdb?.on?.("close", notifyClose);
    }
  }

  function notify() {
    bindCurrentSources();
    for (const callback of [...callbacks.keys()]) {
      callback();
    }
  }

  function notifyClose() {
    for (const onClose of [...callbacks.values()]) {
      onClose();
    }
  }

  subscribedStore?.on?.("change", notify);
  subscribedMessageCache?.on?.("version", notify);
  subscribedSyncdb?.on?.("close", notifyClose);

  const subscription: SharedChatSubscription = {
    subscribe(callback, onClose) {
      callbacks.set(callback, onClose);
      bindCurrentSources();
      if (subscribedSyncdb?.get_state?.() === "closed") {
        onClose();
      }
      return () => {
        callbacks.delete(callback);
        if (callbacks.size > 0) return;
        subscribedStore?.removeListener?.("change", notify);
        subscribedMessageCache?.removeListener?.("version", notify);
        subscribedSyncdb?.removeListener?.("close", notifyClose);
        // Only retract our own registration. A duplicated cleanup must not
        // unregister a successor, which would keep that subscription's
        // listeners attached while the next lookup builds a second set.
        if (sharedChatSubscriptions.get(actions) === subscription) {
          sharedChatSubscriptions.delete(actions);
        }
      };
    },
  };
  sharedChatSubscriptions.set(actions, subscription);
  return subscription;
}

function useSideChatActions(
  project_id: string,
  path: string,
): { chatActions: ChatActions | undefined; chatVersion: number } {
  const [chatActions, setChatActions] = useState<ChatActions | undefined>();
  const [chatVersion, setChatVersion] = useState(0);
  // Bumped when the chat syncdb closes; re-runs the acquisition effect
  // below, which owns the retry logic.
  const [acquireToken, setAcquireToken] = useState(0);

  useEffect(() => {
    if (!project_id || !path || isChatPath(path)) {
      setChatActions(undefined);
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const acquire = () => {
      if (cancelled) return;
      try {
        setChatActions(ensureSideChatActions(project_id, path));
      } catch (err) {
        console.warn("failed to initialize side chat actions", {
          project_id,
          path,
          err,
        });
        setChatActions(undefined);
        retryTimer = setTimeout(acquire, 3000);
      }
    };
    acquire();
    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [project_id, path, acquireToken]);

  useEffect(() => {
    if (!chatActions) {
      return;
    }
    const refresh = () => {
      setChatVersion((value) => value + 1);
    };
    // Incoming chat rows update the shared message cache directly.  They do
    // not necessarily mutate the Redux chat store, so listen to its version
    // event as well. The shared subscription keeps this at one physical
    // listener even when every marker has multiple detached React roots.
    const reconnect = () => {
      setAcquireToken((token) => token + 1);
    };
    const unsubscribe = sharedChatSubscription(chatActions).subscribe(
      refresh,
      reconnect,
    );
    refresh();
    return unsubscribe;
  }, [chatActions]);

  return { chatActions, chatVersion };
}

// All live (unresolved) threads anchored to anchorId in the side chat
// of the given document path.
export function useAnchoredThreads(
  project_id: string,
  path: string,
  anchorId: string | undefined,
): AnchoredThreadsInfo {
  const account_id = useTypedRedux("account", "account_id");
  const { chatActions, chatVersion } = useSideChatActions(project_id, path);
  return useMemo(
    () =>
      computeAnchoredThreads({
        actions: chatActions,
        anchorId: anchorId ?? "",
        accountId: account_id,
        resolved: false,
      }),
    [chatActions, chatVersion, anchorId, account_id],
  );
}

// All resolved threads whose former anchor id is anchorId -- used to
// detect stale markers left in the source after a thread was resolved.
export function useResolvedAnchoredThreads(
  project_id: string,
  path: string,
  anchorId: string | undefined,
): AnchoredThreadsInfo {
  const account_id = useTypedRedux("account", "account_id");
  const { chatActions, chatVersion } = useSideChatActions(project_id, path);
  return useMemo(
    () =>
      computeAnchoredThreads({
        actions: chatActions,
        anchorId: anchorId ?? "",
        accountId: account_id,
        resolved: true,
      }),
    [chatActions, chatVersion, anchorId, account_id],
  );
}
