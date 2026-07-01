import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerMigrateCommand } from "./migrate";

const SOURCE_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DEST_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const MIGRATION_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_BACKUP_OP_ID = "55555555-5555-4555-8555-555555555555";

function isValidUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function commandWithDeps(overrides: Record<string, any> = {}) {
  const state: Record<string, any> = {
    contexts: [],
    calls: [],
    output: undefined,
    error: undefined,
    closed: [],
  };
  const destinationCtx = {
    profile: "prod",
    globals: { profile: "prod" },
    apiBaseUrl: "https://cocalc.ai",
    accountId: "dest-admin",
    timeoutMs: 12 * 60 * 60 * 1000,
    pollMs: 1000,
    hub: {
      projects: {
        prepareIncomingProjectBackupMigration: async (opts: any) => {
          state.calls.push({ ctx: "prod", name: "prepare", opts });
          return {
            migration_id: MIGRATION_ID,
            destination_project_id: DEST_PROJECT_ID,
            destination_backup_repo_id: "44444444-4444-4444-8444-444444444444",
            rustic_repo_toml: "repo toml",
            backup_index_store: { bucket: "indexes" },
            expires_at: "2026-06-30T00:00:00.000Z",
            warnings: ["auto disk warning"],
          };
        },
        finalizeIncomingProjectBackupMigration: async (opts: any) => {
          state.calls.push({ ctx: "prod", name: "finalize", opts });
          return {
            migration_id: MIGRATION_ID,
            destination_project_id: DEST_PROJECT_ID,
            snapshot_id: "snapshot-1",
            status: "finalized",
            warnings: ["restore after finalize is not implemented yet"],
          };
        },
        getProjectSiteMigrationStatus: async (opts: any) => {
          state.calls.push({ ctx: "prod", name: "status", opts });
          return {
            id: MIGRATION_ID,
            status: "finalized",
            source_site: "alpha",
            source_project_id: SOURCE_PROJECT_ID,
            destination_project_id: DEST_PROJECT_ID,
            destination_owner_account_id: "owner",
            destination_backup_repo_id: "44444444-4444-4444-8444-444444444444",
            source_backup_op_id: null,
            destination_restore_op_id: null,
            snapshot_id: "snapshot-1",
            backup_index_key: "index/key.sqlite.zst",
            source_project_title: null,
            source_project_description: null,
            source_usage_bytes: null,
            backup_summary: {},
            metadata: {},
            error: null,
            created_by: null,
            created_at: "2026-06-30T00:00:00.000Z",
            updated_at: "2026-06-30T00:00:00.000Z",
            completed_at: "2026-06-30T00:00:00.000Z",
          };
        },
      },
    },
  };
  const sourceProjects: Record<string, any> = {
    getProjectSiteMigrationSourceProject: async (opts: any) => {
      state.calls.push({ ctx: "alpha", name: "source-info", opts });
      return {
        project_id: SOURCE_PROJECT_ID,
        title: "Source Project",
        description: "Source description",
      };
    },
    backupProjectToExternalRepository: async (opts: any) => {
      state.calls.push({ ctx: "alpha", name: "backup", opts });
      return {
        op_id: SOURCE_BACKUP_OP_ID,
        scope_type: "project",
        scope_id: SOURCE_PROJECT_ID,
        service: "project-backup",
        stream_name: "stream",
      };
    },
  };
  if (overrides.noSourceInfoRpc) {
    delete sourceProjects.getProjectSiteMigrationSourceProject;
  }
  const sourceCtx = {
    profile: "alpha",
    globals: { profile: "alpha" },
    apiBaseUrl: "https://alpha.cocalc.ai",
    accountId: "source-admin",
    timeoutMs: 12 * 60 * 60 * 1000,
    pollMs: 1000,
    hub: {
      projects: sourceProjects,
      lro: {
        get: async (opts: any) => {
          state.calls.push({ ctx: "alpha", name: "lro.get", opts });
          return {
            op_id: opts.op_id,
            status: "succeeded",
            result: {
              id: "snapshot-1",
              time: "2026-06-30T00:00:00.000Z",
              backup_index_key: "index/key.sqlite.zst",
              backup_index: {
                object_key: "index/key.sqlite.zst",
              },
            },
          };
        },
      },
    },
  };
  const deps = {
    globalsFrom: () => overrides.globals ?? {},
    contextForGlobals: async (globals: any) => {
      state.contexts.push(globals);
      if (globals.profile === "prod") return destinationCtx;
      if (globals.profile === "alpha") return sourceCtx;
      throw new Error(`unexpected profile ${globals.profile}`);
    },
    closeCommandContext: (ctx: any) => {
      if (ctx) state.closed.push(ctx.profile);
    },
    emitSuccess: (_ctx: any, commandName: string, data: unknown) => {
      state.output = { commandName, data };
    },
    emitError: (_ctx: any, commandName: string, error: unknown) => {
      state.error = {
        commandName,
        message: error instanceof Error ? error.message : `${error}`,
      };
    },
    resolveProjectFromArgOrContext:
      overrides.resolveProjectFromArgOrContext ??
      (async (ctx: any, project: string) => {
        state.calls.push({
          ctx: ctx.profile,
          name: "resolve-project",
          project,
        });
        return {
          project_id: project,
          title: "Resolved Source Project",
        };
      }),
    waitForLro: async (_ctx: any, opId: string) => {
      state.calls.push({ ctx: "alpha", name: "waitForLro", opId });
      return {
        op_id: opId,
        status: "succeeded",
        result: {
          id: "snapshot-1",
          time: "2026-06-30T00:00:00.000Z",
          backup_index_key: "index/key.sqlite.zst",
          backup_index: {
            object_key: "index/key.sqlite.zst",
          },
        },
      };
    },
    isValidUUID,
    ...overrides,
  };
  const program = new Command();
  program.name("cocalc");
  registerMigrateCommand(program, deps as any);
  return { program, state };
}

test("migrate project dry-run does not connect to either site", async () => {
  const { program, state } = commandWithDeps();
  await program.parseAsync([
    "node",
    "cocalc",
    "migrate",
    `alpha:${SOURCE_PROJECT_ID}`,
    "prod",
    "--owner",
    "wstein@example.com",
    "--dry-run",
  ]);

  assert.equal(state.contexts.length, 0);
  assert.equal(state.output.commandName, "migrate project");
  assert.deepEqual(state.output.data, {
    dry_run: true,
    source_profile: "alpha",
    source_project_id: SOURCE_PROJECT_ID,
    destination_profile: "prod",
    owner: "wstein@example.com",
    title: null,
    description: null,
    disk_mb: "auto",
    source_usage_bytes: null,
    restore: false,
    stop_source: true,
    warnings: [
      "This migrates project HOME files only.",
      "Root filesystem state and .local/share/cocalc/rootfs are excluded.",
      "The destination project will use the destination site's default rootfs.",
      "Site B issues backup-write credentials that site A can use for this migration.",
      "Use this only between sites you administer and trust.",
    ],
  });
});

test("migrate project prepares destination, backs up source, then finalizes", async () => {
  const { program, state } = commandWithDeps();
  await program.parseAsync([
    "node",
    "cocalc",
    "migrate",
    "project",
    `alpha:${SOURCE_PROJECT_ID}`,
    "prod",
    "--owner",
    "wstein@example.com",
    "--title",
    "Big project",
    "--disk-mb",
    "65000",
    "--source-usage-bytes",
    "60000000000",
    "--restore",
    "--tag",
    "manual-test",
    "--yes",
  ]);

  assert.deepEqual(
    state.contexts.map((ctx: any) => ctx.profile),
    ["alpha", "prod"],
  );
  assert.equal(state.calls[0].name, "source-info");
  assert.deepEqual(state.calls[0].opts, {
    project_id: SOURCE_PROJECT_ID,
  });
  assert.equal(state.calls[1].name, "prepare");
  assert.deepEqual(state.calls[1].opts, {
    source_site: "alpha",
    source_project_id: SOURCE_PROJECT_ID,
    owner: "wstein@example.com",
    title: "Big project",
    description: "Source description",
    disk_mb: 65000,
    source_usage_bytes: 60000000000,
    restore_after_finalize: true,
  });
  assert.equal(state.calls[2].name, "backup");
  assert.deepEqual(state.calls[2].opts, {
    project_id: SOURCE_PROJECT_ID,
    destination_site: "prod",
    destination_project_id: DEST_PROJECT_ID,
    migration_id: MIGRATION_ID,
    rustic_repo_toml: "repo toml",
    backup_index_store: { bucket: "indexes" },
    exclude_rootfs_state: true,
    stop_source: true,
    tags: ["manual-test"],
  });
  assert.equal(
    state.calls.find((call: any) => call.name === "finalize").ctx,
    "prod",
  );
  assert.equal(
    state.calls.find((call: any) => call.name === "lro.get"),
    undefined,
  );
  assert.equal(
    state.calls.find((call: any) => call.name === "finalize").opts
      .source_backup_result.source_backup_op_id,
    SOURCE_BACKUP_OP_ID,
  );
  assert.deepEqual(state.output.data, {
    source_profile: "alpha",
    source_project_id: SOURCE_PROJECT_ID,
    destination_profile: "prod",
    destination_project_id: DEST_PROJECT_ID,
    migration_id: MIGRATION_ID,
    source_backup_op_id: SOURCE_BACKUP_OP_ID,
    snapshot_id: "snapshot-1",
    status: "finalized",
    destination_status: "finalized",
    backup_index_key: "index/key.sqlite.zst",
    warnings: [
      "auto disk warning",
      "restore after finalize is not implemented yet",
    ],
  });
  assert.deepEqual(state.closed.sort(), ["alpha", "prod"]);
});

test("migrate project uses source title and description by default", async () => {
  const { program, state } = commandWithDeps();
  await program.parseAsync([
    "node",
    "cocalc",
    "migrate",
    `alpha:${SOURCE_PROJECT_ID}`,
    "prod",
    "--owner",
    "wstein@example.com",
    "--yes",
  ]);

  const prepare = state.calls.find((call: any) => call.name === "prepare");
  assert.equal(prepare.opts.title, "Source Project");
  assert.equal(prepare.opts.description, "Source description");
});

test("migrate project falls back to source project title on old source hubs", async () => {
  const { program, state } = commandWithDeps({ noSourceInfoRpc: true });
  await program.parseAsync([
    "node",
    "cocalc",
    "migrate",
    `alpha:${SOURCE_PROJECT_ID}`,
    "prod",
    "--owner",
    "wstein@example.com",
    "--yes",
  ]);

  assert.equal(
    state.calls.find((call: any) => call.name === "source-info"),
    undefined,
  );
  assert.deepEqual(
    state.calls.find((call: any) => call.name === "resolve-project"),
    {
      ctx: "alpha",
      name: "resolve-project",
      project: SOURCE_PROJECT_ID,
    },
  );
  const prepare = state.calls.find((call: any) => call.name === "prepare");
  assert.equal(prepare.opts.title, "Resolved Source Project");
  assert.equal(prepare.opts.description, undefined);
});

test("migrate project refuses real work without --yes", async () => {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const { program, state } = commandWithDeps();
  await program.parseAsync([
    "node",
    "cocalc",
    "migrate",
    `alpha:${SOURCE_PROJECT_ID}`,
    "prod",
    "--owner",
    "wstein@example.com",
  ]);

  assert.equal(state.contexts.length, 0);
  assert.match(state.error.message, /without --yes/);
  assert.equal(process.exitCode, 1);
  process.exitCode = previousExitCode;
});
