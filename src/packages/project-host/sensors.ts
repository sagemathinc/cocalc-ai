/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Run one approved sensor script in a fresh container for its project. The
// hub supplies the approved body and decides what the result means; the host
// only executes and reports.

import { posix } from "node:path";
import {
  SENSOR_LANGUAGES,
  SENSOR_LIMITS,
  SENSOR_TRUSTED_PATH,
  sensorInterpreterArgv,
  type RunSensorRequest,
  type RunSensorResult,
} from "@cocalc/conat/agents/sensors";
import { isValidUUID } from "@cocalc/util/misc";
import {
  DEFAULT_PROJECT_RUNTIME_HOME,
  DEFAULT_PROJECT_RUNTIME_USER,
} from "@cocalc/util/project-runtime";
import { sandboxExec } from "@cocalc/project-runner/run/sandbox-exec";

/** Output beyond this kills the run; scripts should print little. */
const MAX_OUTPUT_BYTES = 1_000_000;
/** Allowance for starting and stopping the container. */
const CONTAINER_OVERHEAD_MS = 60_000;
const TIMEOUT_EXIT = 124;

/**
 * The container's command. Nothing the project can change runs before the
 * approved body: no login shell or startup files, a cleared environment (no
 * BASH_ENV, LD_PRELOAD, NODE_OPTIONS, PYTHON* or project variables) and a
 * PATH without the project's own bin directories, so the trusted `timeout`
 * and interpreters cannot be shadowed.
 */
export function sensorArgv(
  request: Pick<RunSensorRequest, "language" | "script" | "project_id">,
  {
    sensor_id,
    run_id,
    seconds,
    state,
  }: { sensor_id: string; run_id: string; seconds: number; state: string },
): string[] {
  const HOME = DEFAULT_PROJECT_RUNTIME_HOME;
  const USER = DEFAULT_PROJECT_RUNTIME_USER;
  return [
    "/usr/bin/env",
    "-i",
    `HOME=${HOME}`,
    `USER=${USER}`,
    `LOGNAME=${USER}`,
    "LANG=C.UTF-8",
    "TERM=dumb",
    `PATH=${SENSOR_TRUSTED_PATH}`,
    `COCALC_PROJECT_ID=${request.project_id}`,
    `COCALC_SENSOR_ID=${sensor_id}`,
    `COCALC_SENSOR_RUN_ID=${run_id}`,
    `COCALC_SENSOR_STATE=${state}`,
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-c",
    // $0 is the timeout; "$@" is the interpreter and the approved body.
    'mkdir -p -- "${COCALC_SENSOR_STATE%/*}" && exec /usr/bin/timeout -k 5 "$0" "$@"',
    `${seconds}`,
    ...sensorInterpreterArgv(request.language, request.script),
  ];
}

export async function runSensor(
  request: RunSensorRequest,
  exec: typeof sandboxExec = sandboxExec,
): Promise<RunSensorResult> {
  if (
    !isValidUUID(request.project_id) ||
    !isValidUUID(request.sensor_id) ||
    !isValidUUID(request.run_id)
  )
    throw new Error("invalid sensor run request");
  if (!SENSOR_LANGUAGES.includes(request.language))
    throw new Error("invalid sensor language");
  const seconds = Math.min(
    SENSOR_LIMITS.maxTimeoutSeconds,
    Math.max(
      SENSOR_LIMITS.minTimeoutSeconds,
      Math.floor(request.timeout_seconds),
    ),
  );
  const path = posix.resolve(DEFAULT_PROJECT_RUNTIME_HOME, request.path);
  const result = await exec({
    project_id: request.project_id,
    script: "",
    argv: sensorArgv(request, {
      sensor_id: request.sensor_id,
      run_id: request.run_id,
      seconds,
      state: `${DEFAULT_PROJECT_RUNTIME_HOME}/.local/share/cocalc/sensors/${request.sensor_id}/state.json`,
    }),
    // The agent's chat directory.
    cwd: posix.dirname(path),
    timeoutMs: seconds * 1000 + CONTAINER_OVERHEAD_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    useEphemeral: true,
  });
  return {
    exit_code: result.code,
    timed_out: result.code === TIMEOUT_EXIT || result.signal === "SIGKILL",
    stdout: tail(result.stdout ?? "", 64_000),
    stderr: tail(result.stderr ?? "", SENSOR_LIMITS.maxLogBytes),
  };
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}
