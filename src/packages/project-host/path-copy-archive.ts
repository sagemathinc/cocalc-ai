/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  type BeneathCopyOptions,
  type BeneathPath,
  assertDistinctBeneath,
  beneathRelative,
  copyBeneath,
  copyDeadline,
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
// replacing whatever is there: the copy goes to a hidden sibling first, so a
// failed copy leaves the destination untouched; then the old destination is
// moved aside and the copy renamed into place. These are two renames, so a
// reader can briefly find nothing there, and if the host stops in between,
// the old copy remains at its hidden ".cocalc-previous*" name. Without force, the copy
// is placed only if nothing is there at that moment (one no-replace rename):
// false if something is (or ERR_FS_CP_EEXIST with errorOnExist). Every step
// is anchored beneath the destination root and refuses symlinks, so the
// project owning that root cannot redirect it (see beneath-copy.ts).
export async function replacePathFromStaging({
  source,
  destination,
  options,
}: {
  source: BeneathPath;
  destination: BeneathPath;
  options?: BeneathCopyOptions;
}): Promise<boolean> {
  const root = destination.root;
  const rel = beneathRelative(destination.path);
  if (!rel) {
    throw new Error("copy destination cannot be the root");
  }
  await assertDistinctBeneath(source, destination);
  const check = copyDeadline(options ?? {});
  const parent = path.posix.dirname(rel);
  const token = randomUUID();
  // Fixed-length names, whatever the length of the destination's own name.
  const sibling = (kind: string) => {
    const name = `.cocalc-${kind}-${token}`;
    return parent === "." ? name : path.posix.join(parent, name);
  };
  const incoming = sibling("incoming");
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
    const place = () => {
      check(); // never publish once the copy's deadline has passed
      renameBeneath(root, incoming, rel, { noReplace: true });
    };
    try {
      place();
      return true;
    } catch (err) {
      if (!hasCode(err, "EEXIST")) throw err;
    }
    if (!(options?.force ?? true)) {
      if (options?.errorOnExist) throw existsError();
      return false;
    }
    // Something is there: move it aside and place the copy. Others may create
    // or remove the destination meanwhile, so whatever is found there is
    // moved aside in turn (force replaces it), a few times at most.
    const asides: string[] = [];
    try {
      for (let attempt = 0; ; attempt++) {
        if (attempt >= 5) {
          throw new Error(
            `copy destination ${rel} kept changing; not replaced`,
          );
        }
        const aside = sibling(`previous${attempt}`);
        try {
          renameBeneath(root, rel, aside, { noReplace: true });
          asides.push(aside);
        } catch (err) {
          if (!hasCode(err, "ENOENT")) throw err; // gone meanwhile: place
        }
        try {
          place();
          break;
        } catch (err) {
          if (!hasCode(err, "EEXIST")) throw err;
        }
      }
    } catch (err) {
      // Put the original back; if its name is taken, say where it is kept.
      if (asides.length > 0) {
        try {
          renameBeneath(root, asides[0], rel, { noReplace: true });
        } catch (restoreErr) {
          const failure = new Error(
            `copy replacement failed for ${rel}: ${err}; the previous ${rel} is kept at ${asides[0]} (${restoreErr})`,
          );
          // @ts-ignore -- Error.cause is unavailable in this package's lib target.
          failure.cause = err;
          throw failure;
        }
      }
      throw err;
    }
    for (const aside of asides) {
      await rmBeneath(root, aside).catch(() => {});
    }
    return true;
  } finally {
    await rmBeneath(root, incoming).catch(() => {});
  }
}

function hasCode(err: unknown, code: string): boolean {
  return `${(err as Error)?.message ?? ""}`.startsWith(code);
}

function existsError(): Error {
  const err = new Error(
    "SystemError [ERR_FS_CP_EEXIST]: Target already exists",
  );
  // @ts-ignore -- Node's SystemError code is not part of Error.
  err.code = "ERR_FS_CP_EEXIST";
  return err;
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

  // Checked first to skip the copy; replacePathFromStaging enforces it again
  // when placing the copy, in case the destination appears meanwhile.
  const exists =
    (await kindBeneath(destination.root, destination.path)) !== "missing";
  if (exists && !(options?.force ?? true)) {
    if (options?.errorOnExist) throw existsError();
    return false;
  }

  return await replacePathFromStaging({ source, destination, options });
}
