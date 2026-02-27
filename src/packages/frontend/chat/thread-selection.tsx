/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "@cocalc/frontend/app-framework";
import type { ChatActions } from "./actions";
import { COMBINED_FEED_KEY, type ThreadMeta } from "./threads";
import type { ChatMessages } from "./types";
import { getMessageAtDate, getThreadRootDate } from "./utils";
import { field } from "./access";

interface ThreadSelectionOptions {
  actions: ChatActions;
  threads: ThreadMeta[];
  messages?: ChatMessages;
  fragmentId?: string | null;
  storedThreadFromDesc?: string | null;
  preferLatestThread?: boolean;
}

export function useChatThreadSelection({
  actions,
  threads,
  messages,
  fragmentId,
  storedThreadFromDesc,
  preferLatestThread = false,
}: ThreadSelectionOptions) {
  const [selectedThreadKey, setSelectedThreadKey0] = useState<string | null>(
    storedThreadFromDesc ?? COMBINED_FEED_KEY,
  );
  const [allowAutoSelectThread, setAllowAutoSelectThread] =
    useState<boolean>(true);

  const setSelectedThreadKey = (x: string | null) => {
    if (x != null && x != COMBINED_FEED_KEY) {
      actions.clearAllFilters();
      actions.setFragment();
    }
    setSelectedThreadKey0(x);
    actions.setSelectedThread?.(x);
  };

  const isCombinedFeedSelected = selectedThreadKey === COMBINED_FEED_KEY;
  const singleThreadView = selectedThreadKey != null && !isCombinedFeedSelected;

  useEffect(() => {
    if (
      storedThreadFromDesc != null &&
      storedThreadFromDesc !== selectedThreadKey
    ) {
      setSelectedThreadKey(storedThreadFromDesc);
      setAllowAutoSelectThread(false);
    }
  }, [storedThreadFromDesc]);

  useEffect(() => {
    if (threads.length === 0) {
      const explicitRequestedThread =
        storedThreadFromDesc != null &&
        storedThreadFromDesc !== "" &&
        storedThreadFromDesc !== COMBINED_FEED_KEY;
      if (explicitRequestedThread) {
        if (selectedThreadKey !== storedThreadFromDesc) {
          setSelectedThreadKey(storedThreadFromDesc);
        }
        setAllowAutoSelectThread(false);
        return;
      }
      // Preserve a concrete selected thread while metadata hydrates.
      // Embedded/flyout agent views pass a specific thread key and should not
      // briefly fall back to "new chat" during transient empty-thread states.
      if (
        selectedThreadKey != null &&
        selectedThreadKey !== "" &&
        selectedThreadKey !== COMBINED_FEED_KEY
      ) {
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
        setSelectedThreadKey(storedThreadFromDesc);
      }
      setAllowAutoSelectThread(false);
      return;
    }
    // If a concrete thread key is selected, don't immediately force a fallback
    // when thread metadata is transiently stale. This happens right after send:
    // selection moves to the new root before threadIndex has caught up.
    if (
      selectedThreadKey != null &&
      selectedThreadKey !== COMBINED_FEED_KEY
    ) {
      return;
    }
    if (preferLatestThread && allowAutoSelectThread) {
      const latestThreadKey = threads[0]?.key;
      if (latestThreadKey && latestThreadKey !== selectedThreadKey) {
        setSelectedThreadKey(latestThreadKey);
        setAllowAutoSelectThread(false);
      }
      return;
    }
    const exists = threads.some((thread) => thread.key === selectedThreadKey);
    if (!exists && allowAutoSelectThread) {
      setSelectedThreadKey(COMBINED_FEED_KEY);
    }
  }, [
    threads,
    selectedThreadKey,
    allowAutoSelectThread,
    preferLatestThread,
    storedThreadFromDesc,
  ]);

  useEffect(() => {
    if (!fragmentId || messages == null) {
      return;
    }
    const parsed = parseFloat(fragmentId);
    if (!isFinite(parsed)) {
      return;
    }
    const message = getMessageAtDate({ messages, date: parsed });
    if (message == null) return;
    const threadId = field<string>(message as any, "thread_id")?.trim();
    const root = getThreadRootDate({ date: parsed, messages }) || parsed;
    const threadKey = threadId || `${root}`;
    if (threadKey !== selectedThreadKey) {
      setAllowAutoSelectThread(false);
      setSelectedThreadKey(threadKey);
    }
  }, [fragmentId, messages, selectedThreadKey]);

  const selectedThread = useMemo(
    () => threads.find((t) => t.key === selectedThreadKey),
    [threads, selectedThreadKey],
  );

  const selectedThreadDate = useMemo(() => {
    if (!selectedThreadKey || selectedThreadKey === COMBINED_FEED_KEY) {
      return undefined;
    }
    const rootDate = selectedThread?.rootMessage?.date;
    if (rootDate != null) {
      const d = new Date(rootDate as any);
      if (!Number.isNaN(d.valueOf())) return d;
    }
    const millis = parseInt(selectedThreadKey, 10);
    if (!isFinite(millis)) return undefined;
    return new Date(millis);
  }, [selectedThreadKey, selectedThread]);

  return {
    selectedThreadKey,
    setSelectedThreadKey,
    setAllowAutoSelectThread,
    selectedThreadDate,
    isCombinedFeedSelected,
    singleThreadView,
    selectedThread,
  };
}
