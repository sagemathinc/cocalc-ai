/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const ACTIVE_INTERACTION_MS = 60_000;
const HEARTBEAT_MS = 10_000;
const REMOTE_LEASE_MS = 30_000;

type CodexWatch = {
  account_id: string;
  project_id: string;
  path: string;
  thread_id: string;
};

type RemotePresence = {
  updated_at: number;
  watches: CodexWatch[];
};

const leases = new Map<symbol, CodexWatch>();
const remotePresence = new Map<string, RemotePresence>();
const tabId =
  globalThis.crypto?.randomUUID?.() ??
  `codex-watch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let lastInteractionAt = Date.now();
let listenersInstalled = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;
const presenceChannel =
  typeof BroadcastChannel === "undefined"
    ? undefined
    : new BroadcastChannel("cocalc-codex-watch-presence");

function sameWatch(a: CodexWatch, b: CodexWatch): boolean {
  return (
    a.account_id === b.account_id &&
    a.project_id === b.project_id &&
    a.path === b.path &&
    a.thread_id === b.thread_id
  );
}

function localTabEngaged(now = Date.now()): boolean {
  return (
    typeof document !== "undefined" &&
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    now - lastInteractionAt <= ACTIVE_INTERACTION_MS
  );
}

function activeLocalWatches(now = Date.now()): CodexWatch[] {
  if (!localTabEngaged(now)) return [];
  const unique: CodexWatch[] = [];
  for (const watch of leases.values()) {
    if (!unique.some((candidate) => sameWatch(candidate, watch))) {
      unique.push(watch);
    }
  }
  return unique;
}

function broadcastPresence(): void {
  presenceChannel?.postMessage({
    type: "presence",
    tabId,
    updated_at: Date.now(),
    watches: activeLocalWatches(),
  });
}

function broadcastInactivePresence(): void {
  presenceChannel?.postMessage({
    type: "presence",
    tabId,
    updated_at: Date.now(),
    watches: [],
  });
}

function updateHeartbeat(): void {
  if (leases.size > 0 && heartbeat == null) {
    heartbeat = setInterval(broadcastPresence, HEARTBEAT_MS);
  } else if (leases.size === 0 && heartbeat != null) {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }
}

function noteInteraction(): void {
  lastInteractionAt = Date.now();
  broadcastPresence();
}

function ensureInteractionListeners(): void {
  if (listenersInstalled || typeof window === "undefined") return;
  listenersInstalled = true;
  for (const event of ["pointerdown", "keydown", "touchstart"]) {
    window.addEventListener(event, noteInteraction, { passive: true });
  }
  window.addEventListener("focus", noteInteraction, { passive: true });
  window.addEventListener("blur", broadcastPresence, { passive: true });
  document.addEventListener("visibilitychange", broadcastPresence, {
    passive: true,
  });
  window.addEventListener("pagehide", broadcastInactivePresence, {
    passive: true,
  });
}

presenceChannel?.addEventListener("message", ({ data }) => {
  if (
    data?.type !== "presence" ||
    typeof data.tabId !== "string" ||
    data.tabId === tabId ||
    typeof data.updated_at !== "number" ||
    !Array.isArray(data.watches)
  ) {
    return;
  }
  const watches = data.watches.filter(
    (watch: unknown): watch is CodexWatch =>
      watch != null &&
      typeof watch === "object" &&
      ["account_id", "project_id", "path", "thread_id"].every(
        (key) => typeof (watch as Record<string, unknown>)[key] === "string",
      ),
  );
  remotePresence.set(data.tabId, {
    updated_at: data.updated_at,
    watches,
  });
});

export function registerDirectlyWatchedCodexThread(
  opts: CodexWatch & { active: boolean },
): () => void {
  ensureInteractionListeners();
  const key = Symbol("codex-watch");
  if (opts.active) {
    leases.set(key, {
      account_id: opts.account_id,
      project_id: opts.project_id,
      path: opts.path,
      thread_id: opts.thread_id,
    });
  }
  updateHeartbeat();
  broadcastPresence();
  return () => {
    leases.delete(key);
    updateHeartbeat();
    broadcastPresence();
  };
}

export function isDirectlyWatchingCodexThread(opts: CodexWatch): boolean {
  const now = Date.now();
  if (activeLocalWatches(now).some((watch) => sameWatch(watch, opts))) {
    return true;
  }
  for (const [remoteTabId, presence] of remotePresence) {
    if (now - presence.updated_at > REMOTE_LEASE_MS) {
      remotePresence.delete(remoteTabId);
      continue;
    }
    if (presence.watches.some((watch) => sameWatch(watch, opts))) {
      return true;
    }
  }
  return false;
}

export const __test__ = {
  clear() {
    leases.clear();
    remotePresence.clear();
    lastInteractionAt = Date.now();
    updateHeartbeat();
  },
  setLastInteractionAt(value: number) {
    lastInteractionAt = value;
  },
  setRemotePresence(
    remoteTabId: string,
    presence: { updated_at: number; watches: CodexWatch[] },
  ) {
    remotePresence.set(remoteTabId, presence);
  },
};
