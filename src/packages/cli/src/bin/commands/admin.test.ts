import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerAdminCommand } from "./admin";

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
