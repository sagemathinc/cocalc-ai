/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const getClusterAccountByIdDirectMock = jest.fn();
const updateClusterAccountBannedDirectMock = jest.fn();
const banUserMock = jest.fn();
const removeUserBanMock = jest.fn();
const remoteSetBanMock = jest.fn();

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-1"),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterRole: jest.fn(() => "seed"),
  isMultiBayCluster: jest.fn(() => true),
}));

jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: jest.fn(() => ({})),
}));

jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountDirectoryClient: jest.fn(() => ({
    updateBanned: (...args: any[]) =>
      updateClusterAccountBannedDirectMock(...args),
  })),
  createInterBayAccountLocalClient: jest.fn(() => ({
    setBan: (...args: any[]) => remoteSetBanMock(...args),
  })),
}));

jest.mock("@cocalc/server/accounts/cluster-directory", () => ({
  getClusterAccountByIdDirect: (...args: any[]) =>
    getClusterAccountByIdDirectMock(...args),
  updateClusterAccountBannedDirect: (...args: any[]) =>
    updateClusterAccountBannedDirectMock(...args),
}));

jest.mock("@cocalc/server/accounts/ban", () => ({
  banUser: (...args: any[]) => banUserMock(...args),
  removeUserBan: (...args: any[]) => removeUserBanMock(...args),
}));

describe("inter-bay account ban routing", () => {
  beforeEach(() => {
    jest.resetModules();
    getClusterAccountByIdDirectMock.mockReset();
    updateClusterAccountBannedDirectMock.mockReset().mockResolvedValue({
      account_id: "00000000-0000-4000-8000-000000000001",
      home_bay_id: "bay-1",
      banned: true,
    });
    banUserMock.mockReset().mockResolvedValue(undefined);
    removeUserBanMock.mockReset().mockResolvedValue(undefined);
    remoteSetBanMock.mockReset().mockResolvedValue({
      account_id: "00000000-0000-4000-8000-000000000001",
      home_bay_id: "bay-2",
      banned: true,
    });
  });

  it("applies local bans on the account home bay and syncs the directory", async () => {
    getClusterAccountByIdDirectMock.mockResolvedValue({
      account_id: "00000000-0000-4000-8000-000000000001",
      home_bay_id: "bay-1",
    });

    const { setClusterAccountBan } = await import("./accounts");
    await expect(
      setClusterAccountBan({
        account_id: "00000000-0000-4000-8000-000000000001",
        banned: true,
      }),
    ).resolves.toMatchObject({
      account_id: "00000000-0000-4000-8000-000000000001",
      home_bay_id: "bay-1",
      banned: true,
    });

    expect(banUserMock).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(remoteSetBanMock).not.toHaveBeenCalled();
    expect(updateClusterAccountBannedDirectMock).toHaveBeenCalledWith({
      account_id: "00000000-0000-4000-8000-000000000001",
      banned: true,
    });
  });

  it("routes bans to a remote account home bay before syncing the directory", async () => {
    getClusterAccountByIdDirectMock.mockResolvedValue({
      account_id: "00000000-0000-4000-8000-000000000001",
      home_bay_id: "bay-2",
    });

    const { setClusterAccountBan } = await import("./accounts");
    await setClusterAccountBan({
      account_id: "00000000-0000-4000-8000-000000000001",
      banned: true,
    });

    expect(remoteSetBanMock).toHaveBeenCalledWith({
      account_id: "00000000-0000-4000-8000-000000000001",
      banned: true,
    });
    expect(banUserMock).not.toHaveBeenCalled();
    expect(updateClusterAccountBannedDirectMock).toHaveBeenCalledWith({
      account_id: "00000000-0000-4000-8000-000000000001",
      banned: true,
    });
  });
});
