/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Filesystem as ConatFilesystem } from "@cocalc/conat/files/fs";
import {
  normalizeProjectViewerPolicyPath,
  viewerReadPolicyAllowsPath,
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
