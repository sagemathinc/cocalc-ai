/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  type BeneathCopyOptions,
  type BeneathPath,
  beneathRelative,
  copyBeneath,
  kindBeneath,
  mkdirBeneath,
  renameBeneath,
  rmBeneath,
} from "./beneath-copy";
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

// Copies `source` to exactly `destination` (both beneath trusted roots),
// replacing whatever is there in one rename: the copy goes to a hidden sibling
// first, and a failed copy leaves the destination untouched. Every step is
// anchored beneath the destination root and refuses symlinks, so the project
// owning that root cannot redirect it (see beneath-copy.ts).
export async function replacePathFromStaging({
  source,
  destination,
  options,
}: {
  source: BeneathPath;
  destination: BeneathPath;
  options?: BeneathCopyOptions;
}): Promise<void> {
  const root = destination.root;
  const rel = beneathRelative(destination.path);
  if (!rel) {
    throw new Error("copy destination cannot be the root");
  }
  const parent = path.posix.dirname(rel);
  const basename = path.posix.basename(rel);
  const token = randomUUID();
  const sibling = (kind: string) => {
    const name = `.${basename}.cocalc-${kind}-${token}`;
    return parent === "." ? name : path.posix.join(parent, name);
  };
  const incoming = sibling("incoming");
  const previous = sibling("previous");
  if (parent !== ".") {
    mkdirBeneath(root, parent);
  }
  try {
    await copyBeneath({
      src: source,
      dest: { root, path: incoming },
      options: {
        ...options,
        recursive: options?.recursive ?? true,
        force: true,
        errorOnExist: false,
      },
    });
    if ((await kindBeneath(root, rel)) === "missing") {
      renameBeneath(root, incoming, rel, { noReplace: true });
      return;
    }
    renameBeneath(root, rel, previous, { noReplace: true });
    try {
      renameBeneath(root, incoming, rel, { noReplace: true });
    } catch (err) {
      try {
        renameBeneath(root, previous, rel, { noReplace: true });
      } catch (restoreErr) {
        const failure = new Error(
          `copy replacement and rollback both failed for ${rel}: ${err}; rollback: ${restoreErr}`,
        );
        // @ts-ignore -- Error.cause is unavailable in this package's lib target.
        failure.cause = restoreErr;
        throw failure;
      }
      throw err;
    }
    await rmBeneath(root, previous).catch(() => {});
  } finally {
    await rmBeneath(root, incoming).catch(() => {});
  }
}

// Installs `source` at `destination`. Ordinary copies merge (cp -T); only
// collection requests (`exact`) atomically replace the destination. Returns
// false when an exact no-clobber copy finds the destination already there.
export async function installPathFromStaging({
  source,
  destination,
  exact,
  options,
}: {
  source: BeneathPath;
  destination: BeneathPath;
  exact?: boolean;
  options?: BeneathCopyOptions;
}): Promise<boolean> {
  // The hub resolves array and base-relative sources to their final destination
  // paths. Ordinary copies must therefore use cp's -T-style merge semantics;
  // only collection requests explicitly opt into atomic replacement.
  if (!exact) {
    await copyBeneath({
      src: source,
      dest: destination,
      options: { ...options, recursive: options?.recursive ?? true },
    });
    return true;
  }

  const exists =
    (await kindBeneath(destination.root, destination.path)) !== "missing";
  if (exists && !(options?.force ?? true)) {
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

  await replacePathFromStaging({ source, destination, options });
  return true;
}
