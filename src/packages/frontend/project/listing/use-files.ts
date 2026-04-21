/*
Hook that provides all files in a directory via a Conat FilesystemClient.
This automatically updates when files change.

TESTS: See packages/test/project/listing/

*/

import useAsyncEffect from "use-async-effect";
import { useEffect, useRef, useState } from "react";
import { throttle } from "lodash";
import { type Files } from "@cocalc/conat/files/listing";
import { type FilesystemClient } from "@cocalc/conat/files/fs";
import { type ConatError } from "@cocalc/conat/core/client";
import useCounter from "@cocalc/frontend/app-framework/counter-hook";
import LRU from "lru-cache";
import { sleep, withTimeout } from "@cocalc/util/async-utils";
import type { JSONValue } from "@cocalc/util/types";
import { dirname, join } from "path";

export { Files };

const DEFAULT_THROTTLE_FILE_UPDATE = 500;
const INITIAL_LISTING_TIMEOUT_MS = 2000;
const INITIAL_LISTING_RETRY_DELAY_MS = 250;
const INITIAL_LISTING_MAX_ATTEMPTS = 3;

// max number of subdirs to cache right after computing the listing for a dir
// This makes it so clicking on a subdir for a listing is MUCH faster.
const MAX_SUBDIR_CACHE = 10;

const CACHE_SIZE = 150;

const cache = new LRU<string, Files>({ max: CACHE_SIZE });
const cacheListeners = new Set<() => void>();

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

export default function useFiles({
  fs,
  path,
  throttleUpdate = DEFAULT_THROTTLE_FILE_UPDATE,
  cacheId,
}: {
  // fs = undefined is supported and just waits until you provide a fs that is defined
  fs?: FilesystemClient | null;
  path: string;
  throttleUpdate?: number;
  // cacheId -- if given, save most recently loaded Files for a path in an in-memory LRU cache.
  // An example cacheId could be {project_id}.
  // This is used to speed up the first load, and can also be fetched synchronously.
  cacheId?: JSONValue;
}): { files: Files | null; error: null | ConatError; refresh: () => void } {
  const [filesState, setFilesState] = useState<{
    path: string;
    files: Files | null;
  }>(() => ({ path, files: getFiles({ cacheId, path }) }));
  const [errorState, setErrorState] = useState<{
    path: string;
    error: ConatError | null;
  }>({ path, error: null });
  const { val: counter, inc: refresh } = useCounter();
  const listingRef = useRef<any>(null);
  const throttledUpdateRef = useRef<undefined | { cancel?: () => void }>(
    undefined,
  );
  const requestId = useRef(0);

  useAsyncEffect(
    async () => {
      const id = ++requestId.current;
      if (fs == null) {
        if (requestId.current !== id) return;
        setErrorState({ path, error: null });
        setFilesState({ path, files: null });
        return;
      }
      try {
        setFilesState({ path, files: getFiles({ cacheId, path }) });
        setErrorState({ path, error: null });
        const snapshot = await getListingSnapshot({ fs, path });
        if (requestId.current !== id) return;
        const snapshotFiles = snapshot.files ?? {};
        if (cacheId != null) {
          cache.set(key(cacheId, path), snapshotFiles);
          notifyCacheListeners();
          cacheNeighbors({ fs, cacheId, path, files: snapshotFiles });
        }
        setFilesState({ path, files: { ...snapshotFiles } });
        setErrorState({ path, error: null });
      } catch (err) {
        if (requestId.current !== id) return;
        setErrorState({ path, error: err as ConatError });
        setFilesState({ path, files: null });
        return;
      }
      void fs
        .listing(path)
        .then((listing) => {
          if (requestId.current !== id) {
            listing.close?.();
            return;
          }
          listingRef.current = listing;
          if (cacheId != null && listing.files != null) {
            cache.set(key(cacheId, path), listing.files);
            notifyCacheListeners();
            cacheNeighbors({ fs, cacheId, path, files: listing.files });
          }
          const update = () => {
            if (requestId.current !== id) return;
            setFilesState({ path, files: { ...listing.files } });
          };
          update();
          const throttledUpdate = throttle(update, throttleUpdate, {
            leading: true,
            trailing: true,
          });
          throttledUpdateRef.current = throttledUpdate;
          listing.on("change", throttledUpdate);
        })
        .catch((err) => {
          if (requestId.current !== id) return;
          console.warn("listing watcher bootstrap failed", { path, err });
        });
    },
    () => {
      throttledUpdateRef.current?.cancel?.();
      delete throttledUpdateRef.current;
      listingRef.current?.close();
      delete listingRef.current;
    },
    [fs, path, counter],
  );

  const files = filesState.path === path ? filesState.files : null;
  const error = errorState.path === path ? errorState.error : null;

  return { files, error, refresh };
}

function key(cacheId: JSONValue, path: string) {
  return JSON.stringify({ cacheId, path });
}

function isListingTimeoutError(err: unknown): boolean {
  return `${(err as any)?.message ?? err ?? ""}`.includes("timeout");
}

async function getListingSnapshot({
  fs,
  path,
}: {
  fs: FilesystemClient;
  path: string;
}): Promise<{ files: Files; truncated?: boolean }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= INITIAL_LISTING_MAX_ATTEMPTS; attempt++) {
    try {
      return await withTimeout(fs.getListing(path), INITIAL_LISTING_TIMEOUT_MS);
    } catch (err) {
      lastError = err;
      if (
        !isListingTimeoutError(err) ||
        attempt >= INITIAL_LISTING_MAX_ATTEMPTS
      ) {
        throw err;
      }
      await sleep(INITIAL_LISTING_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

// anything in failed we don't try to update -- this is
// purely a convenience so no need to worry.
const failed = new Set<string>();

async function ensureCached({
  cacheId,
  fs,
  path,
}: {
  fs: FilesystemClient;
  cacheId: JSONValue;
  path: string;
}) {
  const k = key(cacheId, path);
  if (cache.has(k) || failed.has(k)) {
    return;
  }
  try {
    const { files } = await fs.listing(path);
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
  fs: FilesystemClient;
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
