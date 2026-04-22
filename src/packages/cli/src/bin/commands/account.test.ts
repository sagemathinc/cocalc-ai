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
