const settings = jest.fn();
const receivers = jest.fn(),
  state = jest.fn(),
  advance = jest.fn(),
  demand = jest.fn(),
  schedule = jest.fn();
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-revision-receiver",
  () => ({
    readCollaborationRevisionReceiverPage: (...a) => receivers(...a),
    readRevisionSchedulingState: (...a) => state(...a),
    advanceRevisionScheduling: (...a) => advance(...a),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-demand",
  () => ({
    readCollaborationProjectDemandPage: (...a) => demand(...a),
    scheduleCollaborationRevisionDemand: (...a) => schedule(...a),
  }),
);
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: () => settings(),
}));
jest.mock("./indexing-metrics", () => ({ indexingWork: { inc: jest.fn() } }));
import { runRevisionWakeupScheduling } from "./revision-wakeup";
const snapshot = {
  project_id: "p",
  after: null,
  complete: false,
  dirty_seq: "1",
};
beforeEach(() => {
  jest.clearAllMocks();
  settings.mockResolvedValue({ collaborators_enabled: true });
  receivers.mockResolvedValue({
    pending: [{ project_id: "p" }],
    next_after: null,
  });
  state.mockResolvedValue(snapshot);
  demand.mockResolvedValue({ account_ids: ["a", "b"], next_after: null });
  schedule.mockResolvedValue("scheduled");
  advance.mockResolvedValue(true);
});
test("advances only after scheduling the entire page", async () => {
  expect(await runRevisionWakeupScheduling()).toBe(2);
  expect(schedule.mock.calls).toEqual([
    ["a", "p"],
    ["b", "p"],
  ]);
  expect(advance).toHaveBeenCalledWith(snapshot, null);
  expect(advance.mock.invocationCallOrder[0]).toBeGreaterThan(
    schedule.mock.invocationCallOrder[1],
  );
});
test("busy or failed accounts retain the page while other accounts can schedule", async () => {
  schedule.mockResolvedValueOnce("busy");
  expect(await runRevisionWakeupScheduling()).toBe(1);
  expect(advance).not.toHaveBeenCalled();
  schedule.mockRejectedValueOnce(Error("rehoming"));
  expect(await runRevisionWakeupScheduling()).toBe(1);
  expect(advance).not.toHaveBeenCalled();
});
test("empty eligible page advances its continuation, not projection completion", async () => {
  const next = { account_id: "x", grace_until: "time" };
  demand.mockResolvedValue({ account_ids: [], next_after: next });
  expect(await runRevisionWakeupScheduling()).toBe(0);
  expect(advance).toHaveBeenCalledWith(snapshot, next);
  expect(schedule).not.toHaveBeenCalled();
});
test("completed and disabled scheduling do not touch demand", async () => {
  state.mockResolvedValue({ ...snapshot, complete: true });
  await runRevisionWakeupScheduling();
  expect(demand).not.toHaveBeenCalled();
  settings.mockResolvedValue({ collaborators_enabled: false });
  receivers.mockClear();
  await runRevisionWakeupScheduling();
  expect(receivers).not.toHaveBeenCalled();
});
