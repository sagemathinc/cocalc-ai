/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Run one sensor script for its project, like a command in the agent's turn:
// in the project's own software and environment, as the approving account,
// with the credentials the hub issued for this run only. The hub decides
// what the result means; the host only executes and reports.

import { promises as fs } from "node:fs";
import { join, posix } from "node:path";
import { data } from "@cocalc/backend/data";
import {
  SENSOR_LANGUAGES,
  SENSOR_LIMITS,
  sensorInterpreterArgv,
  type RunSensorRequest,
  type RunSensorResult,
} from "@cocalc/conat/agents/sensors";
import { isValidUUID } from "@cocalc/util/misc";
import { DEFAULT_PROJECT_RUNTIME_HOME } from "@cocalc/util/project-runtime";
import { sandboxExec } from "@cocalc/project-runner/run/sandbox-exec";
import {
  CLI_CONNECTOR_DIR,
  syncCliConnectorTokens,
  writeCliConnectorTools,
} from "./codex/cli-connector-files";

/** Output beyond this kills the run; scripts should print little. */
const MAX_OUTPUT_BYTES = 1_000_000;
/** Allowance for starting and stopping the container. */
const CONTAINER_OVERHEAD_MS = 60_000;
const TIMEOUT_EXIT = 124;
/** Where the run's credentials appear inside its container (read-only). */
export const SENSOR_CREDENTIALS_DIR = "/run/cocalc-sensor";

function sensorRunsRoot(): string {
  return join(data, "cache", "sensor-runs");
}

/**
 * The container's command: a login shell like the agent's commands, which
 * creates the state directory and runs the approved body (an argument, never
 * a file the project could swap) under `timeout`.
 */
export function sensorArgv(
  request: Pick<RunSensorRequest, "language" | "script">,
  seconds: number,
): string[] {
  return [
    "/bin/bash",
    "-lc",
    // $0 is the timeout; "$@" is the interpreter and the approved body.
    'mkdir -p -- "${COCALC_SENSOR_STATE%/*}" && exec timeout -k 5 "$0" "$@"',
    `${seconds}`,
    ...sensorInterpreterArgv(request.language, request.script),
  ];
}

async function writeSecret(path: string, value: string): Promise<void> {
  await fs.writeFile(path, value, { mode: 0o600 });
}

export async function runSensor(
  request: RunSensorRequest,
  {
    exec = sandboxExec,
    apiUrl,
    runsRoot = sensorRunsRoot(),
  }: {
    exec?: typeof sandboxExec;
    apiUrl?: string;
    runsRoot?: string;
  } = {},
): Promise<RunSensorResult> {
  if (
    !isValidUUID(request.project_id) ||
    !isValidUUID(request.sensor_id) ||
    !isValidUUID(request.run_id)
  )
    throw new Error("invalid sensor run request");
  if (!SENSOR_LANGUAGES.includes(request.language))
    throw new Error("invalid sensor language");
  const { credentials } = request;
  if (!credentials?.identity?.token || !credentials.bearer)
    throw new Error("sensor run credentials are missing");
  const seconds = Math.min(
    SENSOR_LIMITS.maxTimeoutSeconds,
    Math.max(
      SENSOR_LIMITS.minTimeoutSeconds,
      Math.floor(request.timeout_seconds),
    ),
  );
  const HOME = DEFAULT_PROJECT_RUNTIME_HOME;
  const path = posix.resolve(HOME, request.path);
  const dir = SENSOR_CREDENTIALS_DIR;
  // The run's credentials, on the host, private to the host user (which the
  // container's project user maps to) and removed when the run ends.
  const hostDir = join(runsRoot, request.run_id);
  await fs.mkdir(runsRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(hostDir, { mode: 0o700 });
  try {
    await writeSecret(
      join(hostDir, "identity.json"),
      JSON.stringify(credentials.identity),
    );
    await writeSecret(join(hostDir, "token"), `${credentials.bearer}\n`);
    const env: Record<string, string> = {
      COCALC_SENSOR_ID: request.sensor_id,
      COCALC_SENSOR_RUN_ID: request.run_id,
      COCALC_SENSOR_STATE: `${HOME}/.local/share/cocalc/sensors/${request.sensor_id}/state.json`,
      COCALC_AGENT_IDENTITY_FILE: `${dir}/identity.json`,
      COCALC_BEARER_TOKEN_FILE: `${dir}/token`,
      COCALC_AGENT_TOKEN_FILE: `${dir}/token`,
      COCALC_API_URL:
        apiUrl ??
        (await import("./codex/codex-project")).resolveProjectRuntimeApiUrl(),
    };
    if (credentials.connector_key) {
      await writeSecret(
        join(hostDir, "connector-key"),
        `${credentials.connector_key}\n`,
      );
      env.COCALC_CONNECTOR_API_KEY_FILE = `${dir}/connector-key`;
    }
    const pathPrefix: string[] = [];
    if (credentials.cli_tokens?.length) {
      await writeCliConnectorTools(
        hostDir,
        credentials.cli_tokens.map((token) => token.connector),
      );
      await syncCliConnectorTokens(hostDir, credentials.cli_tokens);
      pathPrefix.push(`${dir}/${CLI_CONNECTOR_DIR}/bin`);
    }
    const result = await exec({
      project_id: request.project_id,
      script: "",
      argv: sensorArgv(request, seconds),
      env,
      // The agent's chat directory.
      cwd: posix.dirname(path),
      // The project's software, named by the hub's project record rather
      // than the image file in the project's home.
      image: request.image,
      extraMounts: [{ source: hostDir, target: dir, readOnly: true }],
      // Other turns' credentials (in scratch /tmp or the runtime directory)
      // are not this run's: hide them.
      tmpfs: ["/tmp", `${HOME}/.local/share/cocalc/runtime`],
      // Like agent commands: no sudo or setuid.
      noNewPrivileges: true,
      pathPrefix,
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
  } finally {
    await fs.rm(hostDir, { recursive: true, force: true });
  }
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}
