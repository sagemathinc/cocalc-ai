/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import type { ChatActions } from "./actions";
import type { ThreadMeta } from "./threads";
import type { ChatMessages } from "./types";
import { getMessageAtDate } from "./utils";
import { field } from "./access";

interface ThreadSelectionOptions {
  actions: ChatActions;
  threads: ThreadMeta[];
  messages?: ChatMessages;
  fragmentId?: string | null;
  storedThreadFromDesc?: string | null;
}

export function resetThreadSelectionForNewChat({
  actions,
  setAllowAutoSelectThread,
  setSelectedThreadKey,
}: {
  actions: Pick<ChatActions, "setFragment">;
  setAllowAutoSelectThread: (value: boolean) => void;
  setSelectedThreadKey: (value: string | null) => void;
}) {
  setAllowAutoSelectThread(false);
  actions.setFragment();
  setSelectedThreadKey(null);
}

export function useChatThreadSelection({
  actions,
  threads,
  messages,
  fragmentId,
  storedThreadFromDesc,
}: ThreadSelectionOptions) {
  const [selectedThreadKey, setSelectedThreadKey0] = useState<string | null>(
    storedThreadFromDesc ?? null,
  );
  const [allowAutoSelectThread, setAllowAutoSelectThread] =
    useState<boolean>(true);
  const appliedFragmentThreadRef = useRef<string | null>(null);

  const syncSelectedThreadKeyFromExternal = (x: string | null) => {
    if (x === selectedThreadKey) {
      return;
    }
    setSelectedThreadKey0(x);
  };

  const setSelectedThreadKey = (x: string | null) => {
    if (x === selectedThreadKey) {
      return;
    }
    if (x != null) {
      actions.clearAllFilters();
      actions.setFragment();
    }
    setSelectedThreadKey0(x);
    actions.setSelectedThread?.(x);
  };

  const singleThreadView = selectedThreadKey != null;
  useEffect(() => {
    if (
      storedThreadFromDesc != null &&
      storedThreadFromDesc !== selectedThreadKey
    ) {
      syncSelectedThreadKeyFromExternal(storedThreadFromDesc);
      setAllowAutoSelectThread(false);
    }
  }, [storedThreadFromDesc]);

  useEffect(() => {
    if (threads.length === 0) {
      const explicitRequestedThread =
        storedThreadFromDesc != null && storedThreadFromDesc !== "";
      if (explicitRequestedThread) {
        if (selectedThreadKey !== storedThreadFromDesc) {
          syncSelectedThreadKeyFromExternal(storedThreadFromDesc);
        }
        setAllowAutoSelectThread(false);
        return;
      }
      // Preserve a concrete selected thread while metadata hydrates.
      // Embedded/flyout agent views pass a specific thread key and should not
      // briefly fall back to "new chat" during transient empty-thread states.
      if (selectedThreadKey != null && selectedThreadKey !== "") {
        return;
      }
      if (selectedThreadKey !== null) {
        setSelectedThreadKey(null);
      }
      setAllowAutoSelectThread(true);
      return;
    }
    if (
      storedThreadFromDesc != null &&
      threads.some((thread) => thread.key === storedThreadFromDesc)
    ) {
      if (selectedThreadKey !== storedThreadFromDesc) {
        syncSelectedThreadKeyFromExternal(storedThreadFromDesc);
      }
      setAllowAutoSelectThread(false);
      return;
    }
    // If a concrete thread key is selected, don't immediately force a fallback
    // when thread metadata is transiently stale. This happens right after send:
    // selection moves to the new root before threadIndex has caught up.
    if (selectedThreadKey != null) {
      return;
    }
    if (allowAutoSelectThread) {
      const latestThreadKey = threads[0]?.key;
      if (latestThreadKey && latestThreadKey !== selectedThreadKey) {
        setSelectedThreadKey(latestThreadKey);
        setAllowAutoSelectThread(false);
      }
      return;
    }
  }, [threads, selectedThreadKey, allowAutoSelectThread, storedThreadFromDesc]);

  useEffect(() => {
    if (!fragmentId || messages == null) {
      appliedFragmentThreadRef.current = null;
      return;
    }
    const parsed = parseFloat(fragmentId);
    if (!isFinite(parsed)) {
      appliedFragmentThreadRef.current = null;
      return;
    }
    const message = getMessageAtDate({ messages, date: parsed });
    if (message == null) return;
    const threadId = field<string>(message as any, "thread_id")?.trim();
    if (!threadId) return;
    const threadKey = threadId;
    const appliedToken = `${fragmentId}:${threadKey}`;
    if (appliedFragmentThreadRef.current === appliedToken) {
      return;
    }
    if (threadKey !== selectedThreadKey) {
      setAllowAutoSelectThread(false);
      syncSelectedThreadKeyFromExternal(threadKey);
    }
    appliedFragmentThreadRef.current = appliedToken;
  }, [fragmentId, messages, selectedThreadKey]);

  const selectedThread = useMemo(
    () => threads.find((t) => t.key === selectedThreadKey),
    [threads, selectedThreadKey],
  );

  return {
    selectedThreadKey,
    setSelectedThreadKey,
    setAllowAutoSelectThread,
    singleThreadView,
    selectedThread,
  };
}
