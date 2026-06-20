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
      scanner_image: "docker.io/aquasec/trivy:latest",
      trivy_cache_dir: "/mnt/cocalc/data/trivy-cache",
      timeout_ms: 30 * 60 * 1000,
    });
  });
});
