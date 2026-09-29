const prune = jest.fn();
const pruneDemand = jest.fn();
const enabled = jest.fn();
const settings = jest.fn();
const expiryPage = jest.fn();
const pruneInterests = jest.fn();
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-revision-interest",
  () => ({
    readCollaborationRevisionExpiryPage: (...args) => expiryPage(...args),
    pruneCollaborationRevisionInterests: (...args) => pruneInterests(...args),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-revision-receiver",
  () => ({
    pruneCollaborationRevisionReceivers: (...args) => prune(...args),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-demand",
  () => ({
    demandSchedulingEnabled: () => enabled(),
    pruneCollaborationProjectDemand: () => pruneDemand(),
  }),
);
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: () => settings(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
}));
jest.mock("./indexing-metrics", () => ({ indexingWork: { inc: jest.fn() } }));
import {
  runRevisionReceiverCleanup,
  runRevisionInterestCleanup,
} from "./revision-maintenance";

const previous = process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE;
let now = 100000;
beforeEach(() => {
  now += 100000;
  jest.spyOn(performance, "now").mockImplementation(() => now);
  prune.mockReset().mockResolvedValue(100);
  pruneDemand.mockReset().mockResolvedValue(100);
  expiryPage.mockReset().mockResolvedValue({ complete: true, candidates: [] });
  pruneInterests.mockReset().mockResolvedValue(1);
  enabled.mockReturnValue(true);
  settings.mockResolvedValue({ collaborators_enabled: true });
  process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE = "1";
});
test("owner cleanup coalesces projects, advances past foreign owners, and backs off", async () => {
  const candidate = (
    project_id: string,
    home_bay_id: string,
    local_owner = true,
  ) => ({
    cursor: {
      project_id,
      home_bay_id,
      expires_at: "2026-01-01 00:00:00.000001+00",
    },
    local_owner,
  });
  const last = candidate("foreign", "c", false);
  expiryPage.mockResolvedValueOnce({
    complete: false,
    candidates: [candidate("p", "a"), candidate("p", "b"), last],
  });
  expect(await runRevisionInterestCleanup()).toBe(1);
  expect(pruneInterests.mock.calls).toEqual([["p", { owning_bay_id: "home" }]]);
  expect(await runRevisionInterestCleanup()).toBe(0);
  expect(expiryPage).toHaveBeenCalledTimes(1);
  now += 30000;
  await runRevisionInterestCleanup();
  expect(expiryPage).toHaveBeenLastCalledWith("home", last.cursor);
  now += 30000;
  await runRevisionInterestCleanup();
  expect(expiryPage).toHaveBeenLastCalledWith("home", undefined);
});
test("owner cleanup isolates fenced candidates and honors the pass deadline", async () => {
  const a = {
    cursor: { project_id: "a", home_bay_id: "x", expires_at: "2026-01-01" },
    local_owner: true,
  };
  const b = { ...a, cursor: { ...a.cursor, project_id: "b" } };
  expiryPage.mockResolvedValueOnce({ complete: true, candidates: [a, b] });
  pruneInterests.mockImplementationOnce(async () => {
    now += 5000;
    throw Error("rehoming");
  });
  expect(await runRevisionInterestCleanup()).toBe(0);
  expect(pruneInterests).toHaveBeenCalledTimes(1);
  now += 30000;
  await runRevisionInterestCleanup();
  expect(expiryPage).toHaveBeenLastCalledWith("home", a.cursor);
});
afterEach(() => {
  jest.restoreAllMocks();
  if (previous === undefined)
    delete process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE;
  else process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE = previous;
});
test("cleans only the local home and limits repeated passes", async () => {
  expect(await runRevisionReceiverCleanup()).toBe(100);
  expect(prune).toHaveBeenCalledWith("home");
  expect(await runRevisionReceiverCleanup()).toBe(0);
  expect(prune).toHaveBeenCalledTimes(1);
  expect(pruneDemand).toHaveBeenCalledTimes(1);
  now += 30000;
  expect(await runRevisionReceiverCleanup()).toBe(100);
  expect(prune).toHaveBeenCalledTimes(2);
});
test("all gates prevent cleanup", async () => {
  enabled.mockReturnValue(false);
  await runRevisionReceiverCleanup();
  await runRevisionInterestCleanup();
  enabled.mockReturnValue(true);
  delete process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE;
  await runRevisionReceiverCleanup();
  await runRevisionInterestCleanup();
  process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE = "1";
  settings.mockResolvedValue({ collaborators_enabled: false });
  await runRevisionReceiverCleanup();
  await runRevisionInterestCleanup();
  expect(prune).not.toHaveBeenCalled();
  expect(pruneDemand).not.toHaveBeenCalled();
  expect(expiryPage).not.toHaveBeenCalled();
});
test("failed cleanup is isolated and backs off", async () => {
  prune.mockRejectedValue(Error("database unavailable"));
  expect(await runRevisionReceiverCleanup()).toBe(0);
  expect(await runRevisionReceiverCleanup()).toBe(0);
  expect(prune).toHaveBeenCalledTimes(1);
  now += 30000;
  await runRevisionReceiverCleanup();
  expect(prune).toHaveBeenCalledTimes(2);
});
test("reverse-demand failure preserves receiver cleanup and backs off", async () => {
  pruneDemand.mockRejectedValue(Error("database unavailable"));
  expect(await runRevisionReceiverCleanup()).toBe(100);
  expect(await runRevisionReceiverCleanup()).toBe(0);
  expect(pruneDemand).toHaveBeenCalledTimes(1);
});
test("overlapping calls do not start another cleanup", async () => {
  let finish!: (n: number) => void;
  prune.mockImplementation(
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  );
  const first = runRevisionReceiverCleanup();
  await Promise.resolve();
  now += 30000;
  expect(await runRevisionReceiverCleanup()).toBe(0);
  finish(1);
  expect(await first).toBe(1);
  expect(prune).toHaveBeenCalledTimes(1);
});
