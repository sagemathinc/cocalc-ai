/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, posix } from "node:path";

import getLogger from "@cocalc/backend/logger";
import { podmanEnv } from "@cocalc/backend/podman/env";
import type {
  HostRootfsBuildCancelResponse,
  HostRootfsBuildLogResponse,
  HostRootfsBuildStartRequest,
  HostRootfsBuildStatus,
  HostRootfsBuildStatusResponse,
} from "@cocalc/conat/project-host/api";
import { isValidUUID } from "@cocalc/util/misc";
import {
  DEFAULT_PROJECT_RUNTIME_GID,
  DEFAULT_PROJECT_RUNTIME_HOME,
  DEFAULT_PROJECT_RUNTIME_UID,
  DEFAULT_PROJECT_RUNTIME_USER,
} from "@cocalc/util/project-runtime";
import type { Readable } from "node:stream";

import { getVolume } from "./file-server";

const logger = getLogger("project-host:rootfs-build-runner");

const BUILD_ROOT_RELATIVE = ".cocalc/rootfs-builds";
const MAX_LOG_LINES = 10_000;
const MAX_LOG_BYTES = 1024 * 1024;
const BUILD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEARTBEAT_INTERVAL_MS = 30_000;

interface BuildPaths {
  hostDir: string;
  hostScript: string;
  hostLog: string;
  hostStatus: string;
  hostEvents: string;
  hostResolvedRecipe: string;
  hostMetadata: string;
  containerDir: string;
  containerScript: string;
  publicPaths: HostRootfsBuildStatusResponse["paths"];
}

interface RunningBuild {
  child: ChildProcessByStdio<null, Readable, Readable>;
  cancelRequested: boolean;
  finished: boolean;
  heartbeat?: NodeJS.Timeout;
  paths: BuildPaths;
  status: HostRootfsBuildStatusResponse;
}

const running = new Map<string, RunningBuild>();

function registryKey(project_id: string, build_id: string): string {
  return `${project_id}:${build_id}`;
}

function isoNow(): string {
  return new Date().toISOString();
}

function secondsSince(iso?: string): number | undefined {
  if (!iso) return undefined;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return undefined;
  return Math.max(0, Math.floor((Date.now() - time) / 1000));
}

function generateBuildId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(".", "")
    .replace("Z", "");
  return `rb-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function validateProjectId(project_id: string): void {
  if (!isValidUUID(project_id)) {
    throw new Error(`invalid project_id '${project_id}'`);
  }
}

function validateBuildId(build_id: string): void {
  if (!BUILD_ID_RE.test(build_id)) {
    throw new Error(
      "build_id must be 1-120 characters of letters, digits, '.', '_', or '-'",
    );
  }
}

function normalizeCwd(cwd?: string): string {
  const trimmed = `${cwd ?? ""}`.trim();
  if (!trimmed) return DEFAULT_PROJECT_RUNTIME_HOME;
  const absolute = trimmed.startsWith("/")
    ? posix.normalize(trimmed)
    : posix.normalize(posix.join(DEFAULT_PROJECT_RUNTIME_HOME, trimmed));
  if (
    absolute !== DEFAULT_PROJECT_RUNTIME_HOME &&
    !absolute.startsWith(`${DEFAULT_PROJECT_RUNTIME_HOME}/`)
  ) {
    throw new Error(
      `cwd must be inside ${DEFAULT_PROJECT_RUNTIME_HOME}: '${cwd}'`,
    );
  }
  return absolute;
}

function normalizedEnv(env?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!ENV_NAME_RE.test(key)) {
      throw new Error(`invalid environment variable name '${key}'`);
    }
    result[key] = `${value}`;
  }
  return result;
}

async function buildPaths(
  project_id: string,
  build_id: string,
): Promise<BuildPaths> {
  validateProjectId(project_id);
  validateBuildId(build_id);
  const volume = await getVolume(project_id);
  const relativeDir = posix.join(BUILD_ROOT_RELATIVE, build_id);
  const hostDir = join(volume.path, BUILD_ROOT_RELATIVE, build_id);
  const containerDir = posix.join(DEFAULT_PROJECT_RUNTIME_HOME, relativeDir);
  return {
    hostDir,
    hostScript: join(hostDir, "run.sh"),
    hostLog: join(hostDir, "build.log"),
    hostStatus: join(hostDir, "status.json"),
    hostEvents: join(hostDir, "events.ndjson"),
    hostResolvedRecipe: join(hostDir, "resolved-recipe.json"),
    hostMetadata: join(hostDir, "metadata.json"),
    containerDir,
    containerScript: posix.join(containerDir, "run.sh"),
    publicPaths: {
      dir: relativeDir,
      script: posix.join(relativeDir, "run.sh"),
      log: posix.join(relativeDir, "build.log"),
      status: posix.join(relativeDir, "status.json"),
      events: posix.join(relativeDir, "events.ndjson"),
      resolved_recipe: posix.join(relativeDir, "resolved-recipe.json"),
      metadata: posix.join(relativeDir, "metadata.json"),
    },
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function appendEvent(
  paths: BuildPaths,
  event: Record<string, unknown>,
): Promise<void> {
  await appendFile(
    paths.hostEvents,
    `${JSON.stringify({ time: isoNow(), ...event })}\n`,
    "utf8",
  );
}

async function persistStatus(
  paths: BuildPaths,
  status: HostRootfsBuildStatusResponse,
): Promise<void> {
  await writeJsonAtomic(paths.hostStatus, status);
}

function startHeartbeat(build: RunningBuild): void {
  build.heartbeat = setInterval(() => {
    if (build.finished) return;
    void persistStatus(build.paths, build.status).catch((err) =>
      logger.warn("failed to persist rootfs build heartbeat status", {
        project_id: build.status.project_id,
        build_id: build.status.build_id,
        err,
      }),
    );
    void appendEvent(build.paths, {
      event: "heartbeat",
      status: build.status.status,
      elapsed_s: secondsSince(build.status.started_at),
      last_output_s: secondsSince(build.status.last_output_at),
    }).catch((err) =>
      logger.warn("failed to append rootfs build heartbeat event", {
        project_id: build.status.project_id,
        build_id: build.status.build_id,
        err,
      }),
    );
  }, HEARTBEAT_INTERVAL_MS);
  build.heartbeat.unref();
}

function podmanExecArgs(
  project_id: string,
  opts: { cwd?: string; env?: Record<string, string> },
  paths: BuildPaths,
): string[] {
  const args = [
    "exec",
    "-i",
    "-u",
    `${DEFAULT_PROJECT_RUNTIME_UID}:${DEFAULT_PROJECT_RUNTIME_GID}`,
    "-e",
    `HOME=${DEFAULT_PROJECT_RUNTIME_HOME}`,
    "-e",
    `USER=${DEFAULT_PROJECT_RUNTIME_USER}`,
    "-e",
    `LOGNAME=${DEFAULT_PROJECT_RUNTIME_USER}`,
  ];
  for (const [key, value] of Object.entries(normalizedEnv(opts.env))) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(
    "--workdir",
    normalizeCwd(opts.cwd),
    `project-${project_id}`,
    "/bin/bash",
    paths.containerScript,
  );
  return args;
}

function attachOutputHandlers(
  build: RunningBuild,
  stream: "stdout" | "stderr",
): void {
  build.child[stream].on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    build.status.last_output_at = isoNow();
    void appendFile(build.paths.hostLog, text, "utf8").catch((err) =>
      logger.warn("failed to append rootfs build log chunk", {
        project_id: build.status.project_id,
        build_id: build.status.build_id,
        stream,
        err,
      }),
    );
  });
}

async function markFinished(
  build: RunningBuild,
  status: HostRootfsBuildStatus,
  opts: { exit_code?: number | null; signal?: string | null; error?: string },
): Promise<void> {
  if (build.finished) return;
  build.finished = true;
  if (build.heartbeat) {
    clearInterval(build.heartbeat);
    build.heartbeat = undefined;
  }
  build.status.status = status;
  build.status.finished_at = isoNow();
  build.status.exit_code = opts.exit_code ?? null;
  build.status.signal = opts.signal ?? null;
  if (opts.error) build.status.error = opts.error;
  await persistStatus(build.paths, build.status);
  await appendEvent(build.paths, {
    event: "finished",
    status,
    exit_code: build.status.exit_code,
    signal: build.status.signal,
    error: build.status.error,
  });
  running.delete(registryKey(build.status.project_id, build.status.build_id));
}

export async function startRootfsBuild(
  opts: HostRootfsBuildStartRequest,
): Promise<HostRootfsBuildStatusResponse> {
  if (!opts.script.trim()) {
    throw new Error("script must be non-empty");
  }
  const build_id = opts.build_id ?? generateBuildId();
  const key = registryKey(opts.project_id, build_id);
  if (running.has(key)) {
    throw new Error(`rootfs build '${build_id}' is already running`);
  }
  const paths = await buildPaths(opts.project_id, build_id);
  await mkdir(paths.hostDir, { recursive: true });

  await writeFile(
    paths.hostScript,
    opts.script.endsWith("\n") ? opts.script : `${opts.script}\n`,
    "utf8",
  );
  await chmod(paths.hostScript, 0o755);
  await writeFile(paths.hostLog, "", { flag: "a" });
  await writeFile(paths.hostEvents, "", { flag: "a" });
  if (opts.resolved_recipe_json !== undefined) {
    await writeJsonAtomic(paths.hostResolvedRecipe, opts.resolved_recipe_json);
  }
  if (opts.metadata_json !== undefined) {
    await writeJsonAtomic(paths.hostMetadata, opts.metadata_json);
  }

  const started_at = isoNow();
  const status: HostRootfsBuildStatusResponse = {
    build_id,
    project_id: opts.project_id,
    status: "running",
    recipe_ref: opts.recipe_ref,
    created_at: started_at,
    started_at,
    paths: paths.publicPaths,
  };
  await persistStatus(paths, status);
  await appendEvent(paths, {
    event: "started",
    recipe_ref: opts.recipe_ref,
    cwd: normalizeCwd(opts.cwd),
  });

  const args = podmanExecArgs(opts.project_id, opts, paths);
  const child = spawn("podman", args, {
    detached: true,
    env: podmanEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  status.pid = child.pid;
  const startResponse: HostRootfsBuildStatusResponse = {
    ...status,
    paths: { ...status.paths },
  };
  const build: RunningBuild = {
    child,
    cancelRequested: false,
    finished: false,
    paths,
    status,
  };
  running.set(key, build);
  attachOutputHandlers(build, "stdout");
  attachOutputHandlers(build, "stderr");

  child.on("error", (err) => {
    void markFinished(build, "failed", { error: err.message }).catch((e) =>
      logger.warn("failed to persist rootfs build spawn error", {
        project_id: opts.project_id,
        build_id,
        err: e,
      }),
    );
  });

  child.on("close", (code, signal) => {
    const finalStatus =
      build.cancelRequested || signal === "SIGTERM" || signal === "SIGKILL"
        ? "canceled"
        : code === 0
          ? "succeeded"
          : "failed";
    void markFinished(build, finalStatus, {
      exit_code: code,
      signal,
    }).catch((err) =>
      logger.warn("failed to persist rootfs build completion", {
        project_id: opts.project_id,
        build_id,
        err,
      }),
    );
  });

  await persistStatus(paths, status);
  startHeartbeat(build);

  return startResponse;
}

export async function getRootfsBuildStatus({
  project_id,
  build_id,
}: {
  project_id: string;
  build_id: string;
}): Promise<HostRootfsBuildStatusResponse> {
  const key = registryKey(project_id, build_id);
  const build = running.get(key);
  if (build) return build.status;
  const paths = await buildPaths(project_id, build_id);
  const text = await readFile(paths.hostStatus, "utf8");
  const status = JSON.parse(text) as HostRootfsBuildStatusResponse;
  if (status.status === "running" || status.status === "canceling") {
    return {
      ...status,
      status: "unknown",
      error:
        status.error ??
        "build process is not tracked by this project-host process",
    };
  }
  return status;
}

export async function getRootfsBuildLog({
  project_id,
  build_id,
  lines,
  byte_offset,
  max_bytes,
}: {
  project_id: string;
  build_id: string;
  lines?: number;
  byte_offset?: number;
  max_bytes?: number;
}): Promise<HostRootfsBuildLogResponse> {
  const paths = await buildPaths(project_id, build_id);
  const limit = Math.max(1, Math.min(MAX_LOG_LINES, Math.floor(lines ?? 200)));
  const offset =
    byte_offset == null
      ? undefined
      : Math.max(0, Math.floor(Number(byte_offset) || 0));
  const byteLimit = Math.max(
    1,
    Math.min(MAX_LOG_BYTES, Math.floor(Number(max_bytes) || MAX_LOG_BYTES)),
  );
  try {
    await access(paths.hostLog, fsConstants.R_OK);
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
      path: paths.publicPaths.log,
    };
  }
  if (offset != null) {
    const info = await stat(paths.hostLog);
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
        path: paths.publicPaths.log,
      };
    }
    const bytesToRead = Math.min(byteLimit, info.size - offset);
    const buffer = Buffer.alloc(bytesToRead);
    const handle = await open(paths.hostLog, "r");
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
        path: paths.publicPaths.log,
      };
    } finally {
      await handle.close();
    }
  }
  const text = await readFile(paths.hostLog, "utf8");
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
    path: paths.publicPaths.log,
  };
}

export async function cancelRootfsBuild({
  project_id,
  build_id,
}: {
  project_id: string;
  build_id: string;
}): Promise<HostRootfsBuildCancelResponse> {
  const key = registryKey(project_id, build_id);
  const build = running.get(key);
  if (!build) {
    const status = await getRootfsBuildStatus({ project_id, build_id });
    return {
      build_id,
      project_id,
      status: status.status,
      signaled: false,
      message: "build is not currently tracked by this project-host process",
    };
  }

  build.cancelRequested = true;
  build.status.status = "canceling";
  await persistStatus(build.paths, build.status);
  await appendEvent(build.paths, { event: "cancel_requested" });

  let signaled = false;
  if (build.child.pid) {
    try {
      process.kill(-build.child.pid, "SIGTERM");
      signaled = true;
    } catch (err) {
      logger.warn("failed to signal rootfs build process group", {
        project_id,
        build_id,
        pid: build.child.pid,
        err,
      });
      try {
        build.child.kill("SIGTERM");
        signaled = true;
      } catch (childErr) {
        logger.warn("failed to signal rootfs build process", {
          project_id,
          build_id,
          pid: build.child.pid,
          err: childErr,
        });
      }
    }
  }

  setTimeout(() => {
    const current = running.get(key);
    if (!current?.child.pid) return;
    try {
      process.kill(-current.child.pid, "SIGKILL");
    } catch {
      current.child.kill("SIGKILL");
    }
  }, 15_000).unref();

  return {
    build_id,
    project_id,
    status: "canceling",
    signaled,
  };
}

export const __test__ = {
  reset() {
    for (const build of running.values()) {
      if (build.heartbeat) clearInterval(build.heartbeat);
    }
    running.clear();
  },
  buildPaths,
};
