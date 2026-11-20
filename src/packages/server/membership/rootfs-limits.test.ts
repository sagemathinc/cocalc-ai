/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;
let isAdminMock: jest.Mock;
let resolveMembershipForAccountMock: jest.Mock;
let centralLogMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: (...args: any[]) => centralLogMock(...args),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("./resolve", () => ({
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

describe("rootfs membership limits", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";
  let usage = { count: 0, total_storage_bytes: 0 };
  let existing:
    | {
        image_id: string;
        owner_id: string | null;
        deleted: boolean | null;
        size_bytes: number;
      }
    | undefined;
  type CatalogRow = {
    image_id: string;
    runtime_image: string | null;
    release_id: string | null;
    official?: boolean;
    prepull?: boolean;
    deleted?: boolean;
    blocked?: boolean;
    scan_status?: string | null;
    scan_tool?: string | null;
    scanned_at?: Date | null;
    scan_summary?: any;
  };
  let catalog: CatalogRow[] = [];

  const officialRow: CatalogRow = {
    image_id: "official-example",
    runtime_image: "docker.io/example/official:latest",
    release_id: "release-official",
    official: true,
  };

  beforeEach(() => {
    jest.resetModules();
    usage = { count: 0, total_storage_bytes: 0 };
    existing = undefined;
    catalog = [];
    isAdminMock = jest.fn(async () => false);
    centralLogMock = jest.fn(async () => undefined);
    resolveMembershipForAccountMock = jest.fn(async () => ({
      class: "free",
      source: "free",
      entitlements: {},
      effective_limits: {
        rootfs_count: 0,
        rootfs_total_storage_gb: 0,
        rootfs_max_storage_gb: 0,
        rootfs_oci_images: false,
      },
    }));
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("COUNT(*) AS count")) {
        return {
          rows: [
            {
              count: usage.count,
              total_storage_bytes: usage.total_storage_bytes,
            },
          ],
        };
      }
      if (sql.includes("AS prepull")) {
        // catalog identity lookup: by image_id, or by runtime_image list
        const rows = catalog.filter((row) =>
          sql.includes("img.image_id=$1")
            ? row.image_id === params?.[0]
            : (params?.[0] as string[]).includes(`${row.runtime_image}`),
        );
        return {
          rows: rows.map((row) => ({
            scan_status: null,
            scan_tool: null,
            scanned_at: null,
            scan_summary: null,
            ...row,
            official: row.official === true,
            prepull: row.prepull === true,
            deleted: row.deleted === true,
            blocked: row.blocked === true,
          })),
        };
      }
      if (sql.includes("WHERE img.image_id=$1")) {
        return { rows: existing ? [existing] : [] };
      }
      return { rows: [] };
    });
  });

  it("blocks new rootfs creation when the tier rootfs count is zero", async () => {
    const { assertCanCreateOrUpdateRootfs } = await import("./rootfs-limits");
    await expect(
      assertCanCreateOrUpdateRootfs({
        account_id,
        image: "cocalc.local/rootfs/example",
        operation: "publish",
      }),
    ).rejects.toThrow("rootfs count limit reached");
    expect(centralLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "rootfs_quota_denied",
        value: expect.objectContaining({ limit: "rootfs_count" }),
      }),
    );
  });

  it("blocks a published rootfs that exceeds the per-image size cap", async () => {
    resolveMembershipForAccountMock.mockResolvedValue({
      class: "member",
      source: "subscription",
      entitlements: {},
      effective_limits: {
        rootfs_count: 20,
        rootfs_total_storage_gb: 25,
        rootfs_max_storage_gb: 10,
        rootfs_oci_images: false,
      },
    });
    const { assertCanCreateOrUpdateRootfs } = await import("./rootfs-limits");
    await expect(
      assertCanCreateOrUpdateRootfs({
        account_id,
        image: "cocalc.local/rootfs/example",
        requested_size_bytes: 11_000_000_000,
        operation: "publish",
      }),
    ).rejects.toThrow(
      "rootfs image size 11 GB exceeds per-rootfs limit 10 GB; delete files or upgrade membership",
    );
  });

  it("allows replacing an existing rootfs when projected total remains under cap", async () => {
    usage = { count: 3, total_storage_bytes: 21_000_000_000 };
    existing = {
      image_id: "rootfs-1",
      owner_id: account_id,
      deleted: false,
      size_bytes: 8_000_000_000,
    };
    resolveMembershipForAccountMock.mockResolvedValue({
      class: "member",
      source: "subscription",
      entitlements: {},
      effective_limits: {
        rootfs_count: 3,
        rootfs_total_storage_gb: 25,
        rootfs_max_storage_gb: 10,
        rootfs_oci_images: false,
      },
    });
    const { assertCanCreateOrUpdateRootfs } = await import("./rootfs-limits");
    await expect(
      assertCanCreateOrUpdateRootfs({
        account_id,
        image_id: "rootfs-1",
        image: "cocalc.local/rootfs/replacement",
        requested_size_bytes: 10_000_000_000,
        operation: "publish",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks replacing an existing rootfs when the growth exceeds total storage quota", async () => {
    usage = { count: 3, total_storage_bytes: 24_000_000_000 };
    existing = {
      image_id: "rootfs-1",
      owner_id: account_id,
      deleted: false,
      size_bytes: 8_000_000_000,
    };
    resolveMembershipForAccountMock.mockResolvedValue({
      class: "member",
      source: "subscription",
      entitlements: {},
      effective_limits: {
        rootfs_count: 3,
        rootfs_total_storage_gb: 25,
        rootfs_max_storage_gb: 30,
        rootfs_oci_images: false,
      },
    });
    const { assertCanCreateOrUpdateRootfs } = await import("./rootfs-limits");
    await expect(
      assertCanCreateOrUpdateRootfs({
        account_id,
        image_id: "rootfs-1",
        image: "cocalc.local/rootfs/replacement",
        requested_size_bytes: 10_000_000_000,
        operation: "publish",
      }),
    ).rejects.toThrow("rootfs total storage limit would be exceeded");
    expect(centralLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "rootfs_quota_denied",
        value: expect.objectContaining({
          limit: "rootfs_total_storage_gb",
          current: 24_000_000_000,
          requested: 10_000_000_000,
        }),
      }),
    );
  });

  it("treats a deleted existing rootfs id as a new rootfs for quota purposes", async () => {
    usage = { count: 1, total_storage_bytes: 5_000_000_000 };
    existing = {
      image_id: "rootfs-1",
      owner_id: account_id,
      deleted: true,
      size_bytes: 5_000_000_000,
    };
    resolveMembershipForAccountMock.mockResolvedValue({
      class: "member",
      source: "subscription",
      entitlements: {},
      effective_limits: {
        rootfs_count: 1,
        rootfs_total_storage_gb: 25,
        rootfs_max_storage_gb: 10,
        rootfs_oci_images: false,
      },
    });
    const { assertCanCreateOrUpdateRootfs } = await import("./rootfs-limits");
    await expect(
      assertCanCreateOrUpdateRootfs({
        account_id,
        image_id: "rootfs-1",
        image: "cocalc.local/rootfs/replacement",
        requested_size_bytes: 1_000_000_000,
        operation: "save",
      }),
    ).rejects.toThrow("rootfs count limit reached");
  });

  it("allows metadata-only updates to an existing own rootfs on a zero-storage tier", async () => {
    usage = { count: 1, total_storage_bytes: 5_000_000_000 };
    existing = {
      image_id: "rootfs-1",
      owner_id: account_id,
      deleted: false,
      size_bytes: 5_000_000_000,
    };
    resolveMembershipForAccountMock.mockResolvedValue({
      class: "free",
      source: "free",
      entitlements: {},
      effective_limits: {
        rootfs_count: 1,
        rootfs_total_storage_gb: 0,
        rootfs_max_storage_gb: 0,
        rootfs_oci_images: false,
      },
    });
    const { assertCanCreateOrUpdateRootfs } = await import("./rootfs-limits");
    await expect(
      assertCanCreateOrUpdateRootfs({
        account_id,
        image_id: "rootfs-1",
        image: "cocalc.local/rootfs/existing",
        operation: "save",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks arbitrary remote OCI images unless the tier allows them", async () => {
    resolveMembershipForAccountMock.mockResolvedValue({
      class: "member",
      source: "subscription",
      entitlements: {},
      effective_limits: {
        rootfs_count: 20,
        rootfs_total_storage_gb: 25,
        rootfs_max_storage_gb: 10,
        rootfs_oci_images: false,
      },
    });
    const { assertCanSelectProjectRootfsImage } =
      await import("./rootfs-limits");
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "docker.io/library/ubuntu:latest",
      }),
    ).rejects.toThrow(
      "arbitrary remote OCI root filesystem images are disabled",
    );
  });

  it("allows only released trusted catalog images without OCI-image entitlement", async () => {
    const { assertCanSelectProjectRootfsImage } =
      await import("./rootfs-limits");
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "buildpack-deps:noble-scm",
      }),
    ).rejects.toThrow(
      "arbitrary remote OCI root filesystem images are disabled",
    );

    catalog = [officialRow];
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "docker.io/example/official:latest",
        image_id: "official-example",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "docker.io/example/official:latest",
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses arbitrary OCI images for non-admins even when the tier enables rootfs_oci_images", async () => {
    resolveMembershipForAccountMock.mockResolvedValue({
      class: "pro",
      source: "subscription",
      entitlements: {},
      effective_limits: {
        rootfs_count: 250,
        rootfs_total_storage_gb: 250,
        rootfs_max_storage_gb: 30,
        rootfs_oci_images: true,
      },
    });
    const { assertCanSelectProjectRootfsImage, assertCanCreateOrUpdateRootfs } =
      await import("./rootfs-limits");
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "docker.io/library/ubuntu:latest",
      }),
    ).rejects.toThrow(
      "arbitrary remote OCI root filesystem images are disabled for non-admin accounts",
    );
    await expect(
      assertCanCreateOrUpdateRootfs({
        account_id,
        image: "docker.io/library/ubuntu:latest",
        image_id: "my-entry",
        operation: "save",
      }),
    ).rejects.toThrow(
      "arbitrary remote OCI root filesystem images are disabled for non-admin accounts",
    );
    expect(centralLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "rootfs_quota_denied",
        value: expect.objectContaining({ limit: "rootfs_oci_images" }),
      }),
    );
  });

  it("refuses a forged image_id that names a different trusted image", async () => {
    catalog = [officialRow];
    const { assertCanSelectProjectRootfsImage } =
      await import("./rootfs-limits");
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "docker.io/attacker/anything:latest",
        image_id: "official-example",
      }),
    ).rejects.toThrow(
      "arbitrary remote OCI root filesystem images are disabled",
    );
  });

  it("refuses a pair whose image is trusted under a different catalog id", async () => {
    catalog = [
      officialRow,
      {
        image_id: "other-official",
        runtime_image: "docker.io/example/other:latest",
        release_id: "release-other",
        official: true,
      },
    ];
    const { assertCanSelectProjectRootfsImage } =
      await import("./rootfs-limits");
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "docker.io/example/official:latest",
        image_id: "other-official",
      }),
    ).rejects.toThrow(
      "arbitrary remote OCI root filesystem images are disabled",
    );
  });

  it.each([
    ["deleted", { deleted: true }],
    ["blocked", { blocked: true }],
    ["not official or prepulled", { official: false, prepull: false }],
    ["without a release", { release_id: null }],
    ["with a blank release", { release_id: "  " }],
  ])("refuses a catalog row that is %s", async (_label, patch) => {
    catalog = [{ ...officialRow, ...patch }];
    const { assertCanSelectProjectRootfsImage } =
      await import("./rootfs-limits");
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "docker.io/example/official:latest",
        image_id: "official-example",
      }),
    ).rejects.toThrow(
      "arbitrary remote OCI root filesystem images are disabled",
    );
  });

  it("accepts a released prepulled image and normalizes the image name", async () => {
    catalog = [
      {
        image_id: "prepulled",
        runtime_image: "docker.io/example/prepulled:1",
        release_id: "release-prepulled",
        official: false,
        prepull: true,
      },
    ];
    const { assertCanSelectProjectRootfsImage } =
      await import("./rootfs-limits");
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "example/prepulled:1",
        image_id: "prepulled",
      }),
    ).resolves.toBeUndefined();
  });

  it("binds a managed image named with a catalog id to that id's live row", async () => {
    catalog = [
      {
        image_id: "managed-entry",
        runtime_image: "cocalc.local/rootfs/abc",
        release_id: "release-managed",
      },
    ];
    const { assertCanSelectProjectRootfsImage } =
      await import("./rootfs-limits");
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "cocalc.local/rootfs/abc",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "cocalc.local/rootfs/abc",
        image_id: "managed-entry",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "cocalc.local/rootfs/other",
        image_id: "managed-entry",
      }),
    ).rejects.toThrow(
      "arbitrary remote OCI root filesystem images are disabled",
    );
    catalog = [{ ...catalog[0], blocked: true }];
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "cocalc.local/rootfs/abc",
        image_id: "managed-entry",
      }),
    ).rejects.toThrow(
      "arbitrary remote OCI root filesystem images are disabled",
    );
  });

  it("lets admins select arbitrary OCI images", async () => {
    isAdminMock.mockResolvedValue(true);
    const { assertCanSelectProjectRootfsImage } =
      await import("./rootfs-limits");
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "docker.io/library/ubuntu:latest",
        image_id: "official-example",
      }),
    ).resolves.toBeUndefined();
    expect(queryMock).not.toHaveBeenCalled();
  });

  const scannedOfficialManaged: CatalogRow = {
    image_id: "official-example",
    runtime_image: "cocalc.local/rootfs/official",
    release_id: "release-1",
    official: true,
    scan_status: "findings",
    scan_tool: "trivy",
    scanned_at: new Date("2026-05-17T00:00:00Z"),
    scan_summary: {
      status: "findings",
      tool: "trivy",
      severity_counts: {
        critical: 1,
        high: 0,
        medium: 0,
        low: 0,
        unknown: 0,
      },
    },
  };

  it("allows ordinary users to select official images with unresolved critical scan findings", async () => {
    catalog = [scannedOfficialManaged];
    const { assertCanSelectProjectRootfsImage } =
      await import("./rootfs-limits");
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "cocalc.local/rootfs/official",
        image_id: "official-example",
      }),
    ).resolves.toBeUndefined();
    expect(centralLogMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: "rootfs_scan_policy_blocked",
      }),
    );
  });

  it("binds scan policy to the row matching the requested image", async () => {
    catalog = [scannedOfficialManaged];
    const { assertCanSelectProjectRootfsImage } =
      await import("./rootfs-limits");
    // The supplied id belongs to a different image, so no row is bound: the
    // scan policy of the other row is not consulted, and admission refuses.
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "docker.io/attacker/anything:latest",
        image_id: "official-example",
      }),
    ).rejects.toThrow(
      "arbitrary remote OCI root filesystem images are disabled",
    );
  });

  it("does not apply official scan blocking to admins", async () => {
    isAdminMock.mockResolvedValue(true);
    catalog = [scannedOfficialManaged];
    const { assertCanSelectProjectRootfsImage } =
      await import("./rootfs-limits");
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "cocalc.local/rootfs/official",
        image_id: "official-example",
      }),
    ).resolves.toBeUndefined();
    expect(centralLogMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "rootfs_scan_policy_blocked" }),
    );
  });
});
