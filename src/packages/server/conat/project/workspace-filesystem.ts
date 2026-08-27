/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { join } from "node:path";

import { localPathFileserver } from "@cocalc/backend/conat/files/local-path";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { extractProjectSubject } from "@cocalc/conat/auth/subject-policy";
import type { Client } from "@cocalc/conat/core/client";
import {
  fsSubject,
  type FilesystemJupyterHandlers,
} from "@cocalc/conat/files/fs";
import { createServer as createReadServer } from "@cocalc/conat/files/read";
import {
  importJupyterIpynb,
  saveJupyterIpynb,
  type JupyterFilesystemBlobStore,
} from "@cocalc/jupyter/ipynb/filesystem";
import { getBlob, saveBlob } from "../api/db";

function projectIdFromSubject(subject: string): string {
  const project_id = extractProjectSubject(subject);
  if (!project_id) {
    throw new Error(`invalid workspace filesystem subject '${subject}'`);
  }
  return project_id;
}

export function createWorkspaceJupyterFilesystemHandlers(): FilesystemJupyterHandlers {
  const blobStore: JupyterFilesystemBlobStore = {
    async loadBlob({ project_id, uuid }) {
      const result = await getBlob({ project_id, uuid });
      if (result.blob == null) {
        return;
      }
      return { bytes: Buffer.from(result.blob, "base64") };
    },
    async saveBlob({ project_id, bytes, content_id, filename }) {
      const { uuid } = await saveBlob({
        project_id,
        uuid: content_id,
        blob: bytes.toString("base64"),
      });
      return {
        uuid,
        url: `/blobs/${encodeURIComponent(filename)}?uuid=${uuid}`,
      };
    },
  };

  return {
    async importIpynb({ subject, ipynb }) {
      return await importJupyterIpynb({
        project_id: projectIdFromSubject(subject),
        ipynb,
        blobStore,
      });
    },
    async saveIpynb({ subject, path, ipynb, fs }) {
      return await saveJupyterIpynb({
        project_id: projectIdFromSubject(subject),
        path,
        ipynb,
        fs,
        blobStore,
      });
    },
  };
}

// Canonical home advertised by workspace projects.  The project process uses
// the real workspace directory as HOME, so every filesystem boundary that
// serves workspace projects must translate this alias the same way.
const WORKSPACE_HOME_ALIASES = ["/home/user"];

// Name of the always-on streaming read service for workspace file downloads.
// Unlike the project-local `files:read` service, this one is served by the hub
// and therefore also answers for projects that are not running.
export const WORKSPACE_FILE_DOWNLOAD_READ_SERVICE = ":workspace";

// Stable queue group so that if more than one hub process ever serves the same
// workspace, exactly one of them answers each read request.  The project-local
// and project-host readers do not need this because only one process can ever
// register those subjects.
const WORKSPACE_FILE_DOWNLOAD_READ_QUEUE = "workspace-file-download-read";

// `createReadServer` accounts active streams against a counter that is global to
// the process.  Project-local readers each live in their own project process, so
// the default budget is effectively per project; the hub-side reader serves every
// workspace project from one process, so that same budget would be shared across
// all of them and a few slow downloads could starve unrelated projects.  Size it
// explicitly for a centralized service instead.
const WORKSPACE_FILE_DOWNLOAD_MAX_ACTIVE_STREAMS = parsePositiveInt(
  process.env.COCALC_WORKSPACE_FILE_READ_MAX_ACTIVE,
  128,
);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function requireProjectPath(path?: string): string {
  if (!path) {
    throw new Error(
      "COCALC_PROJECT_PATH must be set to serve workspace project files",
    );
  }
  return path;
}

// A filesystem view of one workspace project, configured exactly like the one
// startWorkspaceFilesystem serves.  Keeping the construction here is what makes
// the streaming reader, stat and cleanup resolve paths identically.
export function workspaceProjectFilesystem({
  project_id,
  path = process.env.COCALC_PROJECT_PATH,
}: {
  project_id: string;
  path?: string;
}): SandboxedFilesystem {
  return new SandboxedFilesystem(join(requireProjectPath(path), project_id), {
    unsafeMode: false,
    host: project_id,
    homeAliases: WORKSPACE_HOME_ALIASES,
  });
}

const fileDownloadReadServers = new Map<string, Promise<void>>();

// The read service subscribes per project, so keep one lazily created server
// per project id.
export async function ensureWorkspaceFileDownloadReadServer({
  client,
  project_id,
  path = process.env.COCALC_PROJECT_PATH,
}: {
  client: Client;
  project_id: string;
  path?: string;
}): Promise<{ readServiceName: string; statSubject: string }> {
  const readServiceName = WORKSPACE_FILE_DOWNLOAD_READ_SERVICE;
  const statSubject = fsSubject({ project_id });
  let server = fileDownloadReadServers.get(project_id);
  if (server == null) {
    server = createReadServer({
      client,
      project_id,
      name: readServiceName,
      queue: WORKSPACE_FILE_DOWNLOAD_READ_QUEUE,
      maxActiveStreams: WORKSPACE_FILE_DOWNLOAD_MAX_ACTIVE_STREAMS,
      // Stream through the sandbox's own verified handle.  Resolving to an
      // absolute path and reopening it by name would leave a window in which
      // the file could be swapped for a symlink pointing outside the project.
      createReadStream: async (requestedPath: string, opts?: any) =>
        await workspaceProjectFilesystem({ project_id, path }).createReadStream(
          requestedPath,
          opts,
        ),
    })
      .then(() => undefined)
      .catch((err) => {
        fileDownloadReadServers.delete(project_id);
        throw err;
      });
    fileDownloadReadServers.set(project_id, server);
  }
  await server;
  return { readServiceName, statSubject };
}

export function closeWorkspaceFileDownloadReadServers() {
  fileDownloadReadServers.clear();
}

export async function startWorkspaceFilesystem({
  client,
  path = process.env.COCALC_PROJECT_PATH,
}: {
  client: Client;
  path?: string;
}) {
  requireProjectPath(path);
  return await localPathFileserver({
    client,
    path,
    unsafeMode: false,
    homeAliases: WORKSPACE_HOME_ALIASES,
    jupyter: createWorkspaceJupyterFilesystemHandlers(),
  });
}
