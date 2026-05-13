import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerProjectEnvSecretCommands } from "./env-secrets";

function makeProjectCommand({
  hubProjects,
  resolveProjectFromArgOrContext,
  resolveProject,
  readAllStdin,
  capture,
}: {
  hubProjects: Record<string, any>;
  resolveProjectFromArgOrContext?: any;
  resolveProject?: any;
  readAllStdin?: any;
  capture: { value?: any };
}): Command {
  const program = new Command();
  const project = program.command("project");
  registerProjectEnvSecretCommands(project, {
    withContext: async (_command, _label, fn) => {
      capture.value = await fn({
        hub: { projects: hubProjects },
      });
    },
    resolveProjectFromArgOrContext:
      resolveProjectFromArgOrContext ??
      (async (_ctx: any, project?: string) => ({
        project_id: project ?? "target-project",
        title: "Target",
      })),
    resolveProject:
      resolveProject ??
      (async (_ctx: any, project: string) => ({
        project_id: project,
        title: "Source",
      })),
    readAllStdin: readAllStdin ?? (async () => "stdin-secret"),
  } as any);
  return program;
}

test("project env set merges assignments with existing env", async () => {
  const calls: Array<[string, any]> = [];
  const capture: { value?: any } = {};
  const program = makeProjectCommand({
    capture,
    hubProjects: {
      getProjectEnv: async (opts: any) => {
        calls.push(["getProjectEnv", opts]);
        return { KEEP: "1", OLD: "old" };
      },
      setProjectEnv: async (opts: any) => {
        calls.push(["setProjectEnv", opts]);
      },
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "project",
    "env",
    "set",
    "--project",
    "target-project",
    "OLD=new",
    "NEXT=2",
  ]);

  assert.deepEqual(calls, [
    ["getProjectEnv", { project_id: "target-project" }],
    [
      "setProjectEnv",
      {
        project_id: "target-project",
        env: { KEEP: "1", OLD: "new", NEXT: "2" },
      },
    ],
  ]);
  assert.deepEqual(capture.value.env, { KEEP: "1", OLD: "new", NEXT: "2" });
});

test("project secrets set reads value from stdin", async () => {
  const calls: Array<[string, any]> = [];
  const capture: { value?: any } = {};
  const program = makeProjectCommand({
    capture,
    readAllStdin: async () => "secret-from-stdin",
    hubProjects: {
      setProjectSecret: async (opts: any) => {
        calls.push(["setProjectSecret", opts]);
        return {
          project_id: opts.project_id,
          name: opts.name,
          value_bytes: opts.value.length,
          created_by: null,
          updated_by: null,
          created_at: "2026-05-13T00:00:00.000Z",
          updated_at: "2026-05-13T00:00:00.000Z",
        };
      },
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "project",
    "secrets",
    "set",
    "--project",
    "target-project",
    "--stdin",
    "API_KEY",
  ]);

  assert.deepEqual(calls, [
    [
      "setProjectSecret",
      {
        project_id: "target-project",
        name: "API_KEY",
        value: "secret-from-stdin",
      },
    ],
  ]);
  assert.equal(capture.value.name, "API_KEY");
  assert.equal(capture.value.value_bytes, "secret-from-stdin".length);
});

test("project secrets copy resolves source and target projects", async () => {
  const calls: Array<[string, any]> = [];
  const capture: { value?: any } = {};
  const program = makeProjectCommand({
    capture,
    resolveProjectFromArgOrContext: async (_ctx: any, project?: string) => ({
      project_id: project ?? "target-project",
      title: "Target",
    }),
    resolveProject: async (_ctx: any, project: string) => ({
      project_id: `${project}-id`,
      title: "Source",
    }),
    hubProjects: {
      copyProjectSecrets: async (opts: any) => {
        calls.push(["copyProjectSecrets", opts]);
        return { copied: ["API_KEY"], conflicts: [], missing: [] };
      },
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "project",
    "secrets",
    "copy",
    "--from",
    "source",
    "--project",
    "target",
    "--name",
    "API_KEY,SSH_KEY",
    "--overwrite",
  ]);

  assert.deepEqual(calls, [
    [
      "copyProjectSecrets",
      {
        source_project_id: "source-id",
        target_project_id: "target",
        names: ["API_KEY", "SSH_KEY"],
        overwrite: true,
      },
    ],
  ]);
  assert.deepEqual(capture.value, {
    source_project_id: "source-id",
    target_project_id: "target",
    copied: ["API_KEY"],
    conflicts: [],
    missing: [],
  });
});
