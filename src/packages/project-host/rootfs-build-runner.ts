/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { spawn, type ChildProcess } from "node:child_process";
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
import { DEFAULT_PROJECT_RUNTIME_HOME } from "@cocalc/util/project-runtime";

import { getVolume } from "./file-server";

const logger = getLogger("project-host:rootfs-build-runner");

const BUILD_ROOT_RELATIVE = ".cocalc/rootfs-builds";
const MAX_LOG_LINES = 10_000;
const MAX_LOG_BYTES = 1024 * 1024;
const BUILD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_HEARTBEAT_MS = HEARTBEAT_INTERVAL_MS * 4;
const ROOTFS_BUILD_USER = "0:0";
const ROOTFS_BUILD_HOME = "/root";
const ROOTFS_BUILD_LOGNAME = "root";

interface BuildPaths {
  hostDir: string;
  hostRunner: string;
  hostScript: string;
  hostLog: string;
  hostStatus: string;
  hostEvents: string;
  hostResolvedRecipe: string;
  hostMetadata: string;
  containerDir: string;
  containerRunner: string;
  containerScript: string;
  publicPaths: HostRootfsBuildStatusResponse["paths"];
}

interface RunningBuild {
  child: ChildProcess;
  cancelRequested: boolean;
  finished: boolean;
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

function isFreshHeartbeat(status: HostRootfsBuildStatusResponse): boolean {
  const iso = status.heartbeat_at ?? status.started_at ?? status.created_at;
  if (!iso) return false;
  const time = Date.parse(iso);
  return Number.isFinite(time) && Date.now() - time <= STALE_HEARTBEAT_MS;
}

function isTerminalStatus(status: HostRootfsBuildStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
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
    hostRunner: join(hostDir, "runner.sh"),
    hostScript: join(hostDir, "run.sh"),
    hostLog: join(hostDir, "build.log"),
    hostStatus: join(hostDir, "status.json"),
    hostEvents: join(hostDir, "events.ndjson"),
    hostResolvedRecipe: join(hostDir, "resolved-recipe.json"),
    hostMetadata: join(hostDir, "metadata.json"),
    containerDir,
    containerRunner: posix.join(containerDir, "runner.sh"),
    containerScript: posix.join(containerDir, "run.sh"),
    publicPaths: {
      dir: relativeDir,
      runner: posix.join(relativeDir, "runner.sh"),
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

async function readStatus(
  paths: BuildPaths,
): Promise<HostRootfsBuildStatusResponse> {
  return JSON.parse(
    await readFile(paths.hostStatus, "utf8"),
  ) as HostRootfsBuildStatusResponse;
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
    ROOTFS_BUILD_USER,
    "-e",
    `HOME=${ROOTFS_BUILD_HOME}`,
    "-e",
    `USER=${ROOTFS_BUILD_LOGNAME}`,
    "-e",
    `LOGNAME=${ROOTFS_BUILD_LOGNAME}`,
  ];
  for (const [key, value] of Object.entries(normalizedEnv(opts.env))) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(
    "--workdir",
    normalizeCwd(opts.cwd),
    `project-${project_id}`,
    "/bin/bash",
    paths.containerRunner,
  );
  return args;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function statusPathsJson(paths: BuildPaths): string {
  return JSON.stringify(paths.publicPaths, null, 4).replace(/^/gm, "    ");
}

function rootfsBuildRunnerScript({
  build_id,
  project_id,
  recipe_ref,
  paths,
}: {
  build_id: string;
  project_id: string;
  recipe_ref?: string;
  paths: BuildPaths;
}): string {
  const heartbeatSeconds = Math.max(
    1,
    Math.floor(HEARTBEAT_INTERVAL_MS / 1000),
  );
  return `#!/usr/bin/env bash
set +e

BUILD_ID=${shellQuote(build_id)}
PROJECT_ID=${shellQuote(project_id)}
RECIPE_REF_JSON=${shellQuote(JSON.stringify(recipe_ref ?? null))}
SCRIPT=${shellQuote(paths.containerScript)}
LOG=${shellQuote(posix.join(paths.containerDir, "build.log"))}
STATUS=${shellQuote(posix.join(paths.containerDir, "status.json"))}
EVENTS=${shellQuote(posix.join(paths.containerDir, "events.ndjson"))}
HEARTBEAT_SECONDS=${heartbeatSeconds}
PACKAGE_MANAGER_WAIT_SECONDS="\${ROOTFS_BUILD_PACKAGE_MANAGER_WAIT_SECONDS:-600}"
main_pid=""
heartbeat_pid=""

now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

json_string() {
  printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/^/"/; s/$/"/'
}

last_output_json() {
  if [ ! -s "$LOG" ]; then
    printf 'null'
    return
  fi
  local mtime
  mtime="$(stat -c %Y "$LOG" 2>/dev/null || true)"
  if [ -z "$mtime" ]; then
    printf 'null'
    return
  fi
  json_string "$(date -u -d "@$mtime" +"%Y-%m-%dT%H:%M:%SZ")"
}

append_event() {
  local event="$1"
  local status="$2"
  printf '{"time":"%s","event":"%s","status":"%s"}\\n' "$(now)" "$event" "$status" >> "$EVENTS"
}

package_manager_processes() {
  local comm
  for comm in /proc/[0-9]*/comm; do
    [ -r "$comm" ] || continue
    case "$(cat "$comm" 2>/dev/null || true)" in
      apt|apt-get|dpkg|unattended-upgr)
        echo "\${comm#/proc/}" | cut -d/ -f1
        ;;
    esac
  done
}

wait_for_package_manager() {
  local deadline
  local pids
  deadline=$(( $(date +%s) + PACKAGE_MANAGER_WAIT_SECONDS ))
  while true; do
    pids="$(package_manager_processes | xargs echo)"
    if [ -z "$pids" ]; then
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "Timed out waiting for package manager processes to finish: $pids" >&2
      return 1
    fi
    echo "Waiting for package manager processes to finish: $pids"
    append_event "waiting_for_package_manager" "running"
    sleep 5
  done
}

write_status() {
  local status="$1"
  local exit_code="$2"
  local signal_json="$3"
  local error_json="$4"
  local finished_json="$5"
  local heartbeat_json
  heartbeat_json="$(json_string "$(now)")"
  local last_output
  last_output="$(last_output_json)"
  local pid_json="null"
  if [ -n "$main_pid" ]; then
    pid_json="$main_pid"
  fi
  local tmp="$STATUS.tmp.$$"
  cat > "$tmp" <<JSON
{
  "build_id": "$BUILD_ID",
  "project_id": "$PROJECT_ID",
  "status": "$status",
  "recipe_ref": $RECIPE_REF_JSON,
  "created_at": ${JSON.stringify(isoNow())},
  "started_at": ${JSON.stringify(isoNow())},
  "finished_at": $finished_json,
  "heartbeat_at": $heartbeat_json,
  "last_output_at": $last_output,
  "exit_code": $exit_code,
  "signal": $signal_json,
  "error": $error_json,
  "pid": $pid_json,
  "paths": ${statusPathsJson(paths)}
}
JSON
  mv "$tmp" "$STATUS"
}

stop_heartbeat() {
  if [ -n "$heartbeat_pid" ]; then
    kill "$heartbeat_pid" 2>/dev/null || true
    wait "$heartbeat_pid" 2>/dev/null || true
    heartbeat_pid=""
  fi
}

cancel_build() {
  trap - TERM INT HUP
  append_event "cancel_requested" "canceling"
  write_status "canceling" "null" '"SIGTERM"' "null" "null"
  if [ -n "$main_pid" ]; then
    kill -TERM -- "-$main_pid" 2>/dev/null || kill -TERM "$main_pid" 2>/dev/null || true
    wait "$main_pid" 2>/dev/null || true
  fi
  stop_heartbeat
  write_status "canceled" "143" '"SIGTERM"' "null" "$(json_string "$(now)")"
  append_event "finished" "canceled"
  exit 143
}

trap cancel_build TERM INT HUP

touch "$LOG" "$EVENTS"
append_event "runner_started" "running"
write_status "running" "null" "null" "null" "null"

wait_for_package_manager >> "$LOG" 2>&1 || {
  exit_code="$?"
  write_status "failed" "$exit_code" "null" '"package manager lock wait failed"' "$(json_string "$(now)")"
  append_event "finished" "failed"
  exit "$exit_code"
}

if command -v setsid >/dev/null 2>&1; then
  setsid /bin/bash "$SCRIPT" >> "$LOG" 2>&1 &
else
  /bin/bash "$SCRIPT" >> "$LOG" 2>&1 &
fi
main_pid="$!"
write_status "running" "null" "null" "null" "null"

(
  while kill -0 "$main_pid" 2>/dev/null; do
    sleep "$HEARTBEAT_SECONDS"
    if kill -0 "$main_pid" 2>/dev/null; then
      write_status "running" "null" "null" "null" "null"
      append_event "heartbeat" "running"
    fi
  done
) &
heartbeat_pid="$!"

wait "$main_pid"
exit_code="$?"
stop_heartbeat

if [ "$exit_code" -eq 0 ]; then
  final_status="succeeded"
else
  final_status="failed"
fi
write_status "$final_status" "$exit_code" "null" "null" "$(json_string "$(now)")"
append_event "finished" "$final_status"
exit "$exit_code"
`;
}

async function markFinished(
  build: RunningBuild,
  status: HostRootfsBuildStatus,
  opts: { exit_code?: number | null; signal?: string | null; error?: string },
): Promise<void> {
  if (build.finished) return;
  build.finished = true;
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

async function handleChildClose(
  build: RunningBuild,
  opts: { code: number | null; signal: NodeJS.Signals | null },
): Promise<void> {
  if (build.finished) return;
  try {
    const diskStatus = await readStatus(build.paths);
    if (isTerminalStatus(diskStatus.status)) {
      build.finished = true;
      running.delete(
        registryKey(build.status.project_id, build.status.build_id),
      );
      return;
    }
  } catch (err) {
    logger.warn("failed to read rootfs build wrapper status after close", {
      project_id: build.status.project_id,
      build_id: build.status.build_id,
      err,
    });
  }
  const finalStatus =
    build.cancelRequested ||
    opts.signal === "SIGTERM" ||
    opts.signal === "SIGKILL"
      ? "canceled"
      : opts.code === 0
        ? "succeeded"
        : "failed";
  await markFinished(build, finalStatus, {
    exit_code: opts.code,
    signal: opts.signal,
  });
}

async function signalRootfsBuildProcess({
  project_id,
  pid,
  signal,
}: {
  project_id: string;
  pid: number;
  signal: "TERM" | "KILL";
}): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const args = [
    "exec",
    "-i",
    "-u",
    ROOTFS_BUILD_USER,
    `project-${project_id}`,
    "/bin/bash",
    "-lc",
    `kill -${signal} -- "-$1" 2>/dev/null || kill -${signal} "$1" 2>/dev/null`,
    "rootfs-build-signal",
    `${pid}`,
  ];
  return await new Promise((resolve) => {
    const child = spawn("podman", args, {
      env: podmanEnv(),
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
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
  await writeFile(
    paths.hostRunner,
    rootfsBuildRunnerScript({
      build_id,
      project_id: opts.project_id,
      recipe_ref: opts.recipe_ref,
      paths,
    }),
    "utf8",
  );
  await chmod(paths.hostScript, 0o755);
  await chmod(paths.hostRunner, 0o755);
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
    stdio: "ignore",
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
    void handleChildClose(build, { code, signal }).catch((err) =>
      logger.warn("failed to persist rootfs build completion", {
        project_id: opts.project_id,
        build_id,
        err,
      }),
    );
  });

  await persistStatus(paths, status);
  child.unref();

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
  const paths = await buildPaths(project_id, build_id);
  const status = await readStatus(paths);
  if (build) {
    build.status = status;
    if (isTerminalStatus(status.status)) {
      build.finished = true;
      running.delete(key);
    }
    return status;
  }
  if (status.status === "running" || status.status === "canceling") {
    if (isFreshHeartbeat(status)) {
      return status;
    }
    return {
      ...status,
      status: "unknown",
      error:
        status.error ??
        "build heartbeat is stale and process is not tracked by this project-host process",
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
  const paths = build?.paths ?? (await buildPaths(project_id, build_id));
  let status: HostRootfsBuildStatusResponse;
  try {
    status = await readStatus(paths);
  } catch {
    status =
      build?.status ?? (await getRootfsBuildStatus({ project_id, build_id }));
  }
  if (!build) {
    if (status.status === "running" || status.status === "canceling") {
      status.status = "canceling";
      await persistStatus(paths, status);
      await appendEvent(paths, { event: "cancel_requested" });
      const signaled =
        status.pid != null
          ? await signalRootfsBuildProcess({
              project_id,
              pid: status.pid,
              signal: "TERM",
            })
          : false;
      return {
        build_id,
        project_id,
        status: "canceling",
        signaled,
        ...(signaled
          ? {}
          : {
              message:
                "build is not currently tracked and no project process could be signaled",
            }),
      };
    }
    return {
      build_id,
      project_id,
      status: status.status,
      signaled: false,
      message: "build is not currently tracked by this project-host process",
    };
  }

  build.cancelRequested = true;
  build.status = { ...status, status: "canceling" };
  await persistStatus(paths, build.status);
  await appendEvent(paths, { event: "cancel_requested" });

  let signaled =
    status.pid != null
      ? await signalRootfsBuildProcess({
          project_id,
          pid: status.pid,
          signal: "TERM",
        })
      : false;
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
    void (async () => {
      const latest = await readStatus(paths).catch(() => current?.status);
      if (latest && !isTerminalStatus(latest.status) && latest.pid != null) {
        await signalRootfsBuildProcess({
          project_id,
          pid: latest.pid,
          signal: "KILL",
        });
      }
      if (!current?.child.pid) return;
      try {
        process.kill(-current.child.pid, "SIGKILL");
      } catch {
        current.child.kill("SIGKILL");
      }
    })();
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
    running.clear();
  },
  buildPaths,
};
