/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let getServerSettingsMock: jest.Mock;
let isAdminMock: jest.Mock;
let resolveMembershipForAccountMock: jest.Mock;

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  __esModule: true,
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

describe("launch kill switches", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";
  const sponsor_account_id = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    getServerSettingsMock = jest.fn(async () => ({}));
    isAdminMock = jest.fn(async () => false);
    resolveMembershipForAccountMock = jest.fn(async () => ({
      source: "free",
      class: "free",
      entitlements: {},
    }));
  });

  it("allows project creation when the switch is off", async () => {
    const { assertProjectCreationAllowed } = await import("./kill-switches");
    await expect(
      assertProjectCreationAllowed({ account_id }),
    ).resolves.toBeUndefined();
  });

  it("blocks non-admin project creation when the switch is on", async () => {
    getServerSettingsMock.mockResolvedValue({
      launch_disable_project_creation: true,
    });
    const { assertProjectCreationAllowed } = await import("./kill-switches");
    await expect(assertProjectCreationAllowed({ account_id })).rejects.toThrow(
      "Creating new projects is temporarily disabled",
    );
  });

  it("lets admins bypass project creation and host creation switches", async () => {
    getServerSettingsMock.mockResolvedValue({
      launch_disable_project_creation: true,
      launch_disable_user_host_create: true,
    });
    isAdminMock.mockResolvedValue(true);
    const { assertProjectCreationAllowed, assertUserHostCreateAllowed } =
      await import("./kill-switches");
    await expect(
      assertProjectCreationAllowed({ account_id }),
    ).resolves.toBeUndefined();
    await expect(
      assertUserHostCreateAllowed({ account_id }),
    ).resolves.toBeUndefined();
  });

  it("blocks write paths in read-mostly maintenance mode while preserving admin diagnosis paths", async () => {
    getServerSettingsMock.mockResolvedValue({
      launch_read_mostly_maintenance: true,
    });
    const {
      assertProjectCreationAllowed,
      assertUserHostCreateAllowed,
      assertFreeProjectStartAllowed,
      assertPaymentCheckoutAllowed,
      assertAiLaunchAllowed,
      isAiLaunchDisabled,
      isReadMostlyMaintenanceEnabled,
    } = await import("./kill-switches");

    await expect(isReadMostlyMaintenanceEnabled()).resolves.toBe(true);
    await expect(isAiLaunchDisabled()).resolves.toBe(true);
    await expect(assertProjectCreationAllowed({ account_id })).rejects.toThrow(
      "read-mostly maintenance mode",
    );
    await expect(assertUserHostCreateAllowed({ account_id })).rejects.toThrow(
      "read-mostly maintenance mode",
    );
    await expect(
      assertFreeProjectStartAllowed({
        actor_account_id: account_id,
        sponsor_account_id,
      }),
    ).rejects.toThrow("read-mostly maintenance mode");
    await expect(assertPaymentCheckoutAllowed()).rejects.toThrow(
      "read-mostly maintenance mode",
    );
    await expect(assertAiLaunchAllowed()).rejects.toThrow(
      "read-mostly maintenance mode",
    );

    isAdminMock.mockResolvedValue(true);
    await expect(
      assertProjectCreationAllowed({ account_id }),
    ).resolves.toBeUndefined();
    await expect(
      assertUserHostCreateAllowed({ account_id }),
    ).resolves.toBeUndefined();
    await expect(
      assertFreeProjectStartAllowed({
        actor_account_id: account_id,
        sponsor_account_id,
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks only free project starts when the free-start switch is on", async () => {
    getServerSettingsMock.mockResolvedValue({
      launch_disable_free_project_starts: true,
    });
    const { assertFreeProjectStartAllowed } = await import("./kill-switches");
    await expect(
      assertFreeProjectStartAllowed({
        actor_account_id: account_id,
        sponsor_account_id,
      }),
    ).rejects.toThrow("Starting free projects is temporarily disabled");

    resolveMembershipForAccountMock.mockResolvedValue({
      source: "subscription",
      class: "member",
      entitlements: {},
    });
    await expect(
      assertFreeProjectStartAllowed({
        actor_account_id: account_id,
        sponsor_account_id,
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks AI when the AI switch is on", async () => {
    getServerSettingsMock.mockResolvedValue({ launch_disable_ai: "yes" });
    const { assertAiLaunchAllowed, isAiLaunchDisabled } =
      await import("./kill-switches");
    await expect(isAiLaunchDisabled()).resolves.toBe(true);
    await expect(assertAiLaunchAllowed()).rejects.toThrow(
      "AI and Codex are temporarily disabled",
    );
  });

  it("blocks payment checkout when the checkout switch is on", async () => {
    getServerSettingsMock.mockResolvedValue({
      launch_disable_payment_checkout: "yes",
    });
    const { assertPaymentCheckoutAllowed } = await import("./kill-switches");
    await expect(assertPaymentCheckoutAllowed()).rejects.toThrow(
      "Payment checkout is temporarily disabled",
    );
  });
});
