/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createContext, useEffect, useRef, useState } from "react";
import type { DirectoryApi } from "./workspace-api";

export const DirectoryRevisionContext = createContext({
  generation: 0,
  ready: true,
});

/** The initial check precedes all page reads. Subsequent checks use its token,
 * so commits during a page query cannot fall into a snapshot/subscription gap.
 * Tokens are opaque: only reset, not token-string changes, invalidates pages.
 */
export function useDirectoryRevision(api: DirectoryApi, active: boolean) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState({
    ready: false,
    generation: 0,
    error: "",
  });
  const wasActive = useRef(active);
  if (wasActive.current !== active) {
    wasActive.current = active;
    setState((current) => ({ ...current, ready: false, error: "" }));
  }
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let since: string | undefined;
    const poll = async () => {
      try {
        const check = await api.check({ since });
        if (cancelled) return;
        if (
          !check ||
          typeof check.revision !== "string" ||
          typeof check.reset !== "boolean"
        )
          throw Error(
            "The collaboration revision service returned an invalid response.",
          );
        since = check.revision;
        setState((current) =>
          !check.reset && current.ready && !current.error
            ? current
            : {
                ready: true,
                generation:
                  current.generation + (check.reset || !current.ready ? 1 : 0),
                error: "",
              },
        );
        timer = setTimeout(
          () => void poll(),
          Math.min(30_000, Math.max(1000, check.poll_after_ms || 5000)),
        );
      } catch (error) {
        if (cancelled) return;
        setState((current) => ({
          ...current,
          ready: false,
          error: String(error),
        }));
        // Recovery always resnapshots; never trust metadata while access is unknown.
        since = undefined;
        timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, active, retry]);
  return {
    ...state,
    ready: active && state.ready,
    retry: () => setRetry((n) => n + 1),
  };
}
