import { useCallback, useEffect, useRef, useState } from "react";

// Retained views are cheap now (virtualized rows; chat data and editor actions
// stay loaded either way). Measured on a long thread: ~13 MB heap and a few
// thousand DOM nodes per retained view, and a hidden streaming turn adds ~5%
// main-thread time. Eviction mostly bounds memory on small devices.
export const MAX_RETAINED_AGENT_WORKSPACES = 8;
export const MAX_RETAINED_AGENT_WORKSPACES_CONSTRAINED = 4;
// Time spent elsewhere in CoCalc (while this browser tab is visible) before an
// unprotected view is evicted.
export const AGENT_WORKSPACE_IDLE_MS = 30 * 60_000;
export const AGENT_WORKSPACE_IDLE_TICK_MS = 30_000;

export function defaultRetainedWorkspaceLimit(): number {
  if (typeof window === "undefined") return MAX_RETAINED_AGENT_WORKSPACES;
  const memory = (navigator as any).deviceMemory;
  const constrained =
    (typeof memory === "number" && memory <= 4) || window.innerWidth < 768;
  return constrained
    ? MAX_RETAINED_AGENT_WORKSPACES_CONSTRAINED
    : MAX_RETAINED_AGENT_WORKSPACES;
}

interface Retained {
  // Idle time accumulated while another workspace was shown.
  idleMs: number;
  // Order of last activation, for least-recently-used eviction.
  lastActive: number;
}

export interface RetainedWorkspacesOptions {
  maxRetained?: number;
  // Views that must stay mounted, e.g. an agent with a running turn.
  isProtected?: (workspace: string) => boolean;
}

// Only the React views are evicted. Shared editor actions, persisted drafts,
// and server-side agent execution have independent lifetimes.
//
// Map order is render order and must stay stable: moving a retained view in the
// DOM silently resets every scroll position inside it (e.g., long chats jump to
// the top). Recency lives only in the values.
//
// Never evicted: the active view, the one shown just before it (switching
// back and forth), and protected views. They still count toward the limit,
// which may be exceeded when everything retained is protected.
export function useRetainedWorkspaces(
  activeWorkspace?: string,
  { maxRetained, isProtected }: RetainedWorkspacesOptions = {},
) {
  const [workspaces, setWorkspaces] = useState(
    () => new Map<string, Retained>(),
  );
  const activeRef = useRef(activeWorkspace);
  const previousRef = useRef<string | undefined>(undefined);
  const limitRef = useRef(maxRetained ?? defaultRetainedWorkspaceLimit());
  limitRef.current = maxRetained ?? limitRef.current;
  const isProtectedRef = useRef(isProtected);
  isProtectedRef.current = isProtected;
  const clockRef = useRef(0);

  const keep = (workspace: string) =>
    workspace === activeRef.current ||
    workspace === previousRef.current ||
    !!isProtectedRef.current?.(workspace);

  const evictOverLimit = (next: Map<string, Retained>) => {
    while (next.size > limitRef.current) {
      let oldest: string | undefined;
      for (const [key, { lastActive }] of next) {
        if (keep(key)) continue;
        if (oldest == null || lastActive < next.get(oldest)!.lastActive) {
          oldest = key;
        }
      }
      if (oldest == null) break;
      next.delete(oldest);
    }
    return next;
  };

  const mountWorkspace = useCallback((workspace: string) => {
    setWorkspaces((old) => {
      const next = new Map(old);
      next.set(workspace, { idleMs: 0, lastActive: ++clockRef.current });
      return evictOverLimit(next);
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
      previousRef.current = previous;
    }
    if (activeWorkspace) mountWorkspace(activeWorkspace);
  }, [activeWorkspace, mountWorkspace]);

  useEffect(() => {
    const timer = setInterval(() => {
      // A hidden browser tab (or a sleeping laptop) is not time spent
      // elsewhere in CoCalc; do not age views then.
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      setWorkspaces((old) => {
        let changed = false;
        const next = new Map<string, Retained>();
        for (const [key, value] of old) {
          if (keep(key)) {
            next.set(key, value.idleMs ? { ...value, idleMs: 0 } : value);
            changed ||= value.idleMs !== 0;
            continue;
          }
          const idleMs = value.idleMs + AGENT_WORKSPACE_IDLE_TICK_MS;
          changed = true;
          if (idleMs < AGENT_WORKSPACE_IDLE_MS) {
            next.set(key, { ...value, idleMs });
          }
        }
        return changed ? evictOverLimit(next) : old;
      });
    }, AGENT_WORKSPACE_IDLE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return { mountedWorkspaces: workspaces, mountWorkspace, unmountWorkspace };
}
