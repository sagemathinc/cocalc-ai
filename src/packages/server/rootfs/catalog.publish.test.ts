/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  }),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: jest.fn(async () => false),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-1",
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterRole: () => "standalone",
  getConfiguredClusterSeedBayId: () => undefined,
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: jest.fn(),
}));

jest.mock("@cocalc/server/rootfs/events", () => ({
  appendRootfsImageEvent: jest.fn(),
  listRecentRootfsImageEvents: jest.fn(async () => []),
}));

jest.mock("@cocalc/server/rootfs/rustic-repo-schema", () => ({
  ensureRootfsRusticRepoSchema: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/membership/rootfs-limits", () => ({
  assertCanCreateOrUpdateRootfs: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/cloud/rootfs-prepull", () => ({
  enqueueRootfsPrepullForRunningHosts: jest.fn(async () => undefined),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

function emptyCounts() {
  return {
    total: 0,
    deleted: 0,
    pending_delete: 0,
    blocked: 0,
    official_unscanned: 0,
    official_critical: 0,
    official_scan_failed: 0,
  };
}

describe("publishProjectRootfsCatalogEntry", () => {
  beforeEach(() => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT DISTINCT jsonb_object_keys")) {
        return { rows: [] };
      }
      if (sql.includes("COUNT(*)::INTEGER AS total")) {
        return { rows: [emptyCounts()] };
      }
      return { rows: [] };
    });
  });

  it("uses the requested public slug when publishing a project artifact", async () => {
    const { publishProjectRootfsCatalogEntry } = await import("./catalog");

    const result = await publishProjectRootfsCatalogEntry({
      account_id: ACCOUNT_ID,
      release_id: "release-1",
      artifact: {
        image: "cocalc.local/rootfs/abc123",
        snapshot: "rootfs-publish-test",
        content_key: "abc123",
        size_bytes: 1_000_000,
        arch: "amd64",
      },
      body: {
        project_id: "project-1",
        label: "Published RootFS",
        slug: "published-rootfs",
        visibility: "public",
      },
    });

    const insert = queryMock.mock.calls.find(
      ([sql, params]) =>
        `${sql}`.includes("INSERT INTO rootfs_images") &&
        Array.isArray(params) &&
        params.length === 28,
    );
    expect(insert).toBeDefined();
    expect(insert?.[1]?.[23]).toBe("published-rootfs");
    expect(result.slug).toBe("published-rootfs");
  });
});

describe("saveRootfsImage", () => {
  beforeEach(() => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT DISTINCT jsonb_object_keys")) {
        return { rows: [] };
      }
      if (sql.includes("COUNT(*)::INTEGER AS total")) {
        return { rows: [emptyCounts()] };
      }
      return { rows: [] };
    });
  });

  it("uses the requested public slug when saving a catalog entry", async () => {
    const { saveRootfsImage } = await import("./catalog");

    const result = await saveRootfsImage({
      account_id: ACCOUNT_ID,
      body: {
        image: "cocalc.local/rootfs/save-test",
        label: "Saved RootFS",
        slug: "saved-rootfs",
        visibility: "public",
      },
    });

    const insert = queryMock.mock.calls.find(
      ([sql, params]) =>
        `${sql}`.includes("INSERT INTO rootfs_images") &&
        Array.isArray(params) &&
        params.length === 28,
    );
    expect(insert).toBeDefined();
    expect(insert?.[1]?.[23]).toBe("saved-rootfs");
    expect(result.slug).toBe("saved-rootfs");
  });
});

export {};
