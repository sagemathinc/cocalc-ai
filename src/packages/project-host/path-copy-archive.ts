/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { SandboxRoot } from "@cocalc/openat2";

import { decodeTarCQuotedString } from "./legacy-migration/tar-output";

export function decodePathCopyArchiveListing(output: Buffer): string[] {
  const entries: string[] = [];
  for (const line of output.toString("utf8").split("\n")) {
    if (!line) continue;
    const { value, remainder } = decodeTarCQuotedString(line);
    if (remainder.trim()) {
      throw new Error(`unexpected output after archive path: ${remainder}`);
    }
    entries.push(value);
  }
  return entries;
}

export function archivePathIsAllowed({
  entry,
  allowedRoots,
}: {
  entry: string;
  allowedRoots: Set<string>;
}): boolean {
  const normalized = path.posix.normalize(entry.replace(/\\/g, "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized)
  ) {
    return false;
  }
  for (const root of allowedRoots) {
    if (normalized === root || normalized.startsWith(`${root}/`)) {
      return true;
    }
  }
  return false;
}

export async function replacePathFromStaging({
  source,
  destination,
  destinationExists,
  copy,
}: {
  source: string;
  destination: string;
  destinationExists: boolean;
  copy: (source: string, destination: string) => Promise<void>;
}): Promise<void> {
  const parent = path.dirname(destination);
  const basename = path.basename(destination);
  const token = randomUUID();
  const incoming = path.join(parent, `.${basename}.cocalc-incoming-${token}`);
  const previous = path.join(parent, `.${basename}.cocalc-previous-${token}`);
  await mkdir(parent, { recursive: true });
  try {
    await copy(source, incoming);
    if (!destinationExists) {
      await rename(incoming, destination);
      return;
    }
    await rename(destination, previous);
    try {
      await rename(incoming, destination);
    } catch (err) {
      try {
        await rename(previous, destination);
      } catch (restoreErr) {
        const failure = new Error(
          `copy replacement and rollback both failed for ${destination}: ${err}; rollback: ${restoreErr}`,
        );
        // @ts-ignore -- Error.cause is unavailable in this package's lib target.
        failure.cause = restoreErr;
        throw failure;
      }
      throw err;
    }
    await rm(previous, { recursive: true, force: true }).catch(() => {});
  } finally {
    await rm(incoming, { recursive: true, force: true }).catch(() => {});
  }
}

export async function installPathFromStaging({
  source,
  destination,
  destinationExists,
  exact,
  options,
  copy,
  home,
}: {
  source: string;
  destination: string;
  destinationExists: boolean;
  exact?: boolean;
  options?: { force?: boolean; errorOnExist?: boolean };
  copy: (source: string, destination: string) => Promise<void>;
  // The destination project's home. An ordinary copy beneath it lands each
  // file atomically (see mergePathFromStaging).
  home?: string;
}): Promise<boolean> {
  // The hub resolves array and base-relative sources to their final destination
  // paths. Ordinary copies must therefore use cp's -T-style merge semantics;
  // only collection requests explicitly opt into atomic replacement.
  if (!exact) {
    if (home != null && isBeneath(home, destination)) {
      await mergePathFromStaging({
        home,
        source,
        destination,
        options,
        copy,
      });
      return true;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await copy(source, destination);
    return true;
  }

  if (destinationExists && !(options?.force ?? true)) {
    if (options?.errorOnExist) {
      const err = new Error(
        "SystemError [ERR_FS_CP_EEXIST]: Target already exists",
      );
      // @ts-ignore -- Node's SystemError code is not part of Error.
      err.code = "ERR_FS_CP_EEXIST";
      throw err;
    }
    return false;
  }

  await replacePathFromStaging({
    source,
    destination,
    destinationExists,
    copy,
  });
  return true;
}

export function isBeneath(home: string, destination: string): boolean {
  const rel = path.relative(home, destination);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

function eexist(): Error {
  const err = new Error(
    "SystemError [ERR_FS_CP_EEXIST]: Target already exists",
  );
  // @ts-ignore -- Node's SystemError code is not part of Error.
  err.code = "ERR_FS_CP_EEXIST";
  return err;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

type Kind = "missing" | "dir" | "other";

// The kind of `rel` beneath the sandbox root, without following symlinks: a
// symlink is "other" (it is replaced, never written through), and a
// symlinked parent directory throws.
function kindOf(root: SandboxRoot, rel: string): Kind {
  try {
    return (root.stat(rel).mode & S_IFMT) === S_IFDIR ? "dir" : "other";
  } catch (err) {
    const code = `${(err as Error)?.message ?? ""}`.match(/^(E[A-Z]+)\b/)?.[1];
    if (code === "ENOENT") return "missing";
    if (code === "ELOOP") return "other";
    throw err;
  }
}

// An ordinary (merging, cp -T style) copy into a project's home in which each
// file appears atomically. Copying in place lets a reader see a file that is
// missing, empty or partly written: e.g. a student who opens an assignment
// while it is being handed out got an empty notebook (support ticket 21023).
// The source is first copied in full to a hidden sibling of the destination,
// then moved into place: a missing destination directory is renamed in one
// step, an existing one is merged entry by entry, and every file replaces its
// old version with a single rename. All moves go through an openat2 root at
// the home, so a symlink planted in the destination is never followed. As
// with cp: force=false keeps existing files (errorOnExist refuses an existing
// destination), and a file and a directory never replace each other.
export async function mergePathFromStaging({
  home,
  source,
  destination,
  options,
  copy,
}: {
  home: string;
  source: string;
  destination: string;
  options?: { force?: boolean; errorOnExist?: boolean };
  copy: (source: string, destination: string) => Promise<void>;
}): Promise<void> {
  if (!isBeneath(home, destination)) {
    throw new Error(
      `copy destination is not inside the project: ${destination}`,
    );
  }
  const force = options?.force ?? true;
  const root = new SandboxRoot(home);
  const rel = path.relative(home, destination);
  const parent = path.dirname(rel);
  if (parent !== ".") root.mkdir(parent, true);
  if (!force && options?.errorOnExist && kindOf(root, rel) !== "missing") {
    throw eexist();
  }
  const staging = path.join(
    parent,
    `.${path.basename(rel)}.cocalc-incoming-${randomUUID()}`,
  );
  try {
    await copy(source, path.join(home, staging));
    await place(root, home, staging, rel, force);
  } finally {
    await root.rm(staging, true, true).catch(() => {});
  }
}

async function place(
  root: SandboxRoot,
  home: string,
  from: string,
  to: string,
  force: boolean,
): Promise<void> {
  const fromKind = kindOf(root, from);
  const toKind = kindOf(root, to);
  if (fromKind === "missing") return;
  if (fromKind === "dir") {
    if (toKind === "missing") {
      root.rename(from, to);
      return;
    }
    if (toKind !== "dir") {
      throw new Error(`cannot overwrite non-directory ${to} with directory`);
    }
    for (const name of await readdir(path.join(home, from))) {
      await place(
        root,
        home,
        path.join(from, name),
        path.join(to, name),
        force,
      );
    }
    return;
  }
  if (toKind === "dir") {
    throw new Error(`cannot overwrite directory ${to} with non-directory`);
  }
  if (toKind !== "missing" && !force) return;
  root.rename(from, to);
}
