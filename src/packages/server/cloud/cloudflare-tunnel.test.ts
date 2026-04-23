/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let getServerSettingsMock: jest.Mock;

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

describe("ensureCloudflareTunnelForHost", () => {
  beforeEach(() => {
    jest.resetModules();
    getServerSettingsMock = jest.fn(async () => ({}));
  });

  it("reuses existing tunnel metadata when the current bay cannot manage Cloudflare", async () => {
    const existing = {
      id: "tunnel-id",
      name: "cocalc-host-host-123",
      hostname: "host-host-123.example.test",
      ssh_hostname: "ssh-host-host-123.example.test",
      tunnel_secret: "secret",
      account_id: "account-id",
      token: "token",
    };
    const { ensureCloudflareTunnelForHost } =
      await import("./cloudflare-tunnel");

    await expect(
      ensureCloudflareTunnelForHost({
        host_id: "host-123",
        existing,
      }),
    ).resolves.toBe(existing);
  });
});
