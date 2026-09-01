import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerLegacyMigrationCommand } from "./legacy-migration";

test("legacy restore retry validates and forwards the project id", async () => {
  const calls: any[] = [];
  const program = new Command();
  registerLegacyMigrationCommand(program, {
    isValidUUID: (value) => value === "00000000-0000-4000-8000-000000000001",
    hubCallByName: async (_ctx, name, args, timeoutMs) => {
      calls.push({ name, args, timeoutMs });
      return { status: "queued" };
    },
    withContext: async (_command, label, fn) => {
      assert.equal(label, "legacy-migration retry");
      return await fn({ timeoutMs: 30_000 });
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "legacy-migration",
    "retry",
    "00000000-0000-4000-8000-000000000001",
  ]);

  assert.deepEqual(calls, [
    {
      name: "legacyMigration.retryProjectRestore",
      args: [{ legacy_project_id: "00000000-0000-4000-8000-000000000001" }],
      timeoutMs: 30_000,
    },
  ]);
});

test("legacy remediation apply forwards required audit context", async () => {
  const calls: any[] = [];
  const projectId = "00000000-0000-4000-8000-000000000001";
  const program = new Command();
  registerLegacyMigrationCommand(program, {
    isValidUUID: (value) => value === projectId,
    hubCallByName: async (_ctx, name, args, timeoutMs) => {
      calls.push({ name, args, timeoutMs });
      return { applied_at: "2026-09-01T00:00:00.000Z" };
    },
    withContext: async (_command, label, fn) => {
      assert.equal(label, "legacy-migration remediation apply");
      return await fn({ timeoutMs: 60_000 });
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "legacy-migration",
    "remediation",
    "apply",
    projectId,
    "--reason",
    "Restore final archive after support review",
    "--support-reference",
    "Zendesk 20655",
  ]);

  assert.deepEqual(calls, [
    {
      name: "legacyMigration.adminApplyProjectRemediation",
      args: [
        {
          project_id: projectId,
          snapshot_name: undefined,
          reason: "Restore final archive after support review",
          support_reference: "Zendesk 20655",
        },
      ],
      timeoutMs: 60_000,
    },
  ]);
});

test("legacy public-share catch-up defaults to one dry-run batch", async () => {
  const calls: any[] = [];
  let result: any;
  const program = new Command();
  registerLegacyMigrationCommand(program, {
    isValidUUID: () => true,
    hubCallByName: async (_ctx, name, args) => {
      calls.push({ name, opts: args[0] });
      return {
        committed: false,
        projects: [
          {
            legacy_project_id: "00000000-0000-4000-8000-000000000001",
            imported: 0,
            skipped: 0,
          },
        ],
        has_more: true,
        next_after_legacy_project_id: "00000000-0000-4000-8000-000000000001",
      };
    },
    withContext: async (_command, _label, fn) => {
      result = await fn({ timeoutMs: 30_000 });
      return result;
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "legacy-migration",
    "public-shares",
    "replay-restored",
    "--reason",
    "deployment catch-up",
  ]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "legacyMigration.adminReplayRestoredPublicPaths");
  assert.deepEqual(calls[0].opts, {
    after_legacy_project_id: undefined,
    limit: 25,
    reason: "deployment catch-up",
    support_reference: undefined,
    commit: false,
  });
  assert.equal(result.committed, false);
  assert.equal(result.has_more, true);
});

test("legacy public-share catch-up advances through every committed batch", async () => {
  const calls: any[] = [];
  let result: any;
  const cursors = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ];
  const program = new Command();
  registerLegacyMigrationCommand(program, {
    isValidUUID: () => true,
    hubCallByName: async (_ctx, name, args) => {
      calls.push({ name, opts: args[0] });
      const index = calls.length - 1;
      return {
        committed: true,
        projects: [
          {
            legacy_project_id: cursors[index],
            imported: index + 1,
            skipped: index,
          },
        ],
        has_more: index === 0,
        next_after_legacy_project_id: cursors[index],
      };
    },
    withContext: async (_command, _label, fn) => {
      result = await fn({ timeoutMs: 30_000 });
      return result;
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "legacy-migration",
    "public-shares",
    "replay-restored",
    "--reason",
    "deployment catch-up",
    "--support-reference",
    "deploy-2026-08-06",
    "--batch-size",
    "10",
    "--all",
    "--commit",
  ]);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.after_legacy_project_id, undefined);
  assert.equal(
    calls[1].opts.after_legacy_project_id,
    "00000000-0000-4000-8000-000000000001",
  );
  assert.equal(calls[1].opts.commit, true);
  assert.equal(calls[1].opts.limit, 10);
  assert.equal(calls[1].opts.support_reference, "deploy-2026-08-06");
  assert.equal(result.batches, 2);
  assert.equal(result.project_count, 2);
  assert.equal(result.imported, 3);
  assert.equal(result.skipped, 1);
  assert.equal(result.has_more, false);
});
