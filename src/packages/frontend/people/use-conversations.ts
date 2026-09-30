/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ListedConversation } from "@cocalc/util/conversations";
import { conversationEvents, conversationsApi } from "./api";

const POLL_MS = 30_000;

export interface ConversationsState {
  conversations: ListedConversation[];
  loading: boolean;
  error?: string;
  unavailableBays: number;
  refresh: () => void;
}

// Plain polling plus local change events. The list is one request to the
// account's home bay, which asks each owning bay once.
export function useConversations(active: boolean): ConversationsState {
  const [conversations, setConversations] = useState<ListedConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [unavailableBays, setUnavailableBays] = useState(0);
  const generation = useRef(0);

  const refresh = useCallback(() => {
    const current = ++generation.current;
    void (async () => {
      try {
        const result = await conversationsApi().list({});
        if (current !== generation.current) return;
        setConversations(result.conversations);
        setUnavailableBays(result.unavailable_bays);
        setError(undefined);
      } catch (err) {
        if (current !== generation.current) return;
        setError(`${err}`);
      } finally {
        if (current === generation.current) setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    conversationEvents.on("changed", refresh);
    return () => {
      generation.current++;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      conversationEvents.off("changed", refresh);
    };
  }, [active, refresh]);

  return { conversations, loading, error, unavailableBays, refresh };
}
