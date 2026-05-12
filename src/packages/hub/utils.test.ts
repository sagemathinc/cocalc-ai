/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const getServerSettingsMock = jest.fn();

jest.mock("./servers/server-settings", () => ({
  __esModule: true,
  default: (...args: any[]) => getServerSettingsMock(...args),
}));

describe("hub registration token policy", () => {
  beforeEach(() => {
    jest.resetModules();
    getServerSettingsMock.mockReset().mockResolvedValue({
      all: {
        public_signup_without_registration_token: false,
      },
    });
  });

  it("requires a registration token by default", async () => {
    const { requires_registration_token } = await import("./utils");
    await expect(requires_registration_token({} as any)).resolves.toBe(true);
  });

  it("only disables token requirement when public signup is explicitly enabled", async () => {
    getServerSettingsMock.mockResolvedValue({
      all: {
        public_signup_without_registration_token: true,
      },
    });
    const { requires_registration_token } = await import("./utils");
    await expect(requires_registration_token({} as any)).resolves.toBe(false);
  });
});
