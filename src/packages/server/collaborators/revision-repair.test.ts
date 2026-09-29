const page = jest.fn(),
  dispatch = jest.fn(),
  enabled = jest.fn();
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-revision-interest",
  () => ({ readCollaborationRevisionDispatchPage: (...a) => page(...a) }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-demand",
  () => ({ demandSchedulingEnabled: () => enabled() }),
);
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ collaborators_enabled: true }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "owner",
}));
jest.mock("./revision-dispatch", () => ({
  dispatchCollaborationRevisionHint: (...a) => dispatch(...a),
}));
jest.mock("./indexing-metrics", () => ({ indexingWork: { inc: jest.fn() } }));
import { runRevisionHintRepair } from "./revision-repair";
const previous = process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE;
const row = (n: number, pending = true) => ({
  project_id: `p${n}`,
  home_bay_id: "home",
  lease_id: "lease",
  pending,
});
beforeEach(() => {
  page.mockReset().mockResolvedValue({ complete: true, candidates: [] });
  dispatch.mockReset().mockResolvedValue({ state: "acknowledged" });
  enabled.mockReturnValue(true);
  process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE = "1";
});
afterEach(() => {
  if (previous === undefined)
    delete process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE;
  else process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE = previous;
});
test("caps delivery attempts and resumes after last examined candidate", async () => {
  page.mockResolvedValueOnce({
    complete: false,
    candidates: Array.from({ length: 20 }, (_, n) => row(n)),
  });
  expect(await runRevisionHintRepair()).toBe(8);
  expect(dispatch).toHaveBeenCalledTimes(8);
  await runRevisionHintRepair();
  expect(page).toHaveBeenLastCalledWith("owner", {
    project_id: "p7",
    home_bay_id: "home",
  });
  await runRevisionHintRepair();
  expect(page).toHaveBeenLastCalledWith("owner", undefined);
});
test("skips inactive candidates and isolates unknown delivery outcomes", async () => {
  page.mockResolvedValueOnce({
    complete: true,
    candidates: [row(0, false), row(1), row(2)],
  });
  dispatch.mockRejectedValueOnce(Error("timeout"));
  expect(await runRevisionHintRepair()).toBe(2);
  expect(dispatch.mock.calls.map(([r]) => r.project_id)).toEqual(["p1", "p2"]);
});
test("disabled repair does not traverse interests", async () => {
  enabled.mockReturnValue(false);
  expect(await runRevisionHintRepair()).toBe(0);
  enabled.mockReturnValue(true);
  delete process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE;
  expect(await runRevisionHintRepair()).toBe(0);
  expect(page).not.toHaveBeenCalled();
});
