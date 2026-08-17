/*
Hook that provides all files in a directory via a Conat FilesystemClient.
This automatically updates when files change.

TESTS: See packages/test/project/listing/

*/

import useAsyncEffect from "use-async-effect";
import { useCallback, useEffect, useRef, useState } from "react";
import { throttle } from "lodash";
import LRU from "lru-cache";
import { sleep, withTimeout } from "@cocalc/util/async-utils";
import type { JSONValue } from "@cocalc/util/types";
import { dirname, join } from "path";
import {
  getErrorMessage,
  isConatInfoBootstrapTimeout,
  isProjectRootfsUnavailable,
} from "./project-host-errors";
import {
  claimDirectoryListingTrace,
  directoryListingTelemetry,
  markDirectoryListingPhase,
  type DirectoryListingTelemetry,
} from "./ux-latency";

export interface FileData {
  mtime: number;
  size: number;
  isDir?: boolean;
  isSymLink?: boolean;
  linkTarget?: string;
  type?: string;
}

export type Files = { [name: string]: FileData };

type ListingLike = {
  files?: Files;
  close?: () => void;
  on: (event: "change", listener: () => void) => void;
};

type FilesystemClientLike = {
  getListing: (path: string) => Promise<{ files: Files; truncated?: boolean }>;
  listing: (path: string) => Promise<ListingLike>;
};

export type FilesDebugContext = {
  kind: "public-directory-share";
  project_id: string;
  share_id: string;
  share_path: string;
};

export type FilesUxContext = {
  project_id: string;
  host_id?: string;
  surface_visible: boolean;
};

type ConatErrorLike = Error & { code?: string | number; data?: unknown };

const DEFAULT_THROTTLE_FILE_UPDATE = 500;
const INITIAL_LISTING_TIMEOUT_MS = 10000;
const INITIAL_LISTING_RETRY_DELAY_MS = 250;
const INITIAL_LISTING_MAX_ATTEMPTS = 3;
const INITIAL_LISTING_HEDGE_DELAYS_MS = [0, 3000, 6000] as const;
const INITIAL_LISTING_HEDGE_DEADLINE_MS = 12000;
const LISTING_WATCHER_RETRY_DELAYS_MS = [1000, 2000, 5000] as const;

// max number of subdirs to cache right after computing the listing for a dir
// This makes it so clicking on a subdir for a listing is MUCH faster.
const MAX_SUBDIR_CACHE = 10;

const CACHE_SIZE = 150;

const cache = new LRU<string, Files>({ max: CACHE_SIZE });
const cacheListeners = new Set<() => void>();

function logPublicShareFiles(
  level: "info" | "warn",
  message: string,
  debugContext: FilesDebugContext | undefined,
  details: Record<string, unknown> = {},
) {
  if (debugContext?.kind !== "public-directory-share") {
    return;
  }
  if (level !== "warn") {
    return;
  }
  const payload = {
    source: "frontend:project:listing:use-files",
    event: message,
    ...debugContext,
    ...details,
  };
  const line = `[public-directory-share] ${message} ${JSON.stringify(payload)}`;
  console.warn(line);
}

function notifyCacheListeners() {
  for (const listener of cacheListeners) {
    listener();
  }
}

export function getFiles({
  cacheId,
  path,
}: {
  cacheId?: JSONValue;
  path: string;
}): Files | null {
  if (cacheId == null) {
    return null;
  }
  return cache.get(key(cacheId, path)) ?? null;
}

export function useFilesCacheVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((value) => value + 1);
    cacheListeners.add(listener);
    return () => {
      cacheListeners.delete(listener);
    };
  }, []);
  return version;
}

function sameFiles(a: Files | null | undefined, b: Files | null | undefined) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const name of aKeys) {
    const x = a[name];
    const y = b[name];
    if (
      y == null ||
      x.mtime !== y.mtime ||
      x.size !== y.size ||
      x.isDir !== y.isDir ||
      x.isSymLink !== y.isSymLink ||
      x.linkTarget !== y.linkTarget ||
      x.type !== y.type
    ) {
      return false;
    }
  }
  return true;
}

export default function useFiles({
  fs,
  path,
  throttleUpdate = DEFAULT_THROTTLE_FILE_UPDATE,
  cacheId,
  watch = true,
  refreshFs,
  debugContext,
  uxContext,
}: {
  // fs = undefined is supported and just waits until you provide a fs that is defined
  fs?: FilesystemClientLike | null;
  path: string;
  throttleUpdate?: number;
  // cacheId -- if given, save most recently loaded Files for a path in an in-memory LRU cache.
  // An example cacheId could be {project_id}.
  // This is used to speed up the first load, and can also be fetched synchronously.
  cacheId?: JSONValue;
  watch?: boolean;
  refreshFs?: () => void;
  debugContext?: FilesDebugContext;
  uxContext?: FilesUxContext;
}): {
  files: Files | null;
  error: null | ConatErrorLike;
  refresh: () => void;
  telemetry: DirectoryListingTelemetry | null;
} {
  const uxTraceRef = useRef<
    | {
        key: string;
        entry: ReturnType<typeof claimDirectoryListingTrace>;
      }
    | undefined
  >(undefined);
  const uxKey = uxContext == null ? "" : `${uxContext.project_id}:${path}`;
  if (uxContext != null) {
    const entry = claimDirectoryListingTrace({
      project_id: uxContext.project_id,
      host_id: uxContext.host_id,
      path,
      surface_visible: uxContext.surface_visible,
    });
    if (
      uxTraceRef.current?.key !== uxKey ||
      uxTraceRef.current.entry.trace.id !== entry.trace.id
    ) {
      uxTraceRef.current = { key: uxKey, entry };
    }
  } else if (uxTraceRef.current != null) {
    uxTraceRef.current = undefined;
  }
  const uxTrace = uxContext == null ? undefined : uxTraceRef.current?.entry;
  const initialCachedFiles = getFiles({ cacheId, path });
  const [filesState, setFilesState] = useState<{
    path: string;
    files: Files | null;
    telemetry?: DirectoryListingTelemetry | null;
  }>(() => ({
    path,
    files: initialCachedFiles,
    telemetry:
      initialCachedFiles == null
        ? null
        : directoryListingTelemetry({
            entry: uxTrace,
            revision: 0,
            data_source: "cache",
            authoritative: false,
            cache_hit: true,
            entries: Object.keys(initialCachedFiles).length,
            truncated: false,
          }),
  }));
  const [errorState, setErrorState] = useState<{
    path: string;
    error: ConatErrorLike | null;
  }>({ path, error: null });
  const [counter, setCounter] = useState(0);
  const listingRef = useRef<any>(null);
  const throttledUpdateRef = useRef<undefined | { cancel?: () => void }>(
    undefined,
  );
  const requestId = useRef(0);
  const staleFilesystemRefreshRequestedRef = useRef(false);
  const refresh = useCallback(() => {
    if (cacheId != null) {
      clearCached({ cacheId, path });
    }
    staleFilesystemRefreshRequestedRef.current = false;
    setErrorState((cur) =>
      cur.path === path && cur.error == null ? cur : { path, error: null },
    );
    // Keep the last successful listing visible while this path is revalidated.
    // Navigation still returns null below because filesState.path no longer
    // matches, but same-directory refreshes must not flash an empty listing.
    setFilesState((cur) =>
      cur.path === path ? cur : { path, files: null, telemetry: null },
    );
    setCounter((value) => value + 1);
  }, [cacheId, path]);

  useAsyncEffect(
    async () => {
      const id = ++requestId.current;
      if (fs == null) {
        markDirectoryListingPhase(uxTrace, "filesystem_client_wait");
        logPublicShareFiles(
          "info",
          "waiting for filesystem client",
          debugContext,
          {
            path,
          },
        );
        staleFilesystemRefreshRequestedRef.current = false;
        if (requestId.current !== id) return;
        setErrorState((cur) =>
          cur.path === path && cur.error == null ? cur : { path, error: null },
        );
        setFilesState((cur) =>
          cur.path === path && cur.files == null
            ? cur
            : { path, files: null, telemetry: null },
        );
        return;
      }
      markDirectoryListingPhase(uxTrace, "filesystem_client_ready");
      const refreshStaleFilesystemClient = (err: unknown): boolean => {
        if (
          refreshFs == null ||
          staleFilesystemRefreshRequestedRef.current ||
          !isStaleFilesystemClientError(err)
        ) {
          return false;
        }
        staleFilesystemRefreshRequestedRef.current = true;
        refreshFs();
        return true;
      };
      try {
        staleFilesystemRefreshRequestedRef.current = false;
        const cachedFiles = getFiles({ cacheId, path });
        markDirectoryListingPhase(uxTrace, "cache_checked", {
          cache_hit: cachedFiles != null,
          entries:
            cachedFiles == null ? undefined : Object.keys(cachedFiles).length,
        });
        setFilesState((cur) => {
          if (
            cur.path === path &&
            (cachedFiles == null || sameFiles(cur.files, cachedFiles))
          ) {
            return cur;
          }
          return {
            path,
            files: cachedFiles,
            telemetry:
              cachedFiles == null
                ? null
                : directoryListingTelemetry({
                    entry: uxTrace,
                    revision: (cur.telemetry?.revision ?? 0) + 1,
                    data_source: "cache",
                    authoritative: false,
                    cache_hit: true,
                    entries: Object.keys(cachedFiles).length,
                    truncated: false,
                  }),
          };
        });
        setErrorState((cur) =>
          cur.path === path && cur.error == null ? cur : { path, error: null },
        );
        try {
          const snapshot = await getListingSnapshot({
            fs,
            path,
            debugContext,
            uxTrace,
            hedge: uxTrace != null && uxContext?.surface_visible === true,
          });
          if (requestId.current !== id) return;
          const snapshotFiles = snapshot.files ?? {};
          if (cacheId != null) {
            cache.set(key(cacheId, path), snapshotFiles);
            notifyCacheListeners();
            cacheNeighbors({ fs, cacheId, path, files: snapshotFiles });
          }
          setFilesState((cur) => ({
            path,
            files:
              cur.path === path && sameFiles(cur.files, snapshotFiles)
                ? cur.files
                : { ...snapshotFiles },
            telemetry: directoryListingTelemetry({
              entry: uxTrace,
              revision: (cur.telemetry?.revision ?? 0) + 1,
              data_source: "snapshot",
              authoritative: true,
              cache_hit: cachedFiles != null,
              entries: Object.keys(snapshotFiles).length,
              truncated: snapshot.truncated === true,
              attempts: snapshot.attempts,
            }),
          }));
          setErrorState((cur) =>
            cur.path === path && cur.error == null
              ? cur
              : { path, error: null },
          );
        } catch (err) {
          if (refreshStaleFilesystemClient(err)) {
            return;
          }
          logPublicShareFiles("warn", "initial listing failed", debugContext, {
            path,
            code: (err as ConatErrorLike | undefined)?.code,
            message: `${(err as ConatErrorLike | undefined)?.message ?? err}`,
          });
          if (requestId.current !== id) return;
          setErrorState((cur) =>
            cur.path === path && cur.error === err
              ? cur
              : { path, error: err as ConatErrorLike },
          );
          setFilesState((cur) =>
            cur.path === path && cur.files == null
              ? cur
              : { path, files: null, telemetry: null },
          );
        }
      } catch (err) {
        if (refreshStaleFilesystemClient(err)) {
          return;
        }
        logPublicShareFiles("warn", "listing hook failed", debugContext, {
          path,
          code: (err as ConatErrorLike | undefined)?.code,
          message: `${(err as ConatErrorLike | undefined)?.message ?? err}`,
        });
        if (requestId.current !== id) return;
        setErrorState((cur) =>
          cur.path === path && cur.error === err
            ? cur
            : { path, error: err as ConatErrorLike },
        );
        setFilesState((cur) =>
          cur.path === path && cur.files == null
            ? cur
            : { path, files: null, telemetry: null },
        );
      }
      if (!watch) {
        return;
      }
      const attachListing = async (attempt = 0): Promise<void> => {
        try {
          markDirectoryListingPhase(uxTrace, "watcher_attach_start", {
            attempt: attempt + 1,
          });
          const listing = await fs.listing(path);
          if (requestId.current !== id) {
            listing.close?.();
            return;
          }
          listingRef.current = listing;
          markDirectoryListingPhase(uxTrace, "watcher_attach_done", {
            attempt: attempt + 1,
            entries: Object.keys(listing.files ?? {}).length,
          });
          if (cacheId != null && listing.files != null) {
            cache.set(key(cacheId, path), listing.files);
            notifyCacheListeners();
            cacheNeighbors({ fs, cacheId, path, files: listing.files });
          }
          const update = () => {
            if (requestId.current !== id) return;
            setFilesState((cur) =>
              cur.path === path && sameFiles(cur.files, listing.files)
                ? cur
                : {
                    path,
                    files: { ...(listing.files ?? {}) },
                    telemetry:
                      cur.path === path ? (cur.telemetry ?? null) : null,
                  },
            );
            setErrorState((cur) =>
              cur.path === path && cur.error == null
                ? cur
                : { path, error: null },
            );
          };
          update();
          const throttledUpdate = throttle(update, throttleUpdate, {
            leading: true,
            trailing: true,
          });
          throttledUpdateRef.current = throttledUpdate;
          listing.on("change", throttledUpdate);
          try {
            const snapshot = await getListingSnapshot({
              fs,
              path,
              debugContext,
            });
            if (requestId.current !== id) return;
            listing.files = snapshot.files ?? {};
            if (cacheId != null) {
              cache.set(key(cacheId, path), listing.files);
              notifyCacheListeners();
              cacheNeighbors({ fs, cacheId, path, files: listing.files });
            }
            update();
          } catch (err) {
            if (requestId.current !== id) return;
            logPublicShareFiles(
              "warn",
              "listing watcher catch-up failed",
              debugContext,
              {
                path,
                code: (err as ConatErrorLike | undefined)?.code,
                message: `${(err as ConatErrorLike | undefined)?.message ?? err}`,
              },
            );
          }
        } catch (err) {
          if (requestId.current !== id) return;
          console.warn("listing watcher bootstrap failed", { path, err });
          markDirectoryListingPhase(uxTrace, "watcher_attach_failed", {
            attempt: attempt + 1,
            error_code:
              `${(err as ConatErrorLike | undefined)?.code ?? ""}`.slice(0, 80),
          });
          logPublicShareFiles(
            "warn",
            "listing watcher bootstrap failed",
            debugContext,
            {
              path,
              attempt: attempt + 1,
              code: (err as ConatErrorLike | undefined)?.code,
              message: `${(err as ConatErrorLike | undefined)?.message ?? err}`,
            },
          );
          if (refreshStaleFilesystemClient(err)) {
            return;
          }
          if (!isRetryableListingError(err)) {
            return;
          }
          const delayMs =
            LISTING_WATCHER_RETRY_DELAYS_MS[
              Math.min(attempt, LISTING_WATCHER_RETRY_DELAYS_MS.length - 1)
            ];
          await sleep(delayMs);
          if (requestId.current !== id) return;
          await attachListing(attempt + 1);
        }
      };
      void attachListing();
    },
    () => {
      throttledUpdateRef.current?.cancel?.();
      delete throttledUpdateRef.current;
      listingRef.current?.close();
      delete listingRef.current;
    },
    [
      cacheId,
      debugContext,
      fs,
      path,
      counter,
      refreshFs,
      throttleUpdate,
      watch,
    ],
  );

  const files = filesState.path === path ? filesState.files : null;
  const error = errorState.path === path ? errorState.error : null;
  const telemetry =
    filesState.path !== path
      ? null
      : files != null &&
          uxTrace != null &&
          filesState.telemetry?.trace_id !== uxTrace.trace.id
        ? directoryListingTelemetry({
            entry: uxTrace,
            revision: 0,
            data_source: "retained",
            authoritative: filesState.telemetry?.authoritative ?? false,
            cache_hit: true,
            entries: Object.keys(files).length,
            truncated: filesState.telemetry?.truncated ?? false,
            attempts: filesState.telemetry?.attempts,
          })
        : (filesState.telemetry ?? null);

  return { files, error, refresh, telemetry };
}

function key(cacheId: JSONValue, path: string) {
  return JSON.stringify({ cacheId, path });
}

function clearCached({ cacheId, path }: { cacheId: JSONValue; path: string }) {
  const k = key(cacheId, path);
  cache.delete(k);
  failed.delete(k);
  notifyCacheListeners();
}

export function isRetryableListingError(err: unknown): boolean {
  const code = `${(err as any)?.code ?? ""}`.trim();
  const message = getErrorMessage(err);
  if (code === "408" || code === "429") {
    return true;
  }
  return (
    isStaleFilesystemClientError(err) ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("failed to fetch") ||
    message.includes("retry in about") ||
    message.includes("failed to sign in") ||
    message.includes("missing project-host bearer token") ||
    message.includes('once: "ready" not emitted before "closed"') ||
    message.includes('once: "inbox" not emitted before "closed"') ||
    message.includes("no subscribers matching") ||
    message.includes("unable to route") ||
    message.includes("unable to connect routed project-host client") ||
    message.includes("project actions unavailable") ||
    isProjectRootfsUnavailable(err)
  );
}

export function isStaleFilesystemClientError(err: unknown): boolean {
  const message = getErrorMessage(err);
  return (
    isConatInfoBootstrapTimeout(err) ||
    message === "closed" ||
    message === "error: closed" ||
    message.includes("connection closed") ||
    message.includes("socket has been disconnected") ||
    message.includes("failed to fetch") ||
    message.includes("disconnected")
  );
}

export async function getListingSnapshot({
  fs,
  path,
  debugContext,
  uxTrace,
  hedge = false,
}: {
  fs: FilesystemClientLike;
  path: string;
  debugContext?: FilesDebugContext;
  uxTrace?: ReturnType<typeof claimDirectoryListingTrace>;
  hedge?: boolean;
}): Promise<{ files: Files; truncated?: boolean; attempts: number }> {
  if (hedge) {
    return await getHedgedListingSnapshot({
      fs,
      path,
      debugContext,
      uxTrace,
    });
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= INITIAL_LISTING_MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    logPublicShareFiles("info", "initial listing start", debugContext, {
      path,
      attempt,
    });
    markDirectoryListingPhase(uxTrace, "snapshot_attempt_start", { attempt });
    try {
      const snapshot = await withTimeout(
        fs.getListing(path),
        INITIAL_LISTING_TIMEOUT_MS,
      );
      logPublicShareFiles("info", "initial listing ready", debugContext, {
        path,
        attempt,
        elapsed_ms: Date.now() - started,
        entries: Object.keys(snapshot.files ?? {}).length,
        truncated: snapshot.truncated === true,
      });
      markDirectoryListingPhase(uxTrace, "snapshot_ready", {
        attempt,
        entries: Object.keys(snapshot.files ?? {}).length,
        truncated: snapshot.truncated === true,
      });
      return { ...snapshot, attempts: attempt };
    } catch (err) {
      lastError = err;
      markDirectoryListingPhase(uxTrace, "snapshot_attempt_failed", {
        attempt,
        retryable: isRetryableListingError(err),
        error_code: `${(err as ConatErrorLike | undefined)?.code ?? ""}`.slice(
          0,
          80,
        ),
      });
      logPublicShareFiles(
        "warn",
        "initial listing attempt failed",
        debugContext,
        {
          path,
          attempt,
          elapsed_ms: Date.now() - started,
          retryable: isRetryableListingError(err),
          code: (err as ConatErrorLike | undefined)?.code,
          message: `${(err as ConatErrorLike | undefined)?.message ?? err}`,
        },
      );
      if (
        !isRetryableListingError(err) ||
        attempt >= INITIAL_LISTING_MAX_ATTEMPTS
      ) {
        throw err;
      }
      await sleep(INITIAL_LISTING_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

async function getHedgedListingSnapshot({
  fs,
  path,
  debugContext,
  uxTrace,
}: {
  fs: FilesystemClientLike;
  path: string;
  debugContext?: FilesDebugContext;
  uxTrace?: ReturnType<typeof claimDirectoryListingTrace>;
}): Promise<{ files: Files; truncated?: boolean; attempts: number }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let completedAttempts = 0;
    let lastError: unknown;
    const startedAttempts = new Set<number>();
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const cleanup = () => {
      for (const timer of timers) clearTimeout(timer);
    };
    const rejectOnce = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const resolveOnce = (
      snapshot: { files: Files; truncated?: boolean },
      attempt: number,
      started: number,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      markDirectoryListingPhase(uxTrace, "snapshot_ready", {
        attempt,
        attempts_started: started,
        entries: Object.keys(snapshot.files ?? {}).length,
        truncated: snapshot.truncated === true,
      });
      resolve({ ...snapshot, attempts: started });
    };

    const startAttempt = (attempt: number) => {
      if (
        settled ||
        startedAttempts.has(attempt) ||
        attempt > INITIAL_LISTING_HEDGE_DELAYS_MS.length
      ) {
        return;
      }
      startedAttempts.add(attempt);
      const started = Date.now();
      logPublicShareFiles("info", "initial listing start", debugContext, {
        path,
        attempt,
        hedged: attempt > 1,
      });
      markDirectoryListingPhase(uxTrace, "snapshot_attempt_start", {
        attempt,
        hedged: attempt > 1,
      });
      markDirectoryListingPhase(uxTrace, `snapshot_attempt_${attempt}_start`, {
        hedged: attempt > 1,
      });
      void Promise.resolve()
        .then(() => fs.getListing(path))
        .then(
          (snapshot) => {
            logPublicShareFiles("info", "initial listing ready", debugContext, {
              path,
              attempt,
              elapsed_ms: Date.now() - started,
              entries: Object.keys(snapshot.files ?? {}).length,
              truncated: snapshot.truncated === true,
            });
            resolveOnce(snapshot, attempt, startedAttempts.size);
          },
          (err) => {
            if (settled) return;
            completedAttempts += 1;
            lastError = err;
            const retryable = isRetryableListingError(err);
            markDirectoryListingPhase(uxTrace, "snapshot_attempt_failed", {
              attempt,
              retryable,
              error_code:
                `${(err as ConatErrorLike | undefined)?.code ?? ""}`.slice(
                  0,
                  80,
                ),
            });
            markDirectoryListingPhase(
              uxTrace,
              `snapshot_attempt_${attempt}_failed`,
              { retryable },
            );
            logPublicShareFiles(
              "warn",
              "initial listing attempt failed",
              debugContext,
              {
                path,
                attempt,
                elapsed_ms: Date.now() - started,
                retryable,
                code: (err as ConatErrorLike | undefined)?.code,
                message: `${(err as ConatErrorLike | undefined)?.message ?? err}`,
              },
            );
            if (!retryable) {
              rejectOnce(err);
              return;
            }
            startAttempt(attempt + 1);
            if (completedAttempts === INITIAL_LISTING_HEDGE_DELAYS_MS.length) {
              rejectOnce(err);
            }
          },
        );
    };

    for (const [index, delay] of INITIAL_LISTING_HEDGE_DELAYS_MS.entries()) {
      const attempt = index + 1;
      if (delay === 0) {
        startAttempt(attempt);
      } else {
        timers.push(setTimeout(() => startAttempt(attempt), delay));
      }
    }
    timers.push(
      setTimeout(() => {
        const err = new Error(
          `directory listing timed out after ${INITIAL_LISTING_HEDGE_DEADLINE_MS / 1000} seconds`,
        ) as ConatErrorLike;
        err.code = 408;
        markDirectoryListingPhase(uxTrace, "snapshot_deadline_reached", {
          attempts_started: startedAttempts.size,
          last_error: getErrorMessage(lastError).slice(0, 160),
        });
        rejectOnce(err);
      }, INITIAL_LISTING_HEDGE_DEADLINE_MS),
    );
  });
}

// anything in failed we don't try to update -- this is
// purely a convenience so no need to worry.
const failed = new Set<string>();

async function ensureCached({
  cacheId,
  fs,
  path,
}: {
  fs: FilesystemClientLike;
  cacheId: JSONValue;
  path: string;
}) {
  const k = key(cacheId, path);
  if (cache.has(k) || failed.has(k)) {
    return;
  }
  try {
    const { files } = await getListingSnapshot({ fs, path });
    if (files) {
      cache.set(k, files);
      notifyCacheListeners();
    } else {
      failed.add(k);
    }
  } catch {
    failed.add(k);
  }
}

async function cacheNeighbors({
  fs,
  cacheId,
  path,
  files,
}: {
  fs: FilesystemClientLike;
  cacheId: JSONValue;
  path: string;
  files: Files;
}) {
  let v: string[] = [];
  for (const dir in files) {
    if (!dir.startsWith(".") && files[dir].isDir) {
      const full = join(path, dir);
      const k = key(cacheId, full);
      if (!cache.has(k) && !failed.has(k)) {
        v.push(full);
      }
    }
  }
  if (path) {
    let parent = dirname(path);
    if (parent == ".") {
      parent = "/";
    }
    const k = key(cacheId, parent);
    if (!cache.has(k) && !failed.has(k)) {
      v.push(parent);
    }
  }
  const f = async (path: string) => {
    await ensureCached({ cacheId, fs, path });
  };
  v.sort();
  // grab up to MAX_SUBDIR_CACHE missing listings in parallel
  v = v.slice(0, MAX_SUBDIR_CACHE);
  await Promise.all(v.map(f));
}

export function getCacheId({ project_id }: { project_id: string }) {
  return { project_id };
}
