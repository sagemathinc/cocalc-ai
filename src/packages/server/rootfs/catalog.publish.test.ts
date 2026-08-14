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

describe("assertRootfsSlugAvailable", () => {
  beforeEach(() => {
    queryMock = jest.fn(async () => ({ rows: [] }));
  });

  it("rejects a slug already used by another catalog image", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ image_id: "existing-image" }] });
    const { assertRootfsSlugAvailable } = await import("./catalog");

    await expect(assertRootfsSlugAvailable({ slug: "basic" })).rejects.toThrow(
      "rootfs slug 'basic' is already in use",
    );
  });

  it("does not query for a blank generated slug", async () => {
    const { assertRootfsSlugAvailable } = await import("./catalog");

    await expect(assertRootfsSlugAvailable({ slug: "" })).resolves.toBe(
      undefined,
    );
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("assertRootfsSupersessionAllowed", () => {
  beforeEach(() => {
    queryMock = jest.fn(async () => ({ rows: [] }));
  });

  const stableCpu = {
    owner_id: ACCOUNT_ID,
    family: "texlive",
    channel: "stable",
    gpu: false,
    official: true,
  };

  it("rejects self-supersession without querying", async () => {
    const { assertRootfsSupersessionAllowed } = await import("./catalog");

    await expect(
      assertRootfsSupersessionAllowed({
        image_id: "image-1",
        ...stableCpu,
        supersedes_image_id: "image-1",
      }),
    ).rejects.toThrow("cannot supersede itself");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects a missing supersession target", async () => {
    const { assertRootfsSupersessionAllowed } = await import("./catalog");

    await expect(
      assertRootfsSupersessionAllowed({
        image_id: "image-2",
        ...stableCpu,
        supersedes_image_id: "missing",
      }),
    ).rejects.toThrow("superseded rootfs image not found");
  });

  it("accepts official supersession across owners and stable defaults", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          channel: null,
          deleted: false,
          family: " TeXLive ",
          gpu: null,
          image_id: "image-1",
          official: true,
          owner_id: "22222222-2222-4222-8222-222222222222",
        },
      ],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { assertRootfsSupersessionAllowed } = await import("./catalog");

    await expect(
      assertRootfsSupersessionAllowed({
        image_id: "image-2",
        ...stableCpu,
        supersedes_image_id: "image-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts same-owner community supersession", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            channel: "stable",
            deleted: false,
            family: "texlive",
            gpu: false,
            image_id: "image-1",
            official: false,
            owner_id: "community publisher",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { assertRootfsSupersessionAllowed } = await import("./catalog");

    await expect(
      assertRootfsSupersessionAllowed({
        image_id: "image-2",
        owner_id: " Community Publisher ",
        family: "texlive",
        channel: "stable",
        gpu: false,
        official: false,
        supersedes_image_id: "image-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects cross-owner community supersession", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          channel: "stable",
          deleted: false,
          family: "texlive",
          gpu: false,
          image_id: "bob-image",
          official: false,
          owner_id: "bob",
        },
      ],
    });
    const { assertRootfsSupersessionAllowed } = await import("./catalog");

    await expect(
      assertRootfsSupersessionAllowed({
        image_id: "eve-image",
        owner_id: "eve",
        family: "texlive",
        channel: "stable",
        gpu: false,
        official: false,
        supersedes_image_id: "bob-image",
      }),
    ).rejects.toThrow("community rootfs image can only supersede");
  });

  it.each([
    [
      "family",
      {
        family: "sagemath",
        channel: "stable",
        gpu: false,
        official: true,
      },
    ],
    [
      "channel",
      { family: "texlive", channel: "beta", gpu: false, official: true },
    ],
    [
      "GPU mode",
      { family: "texlive", channel: "stable", gpu: true, official: true },
    ],
    [
      "official status",
      { family: "texlive", channel: "stable", gpu: false, official: false },
    ],
  ])(
    "rejects supersession across a %s boundary",
    async (_name, predecessor) => {
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            ...predecessor,
            deleted: false,
            image_id: "image-1",
          },
        ],
      });
      const { assertRootfsSupersessionAllowed } = await import("./catalog");

      await expect(
        assertRootfsSupersessionAllowed({
          image_id: "image-2",
          ...stableCpu,
          supersedes_image_id: "image-1",
        }),
      ).rejects.toThrow("same family, channel, GPU mode, and official status");
    },
  );

  it("rejects a supersession cycle", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ...stableCpu,
            deleted: false,
            image_id: "image-1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ image_id: "image-2" }] });
    const { assertRootfsSupersessionAllowed } = await import("./catalog");

    await expect(
      assertRootfsSupersessionAllowed({
        image_id: "image-2",
        ...stableCpu,
        supersedes_image_id: "image-1",
      }),
    ).rejects.toThrow("would create a cycle");
  });

  it("rejects a target whose existing predecessor chain is cyclic", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ...stableCpu,
            deleted: false,
            image_id: "image-1",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ cycle: true, image_id: "image-1" }],
      });
    const { assertRootfsSupersessionAllowed } = await import("./catalog");

    await expect(
      assertRootfsSupersessionAllowed({
        image_id: "image-3",
        ...stableCpu,
        supersedes_image_id: "image-1",
      }),
    ).rejects.toThrow("would create a cycle");
  });
});

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
