/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { dirname, normalize } from "path";

import type { DirectoryListingEntry } from "../types";

const PARENT_DIRECTORY_ROW: DirectoryListingEntry = {
  name: "..",
  isDir: true,
  size: -1,
  mtime: 0,
};

function normalizeListingPath(path: string): string {
  const normalized = normalize(path || "/");
  if (normalized === ".") return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function parentDirectoryPath(path: string): string {
  const normalized = normalizeListingPath(path);
  if (normalized === "/") return "/";
  return dirname(normalized) || "/";
}

export function isParentDirectoryRow(
  entry: Pick<DirectoryListingEntry, "name">,
): boolean {
  return entry.name === "..";
}

export function hasRealListingRows(
  listing: Pick<DirectoryListingEntry, "name">[],
): boolean {
  return listing.some((entry) => !isParentDirectoryRow(entry));
}

export function withParentDirectoryRow({
  currentPath,
  fileSearch,
  listing,
}: {
  currentPath: string;
  fileSearch: string;
  listing: DirectoryListingEntry[];
}): DirectoryListingEntry[] {
  if (fileSearch.trim() !== "" || normalizeListingPath(currentPath) === "/") {
    return listing;
  }
  if (listing.some(isParentDirectoryRow)) {
    return listing;
  }
  return [{ ...PARENT_DIRECTORY_ROW }, ...listing];
}
