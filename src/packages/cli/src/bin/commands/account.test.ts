import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerAccountCommand } from "./account";

test("account where defaults to the current account", async () => {
  let captured: any;
  const program = new Command();
  registerAccountCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          system: {
            getAccountBay: async ({ user_account_id }) => ({
              account_id: user_account_id,
              email_address: "alice@example.com",
              first_name: "Alice",
              last_name: "Example",
              name: "Alice Example",
              home_bay_id: "bay-0",
              source: "single-bay-default",
            }),
          },
        },
      };
      captured = await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => {
      throw new Error("should not resolve an explicit account");
    },
  } as any);

  await program.parseAsync(["node", "test", "account", "where"]);

  assert.equal(captured?.account_id, "11111111-1111-1111-1111-111111111111");
  assert.equal(captured?.email_address, "alice@example.com");
  assert.equal(captured?.first_name, "Alice");
  assert.equal(captured?.last_name, "Example");
  assert.equal(captured?.name, "Alice Example");
  assert.equal(captured?.home_bay_id, "bay-0");
});

test("account where resolves an explicit account identifier", async () => {
  let captured: any;
  let resolvedIdentifier: string | undefined;
  const program = new Command();
  registerAccountCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          system: {
            getAccountBay: async ({ user_account_id }) => ({
              account_id: user_account_id,
              email_address: "bob@example.com",
              first_name: "Bob",
              last_name: "Other",
              name: "Bob Other",
              home_bay_id: "bay-0",
              source: "single-bay-default",
            }),
          },
        },
      };
      captured = await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async (_ctx, identifier) => {
      resolvedIdentifier = identifier;
      return {
        account_id: "22222222-2222-2222-2222-222222222222",
      };
    },
  } as any);

  await program.parseAsync(["node", "test", "account", "where", "alice"]);

  assert.equal(resolvedIdentifier, "alice");
  assert.equal(captured?.account_id, "22222222-2222-2222-2222-222222222222");
  assert.equal(captured?.email_address, "bob@example.com");
  assert.equal(captured?.first_name, "Bob");
  assert.equal(captured?.last_name, "Other");
  assert.equal(captured?.name, "Bob Other");
});

test("account membership defaults to the current account", async () => {
  let captured: any;
  const program = new Command();
  registerAccountCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          purchases: {
            getMembershipDetails: async () => ({
              selected: {
                class: "pro",
                source: "subscription",
                entitlements: {
                  usage_limits: {
                    total_storage_soft_bytes: 1024,
                    total_storage_hard_bytes: 2048,
                    max_projects: 5,
                    egress_5h_bytes: 4096,
                    egress_7d_bytes: 8192,
                  },
                },
              },
              candidates: [],
              usage_status: {
                collected_at: "2026-04-26T12:00:00.000Z",
                owned_project_count: 2,
                sampled_project_count: 2,
                unsampled_project_count: 0,
                total_storage_bytes: 512,
                managed_egress_5h_bytes: 256,
                managed_egress_7d_bytes: 1536,
                managed_egress_categories_5h_bytes: {
                  "file-download": 256,
                },
                managed_egress_categories_7d_bytes: {
                  "file-download": 1536,
                },
                managed_egress_recent_events: [],
              },
            }),
          },
        },
      };
      captured = await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => {
      throw new Error("should not resolve an explicit account");
    },
  } as any);

  await program.parseAsync(["node", "test", "account", "membership"]);

  assert.equal(captured?.account_id, "11111111-1111-1111-1111-111111111111");
  assert.equal(captured?.membership_class, "pro");
  assert.equal(captured?.total_storage_soft_bytes, 1024);
  assert.equal(captured?.total_storage_soft, "1.0 KB");
  assert.equal(captured?.managed_egress_5h_used_bytes, 256);
  assert.equal(captured?.managed_egress_5h_used, "256 B");
  assert.deepEqual(captured?.managed_egress_categories_5h_bytes, {
    "file-download": 256,
  });
});

test("account membership resolves an explicit account identifier", async () => {
  let capturedArgs: any;
  let resolvedIdentifier: string | undefined;
  const program = new Command();
  registerAccountCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          purchases: {
            getMembershipDetails: async (opts) => {
              capturedArgs = opts;
              return {
                selected: {
                  class: "team",
                  source: "admin",
                  entitlements: { usage_limits: {} },
                },
                candidates: [
                  {
                    class: "team",
                    source: "admin",
                    priority: 5,
                    entitlements: { usage_limits: { max_projects: 42 } },
                  },
                ],
                usage_status: {
                  collected_at: "2026-04-26T12:00:00.000Z",
                  owned_project_count: 0,
                  sampled_project_count: 0,
                  unsampled_project_count: 0,
                  total_storage_bytes: 0,
                  managed_egress_categories_5h_bytes: {},
                  managed_egress_categories_7d_bytes: {},
                  managed_egress_recent_events: [
                    {
                      project_id: "33333333-3333-3333-3333-333333333333",
                      category: "file-download",
                      bytes: 1048576,
                      occurred_at: "2026-04-26T12:34:56.000Z",
                      metadata: { request_path: "/x?download" },
                    },
                  ],
                },
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async (_ctx, identifier) => {
      resolvedIdentifier = identifier;
      return {
        account_id: "22222222-2222-2222-2222-222222222222",
      };
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "account",
    "membership",
    "qa@example.com",
  ]);

  assert.equal(resolvedIdentifier, "qa@example.com");
  assert.deepEqual(capturedArgs, {
    user_account_id: "22222222-2222-2222-2222-222222222222",
  });
});

test("account delete refuses to run without --yes", async () => {
  const program = new Command();
  registerAccountCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          system: {
            deleteAccount: async () => {
              throw new Error("should not delete without --yes");
            },
          },
        },
      };
      await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => {
      throw new Error("should not resolve an explicit account");
    },
  } as any);

  await assert.rejects(
    () => program.parseAsync(["node", "test", "account", "delete"]),
    /without --yes/,
  );
});

test("account delete forwards the target account and safety tag", async () => {
  let captured: any;
  let resolvedIdentifier: string | undefined;
  const program = new Command();
  registerAccountCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          system: {
            deleteAccount: async (opts) => {
              captured = opts;
              return {
                account_id: opts.user_account_id,
                home_bay_id: "bay-2",
                status: "deleted",
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async (_ctx, identifier) => {
      resolvedIdentifier = identifier;
      return {
        account_id: "22222222-2222-2222-2222-222222222222",
        email_address: "qa@example.com",
      };
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "account",
    "delete",
    "qa@example.com",
    "--yes",
    "--only-if-tag",
    "qa-safe-delete",
  ]);

  assert.equal(resolvedIdentifier, "qa@example.com");
  assert.deepEqual(captured, {
    user_account_id: "22222222-2222-2222-2222-222222222222",
    only_if_tag: "qa-safe-delete",
  });
});

test("account rehome refuses to run without --yes", async () => {
  const program = new Command();
  registerAccountCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          system: {
            rehomeAccount: async () => {
              throw new Error("should not rehome without --yes");
            },
          },
        },
      };
      await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => ({
      account_id: "22222222-2222-2222-2222-222222222222",
      email_address: "qa@example.com",
    }),
  } as any);

  await assert.rejects(
    () =>
      program.parseAsync([
        "node",
        "test",
        "account",
        "rehome",
        "qa@example.com",
        "--bay",
        "bay-1",
      ]),
    /without --yes/,
  );
});

test("account rehome forwards destination bay and metadata", async () => {
  let captured: any;
  let resolvedIdentifier: string | undefined;
  const program = new Command();
  registerAccountCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          system: {
            rehomeAccount: async (opts) => {
              captured = opts;
              return {
                account_id: opts.user_account_id,
                previous_bay_id: "bay-0",
                home_bay_id: opts.dest_bay_id,
                status: "rehomed",
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async (_ctx, identifier) => {
      resolvedIdentifier = identifier;
      return {
        account_id: "22222222-2222-2222-2222-222222222222",
        email_address: "qa@example.com",
      };
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "account",
    "rehome",
    "qa@example.com",
    "--bay",
    "bay-1",
    "--reason",
    "load-shed",
    "--campaign",
    "drain-1",
    "--yes",
  ]);

  assert.equal(resolvedIdentifier, "qa@example.com");
  assert.deepEqual(captured, {
    user_account_id: "22222222-2222-2222-2222-222222222222",
    dest_bay_id: "bay-1",
    reason: "load-shed",
    campaign_id: "drain-1",
  });
});

test("account rehome-status forwards source bay", async () => {
  let captured: any;
  const program = new Command();
  registerAccountCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          system: {
            getAccountRehomeOperation: async (opts) => {
              captured = opts;
              return {
                op_id: opts.op_id,
                account_id: "22222222-2222-2222-2222-222222222222",
                source_bay_id: "bay-0",
                dest_bay_id: "bay-1",
                status: "succeeded",
                stage: "complete",
                attempt: 1,
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => {
      throw new Error("should not resolve account identifier");
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "account",
    "rehome-status",
    "--op-id",
    "33333333-3333-3333-3333-333333333333",
    "--source-bay",
    "bay-0",
  ]);

  assert.deepEqual(captured, {
    op_id: "33333333-3333-3333-3333-333333333333",
    source_bay_id: "bay-0",
  });
});

test("account rehome-reconcile forwards source bay", async () => {
  let captured: any;
  const program = new Command();
  registerAccountCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          system: {
            reconcileAccountRehome: async (opts) => {
              captured = opts;
              return {
                op_id: opts.op_id,
                account_id: "22222222-2222-2222-2222-222222222222",
                previous_bay_id: "bay-0",
                home_bay_id: "bay-1",
                status: "rehomed",
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => {
      throw new Error("should not resolve account identifier");
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "account",
    "rehome-reconcile",
    "--op-id",
    "33333333-3333-3333-3333-333333333333",
    "--source-bay",
    "bay-0",
  ]);

  assert.deepEqual(captured, {
    op_id: "33333333-3333-3333-3333-333333333333",
    source_bay_id: "bay-0",
  });
});

test("account rehome-drain defaults to a dry run", async () => {
  let captured: any;
  const program = new Command();
  registerAccountCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          system: {
            drainAccountRehome: async (opts) => {
              captured = opts;
              return {
                source_bay_id: "bay-0",
                dest_bay_id: opts.dest_bay_id,
                dry_run: opts.dry_run,
                limit: opts.limit,
                only_if_tag: opts.only_if_tag ?? null,
                candidate_count: 0,
                candidates: [],
                rehomed: [],
                errors: [],
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => {
      throw new Error("should not resolve account identifier");
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "account",
    "rehome-drain",
    "--dest-bay",
    "bay-2",
  ]);

  assert.deepEqual(captured, {
    source_bay_id: undefined,
    dest_bay_id: "bay-2",
    limit: 25,
    dry_run: true,
    campaign_id: undefined,
    reason: undefined,
    only_if_tag: undefined,
  });
});

test("account rehome-drain forwards write mode and metadata", async () => {
  let captured: any;
  const program = new Command();
  registerAccountCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          system: {
            drainAccountRehome: async (opts) => {
              captured = opts;
              return {
                source_bay_id: opts.source_bay_id,
                dest_bay_id: opts.dest_bay_id,
                dry_run: opts.dry_run,
                limit: opts.limit,
                campaign_id: opts.campaign_id,
                only_if_tag: opts.only_if_tag,
                candidate_count: 1,
                candidates: ["22222222-2222-2222-2222-222222222222"],
                rehomed: [],
                errors: [],
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => {
      throw new Error("should not resolve account identifier");
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "account",
    "rehome-drain",
    "--source-bay",
    "bay-0",
    "--dest-bay",
    "bay-2",
    "--limit",
    "7",
    "--campaign",
    "drain-accounts",
    "--reason",
    "load shed",
    "--only-if-tag",
    "qa-drain",
    "--write",
  ]);

  assert.deepEqual(captured, {
    source_bay_id: "bay-0",
    dest_bay_id: "bay-2",
    limit: 7,
    dry_run: false,
    campaign_id: "drain-accounts",
    reason: "load shed",
    only_if_tag: "qa-drain",
  });
});
