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
  let trusted = false;
  let scanEntry:
    | {
        image_id: string;
        release_id: string | null;
        official: boolean | null;
        scan_status: string | null;
        scan_tool: string | null;
        scanned_at: Date | null;
        scan_summary: any;
      }
    | undefined;

  beforeEach(() => {
    jest.resetModules();
    usage = { count: 0, total_storage_bytes: 0 };
    existing = undefined;
    trusted = false;
    scanEntry = undefined;
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
    queryMock = jest.fn(async (sql: string) => {
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
      if (sql.includes("WHERE img.image_id=$1")) {
        return { rows: existing ? [existing] : [] };
      }
      if (sql.includes("SELECT COALESCE(official, false)")) {
        return { rows: trusted ? [{ trusted: true }] : [] };
      }
      if (sql.includes("rel.scan_status")) {
        return { rows: scanEntry ? [scanEntry] : [] };
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
    ).rejects.toThrow("exceeds per-rootfs limit");
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

  it("allows built-in and trusted catalog images without OCI-image entitlement", async () => {
    const { assertCanSelectProjectRootfsImage } =
      await import("./rootfs-limits");
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "buildpack-deps:noble-scm",
      }),
    ).resolves.toBeUndefined();

    trusted = true;
    await expect(
      assertCanSelectProjectRootfsImage({
        account_id,
        image: "docker.io/example/official:latest",
        image_id: "official-example",
      }),
    ).resolves.toBeUndefined();
  });

  it("allows ordinary users to select official images with unresolved critical scan findings", async () => {
    scanEntry = {
      image_id: "official-example",
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

  it("does not apply official scan blocking to admins", async () => {
    isAdminMock.mockResolvedValue(true);
    scanEntry = {
      image_id: "official-example",
      release_id: "release-1",
      official: true,
      scan_status: "findings",
      scan_tool: "trivy",
      scanned_at: new Date("2026-05-17T00:00:00Z"),
      scan_summary: {
        status: "findings",
        tool: "trivy",
        severity_counts: { critical: 1 },
      },
    };
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
