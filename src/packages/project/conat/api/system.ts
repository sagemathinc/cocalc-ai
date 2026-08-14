export async function ping() {
  return { now: Date.now() };
}

import { handleExecShellCode } from "@cocalc/project/exec_shell_code";
export { handleExecShellCode as exec };

import { realpath as legacyRealpath } from "@cocalc/project/browser-websocket/realpath";

import { version as versionNumber } from "@cocalc/util/smc-version";
export async function version() {
  return versionNumber;
}

import getListing from "@cocalc/backend/get-listing";
import {
  projectRuntimePathForClient,
  projectRuntimePathForProcess,
} from "@cocalc/util/project-runtime";

function processPath(path: string): string {
  return projectRuntimePathForProcess(path) ?? path;
}

function clientPath(path: string): string {
  return projectRuntimePathForClient(path) ?? path;
}

export async function listing({ path, hidden }) {
  return await getListing(processPath(path), hidden);
}

import { getClient } from "@cocalc/project/client";
async function setDeleted(path) {
  const client = getClient();
  await client.set_deleted(clientPath(path));
}

import { move_files } from "@cocalc/backend/files/move-files";
export async function moveFiles({
  paths,
  dest,
}: {
  paths: string[];
  dest: string;
}) {
  await move_files(paths.map(processPath), processPath(dest), setDeleted);
}

import { rename_file } from "@cocalc/backend/files/rename-file";
export async function renameFile({ src, dest }: { src: string; dest: string }) {
  await rename_file(processPath(src), processPath(dest), setDeleted);
}

import { get_configuration } from "@cocalc/project/configuration";
export { get_configuration as configuration };

import ensureContainingDirectoryExists from "@cocalc/backend/misc/ensure-containing-directory-exists";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  realpath as fsRealpath,
  stat,
  rename,
  writeFile,
} from "fs/promises";
import { isAbsolute, join, posix } from "node:path";
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
  const nativePath = processPath(path);
  await ensureContainingDirectoryExists(nativePath);
  await writeFile(nativePath, content);
}

export async function readTextFileFromProject({
  path,
}: {
  path: string;
}): Promise<string> {
  return (await readFile(processPath(path))).toString();
}

export async function managedVmSshPublicKey(): Promise<string | null> {
  try {
    const key = (
      await readFile(processPath(".ssh/id_ed25519.pub"), "utf8")
    ).trim();
    if (!key) return null;
    if (key.length > 16_384 || key.includes("\n") || key.includes("\r")) {
      throw new Error("project deploy public key is invalid");
    }
    return key;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function managedVmAlias(vmName: string, vmId: string): string {
  const name = vmName.trim();
  const shortId = vmId.replaceAll("-", "").slice(0, 8).toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || !/^[a-f0-9]{8}$/.test(shortId)) {
    throw new Error("invalid managed VM identity");
  }
  return name;
}

function hasExactSshHostAlias(content: string, alias: string): boolean {
  const normalizedAlias = alias.toLowerCase();
  return content.split("\n").some((line) => {
    const match = line.match(/^\s*Host\s+(.+)$/i);
    if (!match) return false;
    return match[1]
      .split("#", 1)[0]
      .trim()
      .split(/\s+/)
      .some((token) => token.toLowerCase() === normalizedAlias);
  });
}

function managedVmMarkers(vmId: string) {
  const shortId = vmId.replaceAll("-", "").slice(0, 8).toLowerCase();
  return {
    start: `# >>> cocalc managed vm ${shortId} >>>`,
    end: `# <<< cocalc managed vm ${shortId} <<<`,
  };
}

export function updateManagedVmSshConfig(opts: {
  content: string;
  vm_id: string;
  vm_name: string;
  hostname: string;
  enabled: boolean;
}): { content: string; alias: string } {
  const alias = managedVmAlias(opts.vm_name, opts.vm_id);
  const hostname = opts.hostname.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(hostname)) {
    throw new Error("invalid managed VM hostname");
  }
  const markers = managedVmMarkers(opts.vm_id);
  const escape = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:^|\\n)${escape(markers.start)}\\n[\\s\\S]*?\\n${escape(markers.end)}(?:\\n|$)`,
    "g",
  );
  const stripped = opts.content
    .replace(pattern, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  if (!opts.enabled) {
    return { content: stripped ? `${stripped}\n` : "", alias };
  }
  if (hasExactSshHostAlias(stripped, alias)) {
    throw new Error(
      `SSH config already defines Host '${alias}'; rename that entry or choose another VM name`,
    );
  }
  const block = `${markers.start}
Host ${alias}
  HostName ${hostname}
  User user
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  ServerAliveInterval 15
  ServerAliveCountMax 2
  BatchMode yes
  PreferredAuthentications publickey
  PasswordAuthentication no
  KbdInteractiveAuthentication no
${markers.end}
`;
  return {
    content: stripped ? `${stripped}\n\n${block}` : block,
    alias,
  };
}

let managedVmSshConfigMutation: Promise<unknown> = Promise.resolve();

async function syncManagedVmSshConfigImpl(opts: {
  vm_id: string;
  vm_name: string;
  hostname: string;
  enabled: boolean;
}): Promise<{ alias: string; changed: boolean }> {
  const sshDir = processPath(".ssh");
  const configPath = processPath(".ssh/config");
  await mkdir(sshDir, { recursive: true, mode: 0o700 });
  await chmod(sshDir, 0o700);
  const current = await readFile(configPath, "utf8").catch((err: any) => {
    if (err?.code === "ENOENT") return "";
    throw err;
  });
  const next = updateManagedVmSshConfig({ ...opts, content: current });
  if (next.content === current) return { alias: next.alias, changed: false };
  const tempPath = `${configPath}.cocalc-vm-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, next.content, { mode: 0o600 });
  await rename(tempPath, configPath);
  await chmod(configPath, 0o600);
  return { alias: next.alias, changed: true };
}

export async function syncManagedVmSshConfig(opts: {
  vm_id: string;
  vm_name: string;
  hostname: string;
  enabled: boolean;
}): Promise<{ alias: string; changed: boolean }> {
  const mutation = managedVmSshConfigMutation
    .catch(() => undefined)
    .then(() => syncManagedVmSshConfigImpl(opts));
  managedVmSshConfigMutation = mutation;
  return await mutation;
}

export async function realpath(path: string): Promise<string> {
  if (!process.env.COCALC_RUNTIME_HOME) {
    return await legacyRealpath(path);
  }
  const processVisiblePath = processPath(path);
  const fullPath = isAbsolute(processVisiblePath)
    ? processVisiblePath
    : join(process.env.HOME ?? "/home/user", processVisiblePath);
  const resolved = await fsRealpath(fullPath);
  const visible = clientPath(resolved);
  if (visible === resolved) return path;
  const home = posix.resolve(process.env.COCALC_RUNTIME_HOME ?? "/home/user");
  if (visible !== home && !visible.startsWith(`${home}/`)) return path;
  if (path.startsWith("/")) return visible;
  return visible === home ? "" : posix.relative(home, visible);
}

async function readRootfsBuildTextFile({
  build_id,
  filename,
  lines,
  byte_offset,
  max_bytes,
}: {
  build_id: string;
  filename: string;
  lines?: number;
  byte_offset?: number;
  max_bytes?: number;
}): Promise<HostRootfsBuildLogResponse> {
  if (!ROOTFS_BUILD_ID_RE.test(build_id)) {
    throw new Error("invalid build_id");
  }
  const project_id = `${process.env.COCALC_PROJECT_ID ?? ""}`;
  const relativePath = join(ROOTFS_BUILD_DIR, build_id, filename);
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
  return await readRootfsBuildTextFile({
    build_id,
    filename: "build.log",
    lines,
    byte_offset,
    max_bytes,
  });
}

export async function readRootfsBuildEvents({
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
  return await readRootfsBuildTextFile({
    build_id,
    filename: "events.ndjson",
    lines,
    byte_offset,
    max_bytes,
  });
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
