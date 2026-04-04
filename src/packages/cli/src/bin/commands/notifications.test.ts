import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerNotificationsCommand } from "./notifications";

test("notifications list forwards filters to the hub", async () => {
  let captured: any;
  const program = new Command();
  registerNotificationsCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          notifications: {
            list: async (opts: any) => {
              captured = opts;
              return [];
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
    "notifications",
    "list",
    "--kind",
    "mention",
    "--state",
    "unread",
    "--project-id",
    "11111111-1111-4111-8111-111111111111",
    "--notification-id",
    "22222222-2222-4222-8222-222222222222",
    "--limit",
    "25",
  ]);

  assert.deepEqual(captured, {
    kind: "mention",
    state: "unread",
    project_id: "11111111-1111-4111-8111-111111111111",
    notification_id: "22222222-2222-4222-8222-222222222222",
    limit: 25,
  });
});

test("notifications counts calls the hub counts api", async () => {
  let called = false;
  const program = new Command();
  registerNotificationsCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          notifications: {
            counts: async () => {
              called = true;
              return {
                total: 0,
                unread: 0,
                saved: 0,
                archived: 0,
                by_kind: {},
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync(["node", "test", "notifications", "counts"]);

  assert.equal(called, true);
});

test("notifications mark-read defaults to read=true and supports --unread", async () => {
  const calls: any[] = [];
  const program = new Command();
  registerNotificationsCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          notifications: {
            markRead: async (opts: any) => {
              calls.push(opts);
              return { updated_count: 1 };
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
    "notifications",
    "mark-read",
    "11111111-1111-4111-8111-111111111111",
  ]);
  await program.parseAsync([
    "node",
    "test",
    "notifications",
    "mark-read",
    "--unread",
    "22222222-2222-4222-8222-222222222222",
  ]);

  assert.deepEqual(calls, [
    {
      notification_ids: ["11111111-1111-4111-8111-111111111111"],
      read: true,
    },
    {
      notification_ids: ["22222222-2222-4222-8222-222222222222"],
      read: false,
    },
  ]);
});
