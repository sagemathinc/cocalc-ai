import { useEffect, useMemo, useRef, useState } from "react";
import LRUCache from "lru-cache";
import { appendStreamMessage } from "@cocalc/chat";
import { webapp_client } from "@cocalc/frontend/webapp-client";

// Backend batches live ACP log pubsub at 100ms and AKV persistence at 250ms in
// lite/hub/acp.ts. We delay the initial AKV fetch to let the first persisted
// batch land, so mid-turn openings still see early events. If the backend
// cadence changes, update this constant too.
const LOG_PERSIST_THROTTLE_MS = 250;
const LIVE_LOG_FLUSH_MS = 100;
const RECENT_LOG_CACHE_SIZE = 5;

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
}

function recentLogCacheKey({
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
  const cacheKey = recentLogCacheKey({ projectId, logStore, logKey });

  const [fetchedLog, setFetchedLog] = useState<any[] | null>(() => {
    if (!cacheKey) return null;
    return recentLogCache.get(cacheKey) ?? null;
  });
  const [akvLoaded, setAkvLoaded] = useState<boolean>(false);
  const [liveLog, setLiveLog] = useState<any[]>(() => {
    if (!cacheKey) return [];
    return recentLogCache.get(cacheKey) ?? [];
  });
  const liveBufferRef = useRef<any[]>([]);
  const liveFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Load from AKV once per key.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function fetchLog() {
      if (
        !enabled ||
        !hasLogRef ||
        !projectId ||
        akvLoaded ||
        (generating && liveLogStream)
      ) {
        return;
      }
      try {
        const cn = webapp_client.conat_client.conat();
        const kv = cn.sync.akv<any[]>({
          project_id: projectId,
          name: logStore!,
        });
        const data = await kv.get(logKey!);
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
    akvLoaded,
    generating,
    liveLogStream,
  ]);

  // Subscribe to live events while generating.
  useEffect(() => {
    let sub: any;
    let liveStream: any;
    let stopped = false;
    const flushBufferedLiveLog = () => {
      if (liveFlushTimerRef.current != null) {
        clearTimeout(liveFlushTimerRef.current);
        liveFlushTimerRef.current = null;
      }
      const pending = liveBufferRef.current;
      if (!pending.length) return;
      liveBufferRef.current = [];
      setLiveLog((prev) => {
        let next = prev ?? [];
        for (const evt of pending) {
          next = appendStreamMessage(next, evt);
        }
        return next;
      });
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
      if (!enabled || !generating || !projectId) return;
      try {
        const cn = webapp_client.conat_client.conat();
        if (liveLogStream) {
          liveStream = cn.sync.astream({
            project_id: projectId,
            name: liveLogStream,
            ephemeral: true,
          });
          const initial: any[] = [];
          for await (const { mesg, seq, time } of liveStream.getAll()) {
            const evt =
              getEventTime(mesg) == null
                ? { ...mesg, seq: mesg?.seq ?? seq, time }
                : mesg;
            initial.push(evt);
          }
          if (!stopped && initial.length > 0) {
            setLiveLog((prev) => mergeLogs(prev ?? [], initial));
          }
          sub = await liveStream.changefeed();
          for await (const batch of sub) {
            if (stopped) break;
            let immediate = false;
            for (const update of batch ?? []) {
              if (update?.op !== "set" || update?.mesg == null) continue;
              const evt =
                getEventTime(update.mesg) == null
                  ? {
                      ...update.mesg,
                      seq: update.mesg?.seq ?? update.seq,
                      time: update.time,
                    }
                  : update.mesg;
              liveBufferRef.current.push(evt);
              if (evt.type === "summary" || evt.type === "error") {
                immediate = true;
              }
            }
            scheduleBufferedFlush(immediate);
          }
          return;
        }
        if (!logSubject) return;
        sub = await cn.subscribe(logSubject);
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
      } catch (err) {
        console.warn("live log subscribe failed", err);
      }
    }
    void subscribe();
    return () => {
      stopped = true;
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
        liveStream?.close?.();
      } catch {
        // ignore
      }
    };
  }, [enabled, generating, projectId, liveLogStream, logSubject, mergeLogs]);

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
      const cn = webapp_client.conat_client.conat();
      const kv = cn.sync.akv({ project_id: projectId, name: logStore });
      await kv.delete(logKey);
    } catch (err) {
      console.warn("failed to delete acp log", err);
    }
    if (cacheKey) {
      recentLogCache.delete(cacheKey);
    }
    setFetchedLog(null);
    setLiveLog([]);
  };

  return { events, hasLogRef, deleteLog };
}
