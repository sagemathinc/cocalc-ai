/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { projectSubject } from "@cocalc/conat/names";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import type { FileTextPreview } from "@cocalc/conat/files/file-server";

const SERVICE_NAME = "archive-info";

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

export interface BackupFindResult {
  id: string;
  time: Date;
  path: string;
  isDir: boolean;
  mtime: number;
  size: number;
}

interface Api {
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
  }) => Promise<BackupFindResult[]>;
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

export async function findBackupFiles({
  client,
  project_id,
  glob,
  iglob,
  path,
  ids,
}: {
  client?: ConatClient;
  project_id: string;
  glob?: string[];
  iglob?: string[];
  path?: string;
  ids?: string[];
}): Promise<BackupFindResult[]> {
  return await requireExplicitConatClient(client)
    .call<Api>(getSubject({ project_id }))
    .findBackupFiles({ glob, iglob, path, ids });
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
