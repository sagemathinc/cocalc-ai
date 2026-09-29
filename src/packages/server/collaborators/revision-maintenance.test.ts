const prune = jest.fn();
const enabled = jest.fn();
const settings = jest.fn();
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
  }),
);
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: () => settings(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
}));
jest.mock("./indexing-metrics", () => ({ indexingWork: { inc: jest.fn() } }));
import { runRevisionReceiverCleanup } from "./revision-maintenance";

const previous = process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE;
let now = 100000;
beforeEach(() => {
  now += 100000;
  jest.spyOn(performance, "now").mockImplementation(() => now);
  prune.mockReset().mockResolvedValue(100);
  enabled.mockReturnValue(true);
  settings.mockResolvedValue({ collaborators_enabled: true });
  process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE = "1";
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
  now += 30000;
  expect(await runRevisionReceiverCleanup()).toBe(100);
  expect(prune).toHaveBeenCalledTimes(2);
});
test("all gates prevent cleanup", async () => {
  enabled.mockReturnValue(false);
  await runRevisionReceiverCleanup();
  enabled.mockReturnValue(true);
  delete process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE;
  await runRevisionReceiverCleanup();
  process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE = "1";
  settings.mockResolvedValue({ collaborators_enabled: false });
  await runRevisionReceiverCleanup();
  expect(prune).not.toHaveBeenCalled();
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
