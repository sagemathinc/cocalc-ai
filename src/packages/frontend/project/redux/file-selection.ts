/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { List, Set as ImmutableSet } from "immutable";

import * as misc from "@cocalc/util/misc";

type FileActionChanges<FileAction extends string> = {
  checked_files: ImmutableSet<string>;
  file_action?: FileAction | undefined;
};

export function nextSelectedFileIndex({
  selectedFileIndex,
  numDisplayedFiles,
  delta,
}: {
  selectedFileIndex?: number;
  numDisplayedFiles?: number;
  delta: 1 | -1;
}): number | undefined {
  const selected = selectedFileIndex ?? 0;
  if (delta > 0) {
    return selected + 1 < (numDisplayedFiles ?? 0) ? selected + 1 : undefined;
  }
  return selected > 0 ? selected - 1 : undefined;
}

export function selectedFileRange({
  file,
  listing,
  currentPath,
  mostRecentFileClick,
}: {
  file: string;
  listing: { name: string }[];
  currentPath: string;
  mostRecentFileClick?: string;
}): string[] {
  if (mostRecentFileClick == null) {
    return [file];
  }
  const names = listing.map(({ name }) => misc.path_to_file(currentPath, name));
  return misc.get_array_range(names, mostRecentFileClick, file);
}

export function setFileCheckedState<FileAction extends string>({
  checkedFiles,
  fileAction,
  allowsMultipleFiles,
  file,
  checked,
}: {
  checkedFiles: ImmutableSet<string>;
  fileAction?: FileAction;
  allowsMultipleFiles: (action: FileAction) => boolean;
  file: string;
  checked: boolean;
}): Partial<FileActionChanges<FileAction>> {
  const nextCheckedFiles = checked
    ? checkedFiles.add(file)
    : checkedFiles.delete(file);
  const changes: Partial<FileActionChanges<FileAction>> = {
    checked_files: nextCheckedFiles,
  };
  if (
    checked &&
    fileAction != null &&
    nextCheckedFiles.size > 1 &&
    !allowsMultipleFiles(fileAction)
  ) {
    changes.file_action = undefined;
  } else if (!checked && nextCheckedFiles.size === 0) {
    changes.file_action = undefined;
  }
  return changes;
}

export function setFileListCheckedState<FileAction extends string>({
  checkedFiles,
  fileAction,
  allowsMultipleFiles,
  fileList,
}: {
  checkedFiles: ImmutableSet<string>;
  fileAction?: FileAction;
  allowsMultipleFiles: (action: FileAction) => boolean;
  fileList: List<string> | string[];
}): FileActionChanges<FileAction> {
  const nextCheckedFiles = checkedFiles.union(fileList);
  const changes: FileActionChanges<FileAction> = {
    checked_files: nextCheckedFiles,
  };
  if (
    fileAction != null &&
    nextCheckedFiles.size > 1 &&
    !allowsMultipleFiles(fileAction)
  ) {
    changes.file_action = undefined;
  }
  return changes;
}

export function setFileListUncheckedState<FileAction extends string>({
  checkedFiles,
  fileList,
}: {
  checkedFiles: ImmutableSet<string>;
  fileList: List<string> | string[];
}): FileActionChanges<FileAction> {
  const nextCheckedFiles = checkedFiles.subtract(fileList);
  const changes: FileActionChanges<FileAction> = {
    checked_files: nextCheckedFiles,
  };
  if (nextCheckedFiles.size === 0) {
    changes.file_action = undefined;
  }
  return changes;
}

export function suggestDuplicateFilenameInDirectory({
  name,
  filesInDir,
}: {
  name: string;
  filesInDir: Record<string, unknown>;
}): string {
  while (true) {
    name = misc.suggest_duplicate_filename(name);
    if (!filesInDir[name]) {
      return name;
    }
  }
}

export function uniqueFileActionPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter(Boolean)));
}
