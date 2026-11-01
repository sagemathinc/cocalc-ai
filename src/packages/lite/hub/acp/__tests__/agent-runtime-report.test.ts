import {
  reportAgentModelFromEvent,
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

test("non-chat requests are not reported", async () => {
  const report = jest.fn(async () => {});
  setAgentRuntimeReporterForTests(report);
  reportAgentRuntimeOnce({
    ...request(),
    chat: { path: "x.ipynb", thread_id: "t" },
  });
  await settle();
  expect(report).not.toHaveBeenCalled();
});

const CLAUDE = {
  version: 1,
  kind: "acp",
  profile: { version: 2, id: "claude-code" },
};

// As the harness publishes it (ai/acp/harness-agent.ts publishControls).
const controls = (
  model: string,
  effort = "high",
  profile: any = CLAUDE.profile,
) => ({
  type: "event",
  event: {
    type: "harness",
    source: "acp",
    kind: "controls",
    data: {
      profile,
      controls: {
        configOptions: [
          {
            id: "model",
            name: "Model",
            currentValue: model,
            options: [
              { value: "opus", name: "Opus 5.5" },
              { value: "sonnet", name: "Sonnet 5.5" },
            ],
          },
          {
            id: "effort",
            name: "Effort",
            currentValue: effort,
            options: [{ value: effort, name: effort }],
          },
        ],
      },
    },
  },
});

test("reports the model a Claude harness says it uses, on each change", async () => {
  const report = jest.fn(async () => {});
  setAgentRuntimeReporterForTests(report);
  reportAgentModelFromEvent(request(CLAUDE), controls("opus") as any);
  reportAgentModelFromEvent(request(CLAUDE), controls("opus") as any);
  await settle();
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenLastCalledWith(
    expect.objectContaining({
      thread_id: "t1",
      runtime: {
        kind: "claude-code",
        model: "opus",
        model_name: "Opus 5.5",
        effort: "high",
      },
    }),
  );
  // Switched to Sonnet and back: both changes are reported.
  reportAgentModelFromEvent(request(CLAUDE), controls("sonnet") as any);
  reportAgentModelFromEvent(request(CLAUDE), controls("opus") as any);
  await settle();
  expect(report).toHaveBeenCalledTimes(3);
  expect(report).toHaveBeenLastCalledWith(
    expect.objectContaining({
      runtime: expect.objectContaining({ model: "opus" }),
    }),
  );
});

test("reports the model and reasoning of Codex's config event", async () => {
  const report = jest.fn(async () => {});
  setAgentRuntimeReporterForTests(report);
  const config = {
    type: "event",
    event: { type: "config", model: "gpt-6-luna", reasoning: "xhigh" },
  } as any;
  reportAgentModelFromEvent(request(), config);
  // A Codex config event in a Claude turn (or controls in a Codex one) is
  // not about that runtime.
  reportAgentModelFromEvent(request(CLAUDE), config);
  reportAgentModelFromEvent(request(), controls("opus") as any);
  await settle();
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({
      runtime: { kind: "codex", model: "gpt-6-luna", effort: "xhigh" },
    }),
  );
});

test("a failed model report is sent again by the next event", async () => {
  const report = jest
    .fn()
    .mockRejectedValueOnce(new Error("hub unreachable"))
    .mockResolvedValue(undefined);
  setAgentRuntimeReporterForTests(report);
  reportAgentModelFromEvent(request(CLAUDE), controls("opus") as any);
  await settle();
  reportAgentModelFromEvent(request(CLAUDE), controls("opus") as any);
  await settle();
  expect(report).toHaveBeenCalledTimes(2);
});

test("controls of another harness profile are not reported", async () => {
  const report = jest.fn(async () => {});
  setAgentRuntimeReporterForTests(report);
  reportAgentModelFromEvent(
    request(CLAUDE),
    controls("opus", "high", { version: 1, id: "pi" }) as any,
  );
  reportAgentModelFromEvent(
    request(CLAUDE),
    controls("opus", "high", null) as any,
  );
  await settle();
  expect(report).not.toHaveBeenCalled();
});
