/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { appendSupervisionEvent } from "./supervision-events";

const COMMAND_ENV = "COCALC_PROJECT_HOST_SUPERVISED_COMMAND";
const ARGS_ENV = "COCALC_PROJECT_HOST_SUPERVISED_ARGS";
const CWD_ENV = "COCALC_PROJECT_HOST_SUPERVISED_CWD";
const VERSION_ENV = "COCALC_PROJECT_HOST_SUPERVISED_VERSION";
const COMPONENT_ENV = "COCALC_PROJECT_HOST_SUPERVISED_COMPONENT";
const CHILD_PID_PATH_ENV = "COCALC_PROJECT_HOST_SUPERVISED_PID_PATH";
const APP_PID_PATH_ENV = "COCALC_PROJECT_HOST_APP_PID_PATH";
const SUPERVISOR_PID_ENV = "COCALC_PROJECT_HOST_SUPERVISOR_PID";

type SupervisedComponent = "project-host" | "conat-persist";

const FORWARDED_SIGNALS: NodeJS.Signals[] = [
  "SIGTERM",
  "SIGINT",
  "SIGQUIT",
  "SIGHUP",
];

export type SupervisedAppResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  childPid?: number;
  spawnError?: Error;
  forwardedSignal?: NodeJS.Signals;
};

function parseArgs(value: string | undefined): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== "string")) {
    throw new Error(`${ARGS_ENV} must be a JSON array of strings`);
  }
  return parsed;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[COMMAND_ENV];
  delete env[ARGS_ENV];
  delete env[CWD_ENV];
  delete env[VERSION_ENV];
  delete env[COMPONENT_ENV];
  delete env[CHILD_PID_PATH_ENV];
  delete env[APP_PID_PATH_ENV];
  env[SUPERVISOR_PID_ENV] = String(process.pid);
  return env;
}

function supervisedComponent(): SupervisedComponent {
  return process.env[COMPONENT_ENV] === "conat-persist"
    ? "conat-persist"
    : "project-host";
}

function supervisedProcessTitle(component: SupervisedComponent): string {
  return component === "conat-persist"
    ? "project-host:conat-persist"
    : "project-host:app";
}

function removeChildPidFile(
  childPidPath: string | undefined,
  pid?: number,
): void {
  if (!childPidPath || !pid) return;
  try {
    if (`${fs.readFileSync(childPidPath, "utf8")}`.trim() === String(pid)) {
      fs.rmSync(childPidPath, { force: true });
    }
  } catch {
    // best effort
  }
}

function recordResult(
  dataDir: string,
  component: SupervisedComponent,
  selectedVersion: string | undefined,
  result: SupervisedAppResult,
): void {
  try {
    if (result.spawnError) {
      appendSupervisionEvent(dataDir, {
        source: "daemon",
        component,
        action: "spawn_failed",
        message: `${component} child process error: ${result.spawnError.message}`,
        pid: result.childPid,
        selected_version: selectedVersion,
        metadata: {
          supervisor_pid: process.pid,
          error_name: result.spawnError.name,
          error_message: result.spawnError.message,
        },
      });
      return;
    }
    const outcome = result.signal
      ? `signal ${result.signal}`
      : `exit code ${result.code ?? "unknown"}`;
    appendSupervisionEvent(dataDir, {
      source: "daemon",
      component,
      action: "process_exit",
      message: `${component} child exited with ${outcome}`,
      pid: result.childPid,
      selected_version: selectedVersion,
      metadata: {
        supervisor_pid: process.pid,
        exit_code: result.code,
        signal: result.signal,
        forwarded_signal: result.forwardedSignal,
      },
    });
  } catch {
    // Exit evidence is best effort; never prevent the supervisor from exiting.
  }
}

export async function superviseApp(): Promise<SupervisedAppResult> {
  const command = `${process.env[COMMAND_ENV] ?? ""}`.trim();
  if (!command) {
    throw new Error(`${COMMAND_ENV} is required`);
  }
  const args = parseArgs(process.env[ARGS_ENV]);
  const cwd = `${process.env[CWD_ENV] ?? process.cwd()}`;
  const dataDir = `${process.env.COCALC_DATA ?? process.env.DATA ?? ""}`.trim();
  if (!dataDir) {
    throw new Error("COCALC_DATA or DATA is required");
  }
  const selectedVersion =
    `${process.env[VERSION_ENV] ?? ""}`.trim() || undefined;
  const component = supervisedComponent();
  const childPidPath =
    `${process.env[CHILD_PID_PATH_ENV] ?? process.env[APP_PID_PATH_ENV] ?? ""}`.trim() ||
    undefined;

  let forwardedSignal: NodeJS.Signals | undefined;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, {
      cwd,
      env: childEnvironment(),
      argv0: supervisedProcessTitle(component),
      detached: false,
      stdio: "inherit",
    });
  } catch (err) {
    const result: SupervisedAppResult = {
      code: null,
      signal: null,
      spawnError: err instanceof Error ? err : new Error(`${err}`),
    };
    recordResult(dataDir, component, selectedVersion, result);
    return result;
  }

  if (childPidPath && child.pid) {
    try {
      fs.writeFileSync(childPidPath, String(child.pid), { mode: 0o600 });
    } catch {
      // best effort
    }
  }

  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => {
      forwardedSignal = signal;
      try {
        child.kill(signal);
      } catch {
        // The child may have exited between signal delivery and forwarding.
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  const result = await new Promise<SupervisedAppResult>((resolve) => {
    let settled = false;
    const finish = (value: SupervisedAppResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (err) => {
      finish({
        code: null,
        signal: null,
        childPid: child.pid,
        spawnError: err,
        forwardedSignal,
      });
    });
    child.once("close", (code, signal) => {
      finish({
        code,
        signal,
        childPid: child.pid,
        forwardedSignal,
      });
    });
  });

  for (const signal of FORWARDED_SIGNALS) {
    const handler = signalHandlers.get(signal);
    if (handler) process.off(signal, handler);
  }
  removeChildPidFile(childPidPath, result.childPid);
  recordResult(dataDir, component, selectedVersion, result);
  return result;
}

export function supervisorExitCode(result: SupervisedAppResult): number {
  if (result.spawnError) return 1;
  if (result.signal) {
    return 128 + (os.constants.signals[result.signal] ?? 0);
  }
  return result.code ?? 1;
}

if (require.main === module) {
  superviseApp()
    .then((result) => {
      process.exit(supervisorExitCode(result));
    })
    .catch((err) => {
      console.error("project-host app supervisor failed:", err);
      process.exit(1);
    });
}
