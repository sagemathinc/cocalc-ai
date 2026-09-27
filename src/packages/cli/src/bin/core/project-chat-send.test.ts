import assert from "node:assert/strict";
import test from "node:test";
import {
  buildThreadConfigRecord,
  initializeHumanRoom,
  createHumanThread,
  sendHumanMessage,
} from "@cocalc/chat";
import type { Client } from "@cocalc/conat/core/client";
import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";
import {
  prepareChatSend,
  submitChatSend,
  readChatSendAccountSettings,
  submitHumanChatOperation,
} from "./project-chat-send";
import { OTHER_SETTINGS_NOTIFICATION_PREFERENCES_V2_KEY } from "@cocalc/util/notification-preferences";

const options = {
  projectId: "e9a4b7f0-6893-4e6c-9231-83d918bedcbe",
  accountId: "de138181-f1c7-4405-835f-088f2d7d42ec",
  path: "/home/user/review.chat",
  thread: buildThreadConfigRecord({
    thread_id: "thread-1",
    updated_by: "de138181-f1c7-4405-835f-088f2d7d42ec",
    name: "Reviewer",
    agent_kind: "acp",
    acp_config: {
      workingDirectory: "/home/user/repo",
      sessionMode: "read-only",
    },
  }),
  rows: [] as any[],
  prompt: '{"kind":"review","pr":509}\n',
};

test("send preserves JSON text and uses the thread's configuration and distinct identities", () => {
  const { message, request } = prepareChatSend(options);
  assert.equal(message.history[0].content, options.prompt);
  assert.equal(message.sender_id, options.accountId);
  assert.equal(request.prompt, options.prompt);
  assert.equal(request.config?.workingDirectory, "/home/user/repo");
  assert.equal(request.config?.sessionMode, "read-only");
  assert.equal(request.config?.allowWrite, false);
  assert.equal(request.session_id, "thread-1");
  assert.equal(request.chat.thread_title, "Reviewer");
  assert.equal(request.chat.parent_message_id, message.message_id);
  assert.notEqual(request.chat.message_id, message.message_id);
  assert.equal(request.chat.send_mode, undefined);
});

test("send recovers the latest interactive session, not an automation or another thread", () => {
  const rows = [
    {
      event: "chat",
      thread_id: "thread-1",
      date: "2026-09-11T10:00:00Z",
      message_id: "old",
      acp_thread_id: "11111111-1111-4111-8111-111111111111",
    },
    {
      event: "chat",
      thread_id: "thread-1",
      date: "2026-09-11T11:00:00Z",
      message_id: "auto",
      acp_thread_id: "22222222-2222-4222-8222-222222222222",
      acp_automation_id: "automation",
    },
    {
      event: "chat",
      thread_id: "another",
      date: "2026-09-11T12:00:00Z",
      acp_thread_id: "33333333-3333-4333-8333-333333333333",
    },
  ];
  const { request } = prepareChatSend({
    ...options,
    rows: [...rows].reverse(),
  });
  assert.equal(request.session_id, rows[0].acp_thread_id);
  assert.equal(request.config?.sessionId, rows[0].acp_thread_id);
  const configured = prepareChatSend({
    ...options,
    rows,
    thread: {
      ...options.thread,
      acp_config: { sessionId: "44444444-4444-4444-8444-444444444444" },
    },
  });
  assert.equal(
    configured.request.session_id,
    "44444444-4444-4444-8444-444444444444",
  );
});

test("send rejects blank messages, unauthenticated, archived and non-agent threads", () => {
  assert.throws(() => prepareChatSend({ ...options, prompt: " \n" }), /empty/);
  assert.throws(
    () => prepareChatSend({ ...options, accountId: "" }),
    /authenticated/,
  );
  assert.throws(
    () =>
      prepareChatSend({
        ...options,
        thread: { ...options.thread, archived: true },
      }),
    /archived/,
  );
  assert.throws(
    () =>
      prepareChatSend({
        ...options,
        thread: { ...options.thread, agent_kind: "llm", acp_config: undefined },
      }),
    /Codex\/ACP/,
  );
});

test("reads the sender's account settings and does not silently default on lookup failure", async () => {
  const settings = { codex_max_concurrent_subagents: 1 };
  assert.equal(
    await readChatSendAccountSettings(
      {
        userQuery: async (opts) => {
          assert.deepEqual(opts, {
            query: {
              accounts: [
                { account_id: options.accountId, other_settings: null },
              ],
            },
          });
          return {
            accounts: [
              { account_id: options.accountId, other_settings: settings },
            ],
          };
        },
      },
      options.accountId,
    ),
    settings,
  );
  await assert.rejects(
    readChatSendAccountSettings(
      { userQuery: async () => ({ accounts: [] }) },
      options.accountId,
    ),
    /preferences/,
  );
  await assert.rejects(
    readChatSendAccountSettings(
      {
        userQuery: async () => {
          throw Error("offline");
        },
      },
      options.accountId,
    ),
    /offline/,
  );
});

test("accepts legacy config-only and model-only Codex threads", () => {
  for (const thread of [
    { ...options.thread, agent_kind: undefined },
    {
      ...options.thread,
      agent_kind: undefined,
      acp_config: undefined,
      agent_model: "codex-agent",
    },
  ])
    assert.equal(
      prepareChatSend({ ...options, thread }).request.chat.thread_id,
      "thread-1",
    );
});

test("preserves account concurrency and effective completion notifications", () => {
  const otherSettings = {
    codex_max_concurrent_subagents: 1,
    [OTHER_SETTINGS_NOTIFICATION_PREFERENCES_V2_KEY]: {
      version: 2,
      ai: { completion_default: false },
    },
  };
  for (const guidance of [false, true]) {
    const { request } = prepareChatSend({
      ...options,
      otherSettings,
      guidance,
    });
    assert.equal(request.config?.maxConcurrentSubagents, 1);
    assert.equal(request.chat.completion_notification_enabled, false);
  }
  for (const override of ["on", "off", "inherit"] as const) {
    const { request } = prepareChatSend({
      ...options,
      otherSettings,
      thread: { ...options.thread, codex_completion_notification: override },
    });
    assert.equal(
      request.chat.completion_notification_enabled,
      override === "on",
    );
  }
  assert.equal(
    prepareChatSend(options).request.config?.maxConcurrentSubagents,
    undefined,
  );
  assert.equal(
    prepareChatSend(options).request.chat.completion_notification_enabled,
    true,
  );
});

function fixture(guidance = false) {
  const calls: string[] = [];
  const prepared = prepareChatSend({ ...options, guidance });
  const syncdb = {
    get: () => [],
    set: (value: unknown) => {
      assert.equal(value, prepared.message);
      calls.push("set");
    },
    commit: () => {
      calls.push("commit");
      return true;
    },
    save: async () => {
      calls.push("save");
    },
    save_to_disk: async () => {
      calls.push("disk");
    },
  };
  const client = {} as Client;
  return { prepared, syncdb, client, calls };
}

for (const state of ["queued", "running"] as const) {
  test(`ordinary send waits for ${state} acknowledgement, never steers and stops listening`, async () => {
    const f = fixture();
    let closed = false;
    const result = await submitChatSend({
      ...f,
      transport: {
        stream: async function* (request, _, client) {
          assert.deepEqual(f.calls, ["set", "commit", "save", "disk"]);
          assert.equal(request, f.prepared.request);
          assert.equal(client, f.client);
          try {
            yield { type: "status", state: "init", seq: 0 };
            yield { type: "status", state, seq: 1 };
            assert.fail("must not wait for model completion");
          } finally {
            closed = true;
          }
        },
        steer: async () => {
          throw new Error("must not steer");
        },
      },
    });
    assert.equal(closed, true);
    assert.equal(result.state, "accepted");
    assert.equal(result.guidance, false);
    assert.equal(result.message_id, f.prepared.message.message_id);
  });
}

for (const state of ["steered", "queued", "running"] as const) {
  test(`guidance uses steer-or-queue and accepts ${state}`, async () => {
    const f = fixture(true);
    const result = await submitChatSend({
      ...f,
      transport: {
        stream: async function* () {
          throw new Error("must use steer-or-queue");
        },
        steer: async (request, client) => {
          assert.deepEqual(f.calls, ["set", "commit", "save", "disk"]);
          assert.equal(request.chat.send_mode, "immediate");
          assert.equal(client, f.client);
          return { ok: true, state };
        },
      },
    });
    assert.equal(result.state, "accepted");
    assert.equal(result.guidance, true);
  });
}

test("rejection, timeout and unacknowledged streams report uncertainty without retrying", async () => {
  for (const response of [
    undefined,
    { type: "error", error: "not allowed", seq: 0 },
    "timeout",
  ] as const) {
    const f = fixture();
    let attempts = 0;
    await assert.rejects(
      submitChatSend({
        ...f,
        transport: {
          stream: async function* () {
            attempts++;
            if (response === "timeout") throw new Error("timeout");
            if (response) yield response as AcpStreamMessage;
          },
          steer: async () => {
            throw new Error("must not steer");
          },
        },
      }),
      /was saved.*submission was not confirmed.*Check the thread/,
    );
    assert.equal(attempts, 1);
  }
});

test("failed persistence does not submit a turn", async () => {
  const f = fixture();
  f.syncdb.save = async () => {
    throw new Error("disconnected");
  };
  await assert.rejects(
    submitChatSend({
      ...f,
      transport: {
        stream: async function* () {
          assert.fail("must not dispatch");
        },
        steer: async () => {
          assert.fail("must not dispatch");
        },
      },
    }),
    /disconnected/,
  );
});

test("missing guidance target does not produce a success receipt", async () => {
  const f = fixture(true);
  await assert.rejects(
    submitChatSend({
      ...f,
      transport: {
        stream: async function* () {
          assert.fail("must not retry");
        },
        steer: async () => ({ ok: true, state: "missing" }),
      },
    }),
    /submission was not confirmed/,
  );
});

function humanFixture() {
  const room = {
    project_id: options.projectId,
    room_id: "11111111-1111-4111-8111-111111111111",
    chat_path: "/home/user/.collaborators/human.chat",
    initialized: true,
  };
  const threadId = "22222222-2222-4222-8222-222222222222";
  const requestId = "33333333-3333-4333-8333-333333333333";
  const messageId = "44444444-4444-4444-8444-444444444444";
  const calls: any[] = [];
  const ctx = {
    accountId: options.accountId,
    timeoutMs: 12345,
    hub: {
      collaborators: {
        ensureRoom: async (request: any) => {
          calls.push({ ensureRoom: request });
          return room as any;
        },
      },
    },
  };
  const client = {
    request: async (...args: any[]) => {
      calls.push({ rpc: args });
      return { data: { ...room, thread_id: threadId, message_id: messageId } };
    },
  } as any;
  return {
    ctx,
    client,
    projectId: options.projectId,
    requestId,
    room,
    threadId,
    messageId,
    calls,
  };
}

test("human creation and send use owner registration and the account-authenticated host service", async () => {
  for (const action of ["createThread", "send"] as const) {
    const f = humanFixture();
    const operation =
      action === "send"
        ? { action, threadId: f.threadId, text: "@agent is a reference\n" }
        : { action, title: "Discussion" };
    const result = await submitHumanChatOperation({ ...f, operation });
    assert.deepEqual(f.calls, [
      {
        ensureRoom: {
          account_id: f.ctx.accountId,
          project_id: f.projectId,
          request_id: f.requestId,
        },
      },
      {
        rpc: [
          `services.account-${f.ctx.accountId}._.${f.projectId}._.collaborators`,
          [
            action,
            [
              action === "send"
                ? {
                    request_id: f.requestId,
                    expected_room_id: f.room.room_id,
                    thread_id: f.threadId,
                    text: "@agent is a reference\n",
                  }
                : {
                    request_id: f.requestId,
                    expected_room_id: f.room.room_id,
                    title: "Discussion",
                  },
            ],
          ],
          { timeout: 12345, waitForInterest: true },
        ],
      },
    ]);
    assert.equal(result.path, f.room.chat_path);
    assert.equal(result.thread_id, f.threadId);
    assert.equal(result.request_id, f.requestId);
    assert.equal(result.human, true);
    assert.equal(result.state, "accepted");
  }
});

test("human validation occurs before room registration or host writes", async () => {
  const operations = [
    { action: "send", threadId: "invalid", text: "hello" },
    { action: "send", threadId: humanFixture().threadId, text: " \n" },
    {
      action: "send",
      threadId: humanFixture().threadId,
      text: "x".repeat(32769),
    },
    { action: "createThread", title: "x".repeat(513) },
  ] as const;
  for (const operation of operations) {
    const f = humanFixture();
    await assert.rejects(submitHumanChatOperation({ ...f, operation }));
    assert.deepEqual(f.calls, []);
  }
  for (const field of ["accountId", "projectId", "requestId"] as const) {
    const f = humanFixture();
    if (field === "accountId") f.ctx.accountId = "";
    else f[field] = "bad";
    await assert.rejects(
      submitHumanChatOperation({ ...f, operation: { action: "createThread" } }),
      /identities/,
    );
    assert.deepEqual(f.calls, []);
  }
});

test("disabled or unauthorized owner registration fails without a host operation", async () => {
  const f = humanFixture();
  f.ctx.hub.collaborators.ensureRoom = async () => {
    throw Error("disabled or denied");
  };
  await assert.rejects(
    submitHumanChatOperation({ ...f, operation: { action: "createThread" } }),
    /disabled or denied/,
  );
  assert.deepEqual(f.calls, []);
});

test("mismatched canonical registration is not sent to the project host", async () => {
  const f = humanFixture();
  f.room.project_id = "other-project";
  await assert.rejects(
    submitHumanChatOperation({ ...f, operation: { action: "createThread" } }),
    /registration/,
  );
  assert.equal(f.calls.length, 1);
});

test("lost or invalid human acknowledgement retains the exact retry key and never retries automatically", async () => {
  for (const outcome of [
    "lost",
    "wrong-room",
    "wrong-thread",
    "missing-message",
  ]) {
    const f = humanFixture();
    let attempts = 0;
    f.client.request = async () => {
      attempts++;
      if (outcome === "lost") throw Error("timeout");
      return {
        data: {
          ...f.room,
          room_id: outcome === "wrong-room" ? f.threadId : f.room.room_id,
          thread_id: outcome === "wrong-thread" ? f.requestId : f.threadId,
          message_id: outcome === "missing-message" ? undefined : f.messageId,
        },
      };
    };
    await assert.rejects(
      submitHumanChatOperation({
        ...f,
        operation: { action: "send", threadId: f.threadId, text: "hello" },
      }),
      new RegExp(`not confirmed.*--request-id ${f.requestId}`),
    );
    assert.equal(attempts, 1);
  }
});

test("canonical human handlers persist one thread/message across CLI retries after lost acknowledgements", async () => {
  const f = humanFixture();
  const rows: any[] = [];
  let saves = 0;
  const db = {
    get: () => rows,
    set: (row: any) => {
      const index = rows.findIndex(
        (r) =>
          r.event === row.event &&
          r.thread_id === row.thread_id &&
          r.message_id === row.message_id,
      );
      if (index === -1) rows.push(row);
      else rows[index] = row;
    },
    commit: () => {},
    save: async () => {},
    save_to_disk: async () => {
      saves++;
    },
  };
  let loseAck = true;
  const seenRequests: string[] = [];
  f.client.request = async (_subject: string, [action, [opts]]: any) => {
    seenRequests.push(opts.request_id);
    await initializeHumanRoom(db, f.room);
    const result =
      action === "createThread"
        ? await createHumanThread(db, {
            room: f.room,
            account_id: f.ctx.accountId,
            thread_id: f.threadId,
            title: opts.title,
          })
        : await sendHumanMessage(db, {
            room: f.room,
            account_id: f.ctx.accountId,
            thread_id: opts.thread_id,
            message_id: f.messageId,
            text: opts.text,
          });
    if (loseAck) throw Error("lost acknowledgement after disk write");
    return { data: result };
  };
  for (const operation of [
    { action: "createThread", title: "Discussion" },
    {
      action: "send",
      threadId: f.threadId,
      text: "@codex-agent is just a reference\n",
    },
  ] as const) {
    loseAck = true;
    await assert.rejects(
      submitHumanChatOperation({ ...f, operation }),
      /not confirmed/,
    );
    loseAck = false;
    await submitHumanChatOperation({ ...f, operation });
  }
  assert.deepEqual(seenRequests, Array(4).fill(f.requestId));
  assert.equal(
    rows.filter((row) => row.event === "collaborators-room").length,
    1,
  );
  assert.equal(rows.filter((row) => row.event === "chat-thread").length, 1);
  const config = rows.find((row) => row.event === "chat-thread-config");
  assert.equal(config.agent_kind, "none");
  assert.equal(config.acp_config, undefined);
  const messages = rows.filter((row) => row.event === "chat");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sender_id, f.ctx.accountId);
  assert.equal(
    messages[0].history[0].content,
    "@codex-agent is just a reference\n",
  );
  assert.equal(saves, 8);
});
