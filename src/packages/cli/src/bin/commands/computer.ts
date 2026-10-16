/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// `cocalc computer`: computers connected to one of the account's projects.
// Design: src/.agents/computers-direct-host-2026-10-16.md.
//
// On the machine itself (no CoCalc credentials needed):
//   cocalc computer connect https://cocalc.ai/c/R-...   pair, then serve
//   cocalc computer daemon                             serve again later
//
// In the project it serves (any process there, agents included): list and
// exec. Each is one request to the computer through the project's host; the
// hub is not involved, and nothing is retried (at most once).

import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import {
  loadConnection,
  pairComputer,
  runConnector,
  type ConnectorIO,
} from "@cocalc/backend/computers/connector";
import type { Client } from "@cocalc/conat/core/client";
import {
  computerExecSubject,
  computerHelloSubject,
  type ComputerExecReply,
  type ComputerHello,
} from "@cocalc/conat/computers/subjects";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
} from "@cocalc/util/computers/operations";
import { isValidUUID } from "@cocalc/util/misc";
import { openCurrentProjectConnection } from "../../api/current-project";
import type { ProjectCommandDeps } from "./project";

/**
 * What runs there. One argument is a shell line for the computer's login
 * shell (pipes, globs and ~ work there); several are the exact arguments of
 * one command, which no shell re-parses: `-- sh -c 'du -sh ~/* | sort -h'`
 * runs as written, not as `sh -c du ...` the way ssh would join it.
 */
export function commandOf(
  parts: string[],
): { command: string } | { argv: string[] } {
  return parts.length === 1 ? { command: parts[0] } : { argv: parts };
}

const HELP = `A computer is a machine (a laptop, a server) its owner connected to one
of their projects. Anything running in that project can run commands there,
as the user who connected it. Connect one in CoCalc (Settings -> Computers).

On the machine:     cocalc computer connect <the line CoCalc showed>
In the project:     cocalc computer list
                    cocalc computer exec @NAME -- uname -a     (waits; --timeout, default 10 min)
                    cocalc computer exec @NAME -- 'du -sh ~/* | sort -h'   (one argument: a shell line there)
For work that should keep going, start it in the background there:
                    cocalc computer exec @NAME -- 'nohup make > build.log 2>&1 &'`;

/** How long `list` waits for computers to answer. */
const HELLO_WAIT_MS = 2000;

function terminalIO(): ConnectorIO {
  return {
    log: (message) => console.error(message),
    // Always asked, at a terminal: connecting gives full trust here.
    confirm: async (question) => {
      if (!process.stdin.isTTY) {
        console.error(`${question} (needs a terminal to answer)`);
        return false;
      }
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const answer = await rl.question(`${question} [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
  };
}

function stopOnSignals(): AbortController {
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => stop.abort());
  }
  return stop;
}

/** The computers of this project that are connected now. */
export async function listConnectedComputers(
  client: Client,
  project_id: string,
  waitMs = HELLO_WAIT_MS,
): Promise<ComputerHello[]> {
  let sub;
  try {
    sub = await client.requestMany(
      computerHelloSubject(project_id),
      { v: 1 },
      { maxWait: waitMs },
    );
  } catch (err: any) {
    if (err?.code === 503) return []; // none connected
    throw err;
  }
  const found = new Map<string, ComputerHello>();
  const stop = setTimeout(() => sub.close(), waitMs);
  try {
    for await (const mesg of sub) {
      const hello = mesg.data as ComputerHello;
      if (hello?.v === 1 && isValidUUID(hello.computer_id)) {
        found.set(hello.computer_id, hello);
      }
    }
  } finally {
    clearTimeout(stop);
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** "@m1", "m1" or a computer id, among the connected computers. */
export function pickComputer(
  computers: ComputerHello[],
  ref: string,
): ComputerHello {
  const want = ref.replace(/^@/, "");
  const match = computers.filter(
    (c) => c.computer_id === want.toLowerCase() || c.name === want,
  );
  if (match.length === 1) return match[0];
  if (match.length > 1) {
    throw new Error(`several computers are named @${want}; use its id`);
  }
  const names = computers.map((c) => `@${c.name}`).join(", ");
  throw new Error(
    `no connected computer @${want} in this project${
      names ? ` (connected: ${names})` : " (none is connected)"
    }`,
  );
}

export function registerComputerCommand(
  program: Command,
  deps: Pick<ProjectCommandDeps, "emitSuccess" | "globalsFrom">,
): Command {
  const { emitSuccess, globalsFrom } = deps;
  const computer = program
    .command("computer")
    .description(
      "computers connected to a project: connect this machine, or (in that project) run commands on one",
    )
    .addHelpText("after", `\n${HELP}\n`);

  const show = (cmd: Command, label: string, value: unknown) =>
    emitSuccess({ globals: globalsFrom(cmd) }, label, value);

  const withProject = async <T>(
    fn: (client: Client, project_id: string) => Promise<T>,
  ): Promise<T> => {
    const { client, projectId } = await openCurrentProjectConnection();
    try {
      return await fn(client, projectId);
    } finally {
      client.close();
    }
  };

  computer
    .command("connect")
    .description(
      "run ON THE MACHINE to connect it: pairs with the account that made the request, then serves its project until stopped",
    )
    .argument("<url>", "the line CoCalc showed, like https://cocalc.ai/c/R-...")
    .action(async (url: string) => {
      const io = terminalIO();
      const stop = stopOnSignals();
      const connection = await pairComputer({ url, io, signal: stop.signal });
      await runConnector({ connection, io, signal: stop.signal });
    });

  computer
    .command("daemon")
    .description("run ON THE MACHINE: serve a connected computer again")
    .argument("[computer_id]", "which one, if this machine has several")
    .action(async (computer_id?: string) => {
      const io = terminalIO();
      const stop = stopOnSignals();
      await runConnector({
        connection: loadConnection(computer_id),
        io,
        signal: stop.signal,
      });
    });

  computer
    .command("list")
    .description("the computers connected to this project now")
    .action(async (_opts, cmd) =>
      show(
        cmd,
        "computer list",
        await withProject((client, project_id) =>
          listConnectedComputers(client, project_id),
        ),
      ),
    );

  computer
    .command("exec")
    .argument("<computer>", "@name or id (see `cocalc computer list`)")
    .argument(
      "<command...>",
      "after --: one quoted shell line ('du -sh ~/* | sort -h'), or a command and its arguments",
    )
    .description(
      "run a command there and wait until it finishes (stopped after --timeout)",
    )
    .option("--cwd <path>", "working directory (default: home)")
    .option(
      "--timeout <seconds>",
      `stop it after this long (default ${DEFAULT_EXEC_TIMEOUT_MS / 1000}, at most ${MAX_EXEC_TIMEOUT_MS / 1000})`,
      `${DEFAULT_EXEC_TIMEOUT_MS / 1000}`,
    )
    .action(async (ref: string, parts: string[], opts, cmd) => {
      const timeout = Number(opts.timeout);
      if (
        !Number.isFinite(timeout) ||
        timeout <= 0 ||
        timeout * 1000 > MAX_EXEC_TIMEOUT_MS
      ) {
        throw new Error(
          `--timeout is in seconds, at most ${MAX_EXEC_TIMEOUT_MS / 1000}`,
        );
      }
      const timeout_ms = Math.round(timeout * 1000);
      const reply = await withProject(async (client, project_id) => {
        const target = isValidUUID(ref)
          ? { computer_id: ref.toLowerCase() }
          : pickComputer(await listConnectedComputers(client, project_id), ref);
        try {
          const mesg = await client.request(
            computerExecSubject(project_id, target.computer_id),
            {
              v: 1,
              request: {
                ...commandOf(parts),
                cwd: opts.cwd ?? null,
                timeout_ms,
              },
            },
            // Its own timeout, plus time to stop it and answer.
            { timeout: timeout_ms + 30_000 },
          );
          return mesg.data as ComputerExecReply;
        } catch (err: any) {
          if (err?.code === 503) {
            throw new Error(
              `that computer isn't connected to this project now`,
            );
          }
          // Sent, but no answer: it may or may not have run (never retried).
          throw new Error(
            `no answer from the computer (${err?.message ?? err}); the command may or may not have run`,
          );
        }
      });
      const globals = globalsFrom(cmd);
      if (globals.json || reply?.ok !== true) {
        show(cmd, "computer exec", reply);
        if (reply?.ok !== true) process.exitCode = 1;
        return;
      }
      const r = reply.result;
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      if (r.truncated)
        console.error("[output truncated: at most 1 MB is returned]");
      if (r.timed_out) {
        console.error(
          `[stopped: it ran longer than --timeout ${timeout} s; give it more time (at most ${MAX_EXEC_TIMEOUT_MS / 1000} s), or start it in the background there]`,
        );
      }
      if (r.cancelled) {
        console.error("[stopped: the computer was disconnected or revoked]");
      }
      process.exitCode = typeof r.exit_code === "number" ? r.exit_code : 1;
    });

  return computer;
}
