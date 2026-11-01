/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const getServerSettingsMock = jest.fn();

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

describe("RootFS scan execution config", () => {
  beforeEach(() => {
    getServerSettingsMock.mockReset();
  });

  it("rejects scans by default until RootFS scanning is explicitly enabled", async () => {
    getServerSettingsMock.mockResolvedValue({});
    const { getRootfsScanConfig } = await import("./scan-execution");

    await expect(getRootfsScanConfig({})).rejects.toThrow(
      "RootFS vulnerability scanning is disabled",
    );
  });

  it("loads default scanner config when RootFS scanning is enabled", async () => {
    getServerSettingsMock.mockResolvedValue({ rootfs_scan_enabled: true });
    const { getRootfsScanConfig } = await import("./scan-execution");

    await expect(getRootfsScanConfig({})).resolves.toMatchObject({
      scanner_image:
        "docker.io/aquasec/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c",
      trivy_cache_dir: "/mnt/cocalc/data/trivy-cache",
      timeout_ms: 30 * 60 * 1000,
    });
  });

  it("refuses a scanner image that is not pinned by digest", async () => {
    getServerSettingsMock.mockResolvedValue({
      rootfs_scan_enabled: true,
      rootfs_scan_container_image: "docker.io/aquasec/trivy:latest",
    });
    const { getRootfsScanConfig } = await import("./scan-execution");

    await expect(getRootfsScanConfig({})).rejects.toThrow(
      "not pinned by digest",
    );
    await expect(
      getRootfsScanConfig({ scanner_image: "registry.example/trivy:1" }),
    ).rejects.toThrow("not pinned by digest");
  });
});
