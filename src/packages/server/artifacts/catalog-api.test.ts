import { randomUUID } from "node:crypto";
import {
  writerState,
  registerSource,
  ingest,
  catalogOwnerControl,
  listProject,
  sourcePage,
} from "./catalog-api";

const owner = jest.fn();
const state = jest.fn();
const register = jest.fn();
const apply = jest.fn();
const read = jest.fn();
const sources = jest.fn();
const actor = jest.fn();
jest.mock("@cocalc/server/agents/access", () => ({
  assertActor: (...a) => actor(...a),
}));
const remote = {
  writerState: jest.fn(),
  registerSource: jest.fn(),
  ingest: jest.fn(),
  listProject: jest.fn(),
  sourcePage: jest.fn(),
};
const remoteClient = jest.fn(() => remote);
let bay = "owner";
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => bay,
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...a) => owner(...a),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "trusted-fabric",
}));
jest.mock("@cocalc/conat/inter-bay/artifact-catalog", () => ({
  createInterBayArtifactCatalogClient: (o) => remoteClient(o),
}));
jest.mock("@cocalc/database/postgres/artifact-catalog", () => ({
  getArtifactCatalogWriterState: (...a) => state(...a),
  registerArtifactCatalogSource: (...a) => register(...a),
  applyArtifactCatalogSnapshot: (...a) => apply(...a),
  readProjectArtifactCatalog: (...a) => read(...a),
  artifactCatalogSourcePage: (...a) => sources(...a),
}));
const source = {
  project_id: randomUUID(),
  host_id: randomUUID(),
  chat_path: "/home/user/a.chat",
};
const route = { bay_id: "owner", epoch: 3 };
const authority = { owning_bay_id: "owner", host_id: source.host_id };
const snapshot = {
  schema_version: 1 as const,
  project_id: source.project_id,
  chat_path: source.chat_path,
  epoch: randomUUID(),
  sequence: 1,
  items: [],
};
beforeEach(() => {
  jest.clearAllMocks();
  bay = "owner";
  owner.mockReset().mockResolvedValue(route);
  state.mockReset().mockResolvedValue(null);
  register.mockReset().mockResolvedValue(snapshot.epoch);
  apply.mockReset().mockResolvedValue({ revision: 1, replayed: false });
  actor.mockReset().mockResolvedValue(undefined);
  read.mockReset().mockResolvedValue({ entries: [], indexed_sources: 0 });
  sources.mockReset().mockResolvedValue({ paths: [] });
});

test("project reads check collaboration before and after the bounded query", async () => {
  const account_id = randomUUID();
  await listProject({ project_id: source.project_id, account_id });
  expect(actor).toHaveBeenCalledTimes(2);
  expect(actor).toHaveBeenCalledWith(account_id, source.project_id);
  actor.mockRejectedValueOnce(Error("not a collaborator"));
  read.mockClear();
  await expect(
    listProject({ project_id: source.project_id, account_id }),
  ).rejects.toThrow("collaborator");
  expect(read).not.toHaveBeenCalled();
  actor
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(Error("revoked"));
  await expect(
    listProject({ project_id: source.project_id, account_id }),
  ).rejects.toThrow("revoked");
});

test("project reads route to owner while host discovery uses checked host authority", async () => {
  await sourcePage({ project_id: source.project_id, host_id: source.host_id });
  expect(sources).toHaveBeenCalledWith(source.project_id, authority, undefined);
  bay = "entry";
  const request = { project_id: source.project_id, account_id: randomUUID() };
  await listProject(request);
  expect(remote.listProject).toHaveBeenCalledWith({
    ...request,
    after: undefined,
    route,
  });
  await expect(
    catalogOwnerControl.listProject({ ...request, route }),
  ).rejects.toThrow("stale");
});

test("same-bay dispatch binds database authority and strips caller extras", async () => {
  await writerState({ ...source, owning_bay_id: "forged" } as any);
  expect(state).toHaveBeenCalledWith(source, authority);
  const request = {
    ...source,
    expected_epoch: null,
    registration_id: randomUUID(),
  };
  await expect(registerSource(request)).resolves.toEqual({
    epoch: snapshot.epoch,
  });
  expect(register).toHaveBeenCalledWith(
    source,
    authority,
    null,
    request.registration_id,
  );
  await ingest({ ...source, snapshot });
  expect(apply).toHaveBeenCalledWith(snapshot, authority);
});

test("remote dispatch uses owner route and trusted fabric, not local database", async () => {
  bay = "entry";
  await writerState(source);
  await ingest({ ...source, snapshot });
  expect(remoteClient).toHaveBeenCalledWith({
    client: "trusted-fabric",
    bay_id: "owner",
  });
  expect(remote.writerState).toHaveBeenCalledWith({ ...source, route });
  expect(remote.ingest).toHaveBeenCalledWith({ ...source, snapshot, route });
  expect(state).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});

test("owner rechecks directory epoch before touching storage", async () => {
  await expect(
    catalogOwnerControl.writerState({
      ...source,
      route: { ...route, epoch: 2 },
    }),
  ).rejects.toThrow("stale");
  owner.mockResolvedValue({ bay_id: "new-owner", epoch: 4 });
  await expect(
    catalogOwnerControl.ingest({ ...source, snapshot, route }),
  ).rejects.toThrow("stale");
  expect(state).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});

test("invalid host, registration and mismatched snapshot fail before dispatch", async () => {
  await expect(
    writerState({ ...source, host_id: undefined }),
  ).rejects.toThrow();
  await expect(
    registerSource({
      ...source,
      expected_epoch: null,
      registration_id: "invalid",
    }),
  ).rejects.toThrow();
  await expect(
    ingest({ ...source, snapshot: { ...snapshot, project_id: randomUUID() } }),
  ).rejects.toThrow("source mismatch");
  await expect(
    catalogOwnerControl.ingest({
      ...source,
      snapshot: { ...snapshot, chat_path: "/other.chat" },
      route,
    }),
  ).rejects.toThrow("source mismatch");
  expect(apply).not.toHaveBeenCalled();
});

test("per-host admission rejects rather than queueing and releases on failure", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.mockImplementation(async () => {
    await wait;
    throw Error("database unavailable");
  });
  const first = writerState(source);
  const second = writerState(source);
  await expect(writerState(source)).rejects.toThrow("busy");
  release();
  await expect(first).rejects.toThrow("database unavailable");
  await expect(second).rejects.toThrow("database unavailable");
  state.mockResolvedValue(null);
  await expect(writerState(source)).resolves.toBeNull();
});

test("global admission bounds independent hosts and frees capacity on completion", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.mockImplementation(async () => {
    await wait;
    return null;
  });
  const pending = Array.from({ length: 8 }, () =>
    writerState({ ...source, host_id: randomUUID() }),
  );
  await expect(
    writerState({ ...source, host_id: randomUUID() }),
  ).rejects.toThrow("busy");
  release();
  await Promise.all(pending);
  await expect(writerState(source)).resolves.toBeNull();
});
