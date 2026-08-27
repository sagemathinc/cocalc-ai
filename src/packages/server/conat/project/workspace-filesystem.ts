/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createReadStream } from "node:fs";
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
      createReadStream: async (requestedPath: string, opts?: any) => {
        const fs = workspaceProjectFilesystem({ project_id, path });
        const absPath = await fs.safeAbsPath(requestedPath);
        return createReadStream(absPath, opts);
      },
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
