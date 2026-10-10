/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// `cocalc sensor`: an agent proposes, sets and inspects its sensors with its
// runtime identity. A sensor is the agent on a schedule, without the model:
// it runs with the access the approving person gave the agent. People approve,
// resume and run sensors in the agent's Sensors dialog; there is deliberately
// no CLI path for that.

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import {
  parseSensorWake,
  sensorExitPaths,
  sensorInterpreterArgv,
  validateSensorSpec,
} from "@cocalc/conat/agents/sensors";
import { describeSensorSchedule } from "@cocalc/util/ai/sensor-schedule";
import { sendIdentityMessage } from "../core/agent-message";
import type { ProjectCommandDeps } from "./project";
import { spawnProjectTerminalSession } from "./project/terminal";

const CONTRACT = `A sensor is you (the agent) on a schedule, without the model. Three kinds:

1. Watchers: CoCalc's own one-shot checks. No approval; use them instead of
   polling, then end your turn. You get one turn when it happens:
     cocalc sensor watch ci --repo owner/name --pr 123
     cocalc sensor watch file --path out.log [--match 'BUILD DONE']
     cocalc sensor watch at --at 2026-10-16T15:00:00Z --note "check PR 123"
     cocalc sensor watch exit -- make test   # runs it in a project terminal
2. Scripts: a small program you write and a person approves. It runs like a
   command in your turn: in this project's software, as the approving person,
   with the connectors the spec lists in "uses" (if they gave them to you).
   Most runs find nothing and print no wake line. To wake yourself, print
     {"wake": true, "summary": "2 new issues", "data": {...}}
   (summary up to 500 characters, data up to 16 KB; the last such line wins).
   It gets COCALC_SENSOR_STATE, a JSON file to remember what it saw, and your
   identity (cocalc agent send works). Test it first with "cocalc sensor test".
   While one of its wakes waits for you, later ones are held and arrive
   together in the next wake.
3. Scheduled prompts: a prompt sent to you on a schedule, a normal turn.

Script spec (JSON): {"title", "purpose", "language": "sh"|"python"|"node",
  "script", "uses": ["cocalc"|"github"|"cloudflare", ...] (default none),
  "schedule": {"kind": "interval", "minutes": 30}
           or {"kind": "daily", "times": ["07:00"], "timezone": "Europe/Berlin"},
  optional "days" [0-6, 0=Sunday], interval "window" {"start","end"},
  "timeout_seconds" (default 60, max 300), "max_wakes_per_day" (default 24)}
Prompt spec: {"kind": "prompt", "title", "prompt", "schedule", "max_wakes_per_day"}`;

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

/**
 * Run a script spec's code here once, the way a scheduled run does (a login
 * shell in this project's software, the body as an argument, the sensor
 * variables), and report what the run would do. It uses this turn's
 * credentials; a scheduled run gets its own, for the connectors it lists.
 */
async function testSpec(spec: any) {
  const checked = validateSensorSpec(spec, {
    minIntervalMinutes: 1,
    maxWakesPerDay: 1_000,
  });
  if (checked.kind !== "script")
    throw new Error("only script sensors have code to test");
  const dir = join(homedir(), ".local/share/cocalc/sensors/test");
  await mkdir(dir, { recursive: true });
  const argv = sensorInterpreterArgv(checked.language, checked.script);
  const started = Date.now();
  const result = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn("bash", ["-lc", 'exec "$@"', "sensor", ...argv], {
      env: {
        ...process.env,
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
    uses: checked.uses,
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

/**
 * The command an exit watcher waits for, as a terminal runs it: its output
 * goes to the log (and the terminal), then its exit code to the status file.
 * The command is an argument, never spliced into the script.
 */
export function exitWatcherArgs(command: string, id: string): string[] {
  const home = homedir();
  const abs = (path: string) => path.replace(/^~/, home);
  const paths = sensorExitPaths(id);
  const script = [
    'mkdir -p -- "$2"',
    'bash -lc "$1" 2>&1 | tee -- "$3"',
    "code=${PIPESTATUS[0]}",
    `printf '{"exit_code": %d}\\n' "$code" > "$4.tmp" && mv -- "$4.tmp" "$4"`,
    'echo "[exit $code]"',
  ].join("; ");
  return [
    "-lc",
    script,
    "sensor-exit",
    command,
    abs(paths.dir),
    abs(paths.log),
    abs(paths.status),
  ];
}

export function registerSensorCommand(
  program: Command,
  deps: Pick<
    ProjectCommandDeps,
    | "emitSuccess"
    | "globalsFrom"
    | "withContext"
    | "resolveProjectFromArgOrContext"
    | "resolveProjectConatClient"
  >,
): Command {
  const { emitSuccess, globalsFrom } = deps;
  const sensor = program
    .command("sensor")
    .description(
      "watch for events, propose scheduled scripts and prompts, and inspect this agent's sensors (uses the runtime agent identity)",
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
      "run a script spec's code here once, as a scheduled run would, and show whether it would wake the agent",
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
  const watch = sensor
    .command("watch")
    .description(
      "wake this agent once when something happens (no approval needed); end your turn after setting it",
    );
  const hours = (value?: string) =>
    value == null ? {} : { hours: Number(value) };
  watch
    .command("ci")
    .description("when a GitHub pull request's checks have all finished")
    .requiredOption("--repo <owner/name>", "repository")
    .requiredOption("--pr <number>", "pull request number")
    .option("--hours <n>", "give up after this many hours (default 24)")
    .action(async (opts, cmd) =>
      send(
        cmd,
        {
          action: "sensor",
          op: "watch",
          watch: { type: "ci", repo: opts.repo, pr: Number(opts.pr) },
          ...hours(opts.hours),
        },
        "sensor watch ci",
      ),
    );
  watch
    .command("file")
    .description(
      "when a regular file exists (relative to this chat's directory), optionally once its last 1 MB contains some text",
    )
    .requiredOption("--path <path>", "file to watch")
    .option(
      "--match <text>",
      "wait until it contains this text (plain text, not a regular expression)",
    )
    .option("--hours <n>", "give up after this many hours (default 24)")
    .action(async (opts, cmd) =>
      send(
        cmd,
        {
          action: "sensor",
          op: "watch",
          watch: {
            type: "file",
            path: opts.path,
            ...(opts.match ? { match: opts.match } : {}),
          },
          ...hours(opts.hours),
        },
        "sensor watch file",
      ),
    );
  watch
    .command("at")
    .description("a reminder: wake at a time with a note to yourself")
    .requiredOption("--at <time>", "ISO time, e.g. 2026-10-16T15:00:00Z")
    .requiredOption("--note <text>", "what to do then")
    .action(async (opts, cmd) =>
      send(
        cmd,
        {
          action: "sensor",
          op: "watch",
          watch: { type: "at", at: opts.at, note: opts.note },
        },
        "sensor watch at",
      ),
    );
  watch
    .command("exit")
    .description(
      "run a command in a project terminal (it keeps running after your turn) and wake once when it exits, with its exit code and the end of its output",
    )
    .argument("<command...>", "the command and its arguments, after --")
    .option("--cwd <path>", "working directory in the project")
    .option("--hours <n>", "give up after this many hours (default 24)")
    .action(async (commandParts: string[], opts, cmd) =>
      deps.withContext(cmd, "sensor watch exit", async (ctx: any) => {
        const command = commandParts.join(" ").trim();
        if (!command) throw new Error("give the command after --");
        const id = randomUUID();
        const api = globalsFrom(cmd).api;
        // The watcher first: nothing runs if it cannot be set.
        const set: any = await sendIdentityMessage(
          {
            action: "sensor",
            op: "watch",
            watch: { type: "exit", id, command: command.slice(0, 200) },
            ...hours(opts.hours),
          },
          api,
        );
        const terminal_id = `sensor-exit-${id.slice(0, 8)}`;
        try {
          await spawnProjectTerminalSession({
            ctx,
            resolveProjectFromArgOrContext: deps.resolveProjectFromArgOrContext,
            resolveProjectConatClient: deps.resolveProjectConatClient,
            id: terminal_id,
            command: "bash",
            args: exitWatcherArgs(command, id),
            cwd: `${opts.cwd ?? ""}`.trim() || undefined,
          });
        } catch (err) {
          // It never started, so nothing will exit: remove the watcher.
          const sensor_id = set?.sensor?.sensor_id;
          if (sensor_id)
            await sendIdentityMessage(
              { action: "sensor", op: "delete", sensor_id },
              api,
            ).catch(() => undefined);
          throw err;
        }
        return {
          ...set,
          terminal_id,
          output_file: sensorExitPaths(id).log,
          message: `Running in project terminal ${terminal_id}. You will get one [Sensor wake] turn when it exits, with its exit code and the end of its output. You can end your turn now.`,
        };
      }),
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
