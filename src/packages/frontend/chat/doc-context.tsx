/*
 *  This file is part of CoCalc: Copyright © 2024 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 *
 *  Chat now consumes the live SyncDoc (ImmerDB) directly instead of copying
 *  chat messages into Redux. The ChatDocProvider listens to syncdb "change"
 *  events and exposes the current document via React context; components use
 *  useChatDoc() to access it and derive messages on the fly.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { PlainChatMessage } from "./types";
import { ChatMessageCache, type ThreadIndexEntry } from "./message-cache";
import { syncdocDiagnosticLog } from "@cocalc/frontend/syncdoc-diagnostics";

type DocCtx = {
  version: number;
  messages?: Map<string, PlainChatMessage>;
  threadIndex?: Map<string, ThreadIndexEntry>;
};

const ChatDocContext = createContext<DocCtx>({
  version: 0,
  messages: undefined,
});

export function ChatDocProvider({
  cache,
  children,
}: {
  cache?: ChatMessageCache;
  children: React.ReactNode;
}) {
  const previouslyHadCache = useRef(false);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!cache) return () => {};
      cache.on("version", onStoreChange);
      return () => cache.removeListener("version", onStoreChange);
    },
    [cache],
  );
  const getSnapshot = useCallback(() => cache?.getVersion() ?? -1, [cache]);

  const version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!cache) {
      if (previouslyHadCache.current) {
        syncdocDiagnosticLog("chat doc provider lost cache", {
          previous: previouslyHadCache.current,
        });
      }
      return;
    }
    previouslyHadCache.current = true;
  }, [cache]);

  const value = useMemo<DocCtx>(() => {
    return {
      version,
      messages: cache?.getMessages(),
      threadIndex: cache?.getThreadIndex(),
    };
  }, [cache, version]);

  return (
    <ChatDocContext.Provider value={value}>{children}</ChatDocContext.Provider>
  );
}

export function useChatDoc(): DocCtx {
  return useContext(ChatDocContext);
}
