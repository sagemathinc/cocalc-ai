/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;
let bridgeMock: { bayOps: jest.Mock };

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    warn: jest.fn(),
    debug: jest.fn(),
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
  getConfiguredClusterRole: () => "attached",
  getConfiguredClusterSeedBayId: () => "bay-0",
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: () => bridgeMock,
}));

jest.mock("@cocalc/server/rootfs/events", () => ({
  appendRootfsImageEvent: jest.fn(),
  listRecentRootfsImageEvents: jest.fn(async () => []),
}));

jest.mock("@cocalc/server/membership/rootfs-limits", () => ({
  assertCanCreateOrUpdateRootfs: jest.fn(async () => undefined),
}));

describe("RootFS catalog seed sync", () => {
  beforeEach(() => {
    jest.resetModules();
    const synced: any[][] = [];
    bridgeMock = {
      bayOps: jest.fn(() => ({
        getRootfsCatalog: jest.fn(async () => ({
          version: 1,
          images: [
            {
              id: "seed-official",
              release_id: "release-seed",
              image: "cocalc.local/rootfs/seed",
              label: "Seed Official",
              slug: "seed-official",
              official: true,
              visibility: "public",
              arch: ["amd64"],
              content: {
                version: 1,
                title: "Seed Content",
                actions: [
                  {
                    kind: "open",
                    label: "Open notebook",
                    path: "/opt/seed/notebook.ipynb",
                  },
                ],
              },
            },
            {
              id: "seed-public-untrusted",
              release_id: "release-public",
              image: "docker.io/example/public:latest",
              label: "Public User Image",
              visibility: "public",
            },
          ],
        })),
      })),
    };
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("COALESCE($24::TIMESTAMP")) {
        synced.push(params ?? []);
        return { rows: [] };
      }
      if (sql.includes("SELECT DISTINCT jsonb_object_keys")) {
        return { rows: [] };
      }
      if (sql.includes("FROM rootfs_images AS r")) {
        return {
          rows: synced.map((row) => ({
            image_id: row[0],
            release_id: row[1],
            runtime_image: row[2],
            label: row[3],
            visibility: row[9],
            official: row[10],
            prepull: row[11],
            arch: row[12],
            gpu: row[13],
            size_gb: row[14],
            tags: row[15],
            digest: row[16],
            deprecated: row[17],
            deprecated_reason: row[18],
            slug: row[19],
            theme: row[20] ? JSON.parse(row[20]) : null,
            content: row[21] ? JSON.parse(row[21]) : null,
            content_warnings: row[22] ? JSON.parse(row[22]) : null,
            owner_id: null,
            hidden: false,
            blocked: false,
            deleted: false,
            created: new Date("2026-05-24T00:00:00Z"),
          })),
        };
      }
      return { rows: [] };
    });
  });

  it("copies released official seed catalog entries into attached bays before listing", async () => {
    const { listVisibleRootfsImages } = await import("./catalog");
    const manifest = await listVisibleRootfsImages(
      "11111111-1111-4111-8111-111111111111",
    );

    expect(bridgeMock.bayOps).toHaveBeenCalledWith("bay-0", {
      timeout_ms: 15_000,
    });
    expect(manifest.images.map((entry) => entry.id)).toEqual(["seed-official"]);
    expect(manifest.images[0]?.slug).toBe("seed-official");
    expect(manifest.images[0]?.content?.title).toBe("Seed Content");
    expect(
      queryMock.mock.calls
        .filter(([sql]) => `${sql}`.includes("COALESCE($24::TIMESTAMP"))
        .map(([, params]) => params[0]),
    ).toEqual(["seed-official"]);
  });
});
