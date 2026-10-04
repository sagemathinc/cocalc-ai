import {
  reportAgentRuntimeOnce,
  setAgentRuntimeReporterForTests,
} from "../agent-runtime-report";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function request(runtime?: any) {
  return {
    project_id: "00000000-0000-4000-8000-000000000001",
    account_id: "00000000-0000-4000-8000-000000000002",
    prompt: "hi",
    ...(runtime ? { runtime } : {}),
    chat: {
      project_id: "00000000-0000-4000-8000-000000000001",
      path: "/home/user/a.chat",
      thread_id: "t1",
    },
  } as any;
}

afterEach(() => setAgentRuntimeReporterForTests());

test("reports each conversation's runtime once per process", async () => {
  const report = jest.fn(async () => {});
  setAgentRuntimeReporterForTests(report);
  reportAgentRuntimeOnce(request());
  reportAgentRuntimeOnce(request());
  await settle();
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({ thread_id: "t1", runtime: { kind: "codex" } }),
  );
  reportAgentRuntimeOnce(
    request({
      version: 1,
      kind: "acp",
      profile: { version: 2, id: "claude-code" },
    }),
  );
  await settle();
  expect(report).toHaveBeenLastCalledWith(
    expect.objectContaining({ runtime: { kind: "claude-code" } }),
  );
});

test("a failed report is retried on a later turn", async () => {
  const report = jest
    .fn()
    .mockRejectedValueOnce(new Error("older hub"))
    .mockResolvedValue(undefined);
  setAgentRuntimeReporterForTests(report);
  reportAgentRuntimeOnce(request());
  await settle();
  reportAgentRuntimeOnce(request());
  await settle();
  expect(report).toHaveBeenCalledTimes(2);
});

test("commands and non-chat requests are not reported", async () => {
  const report = jest.fn(async () => {});
  setAgentRuntimeReporterForTests(report);
  reportAgentRuntimeOnce({ ...request(), request_kind: "command" });
  reportAgentRuntimeOnce({
    ...request(),
    chat: { path: "x.ipynb", thread_id: "t" },
  });
  await settle();
  expect(report).not.toHaveBeenCalled();
});
