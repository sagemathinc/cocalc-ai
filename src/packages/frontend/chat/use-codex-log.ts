import { delay } from "awaiting";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LRUCache from "lru-cache";
import { appendStreamMessage } from "@cocalc/chat";
import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";
import type { DStream } from "@cocalc/conat/sync/dstream";
import {
  acquireSharedProjectDStream,
  type SharedProjectDStreamRelease,
} from "@cocalc/frontend/conat/project-dstream";
import type { RegisteredReconnectResource } from "@cocalc/frontend/conat/reconnect-coordinator";
import { webapp_client } from "@cocalc/frontend/webapp-client";

// Backend batches live ACP log pubsub at 100ms and AKV persistence at 250ms in
// lite/hub/acp.ts. We delay the initial AKV fetch to let the first persisted
// batch land, so mid-turn openings still see early events. If the backend
// cadence changes, update this constant too.
const LOG_PERSIST_THROTTLE_MS = 250;
const LIVE_LOG_FLUSH_MS = 100;
const RECENT_LOG_CACHE_SIZE = 5;
const RECONNECT_DEBUG_GLOBAL = "__cocalc_syncdoc_reconnect_debug";
const RECONNECT_DEBUG_LOCAL_STORAGE = "cocalc.debug.syncdoc_reconnect";

const recentLogCache = new LRUCache<string, any[]>({
  max: RECENT_LOG_CACHE_SIZE,
});

export interface CodexLogOptions {
  projectId?: string;
  logStore?: string | null;
  logKey?: string | null;
  logSubject?: string | null;
  liveLogStream?: string | null;
  generating?: boolean;
  enabled?: boolean;
}

export interface CodexLogResult {
  events: any[] | null | undefined;
  hasLogRef: boolean;
  deleteLog: () => Promise<void>;
  liveStatus: CodexLiveLogStatus;
}

export type CodexLiveLogStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

function recentLogCacheKey({
  projectId,
  logStore,
  logKey,
  liveLogStream,
  generating,
}: {
  projectId?: string;
  logStore?: string | null;
  logKey?: string | null;
  liveLogStream?: string | null;
  generating?: boolean;
}): string | undefined {
  if (!projectId || !logStore || !logKey) return undefined;
  if (generating && liveLogStream) {
    return `${projectId}:${logStore}:${logKey}:${liveLogStream}`;
  }
  return `${projectId}:${logStore}:${logKey}`;
}

function recentLogCachePrefix({
  projectId,
  logStore,
  logKey,
}: {
  projectId?: string;
  logStore?: string | null;
  logKey?: string | null;
}): string | undefined {
  if (!projectId || !logStore || !logKey) return undefined;
  return `${projectId}:${logStore}:${logKey}`;
}

function getEventTime(evt: any): number | undefined {
  const value = evt?.time;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeIncomingLogPayload(payload: any): any[] {
  if (Array.isArray(payload)) {
    return payload.filter(Boolean);
  }
  return payload ? [payload] : [];
}

function normalizeLiveStreamEvent(event: AcpStreamMessage): AcpStreamMessage {
  if (getEventTime(event) != null) {
    return event;
  }
  return {
    ...event,
    time: Date.now(),
  };
}

function normalizeLiveStreamPayload(
  payload: AcpStreamMessage | AcpStreamMessage[] | null | undefined,
): AcpStreamMessage[] {
  return normalizeIncomingLogPayload(payload).map(normalizeLiveStreamEvent);
}

function isDStreamLiveConnected(stream: DStream<any>): boolean {
  return (
    typeof stream.getRecoveryState !== "function" ||
    stream.getRecoveryState() === "ready"
  );
}

function getDStreamDebugState(stream: DStream<any> | null | undefined): {
  kind: string;
  recoveryState?: string;
  length?: number;
} {
  if (stream == null) {
    return { kind: "none" };
  }
  try {
    let length: number | undefined;
    try {
      length = stream.length;
    } catch {
      length = undefined;
    }
    return {
      kind: "dstream",
      recoveryState:
        typeof stream.getRecoveryState === "function"
          ? stream.getRecoveryState()
          : undefined,
      length,
    };
  } catch (err) {
    return { kind: "error", recoveryState: `${err}` };
  }
}

function shouldLogReconnectDebug(): boolean {
  if (typeof window === "undefined") return false;
  const state = (window as any)[RECONNECT_DEBUG_GLOBAL];
  if (state?.console === true) return true;
  try {
    return window.localStorage.getItem(RECONNECT_DEBUG_LOCAL_STORAGE) === "1";
  } catch {
    return false;
  }
}

function recordCodexActivityReconnectDebug(event: {
  [key: string]: any;
}): void {
  if (typeof window === "undefined") return;
  const w = window as any;
  const state = (w[RECONNECT_DEBUG_GLOBAL] ??= {
    events: [],
    console: false,
    clear() {
      this.events.length = 0;
    },
    print(limit = 80) {
      console.table(this.events.slice(-limit));
    },
  });
  const entry = {
    time: new Date().toISOString(),
    now: performance.now(),
    ...event,
  };
  state.events.push(entry);
  if (state.events.length > 1000) {
    state.events.splice(0, state.events.length - 1000);
  }
  if (shouldLogReconnectDebug()) {
    console.info("[codex activity reconnect]", entry);
  }
}

/**
 * Fetch Codex/ACP logs from AKV and live stream from conat during generation.
 * Resets state when the log key changes so logs don't bleed across turns.
 */
export function useCodexLog({
  projectId,
  logStore,
  logKey,
  logSubject,
  liveLogStream,
  generating,
  enabled = true,
}: CodexLogOptions): CodexLogResult {
  const hasLogRef = Boolean(logStore && logKey);
  const cacheKey = recentLogCacheKey({
    projectId,
    logStore,
    logKey,
    liveLogStream,
    generating,
  });
  const cachePrefix = recentLogCachePrefix({
    projectId,
    logStore,
    logKey,
  });

  const [fetchedLog, setFetchedLog] = useState<any[] | null>(() => {
    if (!cacheKey) return null;
    return recentLogCache.get(cacheKey) ?? null;
  });
  const [akvLoaded, setAkvLoaded] = useState<boolean>(false);
  const [liveLog, setLiveLog] = useState<any[]>(() => {
    if (!cacheKey) return [];
    return recentLogCache.get(cacheKey) ?? [];
  });
  const [liveStatus, setLiveStatus] = useState<CodexLiveLogStatus>("idle");
  const [liveReconnectToken, setLiveReconnectToken] = useState(0);
  const liveBufferRef = useRef<any[]>([]);
  const liveFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveConnectedRef = useRef<boolean>(false);
  const liveStreamRef = useRef<DStream<
    AcpStreamMessage | AcpStreamMessage[]
  > | null>(null);
  const reconnectResourceRef = useRef<RegisteredReconnectResource | null>(null);
  const mountedRef = useRef<boolean>(true);
  const hasLiveSource =
    generating === true && Boolean(projectId && (liveLogStream || logSubject));
  const canReconnectLive =
    enabled === true &&
    Boolean(projectId) &&
    Boolean(liveLogStream || logSubject);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setLiveConnectionState = useCallback(
    (connected: boolean, status: CodexLiveLogStatus) => {
      liveConnectedRef.current = connected;
      if (mountedRef.current) {
        setLiveStatus(status);
      }
    },
    [],
  );
  const recordActivityDebug = useCallback(
    (event: { [key: string]: any }) => {
      recordCodexActivityReconnectDebug({
        projectId,
        logStore,
        logKey,
        liveLogStream,
        stream: getDStreamDebugState(liveStreamRef.current),
        ...event,
      });
    },
    [projectId, logStore, logKey, liveLogStream],
  );

  const mergeLogs = useMemo(() => {
    return (a: any[] | null, b: any[]): any[] => {
      const combined = [...(a ?? []), ...b];
      if (combined.length === 0) return combined;
      const seen = new Map<number | string, any>();
      const withoutSeq: any[] = [];
      for (const evt of combined) {
        const key =
          typeof evt?.seq === "number" || typeof evt?.seq === "string"
            ? evt.seq
            : undefined;
        if (key === undefined) {
          withoutSeq.push(evt);
          continue;
        }
        const prev = seen.get(key);
        if (prev == null) {
          seen.set(key, evt);
        } else if (getEventTime(prev) == null && getEventTime(evt) != null) {
          seen.set(key, { ...prev, time: getEventTime(evt) });
        } else {
          seen.set(key, evt);
        }
      }
      const ordered = Array.from(seen.values());
      ordered.sort((x, y) => {
        const sx = x?.seq;
        const sy = y?.seq;
        if (typeof sx === "number" && typeof sy === "number") return sx - sy;
        if (typeof sx === "string" && typeof sy === "string")
          return sx.localeCompare(sy);
        return 0;
      });
      let normalized = withoutSeq.slice();
      for (const evt of ordered) {
        normalized = appendStreamMessage(normalized, evt);
      }
      return normalized;
    };
  }, []);

  // Reset when log ref changes.
  useEffect(() => {
    if (cacheKey) {
      const cached = recentLogCache.get(cacheKey);
      setFetchedLog(cached ?? null);
      setLiveLog(cached ?? []);
      liveBufferRef.current = [];
      if (liveFlushTimerRef.current != null) {
        clearTimeout(liveFlushTimerRef.current);
        liveFlushTimerRef.current = null;
      }
      // Cached data may be partial (e.g., captured mid-turn before AKV persist).
      // Force at least one AKV fetch for each key to backfill missing early events.
      setAkvLoaded(false);
    } else {
      setFetchedLog(null);
      setLiveLog([]);
      liveBufferRef.current = [];
      if (liveFlushTimerRef.current != null) {
        clearTimeout(liveFlushTimerRef.current);
        liveFlushTimerRef.current = null;
      }
      setAkvLoaded(false);
    }
  }, [cacheKey, logSubject]);

  const fetchPersistedLog = useCallback(
    async ({
      allowDuringGeneration = false,
    }: { allowDuringGeneration?: boolean } = {}): Promise<
      any[] | null | undefined
    > => {
      if (!enabled || !hasLogRef || !projectId || !logStore || !logKey) {
        return undefined;
      }
      if (!allowDuringGeneration && generating && liveLogStream) {
        return undefined;
      }
      const cn = await webapp_client.conat_client.projectConat({
        project_id: projectId,
        caller: "useCodexLog.fetchPersistedLog",
      });
      const kv = cn.sync.akv<any[]>({
        project_id: projectId,
        name: logStore,
      });
      return await kv.get(logKey);
    },
    [
      enabled,
      generating,
      hasLogRef,
      liveLogStream,
      logKey,
      logStore,
      projectId,
    ],
  );

  // Load from AKV once per key.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function fetchLog() {
      if (!enabled || !hasLogRef || !projectId || akvLoaded) {
        return;
      }
      try {
        const data = await fetchPersistedLog();
        if (!cancelled) {
          // If the log has not yet been persisted, leave fetchedLog as null so
          // we will retry (immediately below and on the delayed retry).
          if (data == null) {
            if (!generating) {
              setAkvLoaded(true);
            }
            return;
          }
          setFetchedLog(data);
          setAkvLoaded(true);
        }
        // console.log(data);
      } catch (err) {
        console.warn("failed to fetch acp log", err);
      }
    }
    void fetchLog();
    if (!generating || liveLogStream) return;
    // Also delay and call again to let the throttled writer persist the first batch.
    timer = setTimeout(fetchLog, LOG_PERSIST_THROTTLE_MS + 500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    hasLogRef,
    projectId,
    logStore,
    logKey,
    enabled,
    fetchPersistedLog,
    akvLoaded,
    generating,
    liveLogStream,
  ]);

  const waitForLiveReconnect = useCallback(async () => {
    if (!canReconnectLive || !hasLiveSource) {
      return;
    }
    const started = Date.now();
    while (mountedRef.current && canReconnectLive && hasLiveSource) {
      if (liveConnectedRef.current) {
        return;
      }
      if (Date.now() - started > 30_000) {
        setLiveConnectionState(false, "error");
        throw Error("timed out waiting for codex log reconnect");
      }
      await delay(100);
    }
  }, [canReconnectLive, hasLiveSource, setLiveConnectionState]);

  useEffect(() => {
    if (!canReconnectLive) {
      reconnectResourceRef.current?.close();
      reconnectResourceRef.current = null;
      setLiveConnectionState(false, "idle");
      return;
    }
    reconnectResourceRef.current?.close();
    reconnectResourceRef.current =
      webapp_client.conat_client.registerReconnectResource({
        canReconnect: () => canReconnectLive,
        isConnected: () => !hasLiveSource || liveConnectedRef.current,
        priority: () => "foreground",
        reconnect: async () => {
          const started = Date.now();
          recordActivityDebug({ event: "codex_activity_reconnect_start" });
          setLiveConnectionState(false, "reconnecting");
          void fetchPersistedLog({
            allowDuringGeneration: true,
          })
            .then((persisted) => {
              if (mountedRef.current && persisted != null) {
                setFetchedLog(persisted);
                setAkvLoaded(true);
              }
              recordActivityDebug({
                event: "codex_activity_persisted_fetch_done",
                elapsedMs: Date.now() - started,
              });
            })
            .catch((err) => {
              recordActivityDebug({
                event: "codex_activity_persisted_fetch_error",
                elapsedMs: Date.now() - started,
                error: `${err}`,
              });
              console.warn("codex log reconnect fetch failed", err);
            });
          recordActivityDebug({
            event: "codex_activity_persisted_fetch_started",
          });
          if (!mountedRef.current || !hasLiveSource) {
            recordActivityDebug({
              event: "codex_activity_reconnect_skipped",
              elapsedMs: Date.now() - started,
            });
            return;
          }
          const liveStream = liveStreamRef.current;
          if (liveStream != null && !isDStreamLiveConnected(liveStream)) {
            try {
              recordActivityDebug({
                event: "codex_activity_recover_start",
              });
              await liveStream.recoverNow({
                priority: "foreground",
                reason: "codex_log_reconnect",
              });
              recordActivityDebug({
                event: "codex_activity_recover_done",
              });
            } catch (err) {
              recordActivityDebug({
                event: "codex_activity_recover_error",
                error: `${err}`,
              });
              console.warn("codex log stream recovery failed", err);
            }
          }
          if (liveConnectedRef.current) {
            recordActivityDebug({
              event: "codex_activity_reconnect_done",
              elapsedMs: Date.now() - started,
            });
            return;
          }
          setLiveReconnectToken((n) => n + 1);
          await waitForLiveReconnect();
          recordActivityDebug({
            event: "codex_activity_reconnect_done",
            elapsedMs: Date.now() - started,
          });
        },
      });
    return () => {
      reconnectResourceRef.current?.close();
      reconnectResourceRef.current = null;
    };
  }, [
    canReconnectLive,
    fetchPersistedLog,
    hasLiveSource,
    recordActivityDebug,
    setLiveConnectionState,
    waitForLiveReconnect,
  ]);

  useEffect(() => {
    if (!canReconnectLive) {
      setLiveConnectionState(false, "idle");
      return;
    }
    const handleDisconnected = () => {
      recordActivityDebug({ event: "codex_activity_transport_disconnected" });
      setLiveConnectionState(false, "reconnecting");
      reconnectResourceRef.current?.requestReconnect({
        reason: "codex_log_disconnected",
      });
    };
    webapp_client.conat_client.on("disconnected", handleDisconnected);
    return () => {
      webapp_client.conat_client.off("disconnected", handleDisconnected);
    };
  }, [canReconnectLive, recordActivityDebug, setLiveConnectionState]);

  // Subscribe to live events while generating.
  useEffect(() => {
    let sub: any;
    let liveStream: DStream<AcpStreamMessage | AcpStreamMessage[]> | undefined;
    let releaseLiveStream: SharedProjectDStreamRelease | undefined;
    let liveStreamListener:
      | ((event: AcpStreamMessage | AcpStreamMessage[], seq?: number) => void)
      | undefined;
    let liveStreamDisconnected: (() => void) | undefined;
    let liveStreamRecovered: (() => void) | undefined;
    let stopped = false;
    const flushBufferedLiveLog = () => {
      if (liveFlushTimerRef.current != null) {
        clearTimeout(liveFlushTimerRef.current);
        liveFlushTimerRef.current = null;
      }
      const pending = liveBufferRef.current;
      if (!pending.length) return;
      liveBufferRef.current = [];
      setLiveLog((prev) => mergeLogs(prev ?? [], pending));
    };
    const scheduleBufferedFlush = (immediate: boolean = false) => {
      if (immediate) {
        flushBufferedLiveLog();
        return;
      }
      if (liveFlushTimerRef.current != null) return;
      liveFlushTimerRef.current = setTimeout(
        flushBufferedLiveLog,
        LIVE_LOG_FLUSH_MS,
      );
    };
    async function subscribe() {
      if (!enabled || !generating || !projectId) {
        setLiveConnectionState(false, "idle");
        return;
      }
      setLiveConnectionState(false, "connecting");
      recordActivityDebug({ event: "codex_activity_subscribe_start" });
      try {
        if (liveLogStream) {
          const lease = await acquireSharedProjectDStream<AcpStreamMessage>({
            project_id: projectId,
            name: liveLogStream,
            ephemeral: true,
            maxListeners: 50,
            initPhaseReporter: (phase, details) => {
              recordActivityDebug({
                event: "codex_activity_open_phase",
                phase,
                openElapsedMs: details?.component_elapsed_ms,
                payload: { phase, ...(details ?? {}) },
              });
            },
          });
          liveStream = lease.stream;
          liveStreamRef.current = liveStream;
          releaseLiveStream = lease.release;
          if (stopped) {
            await releaseLiveStream({ immediate: true });
            return;
          }
          const streamConnected = isDStreamLiveConnected(liveStream);
          recordActivityDebug({
            event: "codex_activity_subscribe_acquired",
            connected: streamConnected,
          });
          setLiveConnectionState(
            streamConnected,
            streamConnected ? "connected" : "reconnecting",
          );
          if (!streamConnected) {
            reconnectResourceRef.current?.requestReconnect({
              reason: "codex_log_stream_not_ready",
            });
          }
          liveStreamDisconnected = () => {
            if (stopped) return;
            recordActivityDebug({
              event: "codex_activity_stream_disconnected",
            });
            setLiveConnectionState(false, "reconnecting");
            reconnectResourceRef.current?.requestReconnect({
              reason: "codex_log_stream_disconnected",
            });
          };
          liveStreamRecovered = () => {
            if (stopped) return;
            recordActivityDebug({ event: "codex_activity_stream_recovered" });
            setLiveConnectionState(true, "connected");
          };
          liveStream.on("disconnected", liveStreamDisconnected);
          liveStream.on("recovering", liveStreamDisconnected);
          liveStream.on("paused", liveStreamDisconnected);
          liveStream.on("recovered", liveStreamRecovered);
          liveStream.setMaxListeners(
            Math.max(liveStream.getMaxListeners(), 50),
          );
          liveStreamListener = (
            payload: AcpStreamMessage | AcpStreamMessage[],
          ) => {
            if (stopped) return;
            const events = normalizeLiveStreamPayload(payload);
            if (events.length === 0) return;
            let immediate = false;
            for (const evt of events) {
              liveBufferRef.current.push(evt);
              if (
                evt.type === "summary" ||
                evt.type === "error" ||
                evt.type === "status"
              ) {
                immediate = true;
              }
            }
            scheduleBufferedFlush(immediate);
          };
          // DStream already bridges the backlog/live-update race internally.
          // Register the listener before reading getAll() so local hook state
          // can't miss a late event that arrives between these two steps.
          liveStream.on("change", liveStreamListener);
          const initial = liveStream
            .getAll()
            .flatMap((payload) => normalizeLiveStreamPayload(payload as any));
          if (!stopped && initial.length > 0) {
            setLiveLog((prev) => mergeLogs(prev ?? [], initial));
          }
          recordActivityDebug({
            event: "codex_activity_subscribe_done",
            initialEvents: initial.length,
          });
          return;
        }
        if (!logSubject) {
          setLiveConnectionState(false, "idle");
          return;
        }
        const cn = await webapp_client.conat_client.projectConat({
          project_id: projectId,
          caller: "useCodexLog.subscribe",
        });
        sub = await cn.subscribe(logSubject);
        setLiveConnectionState(true, "connected");
        recordActivityDebug({ event: "codex_activity_subscribe_done" });
        for await (const mesg of sub) {
          if (stopped) break;
          const payload = normalizeIncomingLogPayload(mesg?.data);
          if (payload.length === 0) continue;
          let immediate = false;
          for (const evt of payload) {
            const withTime =
              getEventTime(evt) == null ? { ...evt, time: Date.now() } : evt;
            liveBufferRef.current.push(withTime);
            if (withTime.type === "summary" || withTime.type === "error") {
              immediate = true;
            }
          }
          scheduleBufferedFlush(immediate);
        }
        if (!stopped) {
          setLiveConnectionState(false, "reconnecting");
          reconnectResourceRef.current?.requestReconnect({
            reason: "codex_log_subscription_closed",
          });
        }
      } catch (err) {
        recordActivityDebug({
          event: "codex_activity_subscribe_error",
          error: `${err}`,
        });
        setLiveConnectionState(false, "reconnecting");
        try {
          if (liveStream && liveStreamListener) {
            liveStream.off("change", liveStreamListener);
          }
        } catch {
          // ignore
        }
        void releaseLiveStream?.({ immediate: true });
        console.warn("live log subscribe failed", err);
        if (!stopped) {
          reconnectResourceRef.current?.requestReconnect({
            reason: "codex_log_subscribe_failed",
          });
        }
      }
    }
    void subscribe();
    return () => {
      stopped = true;
      liveConnectedRef.current = false;
      if (liveStreamRef.current === liveStream) {
        liveStreamRef.current = null;
      }
      if (liveFlushTimerRef.current != null) {
        clearTimeout(liveFlushTimerRef.current);
        liveFlushTimerRef.current = null;
      }
      liveBufferRef.current = [];
      try {
        sub?.close?.();
      } catch {
        // ignore
      }
      try {
        if (liveStream && liveStreamListener) {
          liveStream.off("change", liveStreamListener);
        }
        if (liveStream && liveStreamDisconnected) {
          liveStream.off("disconnected", liveStreamDisconnected);
          liveStream.off("recovering", liveStreamDisconnected);
          liveStream.off("paused", liveStreamDisconnected);
        }
        if (liveStream && liveStreamRecovered) {
          liveStream.off("recovered", liveStreamRecovered);
        }
      } catch {
        // ignore
      }
      void releaseLiveStream?.();
    };
  }, [
    enabled,
    generating,
    liveReconnectToken,
    projectId,
    liveLogStream,
    logSubject,
    mergeLogs,
    recordActivityDebug,
    setLiveConnectionState,
  ]);

  const events = useMemo(() => {
    if (!hasLogRef) return generating ? liveLog : undefined;
    // Merge fetched + live, preserving order by seq and de-duplicating.
    const merged = mergeLogs(fetchedLog, liveLog);
    if (merged.length > 0) return merged;
    return generating ? liveLog : fetchedLog;
  }, [hasLogRef, fetchedLog, liveLog, generating, mergeLogs]);

  useEffect(() => {
    if (!cacheKey || !events || !events.length) return;
    recentLogCache.set(cacheKey, events);
  }, [cacheKey, events]);

  const deleteLog = async () => {
    if (!hasLogRef || !projectId || !logStore || !logKey) return;
    try {
      const cn = await webapp_client.conat_client.projectConat({
        project_id: projectId,
        caller: "useCodexLog.deleteLog",
      });
      const kv = cn.sync.akv({ project_id: projectId, name: logStore });
      await kv.delete(logKey);
    } catch (err) {
      console.warn("failed to delete acp log", err);
    }
    if (cachePrefix) {
      for (const key of recentLogCache.keys()) {
        if (key === cachePrefix || key.startsWith(`${cachePrefix}:`)) {
          recentLogCache.delete(key);
        }
      }
    }
    setFetchedLog(null);
    setLiveLog([]);
  };

  return { events, hasLogRef, deleteLog, liveStatus };
}
