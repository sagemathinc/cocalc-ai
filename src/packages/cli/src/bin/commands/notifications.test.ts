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

test("notifications create-mention forwards the create RPC payload", async () => {
  let captured: any;
  const program = new Command();
  registerNotificationsCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          notifications: {
            createMention: async (opts: any) => {
              captured = opts;
              return { target_count: 1 };
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
    "create-mention",
    "--project-id",
    "11111111-1111-4111-8111-111111111111",
    "--path",
    "work/chat.chat",
    "--description",
    "hello",
    "--fragment-id",
    "thread=1",
    "--priority",
    "high",
    "--stable-source-id",
    "msg-1",
    "--target",
    "22222222-2222-4222-8222-222222222222",
    "--target",
    "33333333-3333-4333-8333-333333333333",
  ]);

  assert.deepEqual(captured, {
    source_project_id: "11111111-1111-4111-8111-111111111111",
    source_path: "work/chat.chat",
    source_fragment_id: "thread=1",
    actor_account_id: undefined,
    target_account_ids: [
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ],
    description: "hello",
    priority: "high",
    stable_source_id: "msg-1",
  });
});

test("notifications create-account-notice supports inline body and repeated targets", async () => {
  let captured: any;
  const program = new Command();
  registerNotificationsCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          notifications: {
            createAccountNotice: async (opts: any) => {
              captured = opts;
              return { target_count: 2 };
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
    "create-account-notice",
    "--target",
    "22222222-2222-4222-8222-222222222222",
    "--target",
    "33333333-3333-4333-8333-333333333333",
    "--severity",
    "warning",
    "--title",
    "Maintenance",
    "--body-markdown",
    "Tonight",
    "--origin-label",
    "Admin",
    "--action-link",
    "/status",
    "--action-label",
    "Open",
    "--dedupe-key",
    "maint-1",
  ]);

  assert.deepEqual(captured, {
    target_account_ids: [
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ],
    severity: "warning",
    title: "Maintenance",
    body_markdown: "Tonight",
    origin_label: "Admin",
    action_link: "/status",
    action_label: "Open",
    dedupe_key: "maint-1",
  });
});

test("notifications projector commands forward to system notification projection apis", async () => {
  const calls: any[] = [];
  const program = new Command();
  registerNotificationsCommand(program, {
    withContext: async (_command, label, fn) => {
      const ctx = {
        hub: {
          system: {
            getAccountNotificationIndexProjectionStatus: async (opts: any) => {
              calls.push([label, "status", opts]);
              return {};
            },
            drainAccountNotificationIndexProjection: async (opts: any) => {
              calls.push([label, "drain", opts]);
              return {};
            },
            rebuildAccountNotificationIndex: async (opts: any) => {
              calls.push([label, "rebuild", opts]);
              return {};
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
    "projector",
    "status",
  ]);
  await program.parseAsync([
    "node",
    "test",
    "notifications",
    "projector",
    "drain",
    "--bay-id",
    "bay-7",
    "--limit",
    "25",
    "--write",
  ]);
  await program.parseAsync([
    "node",
    "test",
    "notifications",
    "projector",
    "rebuild",
    "11111111-1111-4111-8111-111111111111",
  ]);

  assert.deepEqual(calls, [
    ["notifications projector status", "status", {}],
    [
      "notifications projector drain",
      "drain",
      { bay_id: "bay-7", limit: 25, dry_run: false },
    ],
    [
      "notifications projector rebuild",
      "rebuild",
      {
        target_account_id: "11111111-1111-4111-8111-111111111111",
        dry_run: true,
      },
    ],
  ]);
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

test("notifications save and archive toggle the corresponding flags", async () => {
  const calls: any[] = [];
  const program = new Command();
  registerNotificationsCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          notifications: {
            save: async (opts: any) => {
              calls.push(["save", opts]);
              return { updated_count: 1 };
            },
            archive: async (opts: any) => {
              calls.push(["archive", opts]);
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
    "save",
    "11111111-1111-4111-8111-111111111111",
  ]);
  await program.parseAsync([
    "node",
    "test",
    "notifications",
    "save",
    "--unsave",
    "22222222-2222-4222-8222-222222222222",
  ]);
  await program.parseAsync([
    "node",
    "test",
    "notifications",
    "archive",
    "33333333-3333-4333-8333-333333333333",
  ]);
  await program.parseAsync([
    "node",
    "test",
    "notifications",
    "archive",
    "--unarchive",
    "44444444-4444-4444-8444-444444444444",
  ]);

  assert.deepEqual(calls, [
    [
      "save",
      {
        notification_ids: ["11111111-1111-4111-8111-111111111111"],
        saved: true,
      },
    ],
    [
      "save",
      {
        notification_ids: ["22222222-2222-4222-8222-222222222222"],
        saved: false,
      },
    ],
    [
      "archive",
      {
        notification_ids: ["33333333-3333-4333-8333-333333333333"],
        archived: true,
      },
    ],
    [
      "archive",
      {
        notification_ids: ["44444444-4444-4444-8444-444444444444"],
        archived: false,
      },
    ],
  ]);
});
