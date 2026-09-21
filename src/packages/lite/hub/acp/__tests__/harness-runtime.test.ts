import { randomUUID } from "node:crypto";
import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import {
  queuedAgentSession,
  prepareHarnessRequest,
  setHarnessLauncher,
  harnessRuntimeKey,
  assertConfiguredHarnessRuntime,
} from "../harness-runtime";
import {
  pinCodexCredentialAtAdmission,
  setCodexCredentialAdmissionResolver,
} from "../codex-credential-admission";
import { closeAcpDatabase, initAcpDatabase } from "../../sqlite/acp-database";
import { decodeAcpJobRequest, enqueueAcpJob } from "../../sqlite/acp-jobs";

const project_id = randomUUID();
function request(): AcpRequest {
  return {
    project_id,
    account_id: randomUUID(),
    prompt: "hello",
    runtime: {
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
    },
    chat: {
      project_id,
      path: "a.chat",
      thread_id: "thread",
      message_id: randomUUID(),
      parent_message_id: randomUUID(),
      message_date: new Date().toISOString(),
      sender_id: "agent",
    },
  };
}
const original = process.env.COCALC_ACP_HARNESSES;
test("configured harness rejects native/unknown/stale clients, without changing submitted runtime", () => {
  const source = request();
  expect(() =>
    assertConfiguredHarnessRuntime(source, source.runtime),
  ).not.toThrow();
  expect(() => assertConfiguredHarnessRuntime({}, source.runtime)).toThrow(
    /reload/,
  );
  expect(() =>
    assertConfiguredHarnessRuntime(source, { kind: "future" }),
  ).toThrow(/runtime/);
  const newer = {
    ...source.runtime!,
    profile: { ...source.runtime!.profile, revision: "new" },
  };
  expect(() => assertConfiguredHarnessRuntime(source, newer)).toThrow(/reload/);
  expect(source.runtime!.profile.revision).toBe("1");
  expect(() => assertConfiguredHarnessRuntime({}, undefined)).not.toThrow();
});
beforeEach(() => {
  process.env.COCALC_ACP_HARNESSES = "1";
  setHarnessLauncher(async () => {
    throw Error("must not launch during admission");
  });
});
afterEach(() => {
  if (original === undefined) delete process.env.COCALC_ACP_HARNESSES;
  else process.env.COCALC_ACP_HARNESSES = original;
  setHarnessLauncher();
  setCodexCredentialAdmissionResolver();
  closeAcpDatabase();
});

test("generic admission snapshots profile and bypasses Codex credentials through SQLite", async () => {
  initAcpDatabase({ filename: ":memory:" });
  const resolver = jest.fn();
  setCodexCredentialAdmissionResolver(resolver);
  const source = request();
  source.runtime!.settings = {
    configOptions: [{ id: "model", value: "fast" }],
  };
  const admitted = await pinCodexCredentialAtAdmission(source);
  const job = enqueueAcpJob(admitted);
  source.runtime!.profile.args.push("changed");
  source.runtime!.profile.revision = "2";
  source.runtime!.settings.configOptions![0].value = "deep";
  expect(decodeAcpJobRequest(job)).toMatchObject({
    runtime: {
      profile: { revision: "1", args: [] },
      settings: { configOptions: [{ id: "model", value: "fast" }] },
    },
  });
  expect(resolver).not.toHaveBeenCalled();
});

test("unconfigured or disabled hosts reject instead of choosing native Codex", () => {
  delete process.env.COCALC_ACP_HARNESSES;
  expect(() => prepareHarnessRequest(request())).toThrow(/not enabled/);
  process.env.COCALC_ACP_HARNESSES = "1";
  setHarnessLauncher();
  expect(() => prepareHarnessRequest(request())).toThrow(/not enabled/);
});

test("queued ACP delivery preserves admitted settings and exact existing session", () => {
  const admitted = request();
  admitted.runtime!.settings = { configOptions: [{ id: "model", value: "a" }] };
  const current = request();
  current.runtime!.settings = { configOptions: [{ id: "model", value: "b" }] };
  current.session_id = "created-by-previous-turn";
  expect(queuedAgentSession(admitted, current)).toEqual({
    config: undefined,
    session_id: "created-by-previous-turn",
  });
  admitted.session_id = "admitted-session";
  expect(queuedAgentSession(admitted, current).session_id).toBe(
    "admitted-session",
  );
  expect(admitted.runtime!.settings.configOptions![0].value).toBe("a");
  current.runtime!.profile.revision = "changed";
  expect(() => queuedAgentSession(admitted, current)).toThrow(
    "runtime changed",
  );
  expect(() =>
    queuedAgentSession({ ...admitted, runtime: undefined }, current),
  ).toThrow();
});

test("generic RPC delivery permits queued envelopes but never live guidance", () => {
  const value = request();
  value.chat!.agent_message = true;
  expect(() => prepareHarnessRequest(value)).toThrow();
  value.chat!.agent_rpc_execution = { guidance: false } as any;
  expect(prepareHarnessRequest(value).chat!.agent_rpc_execution).toEqual({
    guidance: false,
  });
  value.chat!.agent_rpc_execution!.guidance = true;
  expect(() => prepareHarnessRequest(value)).toThrow();
  value.chat!.agent_rpc_execution!.guidance = false;
  value.chat!.send_mode = "immediate";
  expect(() => prepareHarnessRequest(value)).toThrow();
});

test("unsupported runtime versions, funding and recovery fail closed", () => {
  const source = request();
  for (const changes of [
    { runtime: { ...source.runtime, version: 2 } },
    { runtime: { ...source.runtime, kind: "other" } },
    { runtime: null },
    { config: { paymentSource: "auto" } },
    { runtime_env: { KEY: "secret" } },
    { recovery_parent_op_id: "old" },
    { chat: { ...source.chat, project_id: "other" } },
    { chat: { ...source.chat, automation_id: "automation" } },
  ])
    expect(() =>
      prepareHarnessRequest({ ...source, ...changes } as any),
    ).toThrow();
});

test("runtime keys separate principals, conversations and profile revisions", () => {
  const source = request();
  const key = harnessRuntimeKey(source);
  for (const change of [
    { account_id: randomUUID() },
    { project_id: randomUUID() },
    { chat: { ...source.chat!, thread_id: "other" } },
    {
      runtime: {
        ...source.runtime!,
        profile: { ...source.runtime!.profile, revision: "2" },
      },
    },
  ])
    expect(harnessRuntimeKey({ ...source, ...change })).not.toBe(key);
  const native = { ...source, runtime: undefined };
  expect(prepareHarnessRequest(native)).toBe(native);
});
