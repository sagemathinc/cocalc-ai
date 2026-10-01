import {
  prepareChatSend,
  submitChatSend,
  admitPreparedChatSend,
} from "../send";
import { buildThreadConfigRecord } from "../core";
import type { AcpHarnessRuntime } from "@cocalc/util/ai/runtime";

const runtime: AcpHarnessRuntime = {
  version: 1,
  kind: "acp",
  profile: {
    version: 1,
    kind: "acp",
    id: "pi",
    revision: "1",
    executable: "/home/user/bin/pi-acp",
    args: [],
    cwd: "/home/user",
    executionPolicy: "full-access",
    credentialMode: "project-managed",
  },
};

test("generic thread metadata round-trips without inventing Codex funding or a session", () => {
  const thread = buildThreadConfigRecord({
    thread_id: "thread",
    updated_by: "account",
    agent_kind: "acp",
    agent_runtime: runtime,
    acp_config: {
      model: "codex",
      sessionId: "legacy",
      paymentSource: "subscription",
    },
  });
  const prepared = prepareChatSend({
    projectId: "project",
    accountId: "account",
    path: "a.chat",
    thread,
    rows: [],
    prompt: "hello",
  });
  expect(prepared.request.runtime).toEqual(runtime);
  expect(prepared.request.config).toBeUndefined();
  expect(prepared.request.session_id).toBeUndefined();
  runtime.profile.args.push("changed-after-admission");
  expect(prepared.request.runtime!.profile.args).toEqual([]);
  runtime.profile.args.pop();
  thread.agent_session_id = "native-pi-session";
  expect(
    prepareChatSend({
      projectId: "project",
      accountId: "account",
      path: "a.chat",
      thread,
      rows: [],
      prompt: "again",
    }).request.session_id,
  ).toBe("native-pi-session");
});

test("ACP guidance preserves the runtime; unknown runtimes do not fall back to Codex", () => {
  const options = {
    projectId: "project",
    accountId: "account",
    path: "a.chat",
    rows: [],
    prompt: "hello",
    thread: buildThreadConfigRecord({
      thread_id: "thread",
      updated_by: "account",
      agent_kind: "acp",
      agent_runtime: runtime,
    }),
  };
  const guided = prepareChatSend({ ...options, guidance: true }).request;
  expect(guided.runtime).toEqual(runtime);
  expect(guided.config).toBeUndefined();
  expect(guided.harness_credential).toBeUndefined();
  expect(guided.chat.send_mode).toBe("immediate");
  expect(() =>
    prepareChatSend({
      ...options,
      thread: { ...options.thread, agent_runtime: { kind: "future" } as any },
    }),
  ).toThrow(/runtime/);
});

test.each([
  ["", undefined],
  [undefined, "old-session"],
  ["current-session", "current-session"],
])(
  "harness session selection preserves an explicit reset (%s)",
  (persisted, expected) => {
    const thread = buildThreadConfigRecord({
      thread_id: "thread",
      updated_by: "account",
      agent_kind: "acp",
      agent_runtime: runtime,
      agent_session_id: persisted,
    });
    expect(
      prepareChatSend({
        projectId: "project",
        accountId: "account",
        path: "a.chat",
        thread,
        rows: [
          {
            event: "chat",
            thread_id: "thread",
            date: new Date().toISOString(),
            acp_thread_id: "old-session",
          },
        ],
        prompt: "hello",
      }).request.session_id,
    ).toBe(expected);
  },
);

function fixture(guidance = false) {
  const steps: string[] = [];
  const prepared = prepareChatSend({
    projectId: "project",
    accountId: "account",
    path: "/home/user/test.chat",
    thread: {
      event: "chat-thread-config",
      thread_id: "thread",
      agent_kind: "acp",
    } as any,
    rows: [],
    prompt: "Hello",
    guidance,
  });
  const syncdb = {
    get: jest.fn((): any[] => []),
    set: jest.fn(() => {
      steps.push("set");
    }),
    commit: jest.fn(() => {
      steps.push("commit");
    }),
    save: jest.fn(async () => {
      steps.push("save");
    }),
    save_to_disk: jest.fn(async () => {
      steps.push("disk");
    }),
  };
  const transport = {
    stream: jest.fn(async function* () {
      steps.push("queue");
      yield { type: "status", state: "queued" };
    }),
    steer: jest.fn(async () => {
      steps.push("steer");
      return { ok: true, state: "queued" };
    }),
  };
  return {
    steps,
    prepared,
    syncdb,
    transport: transport as any,
    client: {} as any,
  };
}

test("direct human sends still save the live chat before queue submission", async () => {
  const f = fixture();
  expect(await submitChatSend(f)).toMatchObject({
    state: "accepted",
    guidance: false,
    message_id: f.prepared.message.message_id,
  });
  expect(f.steps).toEqual(["set", "commit", "save", "disk", "queue"]);
});

test("direct guidance retains the steer path after persistence", async () => {
  const f = fixture(true);
  expect(await submitChatSend(f)).toMatchObject({
    state: "accepted",
    guidance: true,
  });
  expect(f.steps).toEqual(["set", "commit", "save", "disk", "steer"]);
});

test("queue-only admission never saves or rewrites chat", async () => {
  const f = fixture();
  await admitPreparedChatSend(f);
  expect(f.steps).toEqual(["queue"]);
});

test("failed chat persistence does not attempt admission", async () => {
  const f = fixture();
  f.syncdb.save.mockRejectedValueOnce(new Error("offline"));
  await expect(submitChatSend(f)).rejects.toThrow("offline");
  expect(f.transport.stream).not.toHaveBeenCalled();
});

test("missing queue acknowledgement is explicit uncertainty", async () => {
  const f = fixture();
  f.transport.stream.mockImplementationOnce(async function* () {});
  await expect(submitChatSend(f)).rejects.toThrow(
    "submission was not confirmed",
  );
});

describe.each([false, true])("human-only safety (guidance=%s)", (guidance) => {
  test.each([
    [{ event: "collaborators-room", mode: "human" }],
    [{ event: "collaborators-room" }],
  ])("room marker overrides agent configuration %j", (marker) => {
    for (const agent_kind of ["acp", "none", undefined]) {
      expect(() =>
        prepareChatSend({
          projectId: "project",
          accountId: "account",
          path: "human.chat",
          thread: {
            thread_id: "thread",
            agent_kind,
            acp_config: { model: "gpt-5" },
            agent_model: "codex-agent",
          } as any,
          rows: [marker],
          prompt: "@agent please review",
          guidance,
        }),
      ).toThrow("human-only");
    }
  });

  test.each([
    { acp_config: {} },
    { agent_model: "codex-agent" },
    { acp_config: {}, agent_model: "codex-agent" },
  ])("explicit none overrides stale fields %j", (stale) => {
    expect(() =>
      prepareChatSend({
        projectId: "project",
        accountId: "account",
        path: "human.chat",
        thread: { thread_id: "thread", agent_kind: "none", ...stale } as any,
        rows: [],
        prompt: "hello",
        guidance,
      }),
    ).toThrow("human-only");
  });

  test.each([
    { event: "collaborators-room" },
    {
      event: "chat-thread-config",
      thread_id: "thread",
      agent_kind: "none",
      acp_config: {},
    },
  ])("late human mode blocks all persistence and dispatch %j", async (row) => {
    const f = fixture(guidance);
    f.syncdb.get.mockReturnValue([row]);
    await expect(submitChatSend(f)).rejects.toThrow("human-only");
    expect(f.steps).toEqual([]);
    expect(f.transport.stream).not.toHaveBeenCalled();
    expect(f.transport.steer).not.toHaveBeenCalled();
  });

  test("rechecks live mode after asynchronous persistence before dispatch", async () => {
    const f = fixture(guidance);
    f.syncdb.save_to_disk.mockImplementation(async () => {
      f.syncdb.get.mockReturnValue([{ event: "collaborators-room" }]);
    });
    await expect(submitChatSend(f)).rejects.toThrow("human-only");
    expect(f.transport.stream).not.toHaveBeenCalled();
    expect(f.transport.steer).not.toHaveBeenCalled();
  });
});
