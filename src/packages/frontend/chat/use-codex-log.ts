import { useEffect, useMemo, useState } from "react";
import LRUCache from "lru-cache";
import { appendStreamMessage } from "@cocalc/chat";
import { webapp_client } from "@cocalc/frontend/webapp-client";

// Backend throttles AKV persistence in lite/hub/acp.ts via lodash.throttle
// with {leading:true, trailing:true, wait:1000}. We delay the initial AKV
// fetch to let the first batch land, so mid-turn openings still see early
// events. If the throttle changes, update this constant too.
const LOG_PERSIST_THROTTLE_MS = 1000;
const RECENT_LOG_CACHE_SIZE = 5;

const recentLogCache = new LRUCache<string, any[]>({
  max: RECENT_LOG_CACHE_SIZE,
});

export interface CodexLogOptions {
  projectId?: string;
  logStore?: string | null;
  logKey?: string | null;
  logSubject?: string | null;
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
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  generating,
  enabled = true,
}: CodexLogOptions): CodexLogResult {
  const hasLogRef = Boolean(logStore && logKey);
  const cacheKey = recentLogCacheKey({ projectId, logStore, logKey });

  const [fetchedLog, setFetchedLog] = useState<any[] | null>(() => {
    if (!cacheKey) return null;
    return recentLogCache.get(cacheKey) ?? null;
  });
  const [liveLog, setLiveLog] = useState<any[]>(() => {
    if (!cacheKey) return [];
    return recentLogCache.get(cacheKey) ?? [];
  });

  const mergeLogs = useMemo(() => {
    return (a: any[] | null, b: any[]): any[] => {
      const combined = [...(a ?? []), ...b];
      if (combined.length === 0) return combined;
      const seen = new Map<number | string, any>();
      for (const evt of combined) {
        const key =
          typeof evt?.seq === "number" || typeof evt?.seq === "string"
            ? evt.seq
            : undefined;
        if (key === undefined) {
          // no seq — append with synthetic key
          seen.set(`no-seq-${seen.size}`, evt);
          continue;
        }
        const prev = seen.get(key);
        if (prev == null) {
          seen.set(key, evt);
        } else if (getEventTime(prev) == null && getEventTime(evt) != null) {
          seen.set(key, { ...prev, time: getEventTime(evt) });
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
      return ordered;
    };
  }, []);

  // Reset when log ref changes.
  useEffect(() => {
    if (cacheKey) {
      const cached = recentLogCache.get(cacheKey);
      setFetchedLog(cached ?? null);
      setLiveLog(cached ?? []);
    } else {
      setFetchedLog(null);
      setLiveLog([]);
    }
  }, [cacheKey, logSubject]);

  // Load from AKV once per key.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function fetchLog() {
      if (!enabled || !hasLogRef || !projectId || fetchedLog != null) return;
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
            return;
          }
          setFetchedLog(data);
        }
        // console.log(data);
      } catch (err) {
        console.warn("failed to fetch acp log", err);
      }
    }
    void fetchLog();
    if (!generating) return;
    // Also delay and call again to let the throttled writer persist the first batch.
    timer = setTimeout(fetchLog, LOG_PERSIST_THROTTLE_MS + 500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasLogRef, projectId, logStore, logKey, fetchedLog, enabled]);

  // Subscribe to live events while generating.
  useEffect(() => {
    let sub: any;
    let stopped = false;
    async function subscribe() {
      if (!enabled || !logSubject) return;
      try {
        const cn = webapp_client.conat_client.conat();
        sub = await cn.subscribe(logSubject);
        for await (const mesg of sub) {
          if (stopped) break;
          const evt = mesg?.data;
          //console.log("sub got ", evt);
          if (!evt) continue;
          const withTime =
            getEventTime(evt) == null ? { ...evt, time: Date.now() } : evt;
          setLiveLog((prev) => appendStreamMessage(prev ?? [], withTime));
        }
      } catch (err) {
        console.warn("live log subscribe failed", err);
      }
    }
    void subscribe();
    return () => {
      stopped = true;
      try {
        sub?.close?.();
      } catch {
        // ignore
      }
    };
  }, [enabled, generating, logSubject]);

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
