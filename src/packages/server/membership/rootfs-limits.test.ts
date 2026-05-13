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

  beforeEach(() => {
    jest.resetModules();
    usage = { count: 0, total_storage_bytes: 0 };
    existing = undefined;
    trusted = false;
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
});
