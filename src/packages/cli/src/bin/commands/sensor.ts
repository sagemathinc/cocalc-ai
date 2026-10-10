/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// `cocalc sensor`: an agent proposes and inspects its sensors with its
// runtime identity. People approve, resume and run them in the agent's
// Sensors panel; there is deliberately no CLI path for that.

import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import {
  SENSOR_TRUSTED_PATH,
  parseSensorWake,
  sensorInterpreterArgv,
  validateSensorSpec,
} from "@cocalc/conat/agents/sensors";
import { describeSensorSchedule } from "@cocalc/util/ai/sensor-schedule";
import { sendIdentityMessage } from "../core/agent-message";
import type { ProjectCommandDeps } from "./project";

const CONTRACT = `A sensor is a small script CoCalc runs on a schedule in this project. It
should be cheap and quiet: most runs find nothing and print no wake line.
To wake the agent, print one JSON line:
  {"wake": true, "summary": "2 new issues", "data": {...}}
(summary up to 500 characters, data up to 16 KB; the last such line wins).
The script gets COCALC_SENSOR_ID and COCALC_SENSOR_STATE, a JSON file it may
read and write to remember what it saw. It runs on the project's base image
(without software installed into the project, and without sudo) with a clean
environment: PATH has only system and CoCalc tools (not ~/bin), Python runs
isolated (-I, no user packages), and project environment variables are not
set. Nothing
runs until a person approves the exact spec. Test first with
"cocalc sensor test --file spec.json".

Spec (JSON): {"title", "purpose", "language": "sh"|"python"|"node", "script",
  "schedule": {"kind": "interval", "minutes": 30}
           or {"kind": "daily", "times": ["07:00"], "timezone": "Europe/Berlin"},
  optional "days" [0-6, 0=Sunday], interval "window" {"start","end"},
  "timeout_seconds" (default 60, max 300), "max_wakes_per_day" (default 24)}`;

async function readSpec(opts: { file?: string; stdin?: boolean }) {
  let text: string;
  if (opts.file) text = await readFile(opts.file, "utf8");
  else if (opts.stdin) {
    text = "";
    for await (const chunk of process.stdin) text += chunk;
  } else throw new Error("give the spec with --file spec.json or --stdin");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("the sensor spec must be JSON");
  }
}

/** Run a spec's script here, the way CoCalc would, and report the result. */
async function testSpec(spec: any) {
  const checked = validateSensorSpec(spec, {
    minIntervalMinutes: 1,
    maxWakesPerDay: 1_000,
  });
  const dir = join(homedir(), ".local/share/cocalc/sensors/test");
  await mkdir(dir, { recursive: true });
  // The same clean environment and interpreter flags as a scheduled run.
  const argv = sensorInterpreterArgv(checked.language, checked.script);
  const started = Date.now();
  const result = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: {
        HOME: homedir(),
        USER: process.env.USER ?? "user",
        LOGNAME: process.env.USER ?? "user",
        LANG: "C.UTF-8",
        TERM: "dumb",
        PATH: SENSOR_TRUSTED_PATH,
        COCALC_PROJECT_ID: process.env.COCALC_PROJECT_ID ?? "",
        COCALC_SENSOR_ID: "test",
        COCALC_SENSOR_RUN_ID: "test",
        COCALC_SENSOR_STATE: join(dir, "state.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: checked.timeout_seconds * 1000,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  let wake: unknown;
  let wake_error: string | undefined;
  try {
    wake = parseSensorWake(result.stdout) ?? null;
  } catch (err) {
    wake_error = err instanceof Error ? err.message : `${err}`;
  }
  return {
    schedule: describeSensorSchedule(checked.schedule),
    exit_code: result.code,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    outcome:
      result.code !== 0
        ? "failed"
        : wake_error
          ? "failed"
          : wake
            ? "wake"
            : "quiet",
    wake,
    ...(wake_error ? { wake_error } : {}),
    stdout: result.stdout.slice(-4000),
    stderr: result.stderr.slice(-4000),
    state_file: join(dir, "state.json"),
  };
}

export function registerSensorCommand(
  program: Command,
  deps: Pick<ProjectCommandDeps, "emitSuccess" | "globalsFrom">,
): Command {
  const { emitSuccess, globalsFrom } = deps;
  const sensor = program
    .command("sensor")
    .description(
      "propose and inspect this agent's sensors: approved scripts that run on a schedule and can wake the agent (uses the runtime agent identity)",
    )
    .addHelpText("after", `\n${CONTRACT}\n`);
  const send = async (cmd: Command, request: any, label: string) => {
    const globals = globalsFrom(cmd);
    emitSuccess(
      { globals },
      label,
      await sendIdentityMessage(request, globals.api),
    );
  };
  sensor
    .command("propose")
    .description(
      "propose a new sensor, or a change to one with --sensor; a person must approve it before it runs",
    )
    .option("--file <path>", "spec JSON file")
    .option("--stdin", "read the spec JSON from standard input")
    .option("--sensor <id>", "revise this sensor instead of creating one")
    .action(async (opts, cmd) =>
      send(
        cmd,
        {
          action: "sensor",
          op: "propose",
          spec: await readSpec(opts),
          ...(opts.sensor ? { sensor_id: opts.sensor } : {}),
        },
        "sensor propose",
      ),
    );
  sensor
    .command("test")
    .description(
      "run a spec's script here once, as CoCalc would, and show whether it would wake the agent",
    )
    .option("--file <path>", "spec JSON file")
    .option("--stdin", "read the spec JSON from standard input")
    .action(async (opts, cmd) =>
      emitSuccess(
        { globals: globalsFrom(cmd) },
        "sensor test",
        await testSpec(await readSpec(opts)),
      ),
    );
  sensor
    .command("list")
    .description("list this agent's sensors")
    .action(async (_opts, cmd) =>
      send(cmd, { action: "sensor", op: "list" }, "sensor list"),
    );
  sensor
    .command("show <sensor>")
    .alias("logs")
    .description("show one sensor, its spec and its recent runs")
    .action(async (sensor_id: string, _opts, cmd) =>
      send(cmd, { action: "sensor", op: "show", sensor_id }, "sensor show"),
    );
  sensor
    .command("pause <sensor>")
    .description("pause an active sensor; a person resumes it")
    .action(async (sensor_id: string, _opts, cmd) =>
      send(cmd, { action: "sensor", op: "pause", sensor_id }, "sensor pause"),
    );
  sensor
    .command("delete <sensor>")
    .description("delete a sensor and its run log")
    .action(async (sensor_id: string, _opts, cmd) =>
      send(cmd, { action: "sensor", op: "delete", sensor_id }, "sensor delete"),
    );
  return sensor;
}
