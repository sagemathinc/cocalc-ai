/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { basename, dirname, join } from "path";

import type { FilesystemClient } from "@cocalc/conat/files/fs";
import * as misc from "@cocalc/util/misc";

import { getFileTemplate } from "../templates";

const BAD_FILENAME_CHARACTERS = "\\";
const BAD_LATEX_FILENAME_CHARACTERS = '\'"()"~%$';
const BANNED_FILE_TYPES = new Set(["doc", "docx", "pdf", "sws"]);

type LogProjectEvent = (event: any) => string | undefined;

export function constructAbsolutePath({
  name,
  currentPath,
  ext,
  toAbsoluteCurrentPath,
}: {
  name: string;
  currentPath: string;
  ext?: string;
  toAbsoluteCurrentPath: (path: string) => string;
}): string {
  if (name.length === 0) {
    throw Error("Cannot use empty filename");
  }
  for (const bad_char of BAD_FILENAME_CHARACTERS) {
    if (name.indexOf(bad_char) !== -1) {
      throw Error(`Cannot use '${bad_char}' in a filename`);
    }
  }
  let path = misc.path_to_file(toAbsoluteCurrentPath(currentPath), name);
  if (ext != null && misc.filename_extension(path) !== ext) {
    path = `${path}.${ext}`;
  }
  return path;
}

export async function createFolder({
  name,
  currentPath,
  switch_over = true,
  fs,
  toAbsoluteCurrentPath,
  setFileCreationError,
  openDirectory,
  log,
}: {
  name: string;
  currentPath: string;
  switch_over?: boolean;
  fs: () => FilesystemClient;
  toAbsoluteCurrentPath: (path: string) => string;
  setFileCreationError: (error: string | undefined) => void;
  openDirectory: (path: string) => void | Promise<void>;
  log: LogProjectEvent;
}): Promise<void> {
  const basePath = toAbsoluteCurrentPath(currentPath);
  const path = join(basePath, name);
  try {
    await fs().mkdir(path, { recursive: true });
  } catch (err) {
    setFileCreationError(`${err}`);
  }
  if (switch_over) {
    openDirectory(path);
  }
  log({ event: "file_action", action: "created", files: [path + "/"] });
}

export async function createFile({
  name,
  ext,
  currentPath,
  switch_over = true,
  projectId,
  fs,
  toAbsoluteCurrentPath,
  setFileCreationError,
  createFolder,
  newFileFromWeb,
  ensureContainingDirectoryExists,
  log,
  getPreferredKernel,
  addCreatedTag,
  openFile,
}: {
  name: string;
  ext?: string;
  currentPath: string;
  switch_over?: boolean;
  projectId: string;
  fs: () => FilesystemClient;
  toAbsoluteCurrentPath: (path: string) => string;
  setFileCreationError: (error: string | undefined) => void;
  createFolder: (opts: {
    name: string;
    current_path?: string;
  }) => Promise<void>;
  newFileFromWeb: (url: string, currentPath: string) => void | Promise<void>;
  ensureContainingDirectoryExists: (path: string) => Promise<void>;
  log: LogProjectEvent;
  getPreferredKernel: () => string | null | undefined;
  addCreatedTag: (tag: string) => void;
  openFile: (opts: {
    path: string;
    explicit: true;
    foreground: true;
  }) => void | Promise<void>;
}): Promise<void> {
  setFileCreationError(undefined);
  if ((name === ".." || name === ".") && ext == null) {
    setFileCreationError("Cannot create a file named . or ..");
    return;
  }
  const basePath = toAbsoluteCurrentPath(currentPath);
  if (misc.is_only_downloadable(name)) {
    newFileFromWeb(name, basePath);
    return;
  }

  if (name[name.length - 1] === "/") {
    if (ext == null) {
      await createFolder({
        name,
        current_path: currentPath,
      });
      return;
    } else {
      name = name.slice(0, name.length - 1);
    }
  }

  let path = join(basePath, name);
  if (ext) {
    path += "." + ext;
  }
  ext = misc.filename_extension(path);

  if (BANNED_FILE_TYPES.has(ext)) {
    setFileCreationError(`Cannot create a file with the ${ext} extension`);
    return;
  }
  if (ext === "tex") {
    const filename = misc.path_split(name).tail;
    for (const bad_char of BAD_LATEX_FILENAME_CHARACTERS) {
      if (filename.includes(bad_char)) {
        setFileCreationError(
          `Cannot use '${bad_char}' in a LaTeX filename '${filename}'`,
        );
        return;
      }
    }
  }
  const content =
    ext === "ipynb"
      ? await (
          await import("@cocalc/frontend/jupyter/new-notebook")
        ).createInitialIpynbContent(projectId, getPreferredKernel())
      : getFileTemplate(ext);
  await ensureContainingDirectoryExists(path);
  try {
    await fs().writeFile(path, content);
  } catch (err) {
    setFileCreationError(`${err}`);
    return;
  }
  log({ event: "file_action", action: "created", files: [path] });
  if (ext) {
    addCreatedTag(`create-${ext}`);
  }
  if (switch_over) {
    openFile({
      path,
      explicit: true,
      foreground: true,
    });
  }
}

export async function ensureContainingDirectoryExists({
  path,
  ensureDirectoryExists,
}: {
  path: string;
  ensureDirectoryExists: (path: string) => Promise<void>;
}): Promise<void> {
  await ensureDirectoryExists(dirname(path));
}

export async function ensureDirectoryExists({
  path,
  fs,
  getFilesCache,
}: {
  path: string;
  fs: () => FilesystemClient;
  getFilesCache: (path: string) => Record<string, any> | null;
}): Promise<void> {
  const v = getFilesCache(dirname(path));
  if (v?.[basename(path)]) {
    return;
  }
  try {
    await fs().mkdir(path, { recursive: true });
  } catch (err) {
    if ((err as any).code == "EEXISTS") {
      return;
    }
    throw err;
  }
}
