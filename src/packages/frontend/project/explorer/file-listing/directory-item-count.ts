/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { BACKUPS, isBackupsPath } from "@cocalc/util/consts/backups";
import * as misc from "@cocalc/util/misc";

import { computeFileMasks } from "@cocalc/frontend/project/explorer/compute-file-masks";
import type { DirectoryListingEntry } from "@cocalc/frontend/project/explorer/types";
import { getCachedBackupsListing } from "@cocalc/frontend/project/listing/use-backups";
import {
  getCacheId,
  getFiles,
  type Files,
} from "@cocalc/frontend/project/listing/use-files";

function filesToEntries(files: Files): DirectoryListingEntry[] {
  return Object.entries(files).map(([name, entry]) => ({ name, ...entry }));
}

export function countVisibleDirectoryEntries({
  entries,
  showHidden,
  hideMaskedFiles,
}: {
  entries: DirectoryListingEntry[];
  showHidden: boolean;
  hideMaskedFiles: boolean;
}): number {
  const filtered = entries
    .filter((entry) => entry.name !== "." && entry.name !== "..")
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .map((entry) => ({ ...entry }));
  if (hideMaskedFiles) {
    computeFileMasks(filtered);
  }
  return filtered.filter((entry) => !hideMaskedFiles || !entry.mask).length;
}

export function getCachedDirectoryItemCount({
  project_id,
  current_path,
  dirName,
  showHidden,
  hideMaskedFiles,
}: {
  project_id: string;
  current_path: string;
  dirName: string;
  showHidden: boolean;
  hideMaskedFiles: boolean;
}): number | null {
  const dirPath = misc.path_to_file(current_path, dirName);
  let entries: DirectoryListingEntry[] | null = null;
  if (
    dirPath === BACKUPS ||
    isBackupsPath(current_path) ||
    isBackupsPath(dirPath)
  ) {
    entries = getCachedBackupsListing({ project_id, path: dirPath });
  } else {
    const files = getFiles({
      cacheId: getCacheId({ project_id }),
      path: dirPath,
    });
    if (files != null) {
      entries = filesToEntries(files);
    }
  }
  if (entries == null) {
    return null;
  }
  return countVisibleDirectoryEntries({
    entries,
    showHidden,
    hideMaskedFiles,
  });
}
