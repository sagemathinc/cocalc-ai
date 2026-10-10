/**
 * Project terminal inspection and input commands.
 */
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { Command } from "commander";

import { terminalClient } from "@cocalc/conat/project/terminal";
import type { ProjectCommandDeps } from "../project";
import { chatTarget, NO_CARD_NOTE, publishCardOnce } from "./chat-card";

type CommandContext = any;

type ProjectRuntimeStateLike = {
  state?: { state?: string } | null;
};

const PROJECT_TERMINAL_RUNTIME_STATES = new Set([
  "running",
  "starting",
  "restarting",
]);

export function assertProjectTerminalRuntimeAvailable({
  project,
}: {
  project: ProjectRuntimeStateLike;
}): void {
  const state = `${project.state?.state ?? ""}`.trim();
  if (!state || PROJECT_TERMINAL_RUNTIME_STATES.has(state)) {
    return;
  }
  throw new Error(
    `project terminal operations are unavailable because the project is ${state}; start the project and try again`,
  );
}

async function withTerminalClient({
  ctx,
  projectIdentifier,
  resolveProjectFromArgOrContext,
  resolveProjectConatClient,
}: {
  ctx: CommandContext;
  projectIdentifier?: string;
  resolveProjectFromArgOrContext: ProjectCommandDeps["resolveProjectFromArgOrContext"];
  resolveProjectConatClient: ProjectCommandDeps["resolveProjectConatClient"];
}) {
  const explicit = `${projectIdentifier ?? ""}`.trim();
  const here = `${process.env.COCALC_PROJECT_ID ?? ""}`.trim();
  // Inside the target project it is running, and its own credential cannot
  // look projects up at the hub; the conat client finds it directly.
  if (!here || (explicit && explicit !== here)) {
    const resolvedProject = await resolveProjectFromArgOrContext(
      ctx,
      projectIdentifier,
    );
    assertProjectTerminalRuntimeAvailable({ project: resolvedProject });
    projectIdentifier = resolvedProject.project_id;
  }
  const { project, client } = await resolveProjectConatClient(
    ctx,
    projectIdentifier,
  );
  const terminal = terminalClient({
    project_id: project.project_id,
    client,
    reconnection: false,
  });
  return { project, terminal };
}

function normalizeMaxChars(value: string | undefined): number | undefined {
  if (value == null || `${value}`.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("--max-chars must be a nonnegative integer");
  }
  return parsed;
}

function normalizePositiveInteger(
  value: string | undefined,
  flag: string,
): number | undefined {
  if (value == null || `${value}`.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function normalizeTerminalId(value: string | undefined): string {
  const trimmed = `${value ?? ""}`.trim();
  return trimmed || `cli-${randomUUID()}`;
}

// The terminal an agent works in for a chat thread: a hidden file next to the
// chat, like the terminals of other documents.
export function agentTerminalId(chatPath: string, threadId: string): string {
  return join(dirname(chatPath), `.${basename(chatPath)}-${threadId}.term`);
}

const TERMINAL_CARD_TEXT =
  "A terminal in this project that the agent works in. You see everything it runs and can type in it too.";

export function registerProjectTerminalCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const {
    withContext,
    resolveProjectFromArgOrContext,
    resolveProjectConatClient,
    readAllStdin,
  } = deps;

  const terminal = project
    .command("terminal")
    .description("project terminal session operations");

  terminal
    .command("spawn [command...]")
    .description("spawn a terminal session")
    .option("-w, --project <project>", "project id or name")
    .option("--id <id>", "terminal session id to use")
    .option("--cwd <path>", "working directory inside project")
    .option("--path <path>", "terminal path for project-scoped tracking")
    .option("--rows <n>", "terminal rows")
    .option("--cols <n>", "terminal columns")
    .option("--bash", "treat command arguments as one bash command string")
    .action(
      async (
        commandParts: string[],
        opts: {
          project?: string;
          id?: string;
          cwd?: string;
          path?: string;
          rows?: string;
          cols?: string;
          bash?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project terminal spawn", async (ctx) => {
          const { project, terminal } = await withTerminalClient({
            ctx,
            projectIdentifier: opts.project,
            resolveProjectFromArgOrContext,
            resolveProjectConatClient,
          });
          try {
            const id = normalizeTerminalId(opts.id);
            const rows = normalizePositiveInteger(opts.rows, "--rows");
            const cols = normalizePositiveInteger(opts.cols, "--cols");
            const cwd = `${opts.cwd ?? ""}`.trim() || undefined;
            const path = `${opts.path ?? ""}`.trim() || undefined;
            const commandText = commandParts.join(" ").trim();
            const spawnCommand = opts.bash ? "bash" : commandParts[0] || "bash";
            const spawnArgs = opts.bash
              ? ["-lc", commandText || "bash"]
              : commandParts.slice(1);
            const history = await terminal.spawn(spawnCommand, spawnArgs, {
              id,
              cwd,
              path,
              rows,
              cols,
            });
            await terminal.closeAndWait();
            return {
              project_id: project.project_id,
              id,
              pid: terminal.pid ?? null,
              command: spawnCommand,
              args: spawnArgs,
              cwd: cwd ?? null,
              path: path ?? null,
              history: history ?? "",
            };
          } finally {
            terminal.close();
          }
        });
      },
    );

  terminal
    .command("start")
    .description(
      "start (or reuse) a terminal the agent works in and show it live in a chat card, where the human watches and can type; prints the session id for write/history",
    )
    .option("-w, --project <project>", "project id or name")
    .option(
      "--id <id>",
      "terminal session id (default: one per chat thread, or a new one without a chat)",
    )
    .option("--cwd <path>", "working directory for a new session")
    .option("--title <title>", "card title", "Terminal")
    .option(
      "--path <path>",
      "chat for the card (default: $COCALC_CODEX_CHAT_PATH)",
    )
    .option(
      "--thread-id <id>",
      "thread for the card (default: $COCALC_CODEX_THREAD_ID)",
    )
    .option(
      "--message-date <date>",
      "producing message timestamp (default: $COCALC_CODEX_MESSAGE_DATE)",
    )
    .option("--no-card", "do not publish a chat card")
    .action(async (opts: any, command: Command) => {
      await withContext(command, "project terminal start", async (ctx) => {
        const chat = chatTarget(opts);
        const id =
          `${opts.id ?? ""}`.trim() ||
          (chat
            ? agentTerminalId(chat.path, chat.threadId)
            : normalizeTerminalId(undefined));
        const { project, terminal } = await withTerminalClient({
          ctx,
          projectIdentifier: opts.project,
          resolveProjectFromArgOrContext,
          resolveProjectConatClient,
        });
        let started = false;
        try {
          if ((await terminal.state(id)) !== "running") {
            await terminal.spawn("bash", [], {
              id,
              cwd: `${opts.cwd ?? ""}`.trim() || undefined,
            });
            await terminal.closeAndWait();
            started = true;
          }
        } finally {
          terminal.close();
        }
        let card: { artifact_id: string; reused: boolean } | null = null;
        if (opts.card !== false && chat)
          card = await publishCardOnce({
            deps,
            ctx,
            projectId: project.project_id,
            chat,
            matches: (a) => a.kind === "terminal" && a.terminal?.path === id,
            payload: {
              title: opts.title,
              markdown: TERMINAL_CARD_TEXT,
              terminal: { path: id },
            },
          });
        return {
          project_id: project.project_id,
          id,
          started,
          card,
          ...(opts.card !== false && !chat ? { note: NO_CARD_NOTE } : {}),
          usage: `Run commands with: cocalc project terminal write ${JSON.stringify(id)} --enter '<command>'; read the output with: cocalc project terminal history ${JSON.stringify(id)} --max-chars 4000. The human sees the terminal live and may type in it too; while they are typing, write returns written: false (wait and retry).`,
        };
      });
    });

  terminal
    .command("list")
    .description("list running project terminal sessions")
    .option("-w, --project <project>", "project id or name")
    .action(async (opts: { project?: string }, command: Command) => {
      await withContext(command, "project terminal list", async (ctx) => {
        const { terminal } = await withTerminalClient({
          ctx,
          projectIdentifier: opts.project,
          resolveProjectFromArgOrContext,
          resolveProjectConatClient,
        });
        try {
          return await terminal.list();
        } finally {
          terminal.close();
        }
      });
    });

  terminal
    .command("history <id>")
    .description("print terminal scrollback/history")
    .option("-w, --project <project>", "project id or name")
    .option("--max-chars <n>", "only print the last n characters")
    .action(
      async (
        id: string,
        opts: { project?: string; maxChars?: string },
        command: Command,
      ) => {
        await withContext(command, "project terminal history", async (ctx) => {
          const { terminal } = await withTerminalClient({
            ctx,
            projectIdentifier: opts.project,
            resolveProjectFromArgOrContext,
            resolveProjectConatClient,
          });
          try {
            const history = `${(await terminal.history(id)) ?? ""}`;
            const maxChars = normalizeMaxChars(opts.maxChars);
            return maxChars == null || history.length <= maxChars
              ? history
              : history.slice(-maxChars);
          } finally {
            terminal.close();
          }
        });
      },
    );

  terminal
    .command("state <id>")
    .description("show whether a terminal session is running")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (id: string, opts: { project?: string }, command: Command) => {
        await withContext(command, "project terminal state", async (ctx) => {
          const { terminal } = await withTerminalClient({
            ctx,
            projectIdentifier: opts.project,
            resolveProjectFromArgOrContext,
            resolveProjectConatClient,
          });
          try {
            return await terminal.state(id);
          } finally {
            terminal.close();
          }
        });
      },
    );

  terminal
    .command("cwd <id>")
    .description("show the terminal process working directory when available")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (id: string, opts: { project?: string }, command: Command) => {
        await withContext(command, "project terminal cwd", async (ctx) => {
          const { terminal } = await withTerminalClient({
            ctx,
            projectIdentifier: opts.project,
            resolveProjectFromArgOrContext,
            resolveProjectConatClient,
          });
          try {
            return (await terminal.cwd(id)) ?? "";
          } finally {
            terminal.close();
          }
        });
      },
    );

  terminal
    .command("write <id> [input...]")
    .description("write input to a terminal session")
    .option("-w, --project <project>", "project id or name")
    .option("--stdin", "read input from stdin")
    .option(
      "--enter",
      "append a newline to the input; usually needed to execute a shell command",
    )
    .option(
      "--force",
      "write as user input even when a browser is actively leading the terminal",
    )
    .action(
      async (
        id: string,
        inputParts: string[],
        opts: {
          project?: string;
          stdin?: boolean;
          enter?: boolean;
          force?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project terminal write", async (ctx) => {
          const { terminal } = await withTerminalClient({
            ctx,
            projectIdentifier: opts.project,
            resolveProjectFromArgOrContext,
            resolveProjectConatClient,
          });
          try {
            let input = opts.stdin
              ? await readAllStdin()
              : inputParts.join(" ");
            if (opts.enter) input += "\n";
            return await terminal.write({
              id,
              input,
              kind: opts.force ? "user" : "auto",
            });
          } finally {
            terminal.close();
          }
        });
      },
    );
}
