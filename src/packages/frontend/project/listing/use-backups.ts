import useAsyncEffect from "use-async-effect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { field_cmp } from "@cocalc/util/misc";
import { BACKUPS, isBackupsPath } from "@cocalc/util/consts/backups";
import type { DirectoryListingEntry } from "@cocalc/frontend/project/explorer/types";

export { BACKUPS, isBackupsPath };

export interface BackupMeta {
  id: string;
  name: string; // display name (ISO string)
  mtime: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const PREFETCH_LIMIT = 8;
const listingCache = new Map<
  string,
  { entries: DirectoryListingEntry[]; at: number }
>();
const backupMetaCache = new Map<string, { meta: BackupMeta[]; at: number }>();
const inflight = new Map<string, Promise<DirectoryListingEntry[]>>();
const cacheListeners = new Set<() => void>();

function notifyCacheListeners() {
  for (const listener of cacheListeners) {
    listener();
  }
}

function cacheKey({
  project_id,
  backup_id,
  subpath,
}: {
  project_id: string;
  backup_id: string;
  subpath: string;
}) {
  return `${project_id}:${backup_id}:${subpath}`;
}

function readBackupMeta(project_id: string): BackupMeta[] | null {
  const cached = backupMetaCache.get(project_id);
  if (!cached) return null;
  if (Date.now() - cached.at > CACHE_TTL_MS) {
    backupMetaCache.delete(project_id);
    return null;
  }
  return cached.meta;
}

function readListingCache(key: string): DirectoryListingEntry[] | null {
  const cached = listingCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.at > CACHE_TTL_MS) {
    listingCache.delete(key);
    return null;
  }
  return cached.entries;
}

export function useBackupsCacheVersion(): number {
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

export function getCachedBackupsListing({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}): DirectoryListingEntry[] | null {
  if (!isBackupsPath(path)) {
    return null;
  }
  const parts = path.split("/").filter(Boolean);
  const meta = readBackupMeta(project_id);
  if (!meta) return null;
  if (parts.length === 1) {
    return meta.map(({ name, mtime }) => ({
      name,
      mtime,
      size: 0,
      isDir: true,
    }));
  }
  const backupName = parts[1];
  const backup =
    meta.find((entry) => entry.name === backupName) ??
    meta.find((entry) => entry.id === backupName);
  if (!backup) return null;
  return readListingCache(
    cacheKey({
      project_id,
      backup_id: backup.id,
      subpath: parts.slice(2).join("/"),
    }),
  );
}

export default function useBackupsListing({
  project_id,
  path,
  sortField = "name",
  sortDirection = "asc",
}: {
  project_id: string;
  path: string;
  sortField?: "name" | "mtime" | "size" | "type";
  sortDirection?: "asc" | "desc";
}): {
  listing: DirectoryListingEntry[] | null;
  error: any;
  refresh: () => void;
} {
  const [listing, setListing] = useState<DirectoryListingEntry[] | null>(null);
  const [error, setError] = useState<any>(null);
  const [tick, setTick] = useState(0);
  const requestId = useRef(0);
  const lastTick = useRef(0);

  const refresh = useCallback(() => setTick((x) => x + 1), []);

  useAsyncEffect(async () => {
    if (!isBackupsPath(path)) {
      setListing(null);
      setError(null);
      return;
    }
    const id = ++requestId.current;
    const force = tick !== lastTick.current;
    lastTick.current = tick;
    setListing(null);
    setError(null);
    try {
      const backups = await webapp_client.conat_client.hub.projects.getBackups({
        project_id,
        indexed_only: true,
      });
      if (requestId.current !== id) return;
      const meta: BackupMeta[] = backups.map(({ id, time }) => ({
        id,
        mtime: new Date(time).getTime(),
        name: new Date(time).toISOString(),
      }));
      backupMetaCache.set(project_id, { meta, at: Date.now() });
      notifyCacheListeners();

      // root .backups listing
      const parts = path.split("/").filter(Boolean);
      if (parts.length === 1) {
        const entries: DirectoryListingEntry[] = meta.map(({ name, mtime }) => {
          return {
            name,
            mtime,
            size: 0,
            isDir: true,
          };
        });
        entries.sort((a, b) => {
          if (a.mtime !== b.mtime) return b.mtime - a.mtime;
          return a.name.localeCompare(b.name);
        });
        if (requestId.current !== id) return;
        setListing(entries);
        setError(null);
        return;
      }

      // path inside a specific backup
      const backupName = parts[1];
      const backup =
        meta.find((b) => b.name === backupName) ??
        meta.find((b) => b.id === backupName);
      if (!backup) {
        throw new Error(`backup '${backupName}' not found`);
      }
      const subpath = parts.slice(2).join("/");
      const key = cacheKey({
        project_id,
        backup_id: backup.id,
        subpath,
      });
      const cached = !force ? readListingCache(key) : null;
      if (cached) {
        setListing(sortEntries(cached));
      }
      const entriesRaw = await listBackupFiles({
        key,
        project_id,
        backup_id: backup.id,
        subpath,
        force,
      });
      if (requestId.current !== id) return;
      const entries = sortEntries(entriesRaw);
      if (requestId.current !== id) return;
      setListing(entries);
      setError(null);
      prefetchSubdirs(project_id, backup.id, subpath, entries);
    } catch (err) {
      if (requestId.current !== id) return;
      setError(err);
      setListing(null);
    }
  }, [project_id, path, sortField, sortDirection, tick]);

  function sortEntries(
    entries: DirectoryListingEntry[],
  ): DirectoryListingEntry[] {
    const sorted = [...entries];
    sorted.sort(field_cmp(sortField));
    if (sortDirection === "desc") sorted.reverse();
    return sorted;
  }

  async function listBackupFiles({
    key,
    project_id,
    backup_id,
    subpath,
    force,
  }: {
    key: string;
    project_id: string;
    backup_id: string;
    subpath: string;
    force: boolean;
  }): Promise<DirectoryListingEntry[]> {
    if (!force) {
      const cached = readListingCache(key);
      if (cached) return cached;
    }
    const existing = inflight.get(key);
    if (existing) return await existing;
    const promise = (async () => {
      const raw =
        (await webapp_client.conat_client.hub.projects.getBackupFiles({
          project_id,
          id: backup_id,
          path: subpath,
        })) ?? [];
      const entries = raw.map(({ name, isDir, mtime, size }) => ({
        name,
        isDir,
        mtime,
        size,
      }));
      listingCache.set(key, { entries, at: Date.now() });
      notifyCacheListeners();
      return entries;
    })();
    inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(key);
    }
  }

  function prefetchSubdirs(
    projectId: string,
    backupId: string,
    basePath: string,
    entries: DirectoryListingEntry[],
  ) {
    const subdirs = entries
      .filter((entry) => entry.isDir)
      .slice(0, PREFETCH_LIMIT);
    if (!subdirs.length) return;
    for (const entry of subdirs) {
      const subpath = basePath ? `${basePath}/${entry.name}` : entry.name;
      const key = cacheKey({
        project_id: projectId,
        backup_id: backupId,
        subpath,
      });
      if (readListingCache(key) || inflight.has(key)) continue;
      void listBackupFiles({
        key,
        project_id: projectId,
        backup_id: backupId,
        subpath,
        force: false,
      }).catch(() => undefined);
    }
  }

  return useMemo(
    () => ({ listing, error, refresh }),
    [listing, error, refresh],
  );
}
