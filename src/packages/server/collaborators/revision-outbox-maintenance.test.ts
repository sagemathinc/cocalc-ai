const read = jest.fn(),
  dispatch = jest.fn(),
  settings = jest.fn();
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-revision-outbox",
  () => ({ readCollaborationRevisionOutboxPage: (...args) => read(...args) }),
);
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: () => settings(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "owner",
}));
jest.mock("./revision-outbox", () => ({
  dispatchRevisionOutboxPage: (...args) => dispatch(...args),
}));
jest.mock("./indexing-metrics", () => ({ indexingWork: { inc: jest.fn() } }));
import { runRevisionOutboxMaintenance } from "./revision-outbox-maintenance";
const candidate = (project_id: string, eligible = true) => ({
  cursor: { project_id, due_at: "2026-01-01 00:00:00.000001+00" },
  eligible,
});
beforeEach(() => {
  settings.mockResolvedValue({ collaborators_enabled: true });
  settings.mockResolvedValue({ collaborators_enabled: true });
  read.mockReset().mockResolvedValue({ candidates: [], complete: true });
  dispatch.mockReset().mockResolvedValue({ state: "advanced" });
});
afterEach(async () => {
  jest.restoreAllMocks();
  // Empty exhaustion resets the disposable cursor between cases.
  settings.mockResolvedValue({ collaborators_enabled: true });
  settings.mockResolvedValue({ collaborators_enabled: true });
  read.mockResolvedValue({ candidates: [], complete: true });
  await runRevisionOutboxMaintenance();
});
test("advances past foreign and failed projects, one dispatch per pass", async () => {
  const a = candidate("a"),
    b = candidate("b");
  read.mockResolvedValueOnce({
    candidates: [candidate("foreign", false), a, b],
    complete: true,
  });
  dispatch.mockRejectedValueOnce(Error("owner unavailable"));
  expect(await runRevisionOutboxMaintenance()).toBe(1);
  expect(dispatch.mock.calls).toEqual([["a"]]);
  read.mockResolvedValueOnce({ candidates: [b], complete: true });
  expect(await runRevisionOutboxMaintenance()).toBe(1);
  expect(read).toHaveBeenLastCalledWith("owner", a.cursor);
  await runRevisionOutboxMaintenance();
  expect(read).toHaveBeenLastCalledWith("owner", undefined);
});
test("empty filtered pages advance and deadline starts no new dispatch", async () => {
  const foreign = candidate("foreign", false);
  read.mockResolvedValueOnce({ candidates: [foreign], complete: false });
  expect(await runRevisionOutboxMaintenance()).toBe(0);
  let now = 0;
  jest.spyOn(performance, "now").mockImplementation(() => now);
  read.mockImplementationOnce(async () => {
    now = 5000;
    return { candidates: [candidate("later")], complete: true };
  });
  expect(await runRevisionOutboxMaintenance()).toBe(0);
  expect(read).toHaveBeenLastCalledWith("owner", foreign.cursor);
  expect(dispatch).not.toHaveBeenCalled();
});
test("site disablement prevents candidate reads", async () => {
  settings.mockResolvedValue({ collaborators_enabled: false });
  await runRevisionOutboxMaintenance();
  settings.mockResolvedValue({ collaborators_enabled: false });
  await runRevisionOutboxMaintenance();
  expect(read).not.toHaveBeenCalled();
});
test("overlapping passes do not duplicate dispatch", async () => {
  read.mockResolvedValueOnce({ candidates: [candidate("a")], complete: true });
  let finish!: (value: unknown) => void;
  const entered = new Promise<void>((resolve) =>
    dispatch.mockImplementationOnce(() => {
      resolve();
      return new Promise((r) => (finish = r));
    }),
  );
  const first = runRevisionOutboxMaintenance();
  await entered;
  expect(await runRevisionOutboxMaintenance()).toBe(0);
  finish({ state: "advanced" });
  expect(await first).toBe(1);
  expect(dispatch).toHaveBeenCalledTimes(1);
});
