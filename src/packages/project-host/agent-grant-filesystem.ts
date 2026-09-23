/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { Filesystem } from "@cocalc/conat/files/fs";
import type { AgentFileGrantMode } from "@cocalc/conat/agents/file-grants";
import {
  PROJECT_VIEWER_SENSITIVE_PATHS,
  type ProjectViewerReadPolicy,
} from "@cocalc/util/project-access";
import {
  assertViewerCanonicalPathAllowed,
  createViewerReadOnlyFilesystem,
} from "./viewer-read-only-filesystem";

export function createAgentGrantFilesystem({
  fs,
  readPolicy,
  authorize,
}: {
  fs: Filesystem;
  readPolicy: ProjectViewerReadPolicy;
  authorize: () => Promise<{ mode?: AgentFileGrantMode }>;
}): Filesystem {
  const reads = createViewerReadOnlyFilesystem({
    fs,
    readPolicy,
    authorize: async () => {
      await authorize();
    },
  });
  const deny = () => {
    throw Object.assign(
      new Error("EACCES: file grant does not permit this mutation"),
      { code: "EACCES" },
    );
  };
  async function writable() {
    if ((await authorize()).mode !== "read-write") deny();
  }
  async function check(path: string, tree = false): Promise<void> {
    if (typeof path !== "string" || !path || path.includes("\0")) deny();
    // Reject symlink components, including dangling links, before resolving a
    // new destination. This is not isolation from concurrent target writers.
    const relative = path.replace(/^\/home\/user\/?/, "");
    if (relative.startsWith("/") || relative.split("/").includes("..")) deny();
    const parts = relative.split("/").filter((part) => part && part !== ".");
    for (let i = 1; i <= parts.length; i++) {
      try {
        const stat = await fs.lstat(parts.slice(0, i).join("/"));
        if ((stat.mode & 0o170000) === 0o120000) deny();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    const canonicalIdentity = await fs.canonicalSyncIdentityPath!(path);
    const canonical = assertViewerCanonicalPathAllowed({
      canonicalIdentity,
      readPolicy,
      path,
    });
    if (
      tree &&
      PROJECT_VIEWER_SENSITIVE_PATHS.some(
        (excluded) =>
          !canonical ||
          excluded === canonical ||
          excluded.startsWith(`${canonical}/`),
      )
    )
      deny();
  }
  return {
    ...reads,
    writeFile: async (path, data, saveLast) => {
      await writable();
      await check(path);
      // No implicit sibling backup outside a single-file grant.
      if (saveLast) deny();
      await fs.writeFile(path, data, false);
    },
    mkdir: async (path, options) => {
      await writable();
      await check(path);
      if (options && Object.keys(options).some((key) => key !== "recursive"))
        deny();
      if (options?.recursive) {
        const parts = path
          .replace(/^\/home\/user\/?/, "")
          .split("/")
          .filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join("/");
          if (!(await fs.exists(parent))) await check(parent);
        }
      }
      await fs.mkdir(path, { recursive: options?.recursive === true });
    },
    rename: async (source, dest) => {
      await writable();
      await check(source, true);
      await check(dest, true);
      await fs.rename(source, dest);
    },
    copyFile: async (source, dest) => {
      await writable();
      await check(source);
      await check(dest);
      await fs.copyFile(source, dest);
    },
    rm: async (path, options) => {
      await writable();
      if (
        typeof path !== "string" ||
        options?.sudo ||
        (options &&
          Object.keys(options).some(
            (key) => !["recursive", "force"].includes(key),
          ))
      )
        deny();
      await check(path as string, true);
      await fs.rm(path, {
        recursive: options?.recursive === true,
        force: options?.force === true,
      });
    },
  } as Filesystem;
}
