import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { Command } from "commander";

import * as archiveInfo from "@cocalc/conat/project/archive-info";
import { registerProjectLifecycleCommands } from "./lifecycle";
import { registerProjectBasicCommands } from "./basic";

const project_id = "22222222-2222-4222-8222-222222222222";

function lifecycleProgram(projects: Record<string, any>) {
  const outputs: any[] = [];
  const program = new Command();
  registerProjectLifecycleCommands(program.command("project"), {
    withContext: async (_command, _label, fn) => {
      outputs.push(await fn({ hub: { projects } }));
    },
    resolveProjectFromArgOrContext: async () => ({ project_id }),
    resolveProjectConatClient: async () => ({
      project: { project_id },
      client: {},
    }),
  } as any);
  return { program, outputs };
}

test("snapshot schedule get reports the effective schedule and the stored value", async () => {
  const { program, outputs } = lifecycleProgram({
    getProjectSnapshotSchedule: async () => null,
  });
  await program.parseAsync([
    "node",
    "cocalc",
    "project",
    "snapshot",
    "schedule",
    "get",
    "-w",
    project_id,
  ]);
  assert.deepEqual(outputs, [
    {
      project_id,
      kind: "snapshots",
      enabled: true,
      frequent: 4,
      daily: 7,
      weekly: 4,
      monthly: 2,
      stored: null,
    },
  ]);
});

test("backup schedule set --disabled calls the fresh-auth API and reads the schedule back", async () => {
  let stored: any = { daily: 1, weekly: 3, monthly: 4, frequent: 0 };
  const calls: any[] = [];
  const { program, outputs } = lifecycleProgram({
    setProjectBackupSchedule: async (opts: any) => {
      calls.push(opts);
      stored = { ...stored, ...opts.schedule };
      return stored;
    },
    getProjectBackupSchedule: async () => stored,
  });
  await program.parseAsync([
    "node",
    "cocalc",
    "project",
    "backup",
    "schedule",
    "set",
    "-w",
    project_id,
    "--disabled",
  ]);
  assert.deepEqual(calls, [{ project_id, schedule: { disabled: true } }]);
  assert.equal(outputs[0].enabled, false);
  assert.deepEqual(outputs[0].stored, { ...stored, disabled: true });
});

test("schedule set fails when the stored schedule does not read back as requested", async () => {
  const { program } = lifecycleProgram({
    setProjectSnapshotSchedule: async () => ({}),
    getProjectSnapshotSchedule: async () => ({ daily: 7 }),
  });
  await assert.rejects(
    program.parseAsync([
      "node",
      "cocalc",
      "project",
      "snapshot",
      "schedule",
      "set",
      "-w",
      project_id,
      "--daily",
      "2",
    ]),
    /snapshot schedule was not stored as requested: daily is 7, expected 2/,
  );
});

test("schedule set refuses bad options before calling the server", async () => {
  const set = async () => {
    throw new Error("must not be called");
  };
  for (const [args, message] of [
    [["--enabled", "--disabled"], /either --enabled or --disabled/],
    [["--daily", "-1"], /--daily must be a non-negative integer/],
    [["--weekly", "2.5"], /--weekly must be a non-negative integer/],
    [[], /nothing to change/],
  ] as const) {
    const { program } = lifecycleProgram({ setProjectSnapshotSchedule: set });
    await assert.rejects(
      program.parseAsync([
        "node",
        "cocalc",
        "project",
        "snapshot",
        "schedule",
        "set",
        "-w",
        project_id,
        ...args,
      ]),
      message,
    );
  }
  const { program } = lifecycleProgram({ setProjectBackupSchedule: set });
  // backups have no frequent tier, so the option does not exist
  program.exitOverride();
  program.commands[0].commands
    .find((c) => c.name() === "backup")!
    .commands.find((c) => c.name() === "schedule")!
    .commands.forEach((c) => c.exitOverride());
  await assert.rejects(
    program.parseAsync([
      "node",
      "cocalc",
      "project",
      "backup",
      "schedule",
      "set",
      "-w",
      project_id,
      "--frequent",
      "1",
    ]),
    /unknown option '--frequent'/,
  );
});

test("backup delete deletes the named backups with the fresh-auth API", async () => {
  const backupsMock = mock.method(archiveInfo, "getBackups", async () => [
    { id: "b1" },
    { id: "b2" },
    { id: "b3" },
  ]);
  try {
    const deleted: any[] = [];
    const { program, outputs } = lifecycleProgram({
      deleteBackup: async (opts: any) => {
        deleted.push(opts);
      },
    });
    await program.parseAsync([
      "node",
      "cocalc",
      "project",
      "backup",
      "delete",
      "-w",
      project_id,
      "--id",
      "b1",
      "--id",
      "b3",
    ]);
    assert.deepEqual(deleted, [
      { project_id, id: "b1" },
      { project_id, id: "b3" },
    ]);
    assert.deepEqual(outputs[0], {
      project_id,
      dry_run: false,
      deleted: ["b1", "b3"],
      would_delete: undefined,
      kept: ["b2"],
    });
  } finally {
    backupsMock.mock.restore();
  }
});

test("backup delete --all --dry-run lists every backup and deletes nothing", async () => {
  const backupsMock = mock.method(archiveInfo, "getBackups", async () => [
    { id: "b1" },
    { id: "b2" },
  ]);
  try {
    const { program, outputs } = lifecycleProgram({
      deleteBackup: async () => {
        throw new Error("must not delete in a dry run");
      },
    });
    await program.parseAsync([
      "node",
      "cocalc",
      "project",
      "backup",
      "delete",
      "-w",
      project_id,
      "--all",
      "--dry-run",
    ]);
    assert.deepEqual(outputs[0].would_delete, ["b1", "b2"]);
    assert.deepEqual(outputs[0].deleted, []);
  } finally {
    backupsMock.mock.restore();
  }
});

test("backup delete refuses an unknown id and a missing selector", async () => {
  const backupsMock = mock.method(archiveInfo, "getBackups", async () => [
    { id: "b1" },
  ]);
  try {
    const deleteBackup = async () => {
      throw new Error("must not delete");
    };
    for (const [args, message] of [
      [["--id", "nope"], /no such backup: nope/],
      [[], /specify --id <backup> or --all-except <backup>/],
      [["--all", "--id", "b1"], /use --all alone/],
    ] as const) {
      const { program } = lifecycleProgram({ deleteBackup });
      await assert.rejects(
        program.parseAsync([
          "node",
          "cocalc",
          "project",
          "backup",
          "delete",
          "-w",
          project_id,
          ...args,
        ]),
        message,
      );
    }
  } finally {
    backupsMock.mock.restore();
  }
});

function createProgram(projects: Record<string, any>) {
  const outputs: any[] = [];
  const program = new Command();
  registerProjectBasicCommands(program.command("project"), {
    withContext: async (_command, _label, fn) => {
      outputs.push(await fn({ hub: { projects } }));
    },
    isValidUUID: () => true,
  } as any);
  return { program, outputs };
}

test("project create --no-auto-snapshots --no-auto-backups disables both at creation and reads them back", async () => {
  const calls: any[] = [];
  const { program, outputs } = createProgram({
    createProject: async (opts: any) => {
      calls.push(opts);
      return project_id;
    },
    getProjectSnapshotSchedule: async () => ({ disabled: true }),
    getProjectBackupSchedule: async () => ({ disabled: true }),
  });
  await program.parseAsync([
    "node",
    "cocalc",
    "project",
    "create",
    "Staging",
    "--no-auto-snapshots",
    "--no-auto-backups",
  ]);
  assert.equal(calls[0].disable_auto_snapshots, true);
  assert.equal(calls[0].disable_auto_backups, true);
  assert.equal(outputs[0].auto_snapshots, false);
  assert.equal(outputs[0].auto_backups, false);
});

test("project create reports a schedule that did not read back as disabled", async () => {
  const { program } = createProgram({
    createProject: async () => project_id,
    getProjectBackupSchedule: async () => null,
  });
  await assert.rejects(
    program.parseAsync([
      "node",
      "cocalc",
      "project",
      "create",
      "Staging",
      "--no-auto-backups",
    ]),
    new RegExp(
      `project ${project_id} was created, but auto_backups did not read back as disabled`,
    ),
  );
});

test("project create without the flags sends no schedule options", async () => {
  const calls: any[] = [];
  const { program, outputs } = createProgram({
    createProject: async (opts: any) => {
      calls.push(opts);
      return project_id;
    },
  });
  await program.parseAsync(["node", "cocalc", "project", "create", "Plain"]);
  assert.equal("disable_auto_snapshots" in calls[0], false);
  assert.equal("disable_auto_backups" in calls[0], false);
  assert.equal("auto_snapshots" in outputs[0], false);
});
