export async function ping() {
  return { now: Date.now() };
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
import { constants as fsConstants } from "node:fs";
import { access, open, readFile, readdir, stat, writeFile } from "fs/promises";
import { join } from "node:path";
import type {
  HostRootfsBuildLogResponse,
  HostRootfsBuildStatusResponse,
} from "@cocalc/conat/project-host/api";

const ROOTFS_BUILD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const ROOTFS_BUILD_MAX_LOG_LINES = 10_000;
const ROOTFS_BUILD_MAX_LOG_BYTES = 1024 * 1024;
const ROOTFS_BUILD_MAX_LIST_LIMIT = 1000;
const ROOTFS_BUILD_DIR = join(".cocalc", "rootfs-builds");

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

export async function readRootfsBuildLog({
  build_id,
  lines,
  byte_offset,
  max_bytes,
}: {
  build_id: string;
  lines?: number;
  byte_offset?: number;
  max_bytes?: number;
}): Promise<HostRootfsBuildLogResponse> {
  if (!ROOTFS_BUILD_ID_RE.test(build_id)) {
    throw new Error("invalid build_id");
  }
  const project_id = `${process.env.COCALC_PROJECT_ID ?? ""}`;
  const relativePath = join(ROOTFS_BUILD_DIR, build_id, "build.log");
  const path = join(process.env.HOME || "/home/user", relativePath);
  const limit = Math.max(
    1,
    Math.min(ROOTFS_BUILD_MAX_LOG_LINES, Math.floor(Number(lines ?? 200))),
  );
  const offset =
    byte_offset == null
      ? undefined
      : Math.max(0, Math.floor(Number(byte_offset) || 0));
  const byteLimit = Math.max(
    1,
    Math.min(
      ROOTFS_BUILD_MAX_LOG_BYTES,
      Math.floor(Number(max_bytes) || ROOTFS_BUILD_MAX_LOG_BYTES),
    ),
  );
  try {
    await access(path, fsConstants.R_OK);
  } catch {
    return {
      build_id,
      project_id,
      lines: limit,
      byte_offset: offset ?? 0,
      next_byte_offset: offset ?? 0,
      bytes: 0,
      eof: true,
      text: "",
      found: false,
      path: relativePath,
    };
  }
  if (offset != null) {
    const info = await stat(path);
    if (offset >= info.size) {
      return {
        build_id,
        project_id,
        lines: limit,
        byte_offset: offset,
        next_byte_offset: offset,
        bytes: 0,
        eof: true,
        text: "",
        found: true,
        path: relativePath,
      };
    }
    const bytesToRead = Math.min(byteLimit, info.size - offset);
    const buffer = Buffer.alloc(bytesToRead);
    const handle = await open(path, "r");
    try {
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
      const next = offset + bytesRead;
      return {
        build_id,
        project_id,
        lines: limit,
        byte_offset: offset,
        next_byte_offset: next,
        bytes: bytesRead,
        eof: next >= info.size,
        text: buffer.subarray(0, bytesRead).toString("utf8"),
        found: true,
        path: relativePath,
      };
    } finally {
      await handle.close();
    }
  }
  const text = await readFile(path, "utf8");
  const split = text.split(/\r?\n/);
  const selected = split
    .slice(Math.max(0, split.length - limit - 1))
    .join("\n");
  const bytes = Buffer.byteLength(selected, "utf8");
  const fileBytes = Buffer.byteLength(text, "utf8");
  return {
    build_id,
    project_id,
    lines: limit,
    byte_offset: Math.max(0, fileBytes - bytes),
    next_byte_offset: fileBytes,
    bytes,
    eof: true,
    text: selected,
    found: true,
    path: relativePath,
  };
}

export async function listRootfsBuilds({
  limit,
}: {
  limit?: number;
} = {}): Promise<HostRootfsBuildStatusResponse[]> {
  const root = join(process.env.HOME || "/home/user", ROOTFS_BUILD_DIR);
  const max = Math.max(
    1,
    Math.min(
      ROOTFS_BUILD_MAX_LIST_LIMIT,
      Math.floor(Number(limit) || ROOTFS_BUILD_MAX_LIST_LIMIT),
    ),
  );
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const statuses: HostRootfsBuildStatusResponse[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ROOTFS_BUILD_ID_RE.test(entry.name)) {
      continue;
    }
    try {
      const text = await readFile(
        join(root, entry.name, "status.json"),
        "utf8",
      );
      const status = JSON.parse(text) as HostRootfsBuildStatusResponse;
      if (status?.build_id === entry.name) {
        statuses.push(status);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  return statuses
    .sort((a, b) =>
      `${b.created_at ?? b.started_at ?? ""}`.localeCompare(
        `${a.created_at ?? a.started_at ?? ""}`,
      ),
    )
    .slice(0, max);
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
