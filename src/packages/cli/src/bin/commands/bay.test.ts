import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerBayCommand } from "./bay";

test("bay list returns the hub bay rows", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            listBays: async () => [
              {
                bay_id: "bay-0",
                label: "bay-0",
                region: null,
                deployment_mode: "single-bay",
                role: "combined",
                is_default: true,
              },
            ],
          },
        },
      };
      captured = await fn(ctx);
    },
  } as any);

  await program.parseAsync(["node", "test", "bay", "list"]);

  assert.equal(captured?.[0]?.bay_id, "bay-0");
});

test("bay show filters one bay from the hub list", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            listBays: async () => [
              {
                bay_id: "bay-0",
                label: "bay-0",
                region: null,
                deployment_mode: "single-bay",
                role: "combined",
                is_default: true,
              },
            ],
          },
        },
      };
      captured = await fn(ctx);
    },
  } as any);

  await program.parseAsync(["node", "test", "bay", "show", "bay-0"]);

  assert.equal(captured?.bay_id, "bay-0");
});

test("bay backfill defaults to a dry run", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            backfillBayOwnership: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-0",
                dry_run: true,
                limit_per_table: null,
                accounts_missing: 12,
                projects_missing: 34,
                hosts_missing: 5,
                accounts_updated: 0,
                projects_updated: 0,
                hosts_updated: 0,
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync(["node", "test", "bay", "backfill"]);

  assert.deepEqual(captured, {
    bay_id: undefined,
    dry_run: true,
    limit_per_table: undefined,
  });
});

test("bay backfill forwards write mode and limit", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            backfillBayOwnership: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-7",
                dry_run: false,
                limit_per_table: 25,
                accounts_missing: 0,
                projects_missing: 0,
                hosts_missing: 0,
                accounts_updated: 3,
                projects_updated: 4,
                hosts_updated: 1,
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "backfill",
    "--write",
    "--bay-id",
    "bay-7",
    "--limit-per-table",
    "25",
  ]);

  assert.deepEqual(captured, {
    bay_id: "bay-7",
    dry_run: false,
    limit_per_table: 25,
  });
});

test("bay projection rebuild-account-project-index defaults to a dry run", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            rebuildAccountProjectIndex: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-0",
                target_account_id: "11111111-1111-4111-8111-111111111111",
                dry_run: true,
                existing_rows: 2,
                source_rows: 2,
                visible_rows: 1,
                hidden_rows: 1,
                deleted_rows: 0,
                inserted_rows: 0,
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "projection",
    "rebuild-account-project-index",
    "11111111-1111-4111-8111-111111111111",
  ]);

  assert.deepEqual(captured, {
    target_account_id: "11111111-1111-4111-8111-111111111111",
    dry_run: true,
  });
});

test("bay projection rebuild-account-project-index forwards write mode", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            rebuildAccountProjectIndex: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-0",
                target_account_id: "11111111-1111-4111-8111-111111111111",
                dry_run: false,
                existing_rows: 1,
                source_rows: 3,
                visible_rows: 2,
                hidden_rows: 1,
                deleted_rows: 1,
                inserted_rows: 3,
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "projection",
    "rebuild-account-project-index",
    "11111111-1111-4111-8111-111111111111",
    "--write",
  ]);

  assert.deepEqual(captured, {
    target_account_id: "11111111-1111-4111-8111-111111111111",
    dry_run: false,
  });
});
