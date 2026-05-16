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

test("project runtime-slots resolves sponsor filters and calls admin report API", async () => {
  let captured: any;

  const deps = {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            getProjectRuntimeSlotReport: async (opts) => {
              captured = opts;
              return { checked_at: "now", slots: [] };
            },
          },
        },
      };
      await fn(ctx);
    },
    resolveAccountByIdentifier: async (_ctx, identifier) => ({
      account_id: `acct:${identifier}`,
    }),
  };

  const program = new Command();
  const project = program.command("project");
  registerProjectBasicCommands(project, deps as any);

  await program.parseAsync([
    "node",
    "test",
    "project",
    "runtime-slots",
    "--sponsor",
    "teacher@example.com",
    "--all",
    "--window-minutes",
    "30",
    "--limit",
    "5",
  ]);

  assert.deepEqual(captured, {
    sponsor_account_id: "acct:teacher@example.com",
    active_only: false,
    window_minutes: 30,
    limit: 5,
  });
});

test("project delete defaults to irreversible hard delete", async () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  let hardDeleteOpts: any;
  let returned: any;

  const deps = {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        timeoutMs: 600_000,
        pollMs: 1_000,
        hub: {
          projects: {
            deleteProject: async () => {
              throw new Error("soft delete must not be called");
            },
            hardDeleteProject: async (opts) => {
              hardDeleteOpts = opts;
              return {
                op_id: "op-1",
                scope_type: "account",
                scope_id: "account-1",
                service: "lro",
                stream_name: "stream-1",
              };
            },
          },
        },
      };
      returned = await fn(ctx);
    },
    resolveProject: async (_ctx, project) => ({
      project_id: project,
      title: "Delete Me",
    }),
    isValidUUID: (value) => value === projectId,
    confirmHardProjectDelete: async () => {
      throw new Error("confirmation should be skipped by --yes");
    },
  };

  const program = new Command();
  const project = program.command("project");
  registerProjectBasicCommands(project, deps as any);

  await program.parseAsync([
    "node",
    "test",
    "project",
    "delete",
    "--project",
    projectId,
    "--yes",
  ]);

  assert.deepEqual(hardDeleteOpts, {
    project_id: projectId,
    backup_retention_days: 7,
    purge_backups_now: false,
  });
  assert.equal(returned?.mode, "hard");
  assert.equal(returned?.status, "queued");
  assert.equal(returned?.op_id, "op-1");
});

test("project delete asks for hard-delete confirmation unless --yes is used", async () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  let confirmationOpts: any;

  const deps = {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        timeoutMs: 600_000,
        pollMs: 1_000,
        hub: {
          projects: {
            hardDeleteProject: async () => ({
              op_id: "op-1",
              scope_type: "account",
              scope_id: "account-1",
              service: "lro",
              stream_name: "stream-1",
            }),
          },
        },
      };
      await fn(ctx);
    },
    resolveProject: async (_ctx, project) => ({
      project_id: project,
      title: "Delete Me",
    }),
    isValidUUID: (value) => value === projectId,
    confirmHardProjectDelete: async (opts) => {
      confirmationOpts = opts;
    },
  };

  const program = new Command();
  const project = program.command("project");
  registerProjectBasicCommands(project, deps as any);

  await program.parseAsync([
    "node",
    "test",
    "project",
    "delete",
    "--project",
    projectId,
    "--backup-retention-days",
    "3",
  ]);

  assert.deepEqual(confirmationOpts, {
    project_id: projectId,
    title: "Delete Me",
    backupRetentionDays: 3,
    purgeBackupsNow: false,
  });
});
