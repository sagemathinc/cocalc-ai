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
import type { KeyPair } from "@cocalc/backend/computers/crypto";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
} from "@cocalc/util/computers/operations";
import {
  DEFAULT_LEASE_HOURS,
  MAX_LEASE_HOURS,
  MIN_LEASE_HOURS,
} from "@cocalc/util/computers/policy";
import type { ProjectCommandDeps } from "./project";

/** An exec is settled once refused, or done/failed/unknown on the computer. */
function execSettled(s: { answered: boolean; reply: any; finished?: unknown }) {
  if (s.finished) return true;
  if (!s.answered) return false;
  if (s.reply?.ok !== true) return true;
  return ["done", "failed", "unknown"].includes(s.reply.state);
}

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

const HELP = `A computer is a machine (a laptop, a server) whose owner connected it so
the agents in one of their agent networks can run commands there. Direct
mode is full trust: commands run as the user who connected it.

On the machine:   cocalc computer connect <the line CoCalc showed>
From an agent:    cocalc computer request NAME --why "..."   (the owner approves)
                  cocalc computer exec @NAME -- uname -a     (waits; --timeout, default 10 min)
                  cocalc computer exec @NAME -- 'du -sh ~/* | sort -h'   (one argument: a shell line there)
                  cocalc computer run @NAME --description "build" -- make   (keeps going)
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

  /**
   * Ticket, proof of possession, relay. Passing `again` re-sends the same
   * operation (same id and proof key): the computer then answers with its
   * recorded outcome, or that it is still running; it never runs it twice.
   */
  const sendOnce = async (
    cmd: Command,
    name: string,
    operation: string,
    request: unknown,
    again?: { operation_id: string; pop: KeyPair },
  ): Promise<{
    answered: boolean;
    reply: any;
    finished?: { state: string; exit_code: number | null };
    operation_id: string;
    pop: KeyPair;
  }> => {
    const pop = again?.pop ?? generateSigningKey();
    const operation_id = again?.operation_id ?? randomUUID();
    const issued: any = await send(cmd, {
      action: "computer",
      op: "ticket",
      computer: ref(name),
      operation,
      request,
      operation_id,
      pop_key: pop.publicDer,
    });
    if (issued?.finished) {
      return {
        answered: true,
        reply: null,
        finished: issued.finished,
        operation_id,
        pop,
      };
    }
    const t = issued.ticket.payload;
    const result: any = await send(cmd, {
      action: "computer",
      op: "send",
      ticket: issued.ticket,
      proof: signProofOfPossession(pop, t.ticket_id, t.request_hash),
      request: issued.operation.request,
    });
    return {
      answered: !!result?.answered,
      reply: result?.reply,
      operation_id,
      pop,
    };
  };

  const operate = async (
    cmd: Command,
    name: string,
    operation: string,
    request: unknown,
  ): Promise<any> => {
    const s = await sendOnce(cmd, name, operation, request);
    if (s.finished)
      return { finished: s.finished, operation_id: s.operation_id };
    if (!s.answered) {
      return {
        dispatched: true,
        operation_id: s.operation_id,
        hint: `still running; see: cocalc computer ops ${name} ${s.operation_id}`,
      };
    }
    return s.reply;
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
      "--lease-hours <n>",
      `if the computer can't connect to CoCalc for this many hours, all its jobs stop; it runs work again once it reconnects (${MIN_LEASE_HOURS} to ${MAX_LEASE_HOURS}, default ${DEFAULT_LEASE_HOURS})`,
      `${DEFAULT_LEASE_HOURS}`,
    )
    .option(
      "--network <id>",
      "agent network it serves (default: yours, if one)",
    )
    .action(async (name: string, opts, cmd) => {
      const hours = Number(opts.hours);
      const maxHours = Number(opts.maxHours);
      const leaseHours = Number(opts.leaseHours);
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
        lease_hours: leaseHours,
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
    .argument(
      "<command...>",
      "after --: one quoted shell line ('du -sh ~/* | sort -h'), or a command and its arguments",
    )
    .description(
      "run a command there and wait until it finishes (stopped after --timeout); for work that should keep going without you, use run",
    )
    .option("--cwd <path>", "working directory (default: home)")
    .option(
      "--timeout <seconds>",
      `stop it after this long (default ${DEFAULT_EXEC_TIMEOUT_MS / 1000}, at most ${MAX_EXEC_TIMEOUT_MS / 1000})`,
      `${DEFAULT_EXEC_TIMEOUT_MS / 1000}`,
    )
    .action(async (name: string, parts: string[], opts, cmd) => {
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
      const request = {
        ...commandOf(parts),
        cwd: opts.cwd ?? null,
        timeout_ms: Math.round(timeout * 1000),
      };
      // Each call to the hub waits at most ~25 s for the answer; a longer
      // command keeps running there, and asking again with the same
      // operation returns its outcome once it has one.
      const giveUpAt = Date.now() + timeout * 1000 + 2 * 60 * 1000;
      let s = await sendOnce(cmd, name, "exec", request);
      let pause = 2000;
      while (!execSettled(s)) {
        if (Date.now() > giveUpAt) {
          console.error(
            `still running on @${ref(name)}; check it with: cocalc computer ops ${name} ${s.operation_id}`,
          );
          process.exitCode = 1;
          return;
        }
        await new Promise((r) => setTimeout(r, pause));
        pause = Math.min(pause * 2, 15_000);
        s = await sendOnce(cmd, name, "exec", request, s);
      }
      const reply = s.finished ? { finished: s.finished } : s.reply;
      const globals = globalsFrom(cmd);
      if (globals.json || reply?.ok !== true) {
        show(cmd, "computer exec", reply);
        if (reply?.ok === false || s.finished) process.exitCode = 1;
        return;
      }
      const r = reply.result ?? {};
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      if (r.truncated) console.error("[output truncated]");
      if (r.output_pruned) console.error("[its output was already removed]");
      if (r.timed_out) {
        console.error(
          `[stopped: it ran longer than --timeout ${timeout} s. Give it more time with --timeout (at most ${MAX_EXEC_TIMEOUT_MS / 1000}), or use \`cocalc computer run\` for work that should keep going]`,
        );
      }
      if (reply.state === "unknown") {
        console.error(
          "[its outcome is unknown: the computer restarted while it ran]",
        );
      }
      process.exitCode = typeof r.exit_code === "number" ? r.exit_code : 1;
    });

  computer
    .command("run")
    .argument("<computer>")
    .argument(
      "<command...>",
      "after --: one quoted shell line ('du -sh ~/* | sort -h'), or a command and its arguments",
    )
    .description(
      "start a long-running job there (see jobs, logs, kill); every job stops if the computer can't connect to CoCalc for its lease (lease_hours in `computer show`)",
    )
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
          ...commandOf(parts),
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
