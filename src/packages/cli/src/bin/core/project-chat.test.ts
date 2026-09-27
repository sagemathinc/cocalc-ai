import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  mergeThreadConfigRecord,
  resolveArtifactMessage,
  createProjectChatOps,
} from "./project-chat";

test("artifact writes require opt-in before opening a live document", async () => {
  let opened = false;
  const ops = createProjectChatOps({
    readAccountSettings: async () => ({}),
    resolveProjectConatClient: async () => {
      opened = true;
      throw Error("unexpected project connection");
    },
  });
  await assert.rejects(
    ops.projectChatArtifactData({
      ctx: {},
      path: "x.chat",
      threadId: "thread",
      action: "create",
    }),
    /experimental opt-in/,
  );
  assert.equal(opened, false);
});

test("artifact context resolves an exact producing row, never the newest row", () => {
  const row = {
    event: "chat",
    thread_id: "t",
    message_id: "m",
    date: "2026-09-09T00:00:00.000Z",
  };
  assert.equal(
    resolveArtifactMessage(
      [row, { ...row, message_id: "new", date: "2026-09-09T01:00:00Z" }],
      "t",
      row.date,
    ),
    "m",
  );
  assert.throws(
    () => resolveArtifactMessage([row], "other", row.date),
    /missing/,
  );
  assert.throws(
    () => resolveArtifactMessage([row, row], "t", row.date),
    /ambiguous/,
  );
  assert.throws(
    () => resolveArtifactMessage([row], "t", "bad"),
    /valid message date/,
  );
});

test("mergeThreadConfigRecord preserves unrelated thread metadata while updating automation settings", () => {
  const merged = mergeThreadConfigRecord({
    existing: {
      event: "chat-thread-config",
      sender_id: "__thread_config__:thread-1",
      date: "1970-01-01T00:00:00.000Z",
      thread_id: "thread-1",
      name: "Agent thread",
      agent_kind: "acp",
      agent_mode: "interactive",
      automation_config: {
        enabled: true,
        prompt: "run daily",
        local_time: "09:00",
        timezone: "UTC",
      },
      automation_state: {
        status: "active",
      },
      updated_at: "2026-03-16T00:00:00.000Z",
      updated_by: "old-account",
      schema_version: 2,
    },
    threadId: "thread-1",
    accountId: "new-account",
    patch: {
      automation_state: {
        status: "paused",
      },
    },
  });

  assert.equal(merged.thread_id, "thread-1");
  assert.equal(merged.name, "Agent thread");
  assert.equal(merged.agent_kind, "acp");
  assert.deepEqual(merged.automation_config, {
    enabled: true,
    prompt: "run daily",
    local_time: "09:00",
    timezone: "UTC",
  });
  assert.deepEqual(merged.automation_state, { status: "paused" });
  assert.equal(merged.updated_by, "new-account");
});

function chatFixture(rows: any[]) {
  const calls: string[] = [];
  const db = {
    get: () => rows,
    set: () => calls.push("set"),
    commit: () => calls.push("commit"),
    save: async () => {
      calls.push("save");
    },
    save_to_disk: async () => {
      calls.push("disk");
    },
  };
  const acquire = mock.method(
    require("@cocalc/chat/server"),
    "acquireChatSyncDB",
    async () => {
      calls.push("acquire");
      return db;
    },
  );
  const release = mock.method(
    require("@cocalc/chat/server"),
    "releaseChatSyncDB",
    async () => {
      calls.push("release");
    },
  );
  const automation = mock.method(
    require("./chat-automation"),
    "humanChatAutomation",
    async () => {
      calls.push("automation");
      return { ok: true };
    },
  );
  const stream = mock.method(
    require("@cocalc/conat/ai/acp/client"),
    "streamAcp",
    async function* () {
      calls.push("stream");
      yield { type: "status", state: "queued" };
    },
  );
  const steer = mock.method(
    require("@cocalc/conat/ai/acp/client"),
    "steerAcp",
    async () => {
      calls.push("steer");
      return { ok: true, state: "steered" };
    },
  );
  const options = {
    ctx: { accountId: "actor" },
    path: "room.chat",
    threadId: "thread",
  };
  const ops = createProjectChatOps({
    readAccountSettings: async () => ({}),
    resolveProjectConatClient: async () => ({
      project: { project_id: "project", title: "Project", host_id: "host" },
      client: {
        fs: () => ({
          mkdir: async () => {
            calls.push("mkdir");
          },
        }),
      },
    }),
  });
  return {
    calls,
    db,
    options,
    ops,
    restore: () =>
      [acquire, release, automation, stream, steer].forEach((m) =>
        m.mock.restore(),
      ),
  };
}

const staleThread = {
  event: "chat-thread-config",
  thread_id: "thread",
  agent_kind: "none",
  acp_config: { model: "gpt-5" },
  agent_model: "codex-agent",
};

test("canonical send and guidance do not write, stream or steer despite stale ACP fields", async () => {
  for (const guidance of [false, true]) {
    const f = chatFixture([{ event: "collaborators-room" }, staleThread]);
    try {
      await assert.rejects(
        f.ops.projectChatSendData({
          ...f.options,
          prompt: "@agent hello",
          guidance,
        }),
        /human-only/,
      );
      assert.deepEqual(f.calls, ["acquire", "release"]);
    } finally {
      f.restore();
    }
  }
});

test("canonical thread create blocks agent and legacy human config writes before mkdir", async () => {
  for (const agentKind of ["acp", "llm", "none", undefined] as const) {
    const f = chatFixture([{ event: "collaborators-room" }]);
    try {
      await assert.rejects(
        f.ops.projectChatThreadCreateData({
          ...f.options,
          agentKind,
          acpConfig: {},
        }),
        /thread create --human/,
      );
      assert.deepEqual(f.calls, ["acquire", "release"]);
    } finally {
      f.restore();
    }
  }
});

test("all canonical automation mutations are rejected, while status remains readable", async () => {
  const f = chatFixture([{ event: "collaborators-room" }, staleThread]);
  try {
    for (const action of [
      "upsert",
      "pause",
      "resume",
      "run_now",
      "delete",
    ] as const) {
      await assert.rejects(
        f.ops.projectChatAutomationData({
          ...f.options,
          action: action as any,
        }),
        /human-only/,
      );
    }
    const status = await f.ops.projectChatAutomationData({
      ...f.options,
      action: "status",
    });
    assert.equal(status.ok, true);
    assert.equal(f.calls.includes("automation"), false);
    assert.equal(f.calls.includes("set"), false);
  } finally {
    f.restore();
  }
});

test("ordinary agent create, send, guidance and automation keep their existing backends", async () => {
  const f = chatFixture([{ ...staleThread, agent_kind: "acp" }]);
  try {
    await f.ops.projectChatThreadCreateData({
      ...f.options,
      threadId: "new",
      agentKind: "acp",
      acpConfig: {},
    });
    assert.deepEqual(f.calls, [
      "acquire",
      "mkdir",
      "set",
      "commit",
      "save",
      "disk",
      "release",
    ]);
    f.calls.length = 0;
    await f.ops.projectChatSendData({ ...f.options, prompt: "hello" });
    assert.deepEqual(f.calls, [
      "acquire",
      "set",
      "commit",
      "save",
      "disk",
      "stream",
      "release",
    ]);
    f.calls.length = 0;
    await f.ops.projectChatSendData({
      ...f.options,
      prompt: "guidance",
      guidance: true,
    });
    assert.deepEqual(f.calls, [
      "acquire",
      "set",
      "commit",
      "save",
      "disk",
      "steer",
      "release",
    ]);
    f.calls.length = 0;
    await f.ops.projectChatAutomationData({ ...f.options, action: "pause" });
    assert.deepEqual(f.calls, ["acquire", "automation", "release"]);
  } finally {
    f.restore();
  }
});

test("explicit human create/send route through the canonical service without opening a local chat or account AI settings", async () => {
  const f = chatFixture([]);
  const projectId = "11111111-1111-4111-8111-111111111111";
  const accountId = "22222222-2222-4222-8222-222222222222";
  const threadId = "33333333-3333-4333-8333-333333333333";
  const requestId = "44444444-4444-4444-8444-444444444444";
  const room = {
    project_id: projectId,
    room_id: requestId,
    chat_path: "/home/user/room.chat",
  };
  const requests: any[] = [];
  const ctx = {
    accountId,
    hub: { collaborators: { ensureRoom: async () => room } },
  };
  const ops = createProjectChatOps({
    readAccountSettings: async () => {
      assert.fail("human sends do not need AI preferences");
    },
    resolveProjectConatClient: async () => ({
      project: {
        project_id: projectId,
        title: "Project",
        host_id: "remote-host",
      },
      client: {
        request: async (_subject: string, payload: unknown) => {
          requests.push(payload);
          return {
            data: { ...room, thread_id: threadId, message_id: accountId },
          };
        },
      },
    }),
  });
  try {
    const created = await ops.projectChatThreadCreateData({
      ctx,
      human: true,
      name: "Discussion",
      requestId,
    });
    assert.equal(created.thread_id, threadId);
    const sent = await ops.projectChatSendData({
      ctx,
      human: true,
      threadId,
      prompt: "@agent",
      requestId,
    });
    assert.equal(sent.message_id, accountId);
    assert.deepEqual(requests, [
      ["createThread", [{ request_id: requestId, title: "Discussion" }]],
      [
        "send",
        [{ request_id: requestId, thread_id: threadId, text: "@agent" }],
      ],
    ]);
    assert.deepEqual(f.calls, []);
  } finally {
    f.restore();
  }
});
