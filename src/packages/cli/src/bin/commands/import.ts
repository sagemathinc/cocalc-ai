import { Command } from "commander";

import { importTaskBundle } from "@cocalc/export";

export type ImportCommandDeps = {
  globalsFrom: any;
  emitSuccess: any;
  emitError: any;
  normalizeUrl: any;
};

type TaskImportCliOptions = {
  target?: string;
  dryRun?: boolean;
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
          const result = await importTaskBundle({
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
