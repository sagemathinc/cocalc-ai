/*
 *  This file is part of CoCalc: Copyright © 2024 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
// To debug starred files in the browser console:
c = cc.client.conat_client
bm = await c.dkv({account_id: cc.client.account_id, name: 'bookmark-starred-files'})
// Check all bookmark data
console.log('All bookmarks:', bm.getAll())
// Check specific project bookmarks
console.log('Project bookmarks (get):', bm.get("[project_id]"))
// Set starred files for a project
bm.set(project_id, ['file1.txt', 'folder/file2.md'])
// Listen to changes
bm.on('change', (e) => console.log('Bookmark change:', e))
 */

import { sortBy, uniq } from "lodash";
import { useEffect, useRef, useState } from "react";

import { webapp_client } from "@cocalc/frontend/webapp-client";
import { waitForPersistAccountId } from "@cocalc/frontend/project/explorer/persist-account-id";
import { CONAT_BOOKMARKS_KEY } from "@cocalc/util/consts/bookmarks";
import { path_split, path_to_file } from "@cocalc/util/misc";
import type { FlyoutActiveStarred } from "./state";

// Starred files are now managed entirely through conat with in-memory state.
// No local storage dependency - conat handles synchronization and persistence.
export function useStarredFilesManager(
  project_id: string,
  enabled: boolean = true,
) {
  const [starred, setStarred] = useState<FlyoutActiveStarred>([]);
  const [bookmarks, setBookmarks] = useState<any>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const listenerRef = useRef<
    | ((changeEvent: {
        key: string;
        value?: string[];
        prev?: string[];
      }) => void)
    | null
  >(null);

  // Initialize conat bookmarks once on mount, waiting for authentication
  useEffect(() => {
    let conatBookmarks: any = null;
    let isMounted = true;
    (async () => {
      if (!enabled) {
        setBookmarks(null);
        setStarred([]);
        setIsInitialized(true);
        return;
      }

      setBookmarks(null);
      setStarred([]);
      setIsInitialized(false);

      // Wait until account is authenticated
      const account_id = await waitForPersistAccountId();
      if (!isMounted) {
        return;
      }
      try {
        conatBookmarks = await initializeConatBookmarks(account_id);
      } finally {
        if (!isMounted) {
          if (conatBookmarks && listenerRef.current) {
            conatBookmarks.off("change", listenerRef.current);
            listenerRef.current = null;
          }
        }
      }
    })();

    return () => {
      isMounted = false;
      if (conatBookmarks && listenerRef.current) {
        conatBookmarks.off("change", listenerRef.current);
        listenerRef.current = null;
      }
    };
  }, [enabled, project_id]);

  async function initializeConatBookmarks(account_id: string) {
    try {
      const conatBookmarks = await webapp_client.conat_client.dkv<string[]>({
        account_id,
        name: CONAT_BOOKMARKS_KEY,
      });

      conatBookmarks.setMaxListeners(100);

      setBookmarks(conatBookmarks);

      // Listen for changes from other clients
      listenerRef.current = (changeEvent: {
        key: string;
        value?: string[];
        prev?: string[];
      }) => {
        if (changeEvent.key === project_id) {
          const remoteStars = changeEvent.value || [];
          setStarred(sortBy(uniq(remoteStars)));
        }
      };
      conatBookmarks.on("change", listenerRef.current);

      // Load initial data from conat
      const initialStars = conatBookmarks.get(project_id) || [];
      if (Array.isArray(initialStars)) {
        setStarred(sortBy(uniq(initialStars)));
      }

      setIsInitialized(true);
      return conatBookmarks;
    } catch (err) {
      console.warn(`conat bookmark initialization warning -- ${err}`);
      setIsInitialized(true); // Set initialized even on error to avoid infinite loading
      return null;
    }
  }

  function setStarredPath(path: string, starState: boolean) {
    if (!bookmarks || !isInitialized) {
      console.warn("Conat bookmarks not yet initialized");
      return;
    }

    const next = starState
      ? sortBy(uniq([...starred, path]))
      : starred.filter((p) => p !== path);

    // Update local state immediately for responsive UI
    setStarred(next);

    // Store to conat (this will also trigger the change event for other clients)
    try {
      bookmarks.set(project_id, next);
    } catch (err) {
      console.warn(`conat bookmark storage warning -- ${err}`);
      // Revert local state on error
      setStarred(starred);
    }
  }

  return {
    starred,
    setStarredPath,
  };
}

export async function migrateStarsOnMove(
  project_id: string,
  srcPaths: string[],
  destDir: string,
): Promise<void> {
  try {
    const account_id = await waitForPersistAccountId();

    const bookmarks = await webapp_client.conat_client.dkv<string[]>({
      account_id,
      name: CONAT_BOOKMARKS_KEY,
    });
    const current: string[] = bookmarks.get(project_id) ?? [];
    if (current.length === 0) return;

    const starredSet = new Set(current);
    let changed = false;

    for (const src of srcPaths) {
      const tail = path_split(src).tail;
      const newPath = path_to_file(destDir, tail);
      for (const oldKey of [src, `${src}/`]) {
        if (!starredSet.has(oldKey)) continue;
        starredSet.delete(oldKey);
        starredSet.add(oldKey.endsWith("/") ? `${newPath}/` : newPath);
        changed = true;
      }
    }

    if (changed) {
      bookmarks.set(project_id, sortBy(Array.from(starredSet)));
    }
  } catch (err) {
    console.warn("migrateStarsOnMove failed:", err);
  }
}
