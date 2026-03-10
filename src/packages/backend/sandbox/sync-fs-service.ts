import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { readFile, stat } from "node:fs/promises";
import { EventEmitter } from "events";
import { dirname } from "path";
import { createHash } from "node:crypto";
import { SyncFsWatchStore, type ExternalChange } from "./sync-fs-watch";
import { AStream } from "@cocalc/conat/sync/astream";
import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import { conat } from "@cocalc/backend/conat/conat";
import { client_db } from "@cocalc/util/db-schema/client-db";
import {
  createDbCodec,
  createImmerDbCodec,
  type DocCodec,
} from "@cocalc/sync/patchflow";
import { type SyncDoc } from "@cocalc/sync";
import {
  comparePatchId,
  decodePatchId,
  encodePatchId,
  legacyPatchId,
  makeClientId,
  type PatchId,
} from "patchflow";
import { trackBackendWatcher } from "../watcher-debug";
import getLogger from "@cocalc/backend/logger";

export interface WatchEvent {
  path: string;
  type: "change" | "delete";
  change?: ExternalChange;
}

export interface WatchMeta {
  project_id?: string;
  syncPath?: string;
  string_id?: string;
  history_epoch?: number;
  owner_id?: string;
  turn_id?: string;
  doctype?: {
    type?: string;
    patch_format?: number;
    opts?: Record<string, unknown>;
  };
}

interface WatchEntry {
  watcher: FSWatcher;
  paths: Set<string>;
  stopTrackingWatcher?: () => void;
}

type PathState = {
  dir: string;
  lastHeartbeat: number;
  createdAt: number;
  meta?: WatchMeta;
  string_id?: string;
};

type ReleaseRecord = {
  at: number;
  path: string;
  reason: string;
  string_id?: string;
  ageMs: number;
};

export type SyncFsServiceOptions = {
  heartbeatTtlMs?: number;
  pruneIntervalMs?: number;
  maxActivePaths?: number;
};

const logger = getLogger("sandbox:sync-fs-service");

const DEFAULT_HEARTBEAT_TTL_MS = 60_000;
const DEFAULT_MAX_ACTIVE_PATHS = 256;
const MAX_RECENT_RELEASES = 32;
const DEBOUNCE_MS = 250; // coalesce rapid events
const SUPPRESS_TTL_MS = 5_000; // suppress self-inflicted fs events briefly

type StreamInfo = {
  heads: Set<PatchId>;
  maxVersion: number;
  maxTimeMs: number;
  lastSeq?: number;
};

type SuppressWriteMarker = {
  timer: NodeJS.Timeout;
  hash: string;
  until: number;
};

type SyncFsReasonCounters = {
  [reason: string]: number;
};

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value == null || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const activeServices = new Set<SyncFsService>();

function topEntries<T>(
  items: Iterable<T>,
  limit: number,
  getValue: (item: T) => number,
): T[] {
  return [...items]
    .sort((left, right) => getValue(right) - getValue(left))
    .slice(0, Math.max(1, limit));
}

export function getSyncFsDebugStats({
  topN = 8,
}: {
  topN?: number;
} = {}) {
  const services = [...activeServices];
  if (services.length === 0) {
    return {
      services: 0,
      activeDirs: 0,
      activePaths: 0,
      patchWriters: 0,
      streamInfoEntries: 0,
      debounceTimers: 0,
      suppressMarkers: 0,
      heartbeatTtlMs: 0,
      pruneIntervalMs: 0,
      maxActivePaths: 0,
      maxActivePathsObserved: 0,
      counters: {
        heartbeatActive: 0,
        heartbeatInactive: 0,
        watcherStarts: 0,
        watcherStops: 0,
        pathReleases: 0,
        stalePrunes: 0,
        capEvictions: 0,
      },
      releasesByReasonTop: [] as Array<{ reason: string; count: number }>,
      activePathsTop: [] as Array<{
        path: string;
        ageMs: number;
        idleMs: number;
        string_id?: string;
      }>,
      activeDirsTop: [] as Array<{ dir: string; paths: number }>,
      recentReleases: [] as ReleaseRecord[],
    };
  }
  if (services.length === 1) {
    return {
      services: 1,
      ...services[0].getDebugStats({ topN }),
    };
  }
  const reasonCounts = new Map<string, number>();
  const activePaths: Array<{
    path: string;
    ageMs: number;
    idleMs: number;
    string_id?: string;
  }> = [];
  const activeDirs = new Map<string, number>();
  const recentReleases: ReleaseRecord[] = [];
  let activePathCount = 0;
  let activeDirCount = 0;
  let patchWriters = 0;
  let streamInfoEntries = 0;
  let debounceTimers = 0;
  let suppressMarkers = 0;
  let heartbeatTtlMs = 0;
  let pruneIntervalMs = 0;
  let maxActivePaths = 0;
  let maxActivePathsObserved = 0;
  const counters = {
    heartbeatActive: 0,
    heartbeatInactive: 0,
    watcherStarts: 0,
    watcherStops: 0,
    pathReleases: 0,
    stalePrunes: 0,
    capEvictions: 0,
  };
  for (const service of services) {
    const stats = service.getDebugStats({ topN });
    activePathCount += stats.activePaths;
    activeDirCount += stats.activeDirs;
    patchWriters += stats.patchWriters;
    streamInfoEntries += stats.streamInfoEntries;
    debounceTimers += stats.debounceTimers;
    suppressMarkers += stats.suppressMarkers;
    heartbeatTtlMs = Math.max(heartbeatTtlMs, stats.heartbeatTtlMs);
    pruneIntervalMs = Math.max(pruneIntervalMs, stats.pruneIntervalMs);
    maxActivePaths = Math.max(maxActivePaths, stats.maxActivePaths);
    maxActivePathsObserved = Math.max(
      maxActivePathsObserved,
      stats.maxActivePathsObserved,
    );
    counters.heartbeatActive += stats.counters.heartbeatActive;
    counters.heartbeatInactive += stats.counters.heartbeatInactive;
    counters.watcherStarts += stats.counters.watcherStarts;
    counters.watcherStops += stats.counters.watcherStops;
    counters.pathReleases += stats.counters.pathReleases;
    counters.stalePrunes += stats.counters.stalePrunes;
    counters.capEvictions += stats.counters.capEvictions;
    for (const item of stats.releasesByReasonTop) {
      reasonCounts.set(
        item.reason,
        (reasonCounts.get(item.reason) ?? 0) + item.count,
      );
    }
    for (const item of stats.activePathsTop) {
      activePaths.push(item);
    }
    for (const item of stats.activeDirsTop) {
      activeDirs.set(item.dir, (activeDirs.get(item.dir) ?? 0) + item.paths);
    }
    recentReleases.push(...stats.recentReleases);
  }
  return {
    services: services.length,
    activeDirs: activeDirCount,
    activePaths: activePathCount,
    patchWriters,
    streamInfoEntries,
    debounceTimers,
    suppressMarkers,
    heartbeatTtlMs,
    pruneIntervalMs,
    maxActivePaths,
    maxActivePathsObserved,
    counters,
    releasesByReasonTop: Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, topN))
      .map(([reason, count]) => ({ reason, count })),
    activePathsTop: topEntries(activePaths, topN, (item) => item.ageMs),
    activeDirsTop: Array.from(activeDirs.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, topN))
      .map(([dir, paths]) => ({ dir, paths })),
    recentReleases: recentReleases
      .sort((left, right) => right.at - left.at)
      .slice(0, Math.max(1, topN)),
  };
}

/**
 * Centralized filesystem watcher that:
 * - Maintains a durable snapshot of last-on-disk content (via SyncFsWatchStore).
 * - Watches directories (not per-client) and emits a single normalized event per
 *   filesystem change.
 * - Heartbeats keep a watch alive; if nobody is interested, the watch is torn down.
 *
 * Consumers can subscribe to "event" and append resulting patches to patchflow.
 */
export class SyncFsService extends EventEmitter {
  private store: SyncFsWatchStore;
  private watchers: Map<string, WatchEntry> = new Map();
  private watcherInFlight: Map<string, Promise<WatchEntry>> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private pathStates: Map<string, PathState> = new Map();
  private patchWriters: Map<string, AStream<any>> = new Map();
  private streamInfo: Map<string, StreamInfo> = new Map();
  private suppressOnce: Map<string, SuppressWriteMarker> = new Map();
  private conatClient?: any;
  private readonly clientId: string;
  private readonly heartbeatTtlMs: number;
  private readonly pruneIntervalMs: number;
  private readonly maxActivePaths: number;
  private pruneTimer?: NodeJS.Timeout;
  private readonly counters = {
    heartbeatActive: 0,
    heartbeatInactive: 0,
    watcherStarts: 0,
    watcherStops: 0,
    pathReleases: 0,
    stalePrunes: 0,
    capEvictions: 0,
  };
  private readonly releasesByReason: SyncFsReasonCounters = {};
  private readonly recentReleases: ReleaseRecord[] = [];
  private maxActivePathsObserved = 0;

  constructor(store?: SyncFsWatchStore, opts?: SyncFsServiceOptions) {
    super();
    this.store = store ?? new SyncFsWatchStore();
    this.clientId = makeClientId();
    this.heartbeatTtlMs = Math.max(
      1_000,
      opts?.heartbeatTtlMs ??
        envNumber("COCALC_SYNC_FS_HEARTBEAT_TTL_MS", DEFAULT_HEARTBEAT_TTL_MS),
    );
    this.pruneIntervalMs = Math.max(
      1_000,
      opts?.pruneIntervalMs ??
        envNumber("COCALC_SYNC_FS_PRUNE_INTERVAL_MS", this.heartbeatTtlMs),
    );
    this.maxActivePaths = Math.max(
      1,
      opts?.maxActivePaths ??
        envNumber("COCALC_SYNC_FS_MAX_ACTIVE_PATHS", DEFAULT_MAX_ACTIVE_PATHS),
    );
    this.pruneTimer = setInterval(this.pruneStale, this.pruneIntervalMs);
    this.pruneTimer.unref?.();
    activeServices.add(this);
  }

  private sha256 = (content: string): string => {
    return createHash("sha256").update(content, "utf8").digest("hex");
  };

  private clearSuppress = (path: string): void => {
    const marker = this.suppressOnce.get(path);
    if (!marker) return;
    clearTimeout(marker.timer);
    this.suppressOnce.delete(path);
  };

  private normalizeMeta(path: string, meta?: WatchMeta): WatchMeta | undefined {
    if (meta == null) {
      return this.pathStates.get(path)?.meta;
    }
    const syncPath =
      typeof meta.syncPath === "string" && meta.syncPath.length > 0
        ? meta.syncPath
        : path;
    if (!meta.project_id) {
      return {
        ...meta,
        syncPath,
      };
    }
    return {
      ...meta,
      syncPath,
      // Canonical sync identity is derived from the canonical filesystem path,
      // never from caller-supplied ids.
      string_id: client_db.sha1(meta.project_id, syncPath),
    };
  }

  private canInitMeta(meta?: WatchMeta): meta is WatchMeta & {
    project_id: string;
    syncPath: string;
  } {
    return (
      typeof meta?.project_id === "string" &&
      meta.project_id.length > 0 &&
      typeof meta?.syncPath === "string" &&
      meta.syncPath.length > 0
    );
  }

  private syncStringId(meta: { project_id: string; syncPath: string }): string {
    return client_db.sha1(meta.project_id, meta.syncPath);
  }

  private shouldReinitializePath(
    existingState: PathState | undefined,
    nextMeta?: WatchMeta,
  ): boolean {
    if (!this.canInitMeta(nextMeta)) {
      return false;
    }
    const prevMeta = existingState?.meta;
    if (!this.canInitMeta(prevMeta)) {
      return true;
    }
    if (existingState?.string_id !== nextMeta.string_id) {
      return true;
    }
    if (prevMeta.project_id !== nextMeta.project_id) {
      return true;
    }
    if (prevMeta.syncPath !== nextMeta.syncPath) {
      return true;
    }
    if (prevMeta.doctype?.type !== nextMeta.doctype?.type) {
      return true;
    }
    if (prevMeta.doctype?.patch_format !== nextMeta.doctype?.patch_format) {
      return true;
    }
    return (
      JSON.stringify(prevMeta.doctype?.opts ?? null) !==
      JSON.stringify(nextMeta.doctype?.opts ?? null)
    );
  }

  private rememberRelease(record: ReleaseRecord): void {
    this.counters.pathReleases += 1;
    this.releasesByReason[record.reason] =
      (this.releasesByReason[record.reason] ?? 0) + 1;
    this.recentReleases.unshift(record);
    if (this.recentReleases.length > MAX_RECENT_RELEASES) {
      this.recentReleases.length = MAX_RECENT_RELEASES;
    }
  }

  private closeStreamState(string_id: string | undefined): void {
    if (!string_id) return;
    const writer = this.patchWriters.get(string_id);
    if (writer != null) {
      writer.close();
      this.patchWriters.delete(string_id);
    }
    this.streamInfo.delete(string_id);
  }

  private hasActivePathForStringId(
    string_id: string | undefined,
    excludePath?: string,
  ): boolean {
    if (!string_id) return false;
    for (const [path, state] of this.pathStates.entries()) {
      if (path === excludePath) continue;
      if (state.string_id === string_id) return true;
    }
    return false;
  }

  private closeWatcher(dir: string, reason: string): void {
    const entry = this.watchers.get(dir);
    if (!entry) return;
    entry.stopTrackingWatcher?.();
    entry.watcher.close();
    this.watchers.delete(dir);
    this.counters.watcherStops += 1;
    if (process.env.SYNC_FS_DEBUG) {
      logger.debug("sync-fs close watcher", {
        dir,
        reason,
        activeDirs: this.watchers.size,
        activePaths: this.pathStates.size,
      });
    }
  }

  private releasePath(path: string, reason: string): void {
    const state = this.pathStates.get(path);
    const dir = state?.dir ?? dirname(path);
    const existingEntry = this.watchers.get(dir);
    if (state == null && !existingEntry?.paths.has(path)) {
      return;
    }
    const string_id = state?.string_id;
    const createdAt = state?.createdAt ?? Date.now();
    this.pathStates.delete(path);
    this.clearSuppress(path);
    const timer = this.debounceTimers.get(path);
    if (timer != null) {
      clearTimeout(timer);
      this.debounceTimers.delete(path);
    }
    const entry = existingEntry ?? this.watchers.get(dir);
    if (entry != null) {
      entry.paths.delete(path);
      if (entry.paths.size === 0) {
        this.closeWatcher(dir, reason);
      }
    }
    if (!this.hasActivePathForStringId(string_id, path)) {
      this.closeStreamState(string_id);
    }
    this.rememberRelease({
      at: Date.now(),
      path,
      reason,
      string_id,
      ageMs: Math.max(0, Date.now() - createdAt),
    });
  }

  private enforceActivePathCap(preferredPath?: string): void {
    this.maxActivePathsObserved = Math.max(
      this.maxActivePathsObserved,
      this.pathStates.size,
    );
    if (this.pathStates.size <= this.maxActivePaths) return;
    const evicted: string[] = [];
    const candidates = [...this.pathStates.entries()]
      .filter(([path]) => path !== preferredPath)
      .sort((left, right) => left[1].lastHeartbeat - right[1].lastHeartbeat);
    for (const [path] of candidates) {
      if (this.pathStates.size <= this.maxActivePaths) break;
      this.counters.capEvictions += 1;
      evicted.push(path);
      this.releasePath(path, "cap");
    }
    if (evicted.length > 0) {
      logger.warn("sync-fs active path cap reached", {
        maxActivePaths: this.maxActivePaths,
        activePaths: this.pathStates.size,
        evicted: evicted.slice(0, 8),
      });
    }
  }

  private async initPath(path: string, meta?: WatchMeta): Promise<void> {
    if (!this.canInitMeta(meta)) return;
    const string_id = this.syncStringId(meta);
    const codec = this.resolveCodec(meta);
    try {
      // Always reconcile local snapshot state against the actual patch stream.
      // A cached filesystem snapshot may exist even when history is empty
      // (e.g. file written via backend API before watcher starts). In that
      // case we MUST force an empty baseline so opening the file publishes the
      // first patch; otherwise clients see an empty live document.
      const { heads, maxVersion, maxTimeMs } = await this.getStreamHeads({
        project_id: meta.project_id,
        string_id,
        path: meta.syncPath,
      });
      const hasHistory = heads.length > 0 || maxVersion > 0;
      if (hasHistory) {
        // Reconstruct the current document from the patch stream (respecting
        // snapshots) to avoid emitting orphaned/incorrect patches when the
        // local fs snapshot cache is stale.
        const current = await this.loadDocViaSyncDoc({
          project_id: meta.project_id,
          string_id,
          syncPath: meta.syncPath,
          doctype: meta.doctype,
        });
        if (current == null) {
          if (process.env.SYNC_FS_DEBUG) {
            console.log("sync-fs initPath: unable to load stream baseline", {
              path: meta.syncPath,
              string_id,
            });
          }
        } else {
          this.store.setContent(path, current);
        }
      } else {
        // Explicitly reset to an empty baseline when stream history is empty.
        // This prevents cached snapshots from suppressing the initial patch.
        this.store.setContent(path, "");
      }

      if (
        hasHistory &&
        !(await this.shouldReconcileDiskOnInit(path, maxTimeMs))
      ) {
        if (process.env.SYNC_FS_DEBUG) {
          console.log("sync-fs initPath: skip stale disk reconciliation", {
            path: meta.syncPath,
            string_id,
            maxTimeMs,
          });
        }
        return;
      }

      const change = await this.store.handleExternalChange(
        path,
        async () => (await readFile(path, "utf8")) as string,
        false,
        codec,
      );
      if (change.patch) {
        const payload: ExternalChange = { ...change, deleted: false };
        await this.appendPatch({ ...meta, string_id }, "change", payload);
      }
    } catch (err) {
      this.emit("error", err);
    }
  }

  close(): void {
    activeServices.delete(this);
    if (this.pruneTimer != null) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
    this.watcherInFlight.clear();
    for (const dir of [...this.watchers.keys()]) {
      this.closeWatcher(dir, "service-close");
    }
    this.watchers.clear();
    this.pathStates.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    for (const writer of this.patchWriters.values()) {
      writer.close();
    }
    this.patchWriters.clear();
    for (const marker of this.suppressOnce.values()) {
      clearTimeout(marker.timer);
    }
    this.suppressOnce.clear();
    this.streamInfo.clear();
    this.store.close();
    this.removeAllListeners();
  }

  // Update the persisted snapshot when we know a local write/delete happened
  // via our own filesystem API. This prevents echo patches on the next fs event.
  recordLocalWrite(
    path: string,
    content: string,
    suppress: boolean = false,
  ): void {
    this.store.setContent(path, content);
    if (!suppress) return;
    this.clearSuppress(path);
    const hash = this.sha256(content);
    const until = Date.now() + SUPPRESS_TTL_MS;
    const timer = setTimeout(() => {
      this.suppressOnce.delete(path);
    }, SUPPRESS_TTL_MS);
    this.suppressOnce.set(path, { timer, hash, until });
  }

  async recordLocalDelete(path: string): Promise<void> {
    let change: ExternalChange = { deleted: true, content: "", hash: "" };
    const meta = this.pathStates.get(path)?.meta;
    const codec = this.resolveCodec(meta);
    try {
      const computed = await this.store.handleExternalChange(
        path,
        async () => "",
        true,
        codec,
      );
      change = { ...computed, deleted: true };
    } catch {
      // at least do this:
      this.store.markDeleted(path);
    }
    // If we already know the meta for this path, append a delete patch immediately
    // so clients see the deletion even if the watcher event is delayed.
    if (process.env.SYNC_FS_DEBUG) {
      console.log("sync-fs recordLocalDelete", {
        path,
        hasMeta: meta != null,
      });
    }
    if (meta) {
      try {
        await this.appendPatch(meta, "delete", change);
      } catch (err) {
        this.emit("error", err);
      }
    }
  }

  /**
   * Indicate interest in a file. Ensures a directory watcher exists and is fresh.
   * If active is false, drops interest immediately. Resolves once a newly
   * created watcher has emitted "ready" so callers know the watch is armed.
   */
  async heartbeat(
    path: string,
    active: boolean = true,
    meta?: WatchMeta,
  ): Promise<void> {
    const dir = dirname(path);
    if (active) {
      this.counters.heartbeatActive += 1;
      const normalizedMeta = this.normalizeMeta(path, meta);
      const now = Date.now();
      const existingState = this.pathStates.get(path);
      const shouldReinitialize = this.shouldReinitializePath(
        existingState,
        normalizedMeta,
      );
      const previousStringId = existingState?.string_id;
      this.pathStates.set(path, {
        dir,
        lastHeartbeat: now,
        createdAt: existingState?.createdAt ?? now,
        meta: normalizedMeta,
        string_id: normalizedMeta?.string_id,
      });
      if (
        previousStringId != null &&
        previousStringId !== normalizedMeta?.string_id &&
        !this.hasActivePathForStringId(previousStringId, path)
      ) {
        this.closeStreamState(previousStringId);
      }
      this.maxActivePathsObserved = Math.max(
        this.maxActivePathsObserved,
        this.pathStates.size,
      );
      this.enforceActivePathCap(path);
      let entry = this.watchers.get(dir);

      if (!entry?.paths.has(path) || shouldReinitialize) {
        await this.initPath(path, normalizedMeta);
      }

      if (!entry) {
        entry = await this.ensureWatcher(dir, path);
      }

      const currentState = this.pathStates.get(path);
      if (currentState == null) {
        if (entry.paths.size === 0) {
          this.closeWatcher(dir, "released-during-init");
        }
        if (!this.hasActivePathForStringId(normalizedMeta?.string_id, path)) {
          this.closeStreamState(normalizedMeta?.string_id);
        }
        return;
      }
      entry.paths.add(path);
    } else {
      this.counters.heartbeatInactive += 1;
      this.releasePath(path, "inactive");
    }
  }

  private onFsEvent(
    dir: string,
    path: string,
    event: "add" | "change" | "unlink",
  ): void {
    const entry = this.watchers.get(dir);
    if (!entry || !entry.paths.has(path)) return;
    // Debounce per path to avoid rapid duplicate events
    if (this.debounceTimers.has(path)) {
      clearTimeout(this.debounceTimers.get(path)!);
    }
    const timer = setTimeout(async () => {
      this.debounceTimers.delete(path);
      const meta = this.pathStates.get(path)?.meta;
      const codec = this.resolveCodec(meta);
      if (event === "unlink") {
        try {
          const change = await this.store.handleExternalChange(
            path,
            async () => "",
            true,
            codec,
          );
          const payload = { ...change, deleted: true };
          this.emitEvent({ path, type: "delete", change: payload });
          if (meta) {
            await this.appendPatch(meta, "delete", payload);
          }
        } catch (err) {
          this.emit("error", err);
        }
        return;
      }
      // add/change
      try {
        let preloaded: string | undefined;
        const marker = this.suppressOnce.get(path);
        if (marker != null) {
          if (Date.now() <= marker.until) {
            try {
              preloaded = (await readFile(path, "utf8")) as string;
            } catch {
              preloaded = undefined;
            }
            if (preloaded != null && this.sha256(preloaded) === marker.hash) {
              // Exact-content echo from our own recent write.
              return;
            }
          }
          // Different content arrived while suppression marker was active:
          // treat this as an external mutation.
          this.clearSuppress(path);
        }
        const change = await this.store.handleExternalChange(
          path,
          async () => {
            return preloaded ?? ((await readFile(path, "utf8")) as string);
          },
          false,
          codec,
        );
        if (!change.deleted && change.patch == null) {
          return;
        }
        this.emitEvent({ path, type: "change", change });
        if (meta) {
          await this.appendPatch(meta, "change", change);
        }
      } catch (err) {
        this.emit("error", err);
      }
    }, DEBOUNCE_MS);
    this.debounceTimers.set(path, timer);
  }

  private emitEvent(evt: WatchEvent): void {
    this.emit("event", evt);
  }

  // Reconstruct the current document value from the patch stream to seed the
  // snapshot store without emitting a bogus "initial" patch.
  private async shouldReconcileDiskOnInit(
    path: string,
    maxTimeMs: number,
  ): Promise<boolean> {
    if (!(maxTimeMs > 0)) {
      return true;
    }
    try {
      const stats = await stat(path);
      if (!stats.isFile()) {
        return true;
      }
      return Number(stats.mtimeMs) > maxTimeMs;
    } catch (err: any) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
        return true;
      }
      this.emit("error", err);
      return true;
    }
  }

  private async loadDocViaSyncDoc({
    project_id,
    string_id,
    syncPath,
    doctype,
  }: {
    project_id: string;
    string_id: string;
    syncPath: string;
    doctype?: WatchMeta["doctype"];
  }): Promise<string | undefined> {
    const client = this.getConatClient();

    const commonOpts = {
      project_id,
      path: syncPath,
      string_id,
      // important to avoid any possible feedback loop
      noSaveToDisk: true,
      noAutosave: true,
      firstReadLockTimeout: 1,
    };

    const toArray = (val: unknown): string[] | undefined => {
      if (Array.isArray(val)) return val;
      if (val instanceof Set) return Array.from(val);
      return undefined;
    };

    const format = doctype?.patch_format;
    const opts = (doctype?.opts ?? {}) as Record<string, unknown>;
    const primaryKeys =
      toArray(
        (opts as { primary_keys?: unknown; primaryKeys?: unknown })
          .primary_keys,
      ) ??
      toArray(
        (opts as { primary_keys?: unknown; primaryKeys?: unknown }).primaryKeys,
      ) ??
      [];
    const stringCols =
      toArray(
        (opts as { string_cols?: unknown; stringCols?: unknown }).string_cols,
      ) ??
      toArray(
        (opts as { string_cols?: unknown; stringCols?: unknown }).stringCols,
      ) ??
      [];

    let doc: SyncDoc | undefined;
    try {
      if (format === 1 && primaryKeys.length > 0) {
        doc = client.sync.db({
          ...commonOpts,
          primary_keys: primaryKeys,
          string_cols: stringCols,
        });
      } else {
        doc = client.sync.string(commonOpts);
      }
      await new Promise<void>((resolve, reject) => {
        doc!.once("ready", () => resolve());
        doc!.once("error", (err) => reject(err));
      });
      const value = doc?.to_str();
      doc?.close?.();
      return value;
    } catch (err) {
      try {
        doc?.close?.();
      } catch {
        // ignore close errors
      }
      this.emit("error", err as Error);
    }

    return;
  }

  // Choose an appropriate codec for structured documents so we can compute
  // patches without falling back to text diffing.
  private resolveCodec(meta?: WatchMeta): DocCodec | undefined {
    const toArray = (val: unknown): string[] | undefined => {
      if (Array.isArray(val)) return val;
      if (val instanceof Set) return Array.from(val);
      return undefined;
    };
    const format = meta?.doctype?.patch_format;
    if (format !== 1) return;
    const opts = (meta?.doctype?.opts ?? {}) as Record<string, unknown>;
    const primaryKeys = toArray(
      (opts as any).primary_keys ?? (opts as any).primaryKeys,
    );
    const stringCols =
      toArray((opts as any).string_cols ?? (opts as any).stringCols) ?? [];
    if (!primaryKeys || primaryKeys.length === 0) {
      return;
    }
    const type = meta?.doctype?.type ?? "";
    if (typeof type === "string" && type.toLowerCase().includes("immer")) {
      return createImmerDbCodec({
        primaryKeys,
        stringCols,
      });
    }
    return createDbCodec({
      primaryKeys,
      stringCols,
    });
  }

  private pruneStale = (): void => {
    const now = Date.now();
    let staleReleased = 0;
    for (const [path, state] of [...this.pathStates.entries()]) {
      if (now - state.lastHeartbeat <= this.heartbeatTtlMs) continue;
      staleReleased += 1;
      this.counters.stalePrunes += 1;
      this.releasePath(path, "stale");
    }
    for (const [dir, entry] of [...this.watchers.entries()]) {
      if (entry.paths.size === 0) {
        this.closeWatcher(dir, "empty");
      }
    }
    if (staleReleased > 0) {
      logger.debug("sync-fs pruned stale paths", {
        staleReleased,
        activePaths: this.pathStates.size,
        activeDirs: this.watchers.size,
        patchWriters: this.patchWriters.size,
      });
    }
  };

  private async ensureWatcher(dir: string, path: string): Promise<WatchEntry> {
    const existing = this.watchers.get(dir);
    if (existing) {
      return existing;
    }
    const inflight = this.watcherInFlight.get(dir);
    if (inflight) {
      return await inflight;
    }

    const create = (async () => {
      const watcher = chokidarWatch(dir, {
        depth: 0,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 200,
          pollInterval: 100,
        },
      });
      const stopTrackingWatcher = trackBackendWatcher({
        source: "backend:sandbox/sync-fs-service",
        type: "chokidar",
        path: dir,
        info: {
          depth: 0,
          ignoreInitial: true,
          stabilityThreshold: 200,
          pollInterval: 100,
        },
      });
      const entry: WatchEntry = {
        watcher,
        paths: new Set(),
        stopTrackingWatcher,
      };
      this.watchers.set(dir, entry);
      this.counters.watcherStarts += 1;

      const ready = new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
        };
        watcher.once("ready", () => settle(resolve));
        watcher.once("error", (err) => settle(() => reject(err)));
      });

      if (process.env.SYNC_FS_DEBUG) {
        console.log("sync-fs heartbeat: start watcher", { dir, path });
      }

      watcher.on("add", (p) => this.onFsEvent(dir, p, "add"));
      watcher.on("change", (p) => this.onFsEvent(dir, p, "change"));
      watcher.on("unlink", (p) => this.onFsEvent(dir, p, "unlink"));
      watcher.on("error", (err) => {
        this.emit("error", err);
      });

      try {
        await ready;
        return entry;
      } catch (err) {
        // Ensure partially-created entries are not leaked on startup errors.
        if (this.watchers.get(dir) === entry) {
          this.closeWatcher(dir, "startup-error");
        } else {
          stopTrackingWatcher?.();
          watcher.close();
        }
        throw err;
      }
    })();

    this.watcherInFlight.set(dir, create);
    try {
      return await create;
    } finally {
      if (this.watcherInFlight.get(dir) === create) {
        this.watcherInFlight.delete(dir);
      }
    }
  }

  getDebugStats({ topN = 8 }: { topN?: number } = {}) {
    const top = Math.max(1, topN);
    const now = Date.now();
    const dirCounts = new Map<string, number>();
    for (const state of this.pathStates.values()) {
      dirCounts.set(state.dir, (dirCounts.get(state.dir) ?? 0) + 1);
    }
    return {
      activeDirs: this.watchers.size,
      activePaths: this.pathStates.size,
      patchWriters: this.patchWriters.size,
      streamInfoEntries: this.streamInfo.size,
      debounceTimers: this.debounceTimers.size,
      suppressMarkers: this.suppressOnce.size,
      heartbeatTtlMs: this.heartbeatTtlMs,
      pruneIntervalMs: this.pruneIntervalMs,
      maxActivePaths: this.maxActivePaths,
      maxActivePathsObserved: this.maxActivePathsObserved,
      counters: { ...this.counters },
      releasesByReasonTop: Object.entries(this.releasesByReason)
        .sort((a, b) => b[1] - a[1])
        .slice(0, top)
        .map(([reason, count]) => ({ reason, count })),
      activePathsTop: [...this.pathStates.entries()]
        .map(([path, state]) => ({
          path,
          string_id: state.string_id,
          ageMs: Math.max(0, now - state.createdAt),
          idleMs: Math.max(0, now - state.lastHeartbeat),
        }))
        .sort((a, b) => b.idleMs - a.idleMs)
        .slice(0, top),
      activeDirsTop: Array.from(dirCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, top)
        .map(([dir, paths]) => ({ dir, paths })),
      recentReleases: this.recentReleases.slice(0, top),
    };
  }

  private async appendPatch(
    meta: WatchMeta,
    type: "change" | "delete",
    change: ExternalChange,
  ): Promise<void> {
    if (!this.canInitMeta(meta)) return;
    const syncPath = meta.syncPath;
    if (process.env.SYNC_FS_DEBUG) {
      console.log("sync-fs appendPatch start", {
        syncPath,
        type,
      });
    }
    const string_id = this.syncStringId(meta);
    const { heads, maxVersion, maxTimeMs } = await this.getStreamHeads({
      project_id: meta.project_id,
      string_id,
      path: syncPath,
    });
    const parents = heads;
    const parentMaxMs =
      parents.length > 0
        ? Math.max(...parents.map((t) => this.timeMs(t)))
        : maxTimeMs;
    const timeMs = Math.max(Date.now(), parentMaxMs + 1);
    const time = encodePatchId(timeMs, this.clientId);
    const version = Math.max(maxVersion, 0) + 1;
    const obj: any = {
      string_id,
      project_id: meta.project_id,
      path: syncPath,
      time,
      wall: timeMs,
      user_id: 0,
      is_snapshot: false,
      parents,
      version,
      file: true,
    };
    if (type === "delete") {
      obj.meta = { deleted: true };
      obj.patch = JSON.stringify(change.patch ?? []);
    } else {
      obj.meta = change.deleted ? { deleted: true } : undefined;
      obj.patch = JSON.stringify(change.patch ?? []);
    }
    if (meta.doctype?.patch_format) {
      obj.format = meta.doctype.patch_format;
    }
    try {
      const writer = await this.getPatchWriter({
        project_id: meta.project_id,
        string_id,
        path: syncPath,
      });
      if (process.env.SYNC_FS_DEBUG) {
        console.log("sync-fs appendPatch publish", {
          type,
          parents,
          time,
          version,
        });
      }
      const headers =
        typeof meta.history_epoch === "number" &&
        Number.isFinite(meta.history_epoch)
          ? { history_epoch: meta.history_epoch }
          : undefined;
      const { seq } = await writer.publish(
        obj,
        headers != null ? { headers } : undefined,
      );
      this.store.setFsHead({ string_id, time, version });
      this.updateStreamInfo(string_id, obj, seq);
      if (process.env.SYNC_FS_DEBUG) {
        console.log("sync-fs appendPatch", {
          path: meta.syncPath,
          type,
          time,
          version,
          parents,
        });
      }
    } catch (err) {
      if (process.env.SYNC_FS_DEBUG) {
        console.log("sync-fs appendPatch error", err);
      }
      this.emit("error", err);
    }
  }

  private async getPatchWriter({
    project_id,
    string_id,
    path,
  }: {
    project_id: string;
    string_id: string;
    path: string;
  }): Promise<AStream<any>> {
    const cached = this.patchWriters.get(string_id);
    if (cached) return cached;
    const writer = new AStream({
      name: patchesStreamName({ path }),
      project_id,
      client: this.getConatClient(),
      noInventory: true,
      noAutosave: true,
    });
    this.patchWriters.set(string_id, writer);
    return writer;
  }

  private updateStreamInfo(string_id: string, patch: any, seq: number): void {
    const persisted = this.store.getFsHead(string_id);
    let info: StreamInfo = this.streamInfo.get(string_id) ?? {
      heads: new Set<PatchId>(
        (persisted?.heads ?? [])
          .map((h) => this.normalizePatchId(h))
          .filter((h): h is PatchId => !!h),
      ),
      maxVersion: persisted?.version ?? 0,
      maxTimeMs: (() => {
        const t = this.normalizePatchId((persisted as any)?.time);
        return t ? this.timeMs(t) : 0;
      })(),
      lastSeq: persisted?.lastSeq,
    };
    info = {
      heads: new Set<PatchId>(
        [...info.heads]
          .map((h) => this.normalizePatchId(h))
          .filter((h): h is PatchId => !!h),
      ),
      maxVersion: info.maxVersion ?? 0,
      maxTimeMs:
        info.maxTimeMs ??
        this.timeMs(this.normalizePatchId((persisted as any)?.time)),
      lastSeq: info.lastSeq,
    };
    info.lastSeq = seq;
    const parentIds = Array.isArray(patch.parents)
      ? patch.parents
          .map((t: any) => this.normalizePatchId(t))
          .filter((t): t is PatchId => !!t)
      : [];
    for (const t of parentIds) info.heads.delete(t);
    const tId = this.normalizePatchId(patch.time);
    if (tId) {
      info.heads.add(tId);
      info.maxTimeMs = Math.max(info.maxTimeMs, this.timeMs(tId));
    }
    if (typeof patch.version === "number") {
      info.maxVersion = Math.max(info.maxVersion, patch.version);
    }
    const latest =
      [...info.heads].sort(comparePatchId).pop() ??
      encodePatchId(info.maxTimeMs || Date.now(), this.clientId);
    this.streamInfo.set(string_id, info);
    this.store.setFsHead({
      string_id,
      time: latest,
      version: info.maxVersion,
      heads: [...info.heads],
      lastSeq: info.lastSeq,
    });
  }

  private getConatClient() {
    if (!this.conatClient) {
      this.conatClient = conat();
    }
    return this.conatClient;
  }

  private normalizePatchId(id: any): PatchId | undefined {
    if (typeof id === "string") return id;
    if (typeof id === "number" && Number.isFinite(id)) {
      return legacyPatchId(id);
    }
    return undefined;
  }

  private timeMs(id?: PatchId): number {
    if (!id) return 0;
    try {
      return decodePatchId(id).timeMs;
    } catch {
      return 0;
    }
  }

  private async getStreamHeads({
    project_id,
    string_id,
    path,
  }: {
    project_id: string;
    string_id: string;
    path: string;
  }): Promise<{
    heads: PatchId[];
    maxVersion: number;
    maxTimeMs: number;
  }> {
    const writer = await this.getPatchWriter({ project_id, string_id, path });
    const persisted = this.store.getFsHead(string_id);
    let info: StreamInfo = this.streamInfo.get(string_id) ?? {
      heads: new Set<PatchId>(
        (persisted?.heads ?? [])
          .map((h) => this.normalizePatchId(h))
          .filter((h): h is PatchId => !!h),
      ),
      maxVersion: persisted?.version ?? 0,
      maxTimeMs: (() => {
        const t = this.normalizePatchId((persisted as any)?.time);
        return t ? this.timeMs(t) : 0;
      })(),
      lastSeq: persisted?.lastSeq,
    };
    // Normalize legacy entries that may still be in-memory.
    info = {
      heads: new Set<PatchId>(
        [...info.heads]
          .map((h) => this.normalizePatchId(h))
          .filter((h): h is PatchId => !!h),
      ),
      maxVersion: info.maxVersion ?? 0,
      maxTimeMs:
        info.maxTimeMs ??
        this.timeMs(this.normalizePatchId((persisted as any)?.time)),
      lastSeq: info.lastSeq,
    };
    // If we don't have any heads persisted yet, rebuild from the beginning so
    // we don't publish an orphaned head with empty parents.
    const start_seq =
      info.heads.size === 0 || info.lastSeq == null
        ? undefined
        : info.lastSeq + 1;
    let sawUpdatesSinceLastSeq = false;
    if (process.env.SYNC_FS_DEBUG) {
      console.log("sync-fs getStreamHeads start", { string_id, start_seq });
    }
    try {
      for await (const { mesg, seq } of writer.getAll({
        timeout: 15000,
        start_seq,
      })) {
        sawUpdatesSinceLastSeq = true;
        const p: any = mesg;
        if (typeof seq === "number") info.lastSeq = seq;
        const parentIds = Array.isArray(p.parents)
          ? p.parents
              .map((t: any) => this.normalizePatchId(t))
              .filter((t): t is PatchId => !!t)
          : [];
        for (const t of parentIds) info.heads.delete(t);
        const tId = this.normalizePatchId(p.time);
        if (tId) {
          info.heads.add(tId);
          info.maxTimeMs = Math.max(info.maxTimeMs, this.timeMs(tId));
        }
        if (typeof p.version === "number") {
          info.maxVersion = Math.max(info.maxVersion, p.version);
        }
      }
    } catch (err) {
      if (process.env.SYNC_FS_DEBUG) {
        console.log("sync-fs getStreamHeads error", err);
      }
      // fall through with whatever we gathered
    }
    // If we resumed from a persisted lastSeq, saw no newer updates, and can no
    // longer load that persisted seq, then the underlying persist stream was
    // reset (e.g. sqlite deleted). Drop stale heads/version so the next write
    // starts a fresh lineage instead of appending orphan patches.
    if (
      start_seq !== undefined &&
      !sawUpdatesSinceLastSeq &&
      info.lastSeq != null
    ) {
      const hasPersistedSeq = await this.streamHasSeq(writer, info.lastSeq);
      if (!hasPersistedSeq) {
        if (process.env.SYNC_FS_DEBUG) {
          console.log("sync-fs getStreamHeads reset-detected", {
            string_id,
            lastSeq: info.lastSeq,
          });
        }
        info = {
          heads: new Set<PatchId>(),
          maxVersion: 0,
          maxTimeMs: 0,
          lastSeq: undefined,
        };
      }
    }
    // If we still have no heads but saw versions, fallback to full replay once.
    if (
      info.heads.size === 0 &&
      info.maxVersion > 0 &&
      start_seq !== undefined
    ) {
      if (process.env.SYNC_FS_DEBUG) {
        console.log("sync-fs getStreamHeads retry from start", { string_id });
      }
      return this.getStreamHeads({ project_id, string_id, path });
    }
    if (process.env.SYNC_FS_DEBUG) {
      console.log("sync-fs getStreamHeads done", {
        string_id,
        heads: info.heads.size,
        maxVersion: info.maxVersion,
      });
    }
    this.streamInfo.set(string_id, info);
    const latest =
      [...info.heads].sort(comparePatchId).pop() ??
      encodePatchId(info.maxTimeMs || Date.now(), this.clientId);
    this.store.setFsHead({
      string_id,
      time: latest,
      version: info.maxVersion,
      heads: [...info.heads],
      lastSeq: info.lastSeq,
    });
    return {
      heads: [...info.heads],
      maxVersion: info.maxVersion,
      maxTimeMs: info.maxTimeMs,
    };
  }

  private async streamHasSeq(
    writer: AStream<any>,
    seq: number,
  ): Promise<boolean> {
    try {
      return (await writer.get(seq, { timeout: 2000 })) != null;
    } catch {
      return false;
    }
  }
}
