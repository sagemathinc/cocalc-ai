/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;
let bridgeMock: { bayOps: jest.Mock };
let seedImages: any[];
let synced: any[][];
let validationTarget: any;

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
    synced = [];
    validationTarget = undefined;
    seedImages = [
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
    ];
    bridgeMock = {
      bayOps: jest.fn(() => ({
        getRootfsCatalog: jest.fn(async () => ({
          version: 1,
          images: seedImages,
        })),
      })),
    };
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("COALESCE($25::TIMESTAMP")) {
        const row = params ?? [];
        const index = synced.findIndex((item) => item[0] === row[0]);
        if (index === -1) {
          synced.push(row);
        } else {
          synced[index] = row;
        }
        return { rows: [{ owner_id: null }] };
      }
      if (
        sql.includes(
          "SELECT image_id, owner_id, family, channel, gpu, official, deleted",
        )
      ) {
        const syncedTarget = synced.find((row) => row[0] === params?.[0]);
        const target =
          validationTarget ??
          (syncedTarget
            ? {
                image_id: syncedTarget[0],
                owner_id: null,
                family: syncedTarget[4],
                channel: syncedTarget[6],
                gpu: syncedTarget[14],
                official: syncedTarget[11],
                deleted: false,
              }
            : undefined);
        return { rows: target ? [target] : [] };
      }
      if (sql.includes("WITH RECURSIVE predecessors AS")) {
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
            family: row[4],
            version: row[5],
            channel: row[6],
            supersedes_image_id: row[7],
            default_jupyter_kernel: row[9],
            visibility: row[10],
            official: row[11],
            prepull: row[12],
            arch: row[13],
            gpu: row[14],
            size_gb: row[15],
            tags: row[16],
            digest: row[17],
            deprecated: row[18],
            deprecated_reason: row[19],
            slug: row[20],
            theme: row[21] ? JSON.parse(row[21]) : null,
            content: row[22] ? JSON.parse(row[22]) : null,
            content_warnings: row[23] ? JSON.parse(row[23]) : null,
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
        .filter(([sql]) => `${sql}`.includes("COALESCE($25::TIMESTAMP"))
        .map(([, params]) => params[0]),
    ).toEqual(["seed-official"]);
  });

  it("strips a cross-owner community supersession edge from seed sync", async () => {
    seedImages = [
      {
        id: "seed-community",
        release_id: "release-community",
        image: "cocalc.local/rootfs/community",
        label: "Community image",
        family: "coolstack",
        version: "9.9",
        channel: "stable",
        official: false,
        prepull: true,
        visibility: "public",
        supersedes_image_id: "bob-image",
      },
    ];
    validationTarget = {
      image_id: "bob-image",
      owner_id: "22222222-2222-4222-8222-222222222222",
      family: "coolstack",
      channel: "stable",
      gpu: false,
      official: false,
      deleted: false,
    };
    const { listVisibleRootfsImages } = await import("./catalog");

    await listVisibleRootfsImages("11111111-1111-4111-8111-111111111111");

    const writes = queryMock.mock.calls.filter(
      ([sql, params]) =>
        `${sql}`.includes("COALESCE($25::TIMESTAMP") &&
        params?.[0] === "seed-community",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1]?.[7]).toBeNull();
  });

  it("restores a valid seed supersession edge after both rows exist", async () => {
    seedImages = [
      {
        id: "seed-next",
        release_id: "release-next",
        image: "cocalc.local/rootfs/next",
        label: "Next",
        family: "seed-family",
        version: "2.0",
        channel: "stable",
        official: true,
        visibility: "public",
        supersedes_image_id: "seed-previous",
      },
      {
        id: "seed-previous",
        release_id: "release-previous",
        image: "cocalc.local/rootfs/previous",
        label: "Previous",
        family: "seed-family",
        version: "1.0",
        channel: "stable",
        official: true,
        visibility: "public",
      },
    ];
    const { listVisibleRootfsImages } = await import("./catalog");

    await listVisibleRootfsImages("11111111-1111-4111-8111-111111111111");

    const writes = queryMock.mock.calls.filter(
      ([sql, params]) =>
        `${sql}`.includes("COALESCE($25::TIMESTAMP") &&
        params?.[0] === "seed-next",
    );
    expect(writes).toHaveLength(2);
    expect(writes[0]?.[1]?.[7]).toBeNull();
    expect(writes[1]?.[1]?.[7]).toBe("seed-previous");
  });
});
