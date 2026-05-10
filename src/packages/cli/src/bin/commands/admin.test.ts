import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Command } from "commander";

import {
  buildEntitlementOverrideSchemaDoc,
  registerAdminCommand,
} from "./admin";

function adminDeps(overrides: Record<string, any> = {}) {
  return {
    withContext: async (_command: unknown, _label: string, fn: any) => {
      const ctx = {
        hub: {
          system: {},
          messages: {},
        },
      };
      Object.assign(ctx.hub.system, overrides.system ?? {});
      Object.assign(ctx.hub.messages, overrides.messages ?? {});
      return await fn(ctx);
    },
    resolveAccountByIdentifier: async (_ctx: unknown, identifier: string) => ({
      account_id:
        identifier === "alice@example.com"
          ? "22222222-2222-4222-8222-222222222222"
          : "33333333-3333-4333-8333-333333333333",
    }),
    isValidUUID: (value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      ),
  };
}

test("admin entitlement-override get resolves a user and fetches override", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      system: {
        getAccountEntitlementOverride: async (opts: any) => {
          capturedArgs = opts;
          return {
            account_id: opts.user_account_id,
            enabled: true,
            updated_by: "admin",
            updated_at: "2026-05-10T00:00:00.000Z",
          };
        },
      },
    }) as any,
  );

  program.exitOverride();
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "entitlement-override",
    "get",
    "alice@example.com",
  ]);

  assert.deepEqual(capturedArgs, {
    user_account_id: "22222222-2222-4222-8222-222222222222",
  });
});

test("admin entitlement-override set reads JSON file and forwards reason and expiration", async () => {
  let capturedArgs: any;
  const dir = await mkdtemp(join(tmpdir(), "cocalc-cli-admin-"));
  const file = join(dir, "override.json");
  await writeFile(
    file,
    JSON.stringify({
      enabled: true,
      usage_limits: {
        max_projects: { mode: "minimum", value: 50 },
      },
    }),
    "utf8",
  );
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      system: {
        setAccountEntitlementOverride: async (opts: any) => {
          capturedArgs = opts;
          return {
            account_id: opts.user_account_id,
            ...opts.override,
            reason: opts.reason,
            updated_by: "admin",
            updated_at: "2026-05-10T00:00:00.000Z",
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "entitlement-override",
    "set",
    "alice@example.com",
    "--file",
    file,
    "--reason",
    "smoke test",
    "--expires-at",
    "2026-05-11T12:00:00Z",
  ]);

  assert.deepEqual(capturedArgs, {
    user_account_id: "22222222-2222-4222-8222-222222222222",
    reason: "smoke test",
    override: {
      enabled: true,
      usage_limits: {
        max_projects: { mode: "minimum", value: 50 },
      },
      expires_at: "2026-05-11T12:00:00.000Z",
    },
  });
});

test("admin entitlement-override clear uses UUID targets without search", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      system: {
        clearAccountEntitlementOverride: async (opts: any) => {
          capturedArgs = opts;
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "entitlement-override",
    "clear",
    "11111111-1111-4111-8111-111111111111",
    "--reason",
    "cleanup",
  ]);

  assert.deepEqual(capturedArgs, {
    user_account_id: "11111111-1111-4111-8111-111111111111",
    reason: "cleanup",
  });
});

test("admin entitlement-override schema documents usable override payloads", async () => {
  const schema = buildEntitlementOverrideSchemaDoc();

  assert.match(JSON.stringify(schema), /project_defaults\.disk_quota/);
  assert.match(
    JSON.stringify(schema),
    /usage_limits\.credit_spend_limit_7d_usd/,
  );
  assert.equal(
    (schema as any).numeric_rule.modes.minimum,
    "Use the override value only when it is higher than the membership value.",
  );

  let output = "";
  const originalWrite = process.stdout.write;
  (process.stdout.write as any) = (chunk: unknown) => {
    output += String(chunk);
    return true;
  };
  try {
    const program = new Command();
    registerAdminCommand(program, adminDeps() as any);
    await program.parseAsync([
      "node",
      "test",
      "admin",
      "entitlement-override",
      "schema",
    ]);
  } finally {
    process.stdout.write = originalWrite;
  }

  const parsed = JSON.parse(output);
  assert.equal(
    parsed.set_command,
    "cocalc admin entitlement-override set <user> --file override.json --reason <reason> [--expires-at <iso|none|never>]",
  );
});

test("admin message send-system-notice forwards the system notice payload", async () => {
  let captured: any;
  const program = new Command();
  registerAdminCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          messages: {
            sendSystemNotice: async (opts: any) => {
              captured = opts;
              return 123;
            },
          },
        },
      };
      return await fn(ctx);
    },
    resolveAccountByIdentifier: async () => {
      throw new Error("not used");
    },
    normalizeUrl: (value: string) => value,
    isValidUUID: () => false,
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "message",
    "send-system-notice",
    "--target",
    "11111111-1111-4111-8111-111111111111",
    "--target",
    "user@example.com",
    "--subject",
    "Maintenance",
    "--body-markdown",
    "Tonight",
    "--dedup-minutes",
    "30",
  ]);

  assert.deepEqual(captured, {
    to_ids: ["11111111-1111-4111-8111-111111111111", "user@example.com"],
    subject: "Maintenance",
    body: "Tonight",
    dedupMinutes: 30,
  });
});
