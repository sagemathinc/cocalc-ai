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
  if (listing.some((entry) => entry.name === "..")) {
    return listing;
  }
  return [{ ...PARENT_DIRECTORY_ROW }, ...listing];
}
