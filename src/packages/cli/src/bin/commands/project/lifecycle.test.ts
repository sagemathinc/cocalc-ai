import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { Command } from "commander";

import * as archiveInfo from "@cocalc/conat/project/archive-info";
import { registerProjectLifecycleCommands } from "./lifecycle";

test("project archive stops, creates a final backup, waits, and archives when the latest backup is stale", async () => {
  const calls: Array<[string, any]> = [];
  let returned: any;
  const stderrWrites: string[] = [];
  const stderrMock = mock.method(process.stderr, "write", ((chunk: any) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as any);
  const backupsMock = mock.method(
    archiveInfo,
    "getBackups",
    async () =>
      [{ id: "backup-1", time: new Date("2026-04-25T15:00:00.000Z") }] as any,
  );

  const deps = {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        timeoutMs: 600_000,
        rpcTimeoutMs: 15_000,
        pollMs: 10,
        globals: {},
        hub: {
          projects: {
            stop: async (opts: any) => {
              calls.push(["stop", opts]);
            },
            createBackup: async (opts: any) => {
              calls.push(["createBackup", opts]);
              return {
                op_id: "backup-op-1",
                scope_type: "project",
                scope_id: "11111111-1111-4111-8111-111111111111",
                service: "persist-service",
                stream_name: "stream-1",
              };
            },
            archiveProject: async (opts: any) => {
              calls.push(["archiveProject", opts]);
            },
          },
        },
      };
      returned = await fn(ctx);
    },
    resolveProjectConatClient: async () => ({
      project: {
        project_id: "11111111-1111-4111-8111-111111111111",
        title: "Archive Me",
        host_id: "host-1",
        state: { state: "running" },
        last_edited: new Date("2026-04-25T15:30:00.000Z"),
      },
      client: {} as any,
    }),
    waitForProjectNotRunning: async () => ({ ok: true, state: "opened" }),
    waitForLro: async (_ctx, opId, opts) => {
      await opts?.onUpdate?.({
        op_id: opId,
        status: "running",
        progress_summary: { phase: "snapshotting", progress: 50 },
      });
      return { op_id: opId, status: "succeeded" };
    },
    projectState: (state: any) => state?.state ?? "",
  };

  const program = new Command();
  const project = program.command("project");
  registerProjectLifecycleCommands(project, deps as any);

  await program.parseAsync([
    "node",
    "test",
    "project",
    "archive",
    "--project",
    "11111111-1111-4111-8111-111111111111",
    "--wait",
  ]);

  stderrMock.mock.restore();
  backupsMock.mock.restore();

  assert.deepEqual(calls, [
    ["stop", { project_id: "11111111-1111-4111-8111-111111111111" }],
    ["createBackup", { project_id: "11111111-1111-4111-8111-111111111111" }],
    [
      "archiveProject",
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        timeout: 30000,
      },
    ],
  ]);
  assert.equal(returned.status, "archived");
  assert.equal(returned.backup_created, true);
  assert.equal(returned.backup_reused, false);
  assert.equal(returned.stopped_first, true);
  assert.match(stderrWrites.join(""), /step=backup/);
  assert.match(stderrWrites.join(""), /step=archiving/);
});

test("project archive reuses a fresh backup without creating another one", async () => {
  const calls: Array<[string, any]> = [];
  let returned: any;
  const backupsMock = mock.method(
    archiveInfo,
    "getBackups",
    async () =>
      [{ id: "backup-1", time: new Date("2026-04-25T15:45:00.000Z") }] as any,
  );

  const deps = {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        timeoutMs: 600_000,
        rpcTimeoutMs: 15_000,
        pollMs: 10,
        globals: {},
        hub: {
          projects: {
            stop: async (opts: any) => {
              calls.push(["stop", opts]);
            },
            createBackup: async (opts: any) => {
              calls.push(["createBackup", opts]);
              return {
                op_id: "backup-op-1",
                scope_type: "project",
                scope_id: "11111111-1111-4111-8111-111111111111",
              };
            },
            archiveProject: async (opts: any) => {
              calls.push(["archiveProject", opts]);
            },
          },
        },
      };
      returned = await fn(ctx);
    },
    resolveProjectConatClient: async () => ({
      project: {
        project_id: "11111111-1111-4111-8111-111111111111",
        title: "Archive Me",
        host_id: "host-1",
        state: { state: "opened" },
        last_edited: new Date("2026-04-25T15:30:00.000Z"),
      },
      client: {} as any,
    }),
    waitForProjectNotRunning: async () => ({ ok: true, state: "opened" }),
    waitForLro: async () => ({ op_id: "backup-op-1", status: "succeeded" }),
    projectState: (state: any) => state?.state ?? "",
  };

  const program = new Command();
  const project = program.command("project");
  registerProjectLifecycleCommands(project, deps as any);

  await program.parseAsync([
    "node",
    "test",
    "project",
    "archive",
    "--project",
    "11111111-1111-4111-8111-111111111111",
  ]);

  backupsMock.mock.restore();

  assert.deepEqual(calls, [
    [
      "archiveProject",
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        timeout: 30000,
      },
    ],
  ]);
  assert.equal(returned.status, "archived");
  assert.equal(returned.backup_reused, true);
  assert.equal(returned.backup_created, false);
  assert.equal(returned.stopped_first, false);
});
