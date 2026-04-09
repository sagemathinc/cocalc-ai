import { Command } from "commander";

import type { ImportApi } from "../../api/import";

export type ImportCommandDeps = {
  globalsFrom: any;
  emitSuccess: any;
  emitError: any;
  normalizeUrl: any;
  withContext: any;
  importApi: ImportApi<any>;
};

type TaskImportCliOptions = {
  target?: string;
  dryRun?: boolean;
};

type ChatImportCliOptions = {
  target?: string;
  projectId?: string;
};

export function registerImportCommand(
  program: Command,
  deps: ImportCommandDeps,
): Command {
  const importCommand = program
    .command("import")
    .description(
      "import structured CoCalc archive bundles back into live documents",
    )
    .addHelpText(
      "after",
      `
Import is intended for agent and automation workflows where a document was
first exported, edited locally in a structured bundle, and then merged back.

- Import should prefer canonical machine-readable files, not derived markdown.
- Current support is patch-oriented rather than overwrite-oriented.
- The importer detects conflicting live edits and fails instead of silently clobbering them.
`,
    );

  importCommand
    .command("chat <bundlePath>")
    .description(
      "import a chat export bundle or extracted export directory into a .chat file",
    )
    .option("--target <path>", "override the destination .chat path")
    .option(
      "--project-id <projectId>",
      "project id/identifier used when uploading imported blobs and forking Codex context",
    )
    .addHelpText(
      "after",
      `
Chat import expects a bundle created by \`cocalc export chat\`.

- It recreates imported threads with fresh thread and message ids.
- Imported blobs/assets are rebound as live CoCalc blobs on the target server.
- Imported Codex context is installed as a local seed session, then forked to a fresh session id for the new thread.
- Importing the same bundle multiple times is supported; each import creates independent imported threads.

Notes:

- Point <bundlePath> at either the \`.cocalc-export.zip\` file or an extracted export directory.
- Import appends new thread records into the target \`.chat\` file; it does not overwrite existing threads.
- When the bundle includes Codex context, import should run in an environment with access to the target CoCalc project and Codex app-server.
`,
    )
    .action(
      async (
        bundlePath: string,
        opts: ChatImportCliOptions,
        command: Command,
      ) => {
        await deps.withContext(command, "import chat", async (ctx) => {
          return await deps.importApi.chat(ctx, {
            sourcePath: bundlePath,
            targetPath: opts.target,
            projectId: opts.projectId,
          });
        });
      },
    );

  importCommand
    .command("tasks <bundlePath>")
    .description(
      "import a tasks export bundle or extracted export directory back into a .tasks file",
    )
    .option("--target <path>", "override the destination .tasks path")
    .option(
      "--dry-run",
      "compute the merge and report conflicts without writing",
    )
    .addHelpText(
      "after",
      `
Tasks import expects a bundle created by \`cocalc export tasks\`.

- It uses \`document.jsonl\` as the export-time base snapshot.
- It uses \`tasks.jsonl\` as the edited desired task state.
- It merges by \`task_id\` into the live target file.
- It preserves unrelated live tasks that are not part of the import.
- It fails on conflicting live edits instead of overwriting them.

Notes:

- Point <bundlePath> at either the \`.cocalc-export.zip\` file or an extracted export directory.
- Asset rebinding is not implemented yet for tasks import. Bundles with local \`assets/\` references are rejected.
`,
    )
    .action(
      async (
        bundlePath: string,
        opts: TaskImportCliOptions,
        command: Command,
      ) => {
        const globals = deps.globalsFrom(command);
        const commandName = "import tasks";
        try {
          const result = await deps.importApi.tasks(undefined, {
            sourcePath: bundlePath,
            targetPath: opts.target,
            dryRun: opts.dryRun === true,
          });
          deps.emitSuccess({ globals }, commandName, result);
        } catch (error) {
          deps.emitError({ globals }, commandName, error, deps.normalizeUrl);
          process.exitCode = 1;
        }
      },
    );

  return importCommand;
}
