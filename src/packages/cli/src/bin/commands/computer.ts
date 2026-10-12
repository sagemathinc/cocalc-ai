/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// `cocalc computer`: computers connected to an account for its agents.
// Plan: src/.agents/computers-plan-2026-10-11.md.
//
// On the machine itself (no CoCalc credentials needed):
//   cocalc computer connect https://cocalc.ai/c/R-...   pair, then serve
//   cocalc computer daemon                             serve again later
//
// From an agent (its runtime identity): list, show, request, and the
// operations exec/run/jobs/logs/kill/info/ops. Each operation gets a ticket
// from the account's home bay for exactly that request, proves possession of
// a fresh key, and the hub relays it to the computer, which checks it all.

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import {
  generateSigningKey,
  signProofOfPossession,
} from "@cocalc/backend/computers/crypto";
import {
  loadConnection,
  pairComputer,
  runConnector,
  type ConnectorIO,
} from "@cocalc/backend/computers/connector";
import { sendIdentityMessage } from "../core/agent-message";
import type { ProjectCommandDeps } from "./project";

const HELP = `A computer is a machine (a laptop, a server) whose owner connected it so
the agents in one of their agent networks can run commands there. Direct
mode is full trust: commands run as the user who connected it.

On the machine:   cocalc computer connect <the line CoCalc showed>
From an agent:    cocalc computer request NAME --why "..."   (the owner approves)
                  cocalc computer exec @NAME -- uname -a
                  cocalc computer run @NAME --description "build" -- make
                  cocalc computer jobs @NAME ; logs @NAME JOB ; kill @NAME JOB`;

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

/** "@m1" and "m1" name the same computer. */
function ref(computer: string): string {
  return computer.replace(/^@/, "");
}

export function registerComputerCommand(
  program: Command,
  deps: Pick<ProjectCommandDeps, "emitSuccess" | "globalsFrom">,
): Command {
  const { emitSuccess, globalsFrom } = deps;
  const computer = program
    .command("computer")
    .description(
      "computers connected for your agents: connect this machine, or (as an agent) request one and run commands on it",
    )
    .addHelpText("after", `\n${HELP}\n`);

  const send = async (cmd: Command, request: any) =>
    await sendIdentityMessage(request, globalsFrom(cmd).api);

  /** Ticket, proof of possession, relay. */
  const operate = async (
    cmd: Command,
    name: string,
    operation: string,
    request: unknown,
  ): Promise<any> => {
    const pop = generateSigningKey();
    const operation_id = randomUUID();
    const issued: any = await send(cmd, {
      action: "computer",
      op: "ticket",
      computer: ref(name),
      operation,
      request,
      operation_id,
      pop_key: pop.publicDer,
    });
    if (issued?.finished) return { finished: issued.finished, operation_id };
    const t = issued.ticket.payload;
    const result: any = await send(cmd, {
      action: "computer",
      op: "send",
      ticket: issued.ticket,
      proof: signProofOfPossession(pop, t.ticket_id, t.request_hash),
      request: issued.operation.request,
    });
    if (!result?.answered) {
      return {
        dispatched: true,
        operation_id,
        hint: `still running; see: cocalc computer ops ${name} ${operation_id}`,
      };
    }
    return result.reply;
  };

  const show = (cmd: Command, label: string, value: unknown) =>
    emitSuccess({ globals: globalsFrom(cmd) }, label, value);

  computer
    .command("connect")
    .description(
      "run ON THE MACHINE to connect it: pairs with the account that made the request, then serves its agents until stopped",
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
    .description(
      "run ON THE MACHINE: serve a connected computer again (one without a time limit)",
    )
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
    .description("the computers your agent network can use")
    .action(async (_opts, cmd) =>
      show(
        cmd,
        "computer list",
        await send(cmd, { action: "computer", op: "list" }),
      ),
    );

  computer
    .command("show")
    .argument("<computer>")
    .description("one computer, with its notes")
    .action(async (name: string, _opts, cmd) =>
      show(
        cmd,
        "computer show",
        await send(cmd, {
          action: "computer",
          op: "show",
          computer: ref(name),
        }),
      ),
    );

  computer
    .command("request")
    .argument("<name>", "a short name, like m1 or gpu-box")
    .description(
      "ask the owner to connect a computer (they approve it and run one line on the machine)",
    )
    .requiredOption(
      "--why <text>",
      "what you need it for (the owner sees this)",
    )
    .option("--hours <n>", "how long (default 1)", "1")
    .option(
      "--max-hours <n>",
      "how long the owner may extend it (default 8)",
      "8",
    )
    .option(
      "--no-time-limit",
      "no time limit (a machine the owner keeps connected)",
    )
    .option(
      "--network <id>",
      "agent network it serves (default: yours, if one)",
    )
    .action(async (name: string, opts, cmd) => {
      const hours = Number(opts.hours);
      const maxHours = Number(opts.maxHours);
      const policy: Record<string, unknown> = {
        version: 1,
        mode: "direct",
        duration:
          opts.timeLimit === false
            ? null
            : {
                initial_seconds: Math.round(hours * 3600),
                max_seconds: Math.round(Math.max(hours, maxHours) * 3600),
              },
        network: "on",
        gpu: true,
        mounts: [],
        images: { kind: "any" },
        scratch_bytes: null,
        limits: { cpu_millis: null, memory_bytes: null, pids: null },
      };
      if (opts.network) policy.agent_network_id = opts.network;
      show(
        cmd,
        "computer request",
        await send(cmd, {
          action: "computer",
          op: "request",
          name,
          policy,
          why: opts.why,
        }),
      );
    });

  computer
    .command("exec")
    .argument("<computer>")
    .argument("<command...>", "the command line, after --")
    .description("run a command there and wait for it (up to --timeout)")
    .option("--cwd <path>", "working directory (default: home)")
    .option("--timeout <seconds>", "stop it after this long (default 20)", "20")
    .action(async (name: string, parts: string[], opts, cmd) => {
      const reply = await operate(cmd, name, "exec", {
        command: parts.join(" "),
        cwd: opts.cwd ?? null,
        timeout_ms: Math.round(Number(opts.timeout) * 1000),
      });
      const globals = globalsFrom(cmd);
      if (globals.json || reply?.ok !== true) {
        show(cmd, "computer exec", reply);
        if (reply?.ok === false) process.exitCode = 1;
        return;
      }
      const r = reply.result ?? {};
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      if (r.truncated) console.error("[output truncated]");
      process.exitCode = typeof r.exit_code === "number" ? r.exit_code : 1;
    });

  computer
    .command("run")
    .argument("<computer>")
    .argument("<command...>", "the command line, after --")
    .description("start a long-running job there (see jobs, logs, kill)")
    .requiredOption("--description <text>", "what it is (others can see it)")
    .option("--name <name>", "a name for the job")
    .option("--exclusive", "refuse if another job has this name")
    .option("--no-nice", "don't run it under nice")
    .option("--cwd <path>", "working directory (default: home)")
    .action(async (name: string, parts: string[], opts, cmd) =>
      show(
        cmd,
        "computer run",
        await operate(cmd, name, "run", {
          command: parts.join(" "),
          cwd: opts.cwd ?? null,
          description: opts.description,
          name: opts.name ?? null,
          exclusive: !!opts.exclusive,
          nice: opts.nice !== false,
        }),
      ),
    );

  computer
    .command("jobs")
    .argument("<computer>")
    .description("jobs on that computer")
    .action(async (name: string, _opts, cmd) =>
      show(cmd, "computer jobs", await operate(cmd, name, "jobs", {})),
    );

  computer
    .command("logs")
    .argument("<computer>")
    .argument("<job>", "the job id (the operation id of its run)")
    .option("--tail <lines>", "last lines (default 100)", "100")
    .description("a job's output")
    .action(async (name: string, job: string, opts, cmd) => {
      const reply = await operate(cmd, name, "logs", {
        job_id: job,
        tail_lines: Number(opts.tail),
      });
      const log = reply?.ok === true ? reply.result?.log : undefined;
      if (!globalsFrom(cmd).json && typeof log === "string") {
        process.stdout.write(log ? `${log}\n` : "");
        return;
      }
      show(cmd, "computer logs", reply);
    });

  computer
    .command("kill")
    .argument("<computer>")
    .argument("<job>")
    .description("stop a job")
    .action(async (name: string, job: string, _opts, cmd) =>
      show(
        cmd,
        "computer kill",
        await operate(cmd, name, "kill", { job_id: job }),
      ),
    );

  computer
    .command("info")
    .argument("<computer>")
    .description("the computer's state: session time left, jobs, versions")
    .action(async (name: string, _opts, cmd) =>
      show(cmd, "computer info", await operate(cmd, name, "info", {})),
    );

  computer
    .command("ops")
    .argument("<computer>")
    .argument("[operation_id]", "one operation (e.g. an exec still running)")
    .description("your recent operations there, or one of them")
    .action(
      async (name: string, operation_id: string | undefined, _opts, cmd) =>
        show(
          cmd,
          "computer ops",
          await operate(cmd, name, "ops", {
            operation_id: operation_id ?? null,
          }),
        ),
    );

  return computer;
}
