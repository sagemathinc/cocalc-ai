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
  let observedCtxTimeoutMs: number | undefined;
  let observedCtxRpcTimeoutMs: number | undefined;
  let finalCtxTimeoutMs: number | undefined;
  let finalCtxRpcTimeoutMs: number | undefined;

  const deps = {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        timeoutMs: 600_000,
        rpcTimeoutMs: 30_000,
        pollMs: 1_000,
        globals: { json: true, output: "json" },
      };
      await fn(ctx);
      finalCtxTimeoutMs = ctx.timeoutMs;
      finalCtxRpcTimeoutMs = ctx.rpcTimeoutMs;
    },
    resolveProjectProjectApi: async (ctx, project) => ({
      project: {
        project_id: project ?? "project-id",
        title: "Project",
        host_id: null,
      },
      api: {
        system: {
          exec: async (execOpts) => {
            captured = {
              project_id: project ?? "project-id",
              execOpts,
            };
            observedCtxTimeoutMs = ctx.timeoutMs;
            observedCtxRpcTimeoutMs = ctx.rpcTimeoutMs;
            return { stdout: "", stderr: "", exit_code: 0 };
          },
        },
      },
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
  assert.equal(observedCtxTimeoutMs, 600_000);
  assert.equal(observedCtxRpcTimeoutMs, 125_000);
  assert.equal(finalCtxTimeoutMs, 600_000);
  assert.equal(finalCtxRpcTimeoutMs, 30_000);
});

test("project exec widens both command and RPC timeouts when the subcommand timeout exceeds the root timeout", async () => {
  let observedCtxTimeoutMs: number | undefined;
  let observedCtxRpcTimeoutMs: number | undefined;

  const deps = {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        timeoutMs: 600_000,
        rpcTimeoutMs: 30_000,
        pollMs: 1_000,
        globals: { json: true, output: "json" },
      };
      await fn(ctx);
    },
    resolveProjectProjectApi: async (ctx, project) => ({
      project: {
        project_id: project ?? "project-id",
        title: "Project",
        host_id: null,
      },
      api: {
        system: {
          exec: async () => {
            observedCtxTimeoutMs = ctx.timeoutMs;
            observedCtxRpcTimeoutMs = ctx.rpcTimeoutMs;
            return { stdout: "", stderr: "", exit_code: 0 };
          },
        },
      },
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
    "1200",
    "sleep 70",
  ];
  try {
    await program.parseAsync(process.argv);
  } finally {
    process.argv = originalArgv;
  }

  assert.equal(observedCtxTimeoutMs, 1_205_000);
  assert.equal(observedCtxRpcTimeoutMs, 1_205_000);
});

test("project exec starts async jobs without widening RPC timeouts", async () => {
  let captured:
    | {
        project_id: string;
        execOpts: {
          command: string;
          bash: boolean;
          timeout: number;
          async_call: boolean;
        };
      }
    | undefined;
  let observedCtxTimeoutMs: number | undefined;
  let observedCtxRpcTimeoutMs: number | undefined;
  let returned: any;

  const deps = {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        timeoutMs: 600_000,
        rpcTimeoutMs: 30_000,
        pollMs: 1_000,
        globals: { json: true, output: "json" },
      };
      returned = await fn(ctx);
    },
    resolveProjectProjectApi: async (ctx, project) => ({
      project: {
        project_id: project ?? "project-id",
        title: "Project",
        host_id: null,
      },
      api: {
        system: {
          exec: async (execOpts) => {
            captured = {
              project_id: project ?? "project-id",
              execOpts,
            };
            observedCtxTimeoutMs = ctx.timeoutMs;
            observedCtxRpcTimeoutMs = ctx.rpcTimeoutMs;
            return {
              type: "async",
              stdout: "",
              stderr: "",
              exit_code: 0,
              start: Date.now(),
              job_id: "job-1",
              status: "running",
              pid: 123,
            };
          },
        },
      },
    }),
  };

  const program = new Command();
  program
    .name("cocalc")
    .option("--timeout <duration>", "wait timeout (default: 600s)", "600s");
  const project = program.command("project");
  registerProjectBasicCommands(project, deps as any);

  await program.parseAsync([
    "node",
    "test",
    "project",
    "exec",
    "--project",
    "project-id",
    "--async",
    "--bash",
    "--timeout",
    "120",
    "sleep 70",
  ]);

  assert.equal(captured?.execOpts.async_call, true);
  assert.equal(captured?.execOpts.timeout, 120);
  assert.equal(observedCtxTimeoutMs, 600_000);
  assert.equal(observedCtxRpcTimeoutMs, 30_000);
  assert.equal(returned?.job_id, "job-1");
  assert.equal(returned?.status, "running");
});

test("project exec fetches an existing async job without requiring a command", async () => {
  let captured:
    | {
        project_id: string;
        execOpts: {
          async_get: string;
        };
      }
    | undefined;
  let returned: any;

  const deps = {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        timeoutMs: 600_000,
        rpcTimeoutMs: 30_000,
        pollMs: 1_000,
        globals: { json: true, output: "json" },
      };
      returned = await fn(ctx);
    },
    resolveProjectProjectApi: async (_ctx, project) => ({
      project: {
        project_id: project ?? "project-id",
        title: "Project",
        host_id: null,
      },
      api: {
        system: {
          exec: async (execOpts) => {
            captured = {
              project_id: project ?? "project-id",
              execOpts,
            };
            return {
              type: "async",
              stdout: "",
              stderr: "",
              exit_code: 0,
              start: Date.now(),
              job_id: "job-1",
              status: "running",
              pid: 123,
            };
          },
        },
      },
    }),
  };

  const program = new Command();
  const project = program.command("project");
  registerProjectBasicCommands(project, deps as any);

  await program.parseAsync([
    "node",
    "test",
    "project",
    "exec",
    "--project",
    "project-id",
    "--job-id",
    "job-1",
  ]);

  assert.equal(captured?.execOpts.async_get, "job-1");
  assert.equal(returned?.job_id, "job-1");
  assert.equal(returned?.status, "running");
});

test("project exec waits for an async job to complete", async () => {
  const calls: any[] = [];
  let returned: any;

  const deps = {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        timeoutMs: 5_000,
        rpcTimeoutMs: 30_000,
        pollMs: 0,
        globals: { json: true, output: "json" },
      };
      returned = await fn(ctx);
    },
    resolveProjectProjectApi: async (_ctx, project) => ({
      project: {
        project_id: project ?? "project-id",
        title: "Project",
        host_id: null,
      },
      api: {
        system: {
          exec: async (execOpts) => {
            calls.push({
              project_id: project ?? "project-id",
              execOpts,
            });
            if (calls.length === 1) {
              return {
                type: "async",
                stdout: "",
                stderr: "",
                exit_code: 0,
                start: Date.now(),
                job_id: "job-1",
                status: "running",
                pid: 123,
              };
            }
            return {
              type: "async",
              stdout: "done\n",
              stderr: "",
              exit_code: 0,
              start: Date.now(),
              job_id: "job-1",
              status: "completed",
              pid: 123,
            };
          },
        },
      },
    }),
  };

  const program = new Command();
  const project = program.command("project");
  registerProjectBasicCommands(project, deps as any);

  await program.parseAsync([
    "node",
    "test",
    "project",
    "exec",
    "--project",
    "project-id",
    "--async",
    "--wait",
    "--poll-ms",
    "0",
    "--bash",
    "echo done",
  ]);

  assert.equal(calls[0]?.execOpts.async_call, true);
  assert.equal(calls[1]?.execOpts.async_get, "job-1");
  assert.equal(returned?.status, "completed");
  assert.equal(returned?.stdout, "done\n");
});

test("project where returns the owning bay for the resolved project", async () => {
  let captured: any;

  const deps = {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            getProjectBay: async ({ project_id }) => ({
              project_id,
              owning_bay_id: "bay-0",
              host_id: "host-1",
              title: "Project",
              source: "single-bay-default",
            }),
          },
        },
      };
      captured = await fn(ctx);
    },
    resolveProjectFromArgOrContext: async (_ctx, project) => ({
      project_id: project ?? "project-id",
      title: "Project",
    }),
  };

  const program = new Command();
  const project = program.command("project");
  registerProjectBasicCommands(project, deps as any);

  await program.parseAsync([
    "node",
    "test",
    "project",
    "where",
    "--project",
    "project-id",
  ]);

  assert.equal(captured?.project_id, "project-id");
  assert.equal(captured?.owning_bay_id, "bay-0");
});
