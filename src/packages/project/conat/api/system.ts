export async function ping() {
  return { now: Date.now() };
}

export async function terminate() {}

import { dstream } from "@cocalc/backend/conat/sync";
import {
  PROJECT_LOG_STREAM_NAME,
  type ProjectLogCursor,
  type ProjectLogPage,
  type ProjectLogRow,
} from "@cocalc/conat/hub/api/projects";
import { uuid } from "@cocalc/util/misc";
import { getIdentity } from "@cocalc/project/conat/connection";

const DEFAULT_PROJECT_LOG_LIMIT = 100;
const MAX_PROJECT_LOG_LIMIT = 500;

function normalizeProjectLogLimit(limit?: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_PROJECT_LOG_LIMIT;
  }
  return Math.max(1, Math.min(MAX_PROJECT_LOG_LIMIT, Math.floor(limit!)));
}

function normalizeProjectLogTime(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(`${value}`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeProjectLogCursor(
  cursor?: ProjectLogCursor,
): ProjectLogCursor | undefined {
  if (!cursor?.id) return;
  return {
    id: `${cursor.id}`,
    time: normalizeProjectLogTime(cursor.time),
  };
}

function compareProjectLogRows(a: ProjectLogRow, b: ProjectLogRow): number {
  const at = normalizeProjectLogTime(a.time)?.getTime() ?? 0;
  const bt = normalizeProjectLogTime(b.time)?.getTime() ?? 0;
  if (at !== bt) return bt - at;
  return `${b.id}`.localeCompare(`${a.id}`);
}

function cursorKey(cursor?: ProjectLogCursor): [number, string] | null {
  if (!cursor?.id) return null;
  return [normalizeProjectLogTime(cursor.time)?.getTime() ?? 0, `${cursor.id}`];
}

async function getProjectLogStream() {
  const { client, project_id } = getIdentity();
  return await dstream<ProjectLogRow>({
    client,
    project_id,
    name: PROJECT_LOG_STREAM_NAME,
    noInventory: true,
  });
}

export async function appendProjectLog({
  account_id,
  id,
  time,
  event,
}: {
  account_id: string;
  id?: string;
  time?: Date | null;
  event: Record<string, any> | string | null;
}): Promise<ProjectLogRow> {
  const { project_id } = getIdentity();
  const row: ProjectLogRow = {
    id: `${id ?? uuid()}`,
    project_id,
    account_id,
    time: normalizeProjectLogTime(time) ?? new Date(),
    event: event ?? {},
  };
  const stream = await getProjectLogStream();
  stream.publish(row);
  await stream.save();
  return row;
}

export async function listProjectLog({
  limit,
  newer_than,
  older_than,
}: {
  limit?: number;
  newer_than?: ProjectLogCursor;
  older_than?: ProjectLogCursor;
} = {}): Promise<ProjectLogPage> {
  const { project_id } = getIdentity();
  const pageLimit = normalizeProjectLogLimit(limit);
  const newerKey = cursorKey(normalizeProjectLogCursor(newer_than));
  const olderKey = cursorKey(normalizeProjectLogCursor(older_than));
  const stream = await getProjectLogStream();
  const entries = stream
    .getAll()
    .map((row, index) => ({
      id: `${row?.id ?? ""}`,
      project_id: `${row?.project_id ?? project_id}`,
      account_id: `${row?.account_id ?? ""}`,
      time: normalizeProjectLogTime(row?.time) ?? stream.time(index) ?? null,
      event: row?.event ?? {},
    }))
    .filter((row) => row.id && row.account_id)
    .sort(compareProjectLogRows)
    .filter((row) => {
      const key: [number, string] = [
        normalizeProjectLogTime(row.time)?.getTime() ?? 0,
        row.id,
      ];
      if (
        newerKey != null &&
        (key[0] < newerKey[0] ||
          (key[0] === newerKey[0] && key[1] <= newerKey[1]))
      ) {
        return false;
      }
      if (
        olderKey != null &&
        (key[0] > olderKey[0] ||
          (key[0] === olderKey[0] && key[1] >= olderKey[1]))
      ) {
        return false;
      }
      return true;
    });
  return {
    entries: entries.slice(0, pageLimit),
    has_more: entries.length > pageLimit,
  };
}

import { handleExecShellCode } from "@cocalc/project/exec_shell_code";
export { handleExecShellCode as exec };

export { realpath } from "@cocalc/project/browser-websocket/realpath";

import { version as versionNumber } from "@cocalc/util/smc-version";
export async function version() {
  return versionNumber;
}

import getListing from "@cocalc/backend/get-listing";
export async function listing({ path, hidden }) {
  return await getListing(path, hidden);
}

import { getClient } from "@cocalc/project/client";
async function setDeleted(path) {
  const client = getClient();
  await client.set_deleted(path);
}

import { move_files } from "@cocalc/backend/files/move-files";
export async function moveFiles({
  paths,
  dest,
}: {
  paths: string[];
  dest: string;
}) {
  await move_files(paths, dest, setDeleted);
}

import { rename_file } from "@cocalc/backend/files/rename-file";
export async function renameFile({ src, dest }: { src: string; dest: string }) {
  await rename_file(src, dest, setDeleted);
}

import { get_configuration } from "@cocalc/project/configuration";
export { get_configuration as configuration };

import ensureContainingDirectoryExists from "@cocalc/backend/misc/ensure-containing-directory-exists";
import { readFile, writeFile } from "fs/promises";

export async function writeTextFileToProject({
  path,
  content,
}: {
  path: string;
  content: string;
}): Promise<void> {
  await ensureContainingDirectoryExists(path);
  await writeFile(path, content);
}

export async function readTextFileFromProject({
  path,
}: {
  path: string;
}): Promise<string> {
  return (await readFile(path)).toString();
}

export async function signal({
  signal,
  pids,
  pid,
}: {
  signal: number;
  pids?: number[];
  pid?: number;
}): Promise<void> {
  const errors: Error[] = [];
  const f = (pid) => {
    try {
      process.kill(pid, signal);
    } catch (err) {
      errors.push(err);
    }
  };
  if (pid != null) {
    f(pid);
  }
  if (pids != null) {
    for (const pid of pids) {
      f(pid);
    }
  }
  if (errors.length > 0) {
    throw errors[errors.length - 1];
  }
}

export { sshPublicKey } from "@cocalc/backend/ssh/ssh-keys";

export { update as updateSshKeys } from "@cocalc/project/conat/authorized-keys";
