import assert from "node:assert/strict";
import test from "node:test";
import { buildThreadConfigRecord } from "@cocalc/chat";
import type { Client } from "@cocalc/conat/core/client";
import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";
import { prepareChatSend, submitChatSend } from "./project-chat-send";

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
        thread: { ...options.thread, agent_kind: "llm" },
      }),
    /Codex\/ACP/,
  );
});

function fixture(guidance = false) {
  const calls: string[] = [];
  const prepared = prepareChatSend({ ...options, guidance });
  const syncdb = {
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
