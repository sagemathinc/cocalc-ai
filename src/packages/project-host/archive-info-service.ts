/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import type { Client } from "@cocalc/conat/core/client";
import { extractProjectSubject } from "@cocalc/conat/auth/subject-policy";
import type {
  BackupFileEntry,
  BackupFindPreview,
  BackupFindResult,
  BackupSummary,
} from "@cocalc/conat/project/archive-info";
import type { FileTextPreview } from "@cocalc/conat/files/file-server";
import type { OversizedFilesReport } from "@cocalc/util/consts/backups";
import { fileServerClient } from "./file-server";

const logger = getLogger("project-host:archive-info");
const BACKUP_SEARCH_TIMEOUT_MS = 2 * 60_000;
const OVERSIZED_FILES_TIMEOUT_MS = 10 * 60_000;

export const PROJECT_ARCHIVE_INFO_SUBJECT = "project.*.archive-info.-";

function extractProjectId(subject?: string): string {
  const project_id = extractProjectSubject(`${subject ?? ""}`);
  if (!project_id) {
    throw new Error(`invalid project archive subject '${subject ?? ""}'`);
  }
  return project_id;
}

function requireClient(client?: Client): Client {
  if (client == null) {
    throw new Error("project archive info requires a local conat client");
  }
  return client;
}

async function getBackupsImpl({
  client,
  project_id,
  indexed_only,
}: {
  client: Client;
  project_id: string;
  indexed_only?: boolean;
}): Promise<BackupSummary[]> {
  return await fileServerClient(client).getBackups({
    project_id,
    indexed_only,
  });
}

async function getBackupFilesImpl({
  client,
  project_id,
  id,
  path,
}: {
  client: Client;
  project_id: string;
  id: string;
  path?: string;
}): Promise<BackupFileEntry[]> {
  return await fileServerClient(client).getBackupFiles({
    project_id,
    id,
    path,
  });
}

async function findBackupFilesImpl({
  client,
  project_id,
  glob,
  iglob,
  path,
  ids,
  preview,
  recursive,
}: {
  client: Client;
  project_id: string;
  glob?: string[];
  iglob?: string[];
  path?: string;
  ids?: string[];
  preview?: boolean;
  recursive?: boolean;
}): Promise<BackupFindResult[] | BackupFindPreview> {
  return await fileServerClient(
    client,
    BACKUP_SEARCH_TIMEOUT_MS,
  ).findBackupFiles({
    project_id,
    glob,
    iglob,
    path,
    ids,
    preview,
    recursive,
  });
}

async function getBackupFileTextImpl({
  client,
  project_id,
  id,
  path,
  max_bytes,
}: {
  client: Client;
  project_id: string;
  id: string;
  path: string;
  max_bytes?: number;
}): Promise<FileTextPreview> {
  return await fileServerClient(client).getBackupFileText({
    project_id,
    id,
    path,
    max_bytes,
  });
}

async function getSnapshotFileTextImpl({
  client,
  project_id,
  snapshot,
  path,
  max_bytes,
}: {
  client: Client;
  project_id: string;
  snapshot: string;
  path: string;
  max_bytes?: number;
}): Promise<FileTextPreview> {
  return await fileServerClient(client).getSnapshotFileText({
    project_id,
    snapshot,
    path,
    max_bytes,
  });
}

export async function handleProjectGetBackupsRequest(
  this: { subject?: string },
  opts?: { indexed_only?: boolean },
  client?: Client,
): Promise<BackupSummary[]> {
  return await getBackupsImpl({
    client: requireClient(client),
    project_id: extractProjectId(this?.subject),
    indexed_only: opts?.indexed_only,
  });
}

export async function handleProjectGetBackupFilesRequest(
  this: { subject?: string },
  opts: { id: string; path?: string },
  client?: Client,
): Promise<BackupFileEntry[]> {
  return await getBackupFilesImpl({
    client: requireClient(client),
    project_id: extractProjectId(this?.subject),
    id: opts?.id,
    path: opts?.path,
  });
}

export async function handleProjectFindBackupFilesRequest(
  this: { subject?: string },
  opts: {
    glob?: string[];
    iglob?: string[];
    path?: string;
    ids?: string[];
    preview?: boolean;
    recursive?: boolean;
  },
  client?: Client,
): Promise<BackupFindResult[] | BackupFindPreview> {
  return await findBackupFilesImpl({
    client: requireClient(client),
    project_id: extractProjectId(this?.subject),
    glob: opts?.glob,
    iglob: opts?.iglob,
    path: opts?.path,
    ids: opts?.ids,
    preview: opts?.preview,
    recursive: opts?.recursive,
  });
}

export async function handleProjectGetBackupFileTextRequest(
  this: { subject?: string },
  opts: { id: string; path: string; max_bytes?: number },
  client?: Client,
): Promise<FileTextPreview> {
  return await getBackupFileTextImpl({
    client: requireClient(client),
    project_id: extractProjectId(this?.subject),
    id: opts?.id,
    path: opts?.path,
    max_bytes: opts?.max_bytes,
  });
}

export async function handleProjectGetSnapshotFileTextRequest(
  this: { subject?: string },
  opts: { snapshot: string; path: string; max_bytes?: number },
  client?: Client,
): Promise<FileTextPreview> {
  return await getSnapshotFileTextImpl({
    client: requireClient(client),
    project_id: extractProjectId(this?.subject),
    snapshot: opts?.snapshot,
    path: opts?.path,
    max_bytes: opts?.max_bytes,
  });
}

export async function handleProjectGetOversizedFilesRequest(
  this: { subject?: string },
  opts: { paths?: string[] } | undefined,
  client?: Client,
): Promise<OversizedFilesReport | null> {
  const paths = opts?.paths;
  if (
    paths != null &&
    (!Array.isArray(paths) ||
      paths.length > 1000 ||
      paths.some((path) => typeof path !== "string"))
  ) {
    throw new Error("paths must be an array of at most 1000 strings");
  }
  return await fileServerClient(
    requireClient(client),
    OVERSIZED_FILES_TIMEOUT_MS,
  ).getOversizedFiles({
    project_id: extractProjectId(this?.subject),
    paths,
  });
}

export async function initProjectArchiveInfoService(client: Client) {
  logger.debug("starting project archive info service", {
    subject: PROJECT_ARCHIVE_INFO_SUBJECT,
  });
  return await client.service(PROJECT_ARCHIVE_INFO_SUBJECT, {
    getBackups(opts?: { indexed_only?: boolean }) {
      return handleProjectGetBackupsRequest.call(this, opts, client);
    },
    getBackupFiles(opts: { id: string; path?: string }) {
      return handleProjectGetBackupFilesRequest.call(this, opts, client);
    },
    findBackupFiles(opts: {
      glob?: string[];
      iglob?: string[];
      path?: string;
      ids?: string[];
      preview?: boolean;
      recursive?: boolean;
    }) {
      return handleProjectFindBackupFilesRequest.call(this, opts, client);
    },
    getBackupFileText(opts: { id: string; path: string; max_bytes?: number }) {
      return handleProjectGetBackupFileTextRequest.call(this, opts, client);
    },
    getSnapshotFileText(opts: {
      snapshot: string;
      path: string;
      max_bytes?: number;
    }) {
      return handleProjectGetSnapshotFileTextRequest.call(this, opts, client);
    },
    getOversizedFiles(opts?: { paths?: string[] }) {
      return handleProjectGetOversizedFilesRequest.call(this, opts, client);
    },
  });
}
