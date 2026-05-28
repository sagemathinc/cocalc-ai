/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Filesystem as ConatFilesystem } from "@cocalc/conat/files/fs";
import {
  normalizeProjectViewerPolicyPath,
  viewerReadPolicyAllowsPath,
  viewerReadPolicyMayAllowDescendant,
  type ProjectViewerReadPolicy,
} from "@cocalc/util/project-access";
import { projectRuntimeHomeRelativePath } from "@cocalc/util/project-runtime";

function viewerAccessDenied(path: string): NodeJS.ErrnoException {
  const err = new Error(
    `EACCES: permission denied by viewer read policy, open '${path}'`,
  ) as NodeJS.ErrnoException;
  err.code = "EACCES";
  err.errno = -13;
  err.path = path;
  err.syscall = "open";
  return err;
}

async function assertViewerPathAllowed({
  fs,
  readPolicy,
  path,
}: {
  fs: ConatFilesystem;
  readPolicy: ProjectViewerReadPolicy;
  path: string;
}): Promise<string> {
  if (typeof fs.canonicalSyncIdentityPath !== "function") {
    throw new Error("project filesystem does not support canonical paths");
  }
  const canonicalIdentity = await fs.canonicalSyncIdentityPath(path);
  const relativeHomePath = projectRuntimeHomeRelativePath(canonicalIdentity);
  const canonical =
    canonicalIdentity.startsWith("/") && relativeHomePath == null
      ? undefined
      : normalizeProjectViewerPolicyPath(relativeHomePath ?? canonicalIdentity);
  if (
    canonical == null ||
    !viewerReadPolicyAllowsPath({ policy: readPolicy, path: canonical })
  ) {
    throw viewerAccessDenied(path);
  }
  return canonical;
}

async function canonicalProjectRelativePath({
  fs,
  path,
}: {
  fs: ConatFilesystem;
  path: string;
}): Promise<string | undefined> {
  if (typeof fs.canonicalSyncIdentityPath !== "function") {
    throw new Error("project filesystem does not support canonical paths");
  }
  const canonicalIdentity = await fs.canonicalSyncIdentityPath(path);
  const relativeHomePath = projectRuntimeHomeRelativePath(canonicalIdentity);
  return canonicalIdentity.startsWith("/") && relativeHomePath == null
    ? undefined
    : normalizeProjectViewerPolicyPath(relativeHomePath ?? canonicalIdentity);
}

function joinViewerPath(parent: string, name: string): string {
  if (!parent || parent === ".") {
    return name;
  }
  return `${parent.replace(/\/+$/, "")}/${name}`;
}

function joinCanonicalPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function isDirectoryListingEntry(info: any): boolean {
  return info?.isDir === true || info?.type === "d";
}

async function viewerChildVisibleInListing({
  fs,
  readPolicy,
  parentPath,
  parentCanonical,
  name,
  info,
}: {
  fs: ConatFilesystem;
  readPolicy: ProjectViewerReadPolicy;
  parentPath: string;
  parentCanonical: string;
  name: string;
  info: any;
}): Promise<boolean> {
  const childPath = joinViewerPath(parentPath, name);
  try {
    await assertViewerPathAllowed({ fs, readPolicy, path: childPath });
    return true;
  } catch {}
  if (!isDirectoryListingEntry(info)) {
    return false;
  }
  return viewerReadPolicyMayAllowDescendant({
    policy: readPolicy,
    path: joinCanonicalPath(parentCanonical, name),
  });
}

export function createViewerReadOnlyFilesystem({
  fs,
  readPolicy,
}: {
  fs: ConatFilesystem;
  readPolicy: ProjectViewerReadPolicy;
}): ConatFilesystem {
  return {
    constants: async () => await fs.constants(),
    describeFile: async (path: string) => {
      await assertViewerPathAllowed({ fs, readPolicy, path });
      return await fs.describeFile(path);
    },
    exists: async (path: string) => {
      try {
        await assertViewerPathAllowed({ fs, readPolicy, path });
      } catch {
        return false;
      }
      return await fs.exists(path);
    },
    getListing: async (path: string) => {
      const canonical = await canonicalProjectRelativePath({ fs, path });
      if (canonical == null) {
        throw viewerAccessDenied(path);
      }
      if (
        !viewerReadPolicyAllowsPath({ policy: readPolicy, path: canonical }) &&
        !viewerReadPolicyMayAllowDescendant({
          policy: readPolicy,
          path: canonical,
        })
      ) {
        throw viewerAccessDenied(path);
      }
      const listing = await fs.getListing(path);
      const files = listing?.files ?? {};
      const filtered: typeof files = {};
      for (const [name, info] of Object.entries(files)) {
        if (
          await viewerChildVisibleInListing({
            fs,
            readPolicy,
            parentPath: path,
            parentCanonical: canonical,
            name,
            info,
          })
        ) {
          filtered[name] = info;
        }
      }
      return { ...listing, files: filtered };
    },
    lstat: async (path: string) => {
      await assertViewerPathAllowed({ fs, readPolicy, path });
      return await fs.lstat(path);
    },
    readFile: async (path: string, encoding?: string, lock?: number) => {
      await assertViewerPathAllowed({ fs, readPolicy, path });
      return await fs.readFile(path, encoding, lock);
    },
    readdir: async (path: string, options?: any) => {
      if (options?.recursive) {
        throw new Error("recursive viewer directory listing is not supported");
      }
      await assertViewerPathAllowed({ fs, readPolicy, path });
      const entries = await fs.readdir(path, options);
      if (!options?.withFileTypes) {
        const names = entries as string[];
        const allowed: string[] = [];
        for (const name of names) {
          const childPath = path ? `${path}/${name}` : name;
          try {
            await assertViewerPathAllowed({
              fs,
              readPolicy,
              path: childPath,
            });
            allowed.push(name);
          } catch {}
        }
        return allowed;
      }
      const allowed: any[] = [];
      for (const entry of entries as any[]) {
        const childPath = path ? `${path}/${entry.name}` : entry.name;
        try {
          await assertViewerPathAllowed({ fs, readPolicy, path: childPath });
          allowed.push(entry);
        } catch {}
      }
      return allowed as any;
    },
    readlink: async (path: string) => {
      await assertViewerPathAllowed({ fs, readPolicy, path });
      return await fs.readlink(path);
    },
    realpath: async (path: string) => {
      return await assertViewerPathAllowed({ fs, readPolicy, path });
    },
    canonicalSyncIdentityPath: async (path: string) => {
      return await assertViewerPathAllowed({ fs, readPolicy, path });
    },
    stat: async (path: string) => {
      await assertViewerPathAllowed({ fs, readPolicy, path });
      return await fs.stat(path);
    },
  } as ConatFilesystem;
}
