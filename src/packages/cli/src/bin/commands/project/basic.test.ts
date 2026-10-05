import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";

import { registerProjectBasicCommands } from "./basic";

test("project create forwards a reserved UUID to the authorized server API", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const calls: any[] = [];
  const program = new Command();
  registerProjectBasicCommands(program.command("project"), {
    withContext: async (_command, _label, fn) =>
      fn({
        hub: {
          projects: {
            createProject: async (opts) => {
              calls.push(opts);
              return id;
            },
          },
        },
      }),
    isValidUUID: (value) => value === id,
    resolveHost: async () => ({ id: "host-id" }),
  } as any);
  await program.parseAsync([
    "node",
    "test",
    "project",
    "create",
    "Canary",
    "--project-id",
    id,
    "--host",
    "host-id",
  ]);
  assert.deepEqual(calls, [
    {
      project_id: id,
      title: "Canary",
      host_id: "host-id",
      rootfs_image: undefined,
      rootfs_image_id: undefined,
      start: false,
    },
  ]);
});

test("project create rejects malformed reserved UUIDs before calling the server", async () => {
  const program = new Command();
  registerProjectBasicCommands(program.command("project"), {
    withContext: async (_command, _label, fn) => fn({}),
    isValidUUID: () => false,
  } as any);
  await assert.rejects(
    program.parseAsync([
      "node",
      "test",
      "project",
      "create",
      "--project-id",
      "not-a-uuid",
    ]),
    /--project-id must be a project UUID/,
  );
});

test("project list selects the turn key while the primary connection remains agent authenticated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "connector-list-"));
  const keyFile = join(directory, "key");
  writeFileSync(keyFile, "turn-key", { mode: 0o600 });
  const originalFetch = global.fetch;
  const calls: RequestInit[] = [];
  global.fetch = (async (_url, options) => {
    calls.push(options!);
    return {
      ok: true,
      json: async () => ({
        projects: [{ project_id: "target", title: "Assignment" }],
        next_offset: null,
      }),
    } as Response;
  }) as typeof fetch;
  try {
    let output: unknown;
    const program = new Command();
    registerProjectBasicCommands(program.command("project"), {
      withContext: async (_command, _label, fn) => {
        output = await fn({
          apiBaseUrl: "https://example.test",
          remote: { user: { auth_actor: "agent" } },
          managedConnector: {
            keyFile,
            sourceProjectId: "11111111-1111-4111-8111-111111111111",
          },
          hub: {
            db: {
              userQuery: () => {
                throw Error("must not use agent userQuery");
              },
            },
          },
        });
      },
    } as any);
    await program.parseAsync(["node", "cocalc", "project", "list"]);
    assert.deepEqual(output, [{ project_id: "target", title: "Assignment" }]);
    assert.equal((calls[0].headers as any).Authorization, "Bearer turn-key");
    rmSync(keyFile);
    await assert.rejects(
      program.parseAsync(["node", "cocalc", "project", "list"]),
      /credential is unavailable/,
    );
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("project status reports the server runtime contract", async () => {
  let output: any;
  const deps = {
    withContext: async (_command, _label, fn) => {
      output = await fn({
        hub: {
          projects: {
            status: async () => ({
              state: "running",
              runtime: {
                mode: "workspace",
                isolation: "trusted-workspace",
                trusted: true,
                label: "Trusted workspace",
                rootfs: false,
                host_placement: false,
                gpu: false,
                backups: false,
                snapshots: false,
                archive: false,
                move: false,
                ssh: false,
                resource_limits: false,
                cloud_hosts: false,
              },
            }),
          },
        },
      });
    },
    resolveProjectFromArgOrContext: async () => ({
      project_id: "project-id",
      title: "Workspace Project",
      host_id: null,
    }),
  };
  const program = new Command();
  program.name("cocalc");
  const project = program.command("project");
  registerProjectBasicCommands(project, deps as any);

  await program.parseAsync([
    "node",
    "cocalc",
    "project",
    "status",
    "--project",
    "project-id",
  ]);

  assert.equal(output.project_id, "project-id");
  assert.equal(output.state, "running");
  assert.equal(output.runtime.mode, "workspace");
  assert.equal(output.runtime.host_placement, false);
});

test("project label commands call project label APIs", async () => {
  const calls: any[] = [];
  const outputs: any[] = [];
  const deps = {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          projects: {
            getProjectLabels: async (opts: any) => {
              calls.push(["get", opts]);
              return { "cocalc.com/project-kind": "rootfs-build" };
            },
            setProjectLabels: async (opts: any) => {
              calls.push(["set", opts]);
              return opts.labels;
            },
          },
        },
      };
      outputs.push(await fn(ctx));
    },
    resolveProjectFromArgOrContext: async (_ctx, project) => ({
      project_id: project ?? "project-id",
      title: "Project",
    }),
  };

  const program = new Command();
  program.name("cocalc");
  const project = program.command("project");
  registerProjectBasicCommands(project, deps as any);

  await program.parseAsync([
    "node",
    "cocalc",
    "project",
    "label",
    "set",
    "--project",
    "project-id",
    "foo=bar",
    "empty=",
  ]);
  await program.parseAsync([
    "node",
    "cocalc",
    "project",
    "label",
    "list",
    "--project",
    "project-id",
  ]);
  await program.parseAsync([
    "node",
    "cocalc",
    "project",
    "label",
    "unset",
    "--project",
    "project-id",
    "foo",
  ]);

  assert.deepEqual(calls, [
    [
      "set",
      {
        project_id: "project-id",
        labels: {
          foo: "bar",
          empty: "",
        },
      },
    ],
    ["get", { project_id: "project-id" }],
    [
      "set",
      {
        project_id: "project-id",
        labels: {
          foo: null,
        },
      },
    ],
  ]);
  assert.deepEqual(outputs, [
    { project_id: "project-id", labels: { foo: "bar", empty: "" } },
    {
      project_id: "project-id",
      labels: { "cocalc.com/project-kind": "rootfs-build" },
    },
    { project_id: "project-id", labels: { foo: null } },
  ]);
});

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

for (const mode of ["async", "scoped-blocking"]) {
  for (const failure of ["CONNECTION_LOST", "403", "timeout", "submission"]) {
    if (mode === "scoped-blocking" && failure === "timeout") continue;
    test(`${mode} exec preserves single submission across ${failure}`, async () => {
      const calls: any[] = [];
      let resolutions = 0;
      let returned: any;
      const deps = {
        withContext: async (_command, _label, fn) => {
          returned = await fn({
            timeoutMs: failure === "timeout" ? 0 : 5_000,
            rpcTimeoutMs: 30_000,
            globals: { json: true, output: "json" },
            apiKey: mode === "scoped-blocking" ? "test-key" : undefined,
          });
        },
        resolveProjectProjectApi: async (_ctx, project) => {
          resolutions++;
          const generation = resolutions;
          return {
            project: { project_id: project, title: "Project", host_id: null },
            api: {
              system: {
                exec: async (opts) => {
                  calls.push(opts);
                  if (
                    failure === "submission" ||
                    (opts.async_get &&
                      (generation === 2 || failure === "timeout"))
                  ) {
                    throw Object.assign(new Error("disconnected"), {
                      code: failure === "403" ? "403" : "CONNECTION_LOST",
                    });
                  }
                  return {
                    type: "async",
                    job_id: "job-1",
                    stdout: "done",
                    stderr: "",
                    exit_code: 0,
                    status: opts.async_get ? "completed" : "running",
                  };
                },
              },
            },
          };
        },
      };
      const program = new Command();
      registerProjectBasicCommands(program.command("project"), deps as any);
      const run = program.parseAsync([
        "node",
        "test",
        "project",
        "exec",
        "--project",
        "project-id",
        ...(mode === "async" ? ["--async", "--wait"] : []),
        "--timeout",
        "0.001",
        "--poll-ms",
        "0",
        "echo done",
      ]);
      if (failure === "CONNECTION_LOST") {
        await run;
        assert.equal(returned.type, mode === "async" ? "async" : "blocking");
        assert.equal(returned.stdout, "done");
        assert.equal(resolutions, 3);
        assert.deepEqual(calls.slice(1), [
          { async_get: "job-1" },
          { async_get: "job-1" },
        ]);
      } else if (failure === "submission") {
        await assert.rejects(run, { code: "CONNECTION_LOST" });
        assert.equal(calls.length, 1);
      } else {
        await assert.rejects(run, (error: any) => {
          assert.match(
            error.message,
            /--project project-id --job-id job-1 --wait/,
          );
          if (failure === "403") assert.equal(error.code, "403");
          return true;
        });
        if (failure === "403") assert.equal(calls.length, 2);
      }
      assert.equal(calls.filter((x) => x.async_call).length, 1);
    });
  }
}

test("project start passes an explicit backup and accepts running as successful wait state", async () => {
  let startOpts: any;
  let waitedOpId: string | undefined;
  let returned: any;

  const deps = {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        timeoutMs: 300_000,
        pollMs: 1_000,
        hub: {
          projects: {
            start: async (opts) => {
              startOpts = opts;
              return { op_id: "start-op-1" };
            },
          },
        },
      };
      returned = await fn(ctx);
    },
    resolveProjectFromArgOrContext: async (_ctx, project) => ({
      project_id: project ?? "project-id",
      title: "Project",
    }),
    waitForLro: async (_ctx, opId) => {
      waitedOpId = opId;
      return {
        op_id: opId,
        status: "running",
        timedOut: true,
      };
    },
  };

  const program = new Command();
  const project = program.command("project");
  registerProjectBasicCommands(project, deps as any);

  await program.parseAsync([
    "node",
    "test",
    "project",
    "start",
    "--project",
    "project-id",
    "--restore-backup-id",
    "backup-1",
    "--wait",
  ]);

  assert.deepEqual(startOpts, {
    project_id: "project-id",
    restore_backup_id: "backup-1",
    wait: false,
  });
  assert.equal(waitedOpId, "start-op-1");
  assert.deepEqual(returned, {
    project_id: "project-id",
    op_id: "start-op-1",
    status: "running",
  });
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

test("project delete does not expose a compatibility --hard option", () => {
  const program = new Command();
  const project = program.command("project");
  registerProjectBasicCommands(project, {} as any);
  const deleteCommand = project.commands.find(
    (command) => command.name() === "delete",
  );

  assert.equal(
    deleteCommand?.options.some((option) => option.long === "--hard"),
    false,
  );
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
