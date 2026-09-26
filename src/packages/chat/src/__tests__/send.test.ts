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

test("unknown runtime and unsupported guidance do not fall back to Codex", () => {
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
  expect(() => prepareChatSend({ ...options, guidance: true })).toThrow(
    /guidance/,
  );
  expect(() =>
    prepareChatSend({
      ...options,
      thread: { ...options.thread, agent_runtime: { kind: "future" } as any },
    }),
  ).toThrow(/runtime/);
});

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
