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
});
