/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { projectSubject } from "@cocalc/conat/names";
import type { BackupAttemptStatus } from "@cocalc/util/types/backup-attempt";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import type {
  BackupFindPreview,
  BackupFindResult,
  FileTextPreview,
} from "@cocalc/conat/files/file-server";

export type { BackupFindPreview, BackupFindResult };

const SERVICE_NAME = "archive-info";
const BACKUP_SEARCH_TIMEOUT_MS = 2 * 60_000;

export interface BackupSummary {
  id: string;
  time: Date;
  summary: { [key: string]: string | number };
}

export interface BackupFileEntry {
  name: string;
  isDir: boolean;
  mtime: number;
  size: number;
}

interface Api {
  getBackupAttempt: () => Promise<BackupAttemptStatus | null>;
  getBackupCoverageReportChunk: (opts: {
    backup_id: string;
    offset: number;
  }) => Promise<
    import("@cocalc/util/types/backup-coverage").BackupCoverageReportChunk
  >;
  getBackupCoverage: (opts: {
    backup_id?: string;
    cursor?: string | null;
    acknowledgement_keys?: string[];
  }) => Promise<
    import("@cocalc/util/types/backup-coverage").BackupCoveragePage | null
  >;
  getBackups: (opts?: { indexed_only?: boolean }) => Promise<BackupSummary[]>;
  getBackupFiles: (opts: {
    id: string;
    path?: string;
  }) => Promise<BackupFileEntry[]>;
  findBackupFiles: (opts: {
    glob?: string[];
    iglob?: string[];
    path?: string;
    ids?: string[];
    preview?: boolean;
    recursive?: boolean;
  }) => Promise<BackupFindResult[] | BackupFindPreview>;
  getBackupFileText: (opts: {
    id: string;
    path: string;
    max_bytes?: number;
  }) => Promise<FileTextPreview>;
  getSnapshotFileText: (opts: {
    snapshot: string;
    path: string;
    max_bytes?: number;
  }) => Promise<FileTextPreview>;
}

export async function getBackupAttempt({
  client,
  project_id,
}: {
  client?: ConatClient;
  project_id: string;
}) {
  return await requireExplicitConatClient(client)
    .call<Api>(getSubject({ project_id }), {
      timeout: BACKUP_SEARCH_TIMEOUT_MS,
    })
    .getBackupAttempt();
}

export async function getBackupCoverageReportChunk({
  client,
  project_id,
  backup_id,
  offset,
}: {
  client?: ConatClient;
  project_id: string;
  backup_id: string;
  offset: number;
}) {
  return await requireExplicitConatClient(client)
    .call<Api>(getSubject({ project_id }), {
      timeout: BACKUP_SEARCH_TIMEOUT_MS,
    })
    .getBackupCoverageReportChunk({ backup_id, offset });
}

export async function getBackupCoverage({
  client,
  project_id,
  backup_id,
  cursor,
  acknowledgement_keys,
}: {
  client?: ConatClient;
  project_id: string;
  backup_id?: string;
  cursor?: string | null;
  acknowledgement_keys?: string[];
}) {
  return await requireExplicitConatClient(client)
    .call<Api>(getSubject({ project_id }), {
      timeout: BACKUP_SEARCH_TIMEOUT_MS,
    })
    .getBackupCoverage({ backup_id, cursor, acknowledgement_keys });
}

function requireExplicitConatClient(client?: ConatClient): ConatClient {
  if (client != null) {
    return client;
  }
  throw new Error("must provide an explicit Conat client");
}

export function getSubject({ project_id }: { project_id: string }): string {
  return projectSubject({
    project_id,
    service: SERVICE_NAME,
  });
}

export async function getBackups({
  client,
  project_id,
  indexed_only,
}: {
  client?: ConatClient;
  project_id: string;
  indexed_only?: boolean;
}): Promise<BackupSummary[]> {
  return await requireExplicitConatClient(client)
    .call<Api>(getSubject({ project_id }))
    .getBackups({ indexed_only });
}

export async function getBackupFiles({
  client,
  project_id,
  id,
  path,
}: {
  client?: ConatClient;
  project_id: string;
  id: string;
  path?: string;
}): Promise<BackupFileEntry[]> {
  return await requireExplicitConatClient(client)
    .call<Api>(getSubject({ project_id }))
    .getBackupFiles({ id, path });
}

type FindBackupFilesOptions = {
  client?: ConatClient;
  project_id: string;
  glob?: string[];
  iglob?: string[];
  path?: string;
  ids?: string[];
  recursive?: boolean;
};

export async function findBackupFiles(
  opts: FindBackupFilesOptions & { preview: true },
): Promise<BackupFindPreview>;
export async function findBackupFiles(
  opts: FindBackupFilesOptions & { preview?: false },
): Promise<BackupFindResult[]>;
export async function findBackupFiles({
  client,
  project_id,
  glob,
  iglob,
  path,
  ids,
  preview,
  recursive,
}: FindBackupFilesOptions & {
  preview?: boolean;
}): Promise<BackupFindResult[] | BackupFindPreview> {
  const response = await requireExplicitConatClient(client)
    .call<Api>(getSubject({ project_id }), {
      timeout: BACKUP_SEARCH_TIMEOUT_MS,
    })
    .findBackupFiles({ glob, iglob, path, ids, preview, recursive });
  if (preview) {
    if (!Array.isArray(response)) return response;
    return {
      results: response.slice(0, 100),
      truncated: response.length > 100,
      truncationReason: response.length > 100 ? "results" : undefined,
    };
  }
  return Array.isArray(response) ? response : response.results;
}

export async function getBackupFileText({
  client,
  project_id,
  id,
  path,
  max_bytes,
}: {
  client?: ConatClient;
  project_id: string;
  id: string;
  path: string;
  max_bytes?: number;
}): Promise<FileTextPreview> {
  return await requireExplicitConatClient(client)
    .call<Api>(getSubject({ project_id }))
    .getBackupFileText({ id, path, max_bytes });
}

export async function getSnapshotFileText({
  client,
  project_id,
  snapshot,
  path,
  max_bytes,
}: {
  client?: ConatClient;
  project_id: string;
  snapshot: string;
  path: string;
  max_bytes?: number;
}): Promise<FileTextPreview> {
  return await requireExplicitConatClient(client)
    .call<Api>(getSubject({ project_id }))
    .getSnapshotFileText({ snapshot, path, max_bytes });
}
