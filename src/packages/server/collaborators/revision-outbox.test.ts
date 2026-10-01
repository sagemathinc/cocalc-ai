const claim = jest.fn(),
  settle = jest.fn(),
  page = jest.fn(),
  dispatch = jest.fn();
const settings = jest.fn();
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-revision-outbox",
  () => ({
    claimCollaborationRevisionOutbox: (...args) => claim(...args),
    settleCollaborationRevisionOutbox: (...args) => settle(...args),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-revision-interest",
  () => ({
    readCollaborationRevisionFanoutPage: (...args) => page(...args),
  }),
);
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: () => settings(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "owner",
}));
jest.mock("./revision-dispatch", () => ({
  dispatchCollaborationRevisionHint: (...args) => dispatch(...args),
}));
import { dispatchRevisionOutboxPage } from "./revision-outbox";

const job = {
  project_id: "project",
  token: "token",
  claim_id: "claim",
  after_home_bay: "home-a",
};
const hints = Array.from({ length: 20 }, (_, i) => ({
  home_bay_id: `home-${i}`,
}));
beforeEach(() => {
  settings.mockResolvedValue({ collaborators_enabled: true });
  settings.mockResolvedValue({ collaborators_enabled: true });
  claim.mockReset().mockResolvedValue(job);
  settle.mockReset().mockResolvedValue(true);
  page
    .mockReset()
    .mockResolvedValue({ hints: hints.slice(0, 2), next_after: "home-z" });
  dispatch.mockReset().mockResolvedValue({ state: "acknowledged" });
});
afterEach(() => {
  jest.restoreAllMocks();
});
test("advances only after destination acknowledgments", async () => {
  expect(await dispatchRevisionOutboxPage("project")).toEqual({
    state: "advanced",
    attempted: 2,
    acknowledged: 2,
  });
  expect(page).toHaveBeenCalledWith(
    { project_id: "project", after_home_bay_id: "home-a" },
    { owning_bay_id: "owner" },
  );
  expect(settle).toHaveBeenCalledWith(job, "home-z", {
    owning_bay_id: "owner",
  });
  expect(settle.mock.invocationCallOrder[0]).toBeGreaterThan(
    dispatch.mock.invocationCallOrder[1],
  );
});
test.each(["deferred", "unknown"])(
  "retains page on %s outcome",
  async (outcome) => {
    if (outcome === "unknown") dispatch.mockRejectedValueOnce(Error("timeout"));
    else dispatch.mockResolvedValueOnce({ state: "deferred" });
    expect(await dispatchRevisionOutboxPage("project")).toMatchObject({
      state: "retained",
      attempted: 2,
      acknowledged: 1,
    });
    expect(settle).not.toHaveBeenCalled();
  },
);
test("bounds attempts and start deadline without dropping continuation", async () => {
  page.mockResolvedValue({ hints, next_after: "home-z" });
  expect(await dispatchRevisionOutboxPage("project")).toMatchObject({
    state: "retained",
    attempted: 8,
  });
  expect(settle).not.toHaveBeenCalled();
  let now = 0;
  jest.spyOn(performance, "now").mockImplementation(() => now);
  dispatch.mockImplementation(async () => {
    now = 5000;
    return { state: "acknowledged" };
  });
  expect(await dispatchRevisionOutboxPage("project")).toMatchObject({
    state: "retained",
    attempted: 1,
  });
});
test("empty final page can settle but newer tokens are respected", async () => {
  page.mockResolvedValue({ hints: [], next_after: null });
  settle.mockResolvedValue(false);
  expect(await dispatchRevisionOutboxPage("project")).toEqual({
    state: "superseded",
    attempted: 0,
    acknowledged: 0,
  });
  expect(settle).toHaveBeenCalledWith(job, null, { owning_bay_id: "owner" });
});
test("disabled and already claimed work performs no delivery", async () => {
  settings.mockResolvedValue({ collaborators_enabled: false });
  expect((await dispatchRevisionOutboxPage("project")).state).toBe("disabled");
  expect(claim).not.toHaveBeenCalled();
  settings.mockResolvedValue({ collaborators_enabled: true });
  claim.mockResolvedValue(null);
  expect((await dispatchRevisionOutboxPage("project")).state).toBe("idle");
  expect(page).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});
test("disabled site prevents claiming durable work", async () => {
  settings.mockResolvedValue({ collaborators_enabled: false });
  expect((await dispatchRevisionOutboxPage("project")).state).toBe("disabled");
  expect(claim).not.toHaveBeenCalled();
});
