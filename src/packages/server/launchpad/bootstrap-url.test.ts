/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const siteURLMock = jest.fn();
const getConfiguredBayIdMock = jest.fn();
const getBayPublicOriginMock = jest.fn();

jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: (...args: any[]) => siteURLMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: (...args: any[]) => getConfiguredBayIdMock(...args),
}));

jest.mock("@cocalc/server/bay-public-origin", () => ({
  getBayPublicOrigin: (...args: any[]) => getBayPublicOriginMock(...args),
}));

describe("resolveLaunchpadBootstrapUrl", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    getConfiguredBayIdMock.mockReturnValue("bay-1");
    getBayPublicOriginMock.mockResolvedValue("https://bay-1-lite4b.cocalc.ai");
    siteURLMock.mockResolvedValue("https://lite4b.cocalc.ai");
  });

  it("uses the current bay public origin for attached-bay bootstrap", async () => {
    const { resolveLaunchpadBootstrapUrl } = await import("./bootstrap-url");
    await expect(
      resolveLaunchpadBootstrapUrl({ preferCurrentBay: true }),
    ).resolves.toEqual({ baseUrl: "https://bay-1-lite4b.cocalc.ai" });
    expect(getBayPublicOriginMock).toHaveBeenCalledWith("bay-1");
    expect(siteURLMock).not.toHaveBeenCalled();
  });

  it("falls back to the stable site URL when current bay origin is unavailable", async () => {
    getBayPublicOriginMock.mockResolvedValue(undefined);
    const { resolveLaunchpadBootstrapUrl } = await import("./bootstrap-url");
    await expect(
      resolveLaunchpadBootstrapUrl({ preferCurrentBay: true }),
    ).resolves.toEqual({ baseUrl: "https://lite4b.cocalc.ai" });
  });

  it("keeps the stable site URL as the default", async () => {
    const { resolveLaunchpadBootstrapUrl } = await import("./bootstrap-url");
    await expect(resolveLaunchpadBootstrapUrl()).resolves.toEqual({
      baseUrl: "https://lite4b.cocalc.ai",
    });
    expect(getBayPublicOriginMock).not.toHaveBeenCalled();
  });
});
