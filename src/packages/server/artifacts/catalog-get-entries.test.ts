import { randomUUID } from "node:crypto";
import { getEntries } from "./catalog-api";
import {
  ARTIFACT_CATALOG_READ_LIMITED,
  artifactCatalogReadLimitEntries,
  resetArtifactCatalogReadLimitsForTests,
  withArtifactCatalogReadLimit,
} from "./catalog-read-limits";

const NOT_PERMITTED = "not found or not permitted";
const ownerOf = jest.fn();
const read = jest.fn();
const authorized = jest.fn();
let banned = false;
const remote = { getEntries: jest.fn() };
const remoteClient = jest.fn((_opts?: any) => remote);

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "here",
}));
const resolveBays = jest.fn(async (project_ids: string[]) => {
  const owners = new Map();
  for (const project_id of project_ids)
    owners.set(project_id, await ownerOf(project_id));
  return owners;
});
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...a) => ownerOf(...a),
  resolveProjectBays: (ids) => resolveBays(ids),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "trusted-fabric",
}));
jest.mock("@cocalc/conat/inter-bay/artifact-catalog", () => ({
  createInterBayArtifactCatalogClient: (o) => remoteClient(o),
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: async () => {},
  isAccountBannedCached: () => banned,
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => "pool",
}));
jest.mock("@cocalc/database/postgres/artifact-catalog-read", () => ({
  ARTIFACT_CATALOG_NOT_PERMITTED: "not found or not permitted",
  // The real, pure validator: the home bay must bound the whole request.
  validateArtifactCatalogEntryRefs: (items) =>
    jest
      .requireActual("@cocalc/database/postgres/artifact-catalog-read")
      .validateArtifactCatalogEntryRefs(items),
  readArtifactCatalogEntriesForAccountLocal: (...a) => read(...a),
  authorizedArtifactCatalogProjects: (...a) => authorized(...a),
}));

const account_id = randomUUID();
const local = randomUUID();
const far = randomUUID();
const entry = (project_id: string) => ({
  project_id,
  entry_id: "a".repeat(64),
});

beforeEach(() => {
  jest.clearAllMocks();
  resetArtifactCatalogReadLimitsForTests();
  banned = false;
  ownerOf.mockImplementation(async (project_id) =>
    project_id === far ? { bay_id: "there", epoch: 1 } : { bay_id: "here" },
  );
  read.mockImplementation(async ({ items }) =>
    items.map((item) => ({ ...item, chat_path: "/c.chat", item: {} })),
  );
  authorized.mockImplementation(
    async (_db, { project_ids }) => new Set(project_ids),
  );
  remote.getEntries.mockResolvedValue([{ ...entry(far), item: {} }]);
});

test("local projects are read and re-authorized on this bay", async () => {
  const result = await getEntries({ account_id, items: [entry(local)] });
  expect(result).toHaveLength(1);
  expect(read).toHaveBeenCalledWith({
    account_id,
    owning_bay_id: "here",
    items: [entry(local)],
  });
  // The post-read check uses the same predicate on the same projects.
  expect(authorized).toHaveBeenCalledWith("pool", {
    account_id,
    owning_bay_id: "here",
    project_ids: [local],
  });
  expect(remoteClient).not.toHaveBeenCalled();
});

test("each owning bay gets only its own items; any refusal fails the whole request", async () => {
  const result = await getEntries({
    account_id,
    items: [entry(local), entry(far)],
  });
  expect(result.map((e) => e.project_id).sort()).toEqual([local, far].sort());
  expect(remoteClient).toHaveBeenCalledWith({
    client: "trusted-fabric",
    bay_id: "there",
  });
  expect(remote.getEntries).toHaveBeenCalledWith({
    account_id,
    items: [entry(far)],
  });
  remote.getEntries.mockRejectedValue(new Error(NOT_PERMITTED));
  await expect(
    getEntries({ account_id, items: [entry(local), entry(far)] }),
  ).rejects.toThrow(NOT_PERMITTED);
});

test("a banned account, an unknown project, or access revoked during the read get the uniform error", async () => {
  banned = true;
  await expect(
    getEntries({ account_id, items: [entry(local)] }),
  ).rejects.toThrow(NOT_PERMITTED);
  expect(read).not.toHaveBeenCalled();
  banned = false;

  ownerOf.mockResolvedValueOnce(null);
  await expect(
    getEntries({ account_id, items: [entry(randomUUID())] }),
  ).rejects.toThrow(NOT_PERMITTED);

  authorized.mockResolvedValueOnce(new Set());
  await expect(
    getEntries({ account_id, items: [entry(local)] }),
  ).rejects.toThrow(NOT_PERMITTED);
});

test("per-account rate limit", async () => {
  for (let i = 0; i < 10; i++)
    await getEntries({ account_id, items: [entry(local)] });
  await expect(
    getEntries({ account_id, items: [entry(local)] }),
  ).rejects.toThrow(ARTIFACT_CATALOG_READ_LIMITED);
  // Another account is unaffected.
  await expect(
    getEntries({ account_id: randomUUID(), items: [entry(local)] }),
  ).resolves.toHaveLength(1);
});

test("the whole request is validated and bounded on the home bay before any routing", async () => {
  // 101 distinct valid refs, split across two owning bays (each half <= 100).
  const items = Array.from({ length: 101 }, (_, i) => ({
    project_id: i % 2 ? far : local,
    entry_id: i.toString(16).padStart(64, "0"),
  }));
  await expect(getEntries({ account_id, items })).rejects.toThrow(
    "invalid catalog entry list",
  );
  for (const bad of [
    [],
    [{ project_id: "not-a-uuid", entry_id: "a".repeat(64) }],
    [{ project_id: local, entry_id: "" }],
    "x" as any,
  ])
    await expect(getEntries({ account_id, items: bad })).rejects.toThrow(
      "invalid catalog entry list",
    );
  expect(resolveBays).not.toHaveBeenCalled();
  expect(ownerOf).not.toHaveBeenCalled();
  expect(remoteClient).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  // Duplicates are folded before routing: one batch lookup, one owner call.
  await getEntries({
    account_id,
    items: [entry(local), entry(local), entry(local)],
  });
  expect(resolveBays).toHaveBeenCalledTimes(1);
  expect(resolveBays).toHaveBeenCalledWith([local]);
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({ items: [entry(local)] }),
  );
});

test("the rate limiter forgets idle callers", async () => {
  let t = 0;
  const now = () => t;
  for (let i = 0; i < 1500; i++)
    await withArtifactCatalogReadLimit(
      randomUUID(),
      "getEntries",
      async () => 0,
      now,
    );
  // The sweep at the 1000th call found nothing expired yet.
  expect(artifactCatalogReadLimitEntries()).toBe(1500);
  t = 60_000;
  for (let i = 0; i < 1000; i++)
    await withArtifactCatalogReadLimit(
      randomUUID(),
      "getEntries",
      async () => 0,
      now,
    );
  // The next sweep (500 calls into this batch, at t=60s) dropped all 1500
  // expired callers; only this batch's 1000 remain, not 2500.
  expect(artifactCatalogReadLimitEntries()).toBe(1000);
});
