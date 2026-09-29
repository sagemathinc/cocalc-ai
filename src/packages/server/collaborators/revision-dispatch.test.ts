import { dispatchCollaborationRevisionHint } from "./revision-dispatch";
const claim = jest.fn(),
  settle = jest.fn(),
  receive = jest.fn();
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-revision-interest",
  () => ({
    claimCollaborationRevisionHint: (...a) => claim(...a),
    settleCollaborationRevisionHint: (...a) => settle(...a),
  }),
);
jest.mock("@cocalc/conat/inter-bay/collaborators", () => ({
  createInterBayCollaboratorsClient: () => ({
    receiveRevisionWakeup: (...a) => receive(...a),
  }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "owner",
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ collaborators_enabled: true }),
}));
const request = {
  project_id: "project",
  home_bay_id: "home",
  lease_id: "lease",
};
const token = {
  ...request,
  claim_id: "claim",
  generation: "generation",
  revision: 7,
  claim_until: 100,
};
const flags = [
  "COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE",
  "COCALC_PEOPLE_DEMAND_PROTOTYPE",
];
let prior: (string | undefined)[];
beforeEach(() => {
  prior = flags.map((n) => process.env[n]);
  flags.forEach((n) => (process.env[n] = "1"));
  jest.clearAllMocks();
  claim.mockResolvedValue(token);
  settle.mockResolvedValue(true);
  receive.mockResolvedValue({ accepted: true });
});
afterEach(() =>
  flags.forEach((n, i) => {
    if (prior[i] === undefined) delete process.env[n];
    else process.env[n] = prior[i];
  }),
);
test("settles only after receiver confirms durable acceptance", async () => {
  expect(await dispatchCollaborationRevisionHint(request)).toEqual({
    state: "acknowledged",
  });
  expect(receive).toHaveBeenCalledWith({
    project_id: "project",
    owner_bay_id: "owner",
    lease_id: "lease",
    route: { bay_id: "home" },
  });
  expect(settle).toHaveBeenCalledWith(token, { owning_bay_id: "owner" });
  expect(receive.mock.invocationCallOrder[0]).toBeLessThan(
    settle.mock.invocationCallOrder[0],
  );
});
test("unknown transport and unarmed receiver never settle", async () => {
  receive.mockRejectedValueOnce(Error("timeout"));
  await expect(dispatchCollaborationRevisionHint(request)).rejects.toThrow(
    "timeout",
  );
  expect(settle).not.toHaveBeenCalled();
  receive.mockResolvedValueOnce({ accepted: false });
  expect(await dispatchCollaborationRevisionHint(request)).toEqual({
    state: "deferred",
  });
  expect(settle).not.toHaveBeenCalled();
});
test("unclaimed work, stale settlement and disabled prototype do not acknowledge", async () => {
  claim.mockResolvedValueOnce(null);
  expect(await dispatchCollaborationRevisionHint(request)).toEqual({
    state: "deferred",
  });
  expect(receive).not.toHaveBeenCalled();
  settle.mockResolvedValueOnce(false);
  expect(await dispatchCollaborationRevisionHint(request)).toEqual({
    state: "deferred",
  });
  delete process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE;
  await expect(dispatchCollaborationRevisionHint(request)).rejects.toThrow(
    "disabled",
  );
  expect(claim).toHaveBeenCalledTimes(2);
});
