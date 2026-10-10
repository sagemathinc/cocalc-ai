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
  sensorCommand,
  type RunSensorRequest,
  type RunSensorResult,
} from "@cocalc/conat/agents/sensors";
import { isValidUUID } from "@cocalc/util/misc";
import { sandboxExec } from "@cocalc/project-runner/run/sandbox-exec";

/** Output beyond this kills the run; scripts should print little. */
const MAX_OUTPUT_BYTES = 1_000_000;
/** Allowance for starting and stopping the container. */
const CONTAINER_OVERHEAD_MS = 60_000;
const TIMEOUT_EXIT = 124;

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
  const path = posix.resolve("/home/user", request.path);
  const cwd = posix.dirname(path);
  const state = `/home/user/.local/share/cocalc/sensors/${request.sensor_id}/state.json`;
  // `timeout` stops the script inside the container, so a hung script never
  // outlives its run even if the container runtime is slow to clean up.
  // The approved body travels inside the command line, never through a file
  // the project could swap between approval and execution.
  const command = [
    `mkdir -p ${shellQuote(posix.dirname(state))}`,
    `cd ${shellQuote(cwd)} 2>/dev/null || cd ~`,
    `timeout -k 5 ${seconds} bash -c ${shellQuote(
      sensorCommand(request.language, request.script),
    )}`,
  ].join("\n");
  const result = await exec({
    project_id: request.project_id,
    script: command,
    env: {
      COCALC_SENSOR_ID: request.sensor_id,
      COCALC_SENSOR_RUN_ID: request.run_id,
      COCALC_SENSOR_STATE: state,
    },
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

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}
