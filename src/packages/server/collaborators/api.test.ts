import { randomUUID } from "node:crypto";
import {
  collaboratorsApi,
  collaboratorsControl,
  fetchCollaborationAccessBatches,
} from "./api";
import {
  runCollaboratorsMaintenance,
  runCollaboratorsAccessMaintenance,
} from "./maintenance";

const owner = jest.fn();
const owners = jest.fn();
const register = jest.fn();
const access = jest.fn();
const claimAccess = jest.fn();
const overlay = jest.fn();
const checkpoint = jest.fn();
const adoption = jest.fn();
const home = jest.fn();
const dbQuery = jest.fn();
const settings = jest.fn();
const ingest = jest.fn();
const room = jest.fn();
const writerState = jest.fn();
const list = jest.fn();
const seed = jest.fn();
const ownedResource = jest.fn();
const personal = jest.fn();
const updatePersonal = jest.fn();
const projects = jest.fn();
const readPins = jest.fn();
const pinsRevision = jest.fn();
const setPin = jest.fn();
const pinFence = jest.fn();
jest.mock("@cocalc/backend/conat", () => ({ conat: () => "local-client" }));
jest.mock("@cocalc/backend/collaborators/project-pins", () => ({
  accountProjectPins: () => ({
    read: readPins,
    set: setPin,
    revision: pinsRevision,
  }),
}));
jest.mock("@cocalc/database/postgres/account-rehome-fence", () => ({
  withAccountRehomeWriteFence: (...args) => pinFence(...args),
}));
const remote = {
  listResources: jest.fn(),
  listPeople: jest.fn(),
  listProjects: jest.fn(),
  setProjectPinned: jest.fn(),
  getResource: jest.fn(),
  ownedResource: jest.fn(),
  roomForHost: jest.fn(),
  ingest: jest.fn(),
  registerSource: jest.fn(),
  writerState: jest.fn(),
  sourcePage: jest.fn(),
  refreshAccess: jest.fn(),
  ownedProjectResources: jest.fn(),
};
let bay = "home";
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => bay,
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...a) => home(...a),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...a) => owner(...a),
  resolveProjectBays: (...a) => owners(...a),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "trusted",
}));
jest.mock("@cocalc/conat/inter-bay/collaborators", () => ({
  createInterBayCollaboratorsClient: () => remote,
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...a) => settings(...a),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...a) => dbQuery(...a) }),
}));
jest.mock("@cocalc/database/postgres/collaborators-owner", () => ({
  ingestCollaborationSnapshot: (...a) => ingest(...a),
  collaborationRoomForHost: (...a) => room(...a),
  collaborationWriterState: (...a) => writerState(...a),
  getOwnedCollaborationResource: (...a) => ownedResource(...a),
  registerCollaborationSource: (...a) => register(...a),
}));
jest.mock("@cocalc/database/postgres/collaborators-access", () => ({
  readCollaborationAccess: (...a) => access(...a),
  claimCollaborationAccess: (...a) => claimAccess(...a),
}));
jest.mock("@cocalc/database/postgres/collaborators-project-page", () => ({
  overlayCollaborationProjectPage: (...a) => overlay(...a),
}));
jest.mock("@cocalc/database/postgres/collaborators-discovery", () => ({
  listCollaborationResources: (...a) => list(...a),
  listCollaborationProjects: (...a) => projects(...a),
}));
jest.mock("@cocalc/database/postgres/collaborators-projection", () => ({
  seedCollaborationProjectionJobs: (...a) => seed(...a),
}));
jest.mock("./personal", () => ({
  collaborationPersonalState: (...a) => personal(...a),
  updateCollaborationPersonalState: (...a) => updatePersonal(...a),
}));
jest.mock("@cocalc/database/postgres/collaborators-checkpoint", () => ({
  collaborationCheckpointPage: (...a) => checkpoint(...a),
}));
jest.mock("@cocalc/database/postgres/collaborators-adoption", () => ({
  requestCollaborationSource: (...a) => adoption(...a),
}));

const account_id = randomUUID();
const project_id = randomUUID();
const host_id = randomUUID();
const route = { bay_id: "owner", epoch: 4 };
const target = {
  project_id,
  kind: "conversation" as const,
  resource_id: "thread",
};
const snapshot = {
  project_id,
  chat_path: "/home/user/work.chat",
  epoch: randomUUID(),
  sequence: 1,
  resources: [],
};
beforeEach(() => {
  jest.clearAllMocks();
  bay = "home";
  owner.mockResolvedValue(route);
  home.mockResolvedValue({ home_bay_id: "home" });
  settings.mockResolvedValue({ collaborators_enabled: true });
  dbQuery.mockResolvedValue({ rows: [{ deleted: false, banned: false }] });
  list.mockResolvedValue({ items: [], coverage: "partial" });
  readPins.mockResolvedValue([project_id]);
  pinsRevision.mockResolvedValue("0");
  projects.mockResolvedValue({ items: [{ project_id }], coverage: "partial" });
  pinFence.mockImplementation(({ fn }) => fn({ query: dbQuery }));
  room.mockResolvedValue({
    project_id,
    room_id: randomUUID(),
    chat_path: "/home/user/.cocalc/collaborators.chat",
  });
  ingest.mockResolvedValue({ revision: 1, replayed: false });
});

test("project pin API routes only to the account home and forwards bounded filters", async () => {
  home.mockResolvedValue({ home_bay_id: "elsewhere" });
  await collaboratorsApi.listProjects({
    account_id,
    view: "pinned",
    person_id: account_id,
    search: "Geometry",
    limit: 5,
  });
  expect(remote.listProjects).toHaveBeenCalledWith({
    account_id,
    view: "pinned",
    person_id: account_id,
    search: "Geometry",
    limit: 5,
    route: { bay_id: "elsewhere" },
  });
  await collaboratorsApi.setProjectPinned({
    account_id,
    project_id,
    pinned: true,
  });
  expect(remote.setProjectPinned).toHaveBeenCalledWith({
    account_id,
    project_id,
    pinned: true,
    route: { bay_id: "elsewhere" },
  });
  expect(readPins).not.toHaveBeenCalled();
  expect(setPin).not.toHaveBeenCalled();
  expect(owner).not.toHaveBeenCalled();
});

test("local project list captures revision before favorites/page reads and supplies server-side pins", async () => {
  await collaboratorsControl.listProjects({
    account_id,
    view: "pinned",
    route: { bay_id: "home" },
  });
  const revisionCall = dbQuery.mock.calls.findIndex(([sql]) =>
    sql.includes("AS revision"),
  );
  expect(revisionCall).toBeGreaterThanOrEqual(0);
  expect(dbQuery.mock.invocationCallOrder[revisionCall]).toBeLessThan(
    readPins.mock.invocationCallOrder[0],
  );
  expect(projects).toHaveBeenCalledWith(
    expect.objectContaining({ account_id, view: "pinned" }),
    [project_id],
  );
});

test("project pin mutation is rehome-fenced, visibility-checked, and bumps account revision", async () => {
  const opts = {
    account_id,
    project_id,
    pinned: true,
    route: { bay_id: "home" },
  };
  await expect(collaboratorsControl.setProjectPinned(opts)).resolves.toEqual({
    pinned: true,
  });
  expect(pinFence).toHaveBeenCalledWith(
    expect.objectContaining({ account_id }),
  );
  expect(projects).toHaveBeenCalledWith({ account_id, project_id, limit: 1 });
  expect(setPin).toHaveBeenCalledWith(project_id, true);
  expect(
    dbQuery.mock.calls.some(([sql]) =>
      sql.includes("INSERT INTO collaboration_account_state"),
    ),
  ).toBe(true);
  setPin.mockClear();
  projects.mockResolvedValue({ items: [] });
  await expect(collaboratorsControl.setProjectPinned(opts)).rejects.toThrow(
    "not accessible",
  );
  expect(setPin).not.toHaveBeenCalled();
  pinFence.mockRejectedValueOnce(Error("rehome frozen"));
  await expect(collaboratorsControl.setProjectPinned(opts)).rejects.toThrow(
    "rehome frozen",
  );
  expect(setPin).not.toHaveBeenCalled();
});

test("project pins fail closed for disabled, stale-home and malformed requests", async () => {
  const opts = {
    account_id,
    project_id,
    pinned: true,
    route: { bay_id: "home" },
  };
  settings.mockResolvedValueOnce({ collaborators_enabled: false });
  await expect(collaboratorsApi.setProjectPinned(opts)).rejects.toThrow(
    "not enabled",
  );
  await expect(
    collaboratorsControl.setProjectPinned({
      ...opts,
      route: { bay_id: "old-home" },
    }),
  ).rejects.toThrow("stale");
  await expect(
    collaboratorsControl.setProjectPinned({ ...opts, pinned: 1 as any }),
  ).rejects.toThrow("invalid");
  expect(setPin).not.toHaveBeenCalled();
  expect(pinFence).not.toHaveBeenCalled();
});
test("feature flag fails closed for human methods and host room use, but host journals may ingest", async () => {
  settings.mockResolvedValue({ collaborators_enabled: false });
  await expect(collaboratorsApi.listResources({ account_id })).rejects.toThrow(
    "not enabled",
  );
  await expect(
    collaboratorsApi.getResource({ account_id, ...target }),
  ).rejects.toThrow("not enabled");
  await expect(
    collaboratorsApi.ensureRoom({
      account_id,
      project_id,
      request_id: randomUUID(),
    }),
  ).rejects.toThrow("not enabled");
  await expect(
    collaboratorsApi.roomForHost({
      host_id,
      project_id,
      requesting_account_id: account_id,
    }),
  ).rejects.toThrow("not enabled");
  expect(owner).not.toHaveBeenCalled();
  expect(home).not.toHaveBeenCalled();
  bay = "owner";
  await expect(collaboratorsApi.ingest({ host_id, snapshot })).resolves.toEqual(
    { revision: 1, replayed: false },
  );
  expect(ingest).toHaveBeenCalledWith(snapshot, {
    owning_bay_id: "owner",
    host_id,
  });
});
test("disabled rollout does not enumerate or backfill account projections", async () => {
  settings.mockResolvedValue({ collaborators_enabled: false });
  await runCollaboratorsMaintenance();
  await runCollaboratorsAccessMaintenance();
  expect(seed).not.toHaveBeenCalled();
  expect(claimAccess).not.toHaveBeenCalled();
});
test("disabled source registration supplies the atomic no-new-sources fence", async () => {
  settings.mockResolvedValue({ collaborators_enabled: false });
  bay = "owner";
  register.mockRejectedValue(Error("not enabled"));
  const registration_id = randomUUID();
  await expect(
    collaboratorsApi.registerSource({
      ...snapshot,
      host_id,
      expected_epoch: null,
      registration_id,
    }),
  ).rejects.toThrow("not enabled");
  expect(register).toHaveBeenCalledWith(
    expect.objectContaining({ project_id }),
    { owning_bay_id: "owner", host_id },
    null,
    registration_id,
    false,
  );
});
test("lease refresh coalesces 50 projects to one owner RPC and validates route epochs in bulk", async () => {
  const jobs = Array.from({ length: 50 }, () => ({
    account_id,
    project_id: randomUUID(),
    grant_request_id: randomUUID(),
  }));
  owners.mockResolvedValue(new Map(jobs.map((j) => [j.project_id, route])));
  const batches = await fetchCollaborationAccessBatches(jobs);
  expect(owners).toHaveBeenCalledTimes(1);
  expect(owner).not.toHaveBeenCalled();
  expect(batches).toHaveLength(1);
  await batches[0].fetch();
  expect(remote.refreshAccess).toHaveBeenCalledWith({
    route: { bay_id: "owner" },
    requests: jobs.map((j) => ({
      account_id,
      project_id: j.project_id,
      epoch: 4,
    })),
  });
  bay = "owner";
  const opts = remote.refreshAccess.mock.calls[0][0];
  await collaboratorsControl.refreshAccess(opts);
  expect(access).toHaveBeenCalledWith(opts.requests, "owner");
  await expect(
    collaboratorsControl.refreshAccess({
      ...opts,
      requests: [{ ...opts.requests[0], epoch: 3 }],
    }),
  ).rejects.toThrow("stale");
  expect(access).toHaveBeenCalledTimes(1);
});
test("account discovery routes to home and never scans project owners", async () => {
  await collaboratorsApi.listResources({ account_id, search: "title" });
  expect(list).toHaveBeenCalledTimes(1);
  expect(owner).not.toHaveBeenCalled();
  bay = "entry";
  await collaboratorsApi.listResources({ account_id });
  expect(remote.listResources).toHaveBeenCalledWith({
    account_id,
    route: { bay_id: "home" },
  });
  await expect(
    collaboratorsControl.listResources({
      account_id,
      route: { bay_id: "home" },
    }),
  ).rejects.toThrow("stale");
});
test("selected-project fallback calls exactly one owner and overlays at account home", async () => {
  const page = { items: [], coverage: "partial" };
  remote.ownedProjectResources.mockResolvedValue(page);
  overlay.mockResolvedValue(page);
  await collaboratorsApi.listProjectResources({
    account_id,
    project_id,
    limit: 20,
  });
  expect(remote.ownedProjectResources).toHaveBeenCalledTimes(1);
  expect(remote.ownedProjectResources).toHaveBeenCalledWith({
    account_id,
    project_id,
    limit: 20,
    route,
  });
  expect(overlay).toHaveBeenCalledWith(account_id, page);
  expect(list).not.toHaveBeenCalled();
});
test("adoption is feature-gated account authority while checkpoint recovery is host-only", async () => {
  bay = "owner";
  await collaboratorsApi.requestSource({
    account_id,
    project_id,
    chat_path: snapshot.chat_path,
  });
  expect(adoption).toHaveBeenCalledWith(
    expect.objectContaining({ account_id, project_id }),
    { owning_bay_id: "owner" },
  );
  await collaboratorsApi.checkpointPage({
    host_id,
    project_id,
    chat_path: snapshot.chat_path,
  });
  expect(checkpoint).toHaveBeenCalledWith(
    expect.objectContaining({ host_id, project_id }),
    { owning_bay_id: "owner", host_id },
  );
  await expect(
    collaboratorsApi.checkpointPage({
      project_id,
      chat_path: snapshot.chat_path,
    }),
  ).rejects.toThrow("host_id");
  settings.mockResolvedValue({ collaborators_enabled: false });
  await expect(
    collaboratorsApi.requestSource({
      account_id,
      project_id,
      chat_path: snapshot.chat_path,
    }),
  ).rejects.toThrow("not enabled");
});
test("owner routing checks epoch and hosting principal before canonical host lookup", async () => {
  await collaboratorsApi.roomForHost({
    host_id,
    project_id,
    requesting_account_id: account_id,
  });
  expect(remote.roomForHost).toHaveBeenCalledWith({
    host_id,
    project_id,
    requesting_account_id: account_id,
    route,
  });
  bay = "owner";
  await collaboratorsControl.roomForHost({
    host_id,
    project_id,
    requesting_account_id: account_id,
    route,
  });
  expect(room).toHaveBeenCalledWith(project_id, account_id, {
    owning_bay_id: "owner",
    host_id,
  });
  await expect(
    collaboratorsControl.roomForHost({
      host_id,
      project_id,
      requesting_account_id: account_id,
      route: { ...route, epoch: 3 },
    }),
  ).rejects.toThrow("stale");
  await expect(
    collaboratorsApi.roomForHost({
      project_id,
      requesting_account_id: account_id,
    }),
  ).rejects.toThrow("host_id");
});
test("background writer metadata stays owner-routed and canonical flush authority fails closed with the flag", async () => {
  const request = { project_id, chat_path: snapshot.chat_path, host_id };
  await collaboratorsApi.writerState(request);
  expect(remote.writerState).toHaveBeenCalledWith({ ...request, route });
  bay = "owner";
  await collaboratorsControl.writerState({ ...request, route });
  expect(writerState).toHaveBeenLastCalledWith(
    expect.objectContaining(request),
    { owning_bay_id: "owner", host_id },
    true,
  );
  settings.mockResolvedValue({ collaborators_enabled: false });
  await collaboratorsControl.writerState({ ...request, route });
  expect(writerState).toHaveBeenLastCalledWith(
    expect.objectContaining(request),
    { owning_bay_id: "owner", host_id },
    false,
  );
  await expect(
    collaboratorsApi.writerState({ ...request, host_id: undefined }),
  ).rejects.toThrow(/host_id/);
});
test("point lookup goes from account home to resource owner, not the alias owner", async () => {
  remote.ownedResource.mockResolvedValue({ ...target, title: "shared" });
  personal.mockResolvedValue({ alias: "personal" });
  expect(await collaboratorsApi.getResource({ account_id, ...target })).toEqual(
    { ...target, title: "shared", personal: { alias: "personal" } },
  );
  expect(remote.ownedResource).toHaveBeenCalledWith({
    account_id,
    ...target,
    route,
  });
});
test("point lookup keeps identity migration metadata private to the account-home adapter", async () => {
  const requested = { ...target, kind: "agent" as const };
  const current = {
    ...requested,
    title: "shared agent",
    agent_id: randomUUID(),
    artifact_entry_ids: ["old-artifact-locator"],
    agent_resource_ids: ["agent-thread:old"],
    agent_catalog_resource_id: "agent-thread:old",
  };
  remote.ownedResource.mockResolvedValue(current);
  personal.mockResolvedValue({ collected: true });
  expect(
    await collaboratorsApi.getResource({ account_id, ...requested }),
  ).toEqual({
    ...requested,
    title: current.title,
    agent_id: current.agent_id,
    personal: { collected: true },
  });
  expect(personal).toHaveBeenCalledWith(account_id, current);
});
test("personal writes recheck owner authorization after mutation and never let aliases authorize", async () => {
  const current = { ...target, title: "shared" };
  remote.ownedResource
    .mockReset()
    .mockResolvedValueOnce(current)
    .mockRejectedValueOnce(Error("access denied"));
  updatePersonal.mockResolvedValue({ following: true });
  await expect(
    collaboratorsApi.setPersonalState({
      account_id,
      ...target,
      patch: { following: true },
    }),
  ).rejects.toThrow("access denied");
  expect(updatePersonal).toHaveBeenCalledWith(account_id, current, {
    following: true,
  });
  remote.ownedResource.mockReset().mockResolvedValue(null);
  updatePersonal.mockClear();
  await expect(
    collaboratorsApi.setPersonalState({
      account_id,
      ...target,
      patch: { following: true },
    }),
  ).rejects.toThrow("unavailable");
  expect(updatePersonal).not.toHaveBeenCalled();
});
test("unknown owners, stale homes and disabled accounts never fall back to local reads", async () => {
  dbQuery.mockResolvedValue({ rows: [{ banned: true }] });
  await expect(collaboratorsApi.listResources({ account_id })).rejects.toThrow(
    "unavailable",
  );
  expect(list).not.toHaveBeenCalled();
  owner.mockResolvedValue(null);
  await expect(collaboratorsApi.ingest({ host_id, snapshot })).rejects.toThrow(
    "owner unavailable",
  );
  expect(ingest).not.toHaveBeenCalled();
});
