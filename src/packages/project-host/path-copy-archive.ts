/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

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
}: {
  source: string;
  destination: string;
  destinationExists: boolean;
  exact?: boolean;
  options?: { force?: boolean; errorOnExist?: boolean };
  copy: (source: string, destination: string) => Promise<void>;
}): Promise<boolean> {
  // The hub resolves array and base-relative sources to their final destination
  // paths. Ordinary copies must therefore use cp's -T-style merge semantics;
  // only collection requests explicitly opt into atomic replacement.
  if (!exact) {
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
