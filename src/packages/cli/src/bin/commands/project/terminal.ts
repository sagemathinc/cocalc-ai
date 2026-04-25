/**
 * Project terminal inspection and input commands.
 */
import { Command } from "commander";

import { terminalClient } from "@cocalc/conat/project/terminal";
import type { ProjectCommandDeps } from "../project";

type CommandContext = any;

async function withTerminalClient({
  ctx,
  projectIdentifier,
  resolveProjectConatClient,
}: {
  ctx: CommandContext;
  projectIdentifier?: string;
  resolveProjectConatClient: ProjectCommandDeps["resolveProjectConatClient"];
}) {
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

export function registerProjectTerminalCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const { withContext, resolveProjectConatClient, readAllStdin } = deps;

  const terminal = project
    .command("terminal")
    .description("project terminal session operations");

  terminal
    .command("list")
    .description("list running project terminal sessions")
    .option("-w, --project <project>", "project id or name")
    .action(async (opts: { project?: string }, command: Command) => {
      await withContext(command, "project terminal list", async (ctx) => {
        const { terminal } = await withTerminalClient({
          ctx,
          projectIdentifier: opts.project,
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
