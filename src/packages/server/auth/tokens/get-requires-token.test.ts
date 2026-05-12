/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const getServerSettingsMock = jest.fn();
const isMultiBayClusterMock = jest.fn();
const getConfiguredClusterRoleMock = jest.fn();
const getInterBayFabricClientMock = jest.fn();
const requiresTokenMock = jest.fn();

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: (...args: any[]) => isMultiBayClusterMock(...args),
  getConfiguredClusterRole: (...args: any[]) =>
    getConfiguredClusterRoleMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: (...args: any[]) =>
    getInterBayFabricClientMock(...args),
}));

jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAuthTokenClient: () => ({
    requiresToken: (...args: any[]) => requiresTokenMock(...args),
  }),
}));

describe("registration token requirement", () => {
  beforeEach(() => {
    jest.resetModules();
    getServerSettingsMock.mockReset().mockResolvedValue({
      public_signup_without_registration_token: false,
    });
    isMultiBayClusterMock.mockReset().mockReturnValue(false);
    getConfiguredClusterRoleMock.mockReset().mockReturnValue("seed");
    getInterBayFabricClientMock.mockReset().mockReturnValue({});
    requiresTokenMock.mockReset().mockResolvedValue(true);
  });

  it("requires registration tokens by default", async () => {
    const { getRequiresTokensDirect } = await import("./get-requires-token");
    await expect(getRequiresTokensDirect()).resolves.toBe(true);
  });

  it("allows public signup only when explicitly enabled", async () => {
    getServerSettingsMock.mockResolvedValue({
      public_signup_without_registration_token: true,
    });
    const { getRequiresTokensDirect } = await import("./get-requires-token");
    await expect(getRequiresTokensDirect()).resolves.toBe(false);
  });

  it("uses the local setting on seed or non-multibay nodes", async () => {
    isMultiBayClusterMock.mockReturnValue(true);
    getConfiguredClusterRoleMock.mockReturnValue("seed");
    const { default: getRequiresTokens } = await import("./get-requires-token");
    await expect(getRequiresTokens()).resolves.toBe(true);
    expect(requiresTokenMock).not.toHaveBeenCalled();
  });

  it("delegates attached multibay nodes to the seed", async () => {
    isMultiBayClusterMock.mockReturnValue(true);
    getConfiguredClusterRoleMock.mockReturnValue("attached");
    requiresTokenMock.mockResolvedValue(false);
    const { default: getRequiresTokens } = await import("./get-requires-token");
    await expect(getRequiresTokens()).resolves.toBe(false);
    expect(getInterBayFabricClientMock).toHaveBeenCalledTimes(1);
    expect(requiresTokenMock).toHaveBeenCalledWith({});
  });
});
