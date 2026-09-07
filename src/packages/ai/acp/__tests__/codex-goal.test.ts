import { CodexGoalSync } from "../codex-goal";
import type {
  CodexGoalCommand,
  CodexGoalEvent,
} from "@cocalc/util/ai/codex-goal";

const goal = {
  objective: "Implement goals",
  status: "active",
  tokenBudget: null,
  tokensUsed: 123,
  timeUsedSeconds: 10,
  updatedAt: 1,
};

function setup(command?: CodexGoalCommand) {
  const events: CodexGoalEvent[] = [];
  const readPending = jest.fn(() => command);
  const request = jest.fn(async (method: string) =>
    method === "thread/goal/clear" ? { cleared: true } : { goal },
  );
  const emit = jest.fn(async (event: CodexGoalEvent) => {
    events.push(event);
  });
  const sync = new CodexGoalSync({
    sessionId: "session",
    request,
    readPending,
    emit,
  });
  return { sync, request, readPending, emit, events };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it("reads snapshots without mutating an existing goal or polling the server", async () => {
  const { sync, request, events } = setup();
  await sync.start();
  await jest.advanceTimersByTimeAsync(5000);
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "thread/goal/get",
  ]);
  await sync.finish();
  expect(events.map((e) => e.phase)).toEqual(["start", "end"]);
  expect(events[0].snapshot?.goal).toEqual(goal);
  await jest.advanceTimersByTimeAsync(5000);
  expect(request).toHaveBeenCalledTimes(2);
});

it("persists the applying marker before applying an explicit revision only once", async () => {
  const { sync, request, emit, events } = setup({
    id: "edit",
    action: "set",
    objective: "New goal",
  });
  await sync.start();
  await jest.advanceTimersByTimeAsync(3000);
  expect(
    request.mock.calls.filter(([method]) => method === "thread/goal/set"),
  ).toHaveLength(1);
  expect(emit.mock.invocationCallOrder[0]).toBeLessThan(
    request.mock.invocationCallOrder[0],
  );
  expect(events.slice(0, 2).map((e) => e.ack)).toEqual([
    { id: "edit", state: "applying" },
    { id: "edit", state: "applied" },
  ]);
  await sync.finish();
});

it("never mutates the runtime if the durable applying marker fails", async () => {
  const { sync, request, emit } = setup({ id: "edit", action: "clear" });
  emit.mockRejectedValueOnce(Error("disk unavailable"));
  await sync.start();
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "thread/goal/get",
  ]);
  expect(emit).toHaveBeenCalledWith(
    expect.objectContaining({
      ack: expect.objectContaining({ state: "failed" }),
    }),
  );
  await sync.finish();
});

it("rejects edits bound to another session", async () => {
  const { sync, request, events } = setup({
    id: "edit",
    action: "clear",
    sessionId: "old-session",
  });
  await sync.start();
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "thread/goal/get",
  ]);
  expect(events[0].ack?.error).toContain("session changed");
  await sync.finish();
});

it("refreshes on this session's notifications only", async () => {
  const { sync, request } = setup();
  await sync.start();
  sync.changed("another-session");
  await jest.advanceTimersByTimeAsync(1000);
  expect(request).toHaveBeenCalledTimes(1);
  sync.changed("session");
  sync.changed("session");
  await jest.advanceTimersByTimeAsync(1000);
  expect(request).toHaveBeenCalledTimes(2);
  await sync.finish();
});

it("keeps unsupported/failed reads unknown rather than fabricating an empty goal", async () => {
  const { sync, request, events } = setup();
  request.mockRejectedValue(Error("unknown method"));
  await sync.start();
  await jest.advanceTimersByTimeAsync(5000);
  await sync.finish();
  expect(events).toEqual([]);
  expect(request).toHaveBeenCalledTimes(1);
});

it("does not apply a newly queued command during finalization", async () => {
  const { sync, request, readPending } = setup();
  await sync.start();
  readPending.mockReturnValue({ id: "late", action: "set", status: "active" });
  await sync.finish();
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "thread/goal/get",
    "thread/goal/get",
  ]);
});

it("distinguishes an explicitly cleared goal from an unavailable snapshot", async () => {
  const { sync, request, events } = setup();
  request.mockResolvedValue({ goal: null } as any);
  await sync.start();
  expect(events[0].snapshot?.goal).toBeNull();
  await sync.finish();
});

it("pauses active goals on Stop, without clearing the objective or budget", async () => {
  const { sync, request, readPending } = setup();
  await sync.start();
  await sync.pauseForStop();
  expect(request.mock.calls).toContainEqual([
    "thread/goal/set",
    { threadId: "session", status: "paused" },
    5000,
  ]);
  readPending.mockReturnValue({ id: "late", action: "set", status: "active" });
  await jest.advanceTimersByTimeAsync(2000);
  await sync.finish();
  expect(
    request.mock.calls.filter(([method]) => method === "thread/goal/set"),
  ).toHaveLength(1);
});

it("does not overwrite completed goals when stopping", async () => {
  const { sync, request } = setup();
  request.mockResolvedValue({ goal: { ...goal, status: "complete" } });
  await sync.start();
  await sync.pauseForStop();
  await sync.finish();
  expect(
    request.mock.calls.every(([method]) => method === "thread/goal/get"),
  ).toBe(true);
});

it("cancels an unapplied edit on Stop so the next turn cannot replay it", async () => {
  const { sync, readPending, events } = setup();
  await sync.start();
  readPending.mockReturnValue({
    id: "queued-resume",
    action: "set",
    status: "active",
  });
  await sync.pauseForStop();
  expect(events).toContainEqual({
    type: "goal",
    phase: "command",
    ack: { id: "queued-resume", state: "cancelled" },
  });
  await sync.finish();
});

it("still pauses the runtime if saving a cancellation fails", async () => {
  const { sync, request, readPending, emit } = setup();
  await sync.start();
  readPending.mockReturnValue({
    id: "queued-resume",
    action: "set",
    status: "active",
  });
  emit.mockRejectedValueOnce(Error("chat storage unavailable"));
  await expect(sync.pauseForStop()).rejects.toThrow("chat storage unavailable");
  expect(request.mock.calls).toContainEqual([
    "thread/goal/set",
    { threadId: "session", status: "paused" },
    5000,
  ]);
  await sync.finish();
});
