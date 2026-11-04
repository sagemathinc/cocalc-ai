import { randomUUID } from "node:crypto";
import { getEntries } from "./catalog-api";
import {
  ARTIFACT_CATALOG_READ_LIMITED,
  resetArtifactCatalogReadLimitsForTests,
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
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...a) => ownerOf(...a),
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
