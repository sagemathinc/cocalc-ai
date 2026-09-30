import { useCallback, useEffect, useRef, useState } from "react";

export const MAX_RETAINED_AGENT_WORKSPACES = 3;
export const AGENT_WORKSPACE_IDLE_MS = 5 * 60_000;

// Only the React views are evicted. Shared editor actions, persisted drafts,
// and server-side agent execution have independent lifetimes.
//
// Map order is render order and must stay stable: moving a retained view in the
// DOM silently resets every scroll position inside it (e.g., long chats jump to
// the top). Recency lives only in the values.
export function useRetainedWorkspaces(activeWorkspace?: string) {
  const [workspaces, setWorkspaces] = useState(() => new Map<string, number>());
  const activeRef = useRef(activeWorkspace);
  const mountWorkspace = useCallback((workspace: string) => {
    setWorkspaces((old) => {
      const next = new Map(old);
      next.set(workspace, Date.now());
      while (next.size > MAX_RETAINED_AGENT_WORKSPACES) {
        let oldest: string | undefined;
        for (const [key, lastActive] of next) {
          if (key === workspace) continue;
          if (oldest == null || lastActive < next.get(oldest)!) oldest = key;
        }
        next.delete(oldest!);
      }
      return next;
    });
  }, []);
  const unmountWorkspace = useCallback((workspace: string) => {
    setWorkspaces((old) => {
      if (!old.has(workspace)) return old;
      const next = new Map(old);
      next.delete(workspace);
      return next;
    });
  }, []);

  useEffect(() => {
    const previous = activeRef.current;
    activeRef.current = activeWorkspace;
    if (previous && previous !== activeWorkspace) {
      setWorkspaces((old) => {
        if (!old.has(previous)) return old;
        return new Map(old).set(previous, Date.now());
      });
    }
    if (activeWorkspace) mountWorkspace(activeWorkspace);
  }, [activeWorkspace, mountWorkspace]);

  useEffect(() => {
    const timer = setInterval(() => {
      setWorkspaces((old) => {
        const expired = [...old].filter(
          ([key, lastActive]) =>
            key !== activeRef.current &&
            Date.now() - lastActive >= AGENT_WORKSPACE_IDLE_MS,
        );
        if (!expired.length) return old;
        const next = new Map(old);
        for (const [key] of expired) next.delete(key);
        return next;
      });
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  return { mountedWorkspaces: workspaces, mountWorkspace, unmountWorkspace };
}
