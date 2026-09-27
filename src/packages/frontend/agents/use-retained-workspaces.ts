import { useCallback, useEffect, useRef, useState } from "react";

export const MAX_RETAINED_AGENT_WORKSPACES = 3;
export const AGENT_WORKSPACE_IDLE_MS = 5 * 60_000;

// Only the React views are evicted. Shared editor actions, persisted drafts,
// and server-side agent execution have independent lifetimes.
export function useRetainedWorkspaces(activeWorkspace?: string) {
  const [workspaces, setWorkspaces] = useState(() => new Map<string, number>());
  const activeRef = useRef(activeWorkspace);
  const mountWorkspace = useCallback((workspace: string) => {
    setWorkspaces((old) => {
      const next = new Map(old);
      next.delete(workspace);
      next.set(workspace, Date.now());
      while (next.size > MAX_RETAINED_AGENT_WORKSPACES) {
        next.delete(next.keys().next().value!);
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
