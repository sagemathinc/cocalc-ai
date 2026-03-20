import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerProjectBasicCommands } from "./basic";

test("project exec honors the subcommand timeout even when the root CLI also uses --timeout", async () => {
  let captured:
    | {
        project_id: string;
        execOpts: {
          command: string;
          bash: boolean;
          timeout: number;
          err_on_exit: boolean;
        };
      }
    | undefined;

  const deps = {
    withContext: async (_command, _label, fn) => {
      await fn({
        hub: {
          projects: {
            exec: async (args) => {
              captured = args;
              return { stdout: "", stderr: "", exit_code: 0 };
            },
          },
        },
        globals: { json: true, output: "json" },
      });
    },
    resolveProjectFromArgOrContext: async (_ctx, project) => ({
      project_id: project ?? "project-id",
      title: "Project",
    }),
  };

  const program = new Command();
  program
    .name("cocalc")
    .option("--timeout <duration>", "wait timeout (default: 600s)", "600s");
  const project = program.command("project");
  registerProjectBasicCommands(project, deps as any);

  const originalArgv = process.argv;
  process.argv = [
    "node",
    "cocalc",
    "--timeout",
    "10m",
    "project",
    "exec",
    "--project",
    "project-id",
    "--bash",
    "--timeout",
    "120",
    "sleep 70",
  ];
  try {
    await program.parseAsync(process.argv);
  } finally {
    process.argv = originalArgv;
  }

  assert.equal(captured?.execOpts.timeout, 120);
  assert.equal(captured?.execOpts.command, "sleep 70");
});
