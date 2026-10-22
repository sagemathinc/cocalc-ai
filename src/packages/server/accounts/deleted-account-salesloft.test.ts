/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const getServerSettingsMock = jest.fn();
const removeDeletedUsersMock = jest.fn();

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("@cocalc/server/salesloft/sync", () => ({
  __esModule: true,
  removeDeletedUsers: (...args: any[]) => removeDeletedUsersMock(...args),
}));

describe("salesloft people of deleted accounts", () => {
  beforeEach(() => {
    getServerSettingsMock.mockReset();
    removeDeletedUsersMock.mockReset().mockResolvedValue({
      deleted: 2,
      failed: 0,
    });
  });

  it("are deleted by the retention loop when salesloft is configured", async () => {
    getServerSettingsMock.mockResolvedValue({ salesloft_api_key: "key" });
    const { purgeDeletedAccountSalesloftPeople } =
      await import("./deleted-account-retention");
    expect(await purgeDeletedAccountSalesloftPeople()).toEqual({
      deleted: 2,
      failed: 0,
    });
    expect(removeDeletedUsersMock).toHaveBeenCalledTimes(1);
  });

  it("are left alone when salesloft is not configured", async () => {
    getServerSettingsMock.mockResolvedValue({ salesloft_api_key: "" });
    const { purgeDeletedAccountSalesloftPeople } =
      await import("./deleted-account-retention");
    expect(await purgeDeletedAccountSalesloftPeople()).toBeNull();
    expect(removeDeletedUsersMock).not.toHaveBeenCalled();
  });
});
