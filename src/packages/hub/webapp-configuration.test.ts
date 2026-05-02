/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockGetPassportManager = jest.fn();
const mockGetServerSettings = jest.fn();
const mockHaveActiveRegistrationTokens = jest.fn();
const mockGetLaunchpadCloudflaredStatus = jest.fn();
const mockGetPoolQuery = jest.fn();

jest.mock("@cocalc/server/hub/auth", () => ({
  get_passport_manager: (...args) => mockGetPassportManager(...args),
}));

jest.mock("./servers/server-settings", () => ({
  __esModule: true,
  default: (...args) => mockGetServerSettings(...args),
}));

jest.mock("./utils", () => ({
  have_active_registration_tokens: (...args) =>
    mockHaveActiveRegistrationTokens(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: (...args) => mockGetPoolQuery(...args),
  }),
}));

jest.mock("@cocalc/server/launchpad/mode", () => ({
  getCocalcProduct: () => "launchpad",
  isLaunchpadProduct: () => true,
  isRocketProduct: () => false,
}));

jest.mock("@cocalc/server/launchpad/onprem-sshd", () => ({
  getLaunchpadCloudflaredStatus: (...args) =>
    mockGetLaunchpadCloudflaredStatus(...args),
}));

describe("webapp configuration", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetPassportManager.mockReset().mockReturnValue({
      get_strategies_v2: () => [{ name: "email", public: true }],
    });
    mockGetServerSettings.mockReset().mockResolvedValue({
      all: {
        ollama_configuration: {},
        custom_openai_configuration: {},
      },
      pub: {
        site_name: "CoCalc",
      },
      version: {},
      table: { on: jest.fn() },
    });
    mockHaveActiveRegistrationTokens.mockReset().mockResolvedValue(true);
    mockGetLaunchpadCloudflaredStatus.mockReset();
    mockGetPoolQuery.mockReset().mockResolvedValue({ rows: [] });
  });

  it("does not block forever when cloudflared status hangs", async () => {
    mockGetLaunchpadCloudflaredStatus.mockImplementation(
      () => new Promise(() => {}),
    );

    const { WebappConfiguration, clear_cache } =
      await import("./webapp-configuration");
    clear_cache();
    const config = new WebappConfiguration({
      db: { _query: jest.fn() } as any,
    });

    const result = await Promise.race([
      config.get({
        host: "127.0.0.1:9100",
        country: "XX",
      } as any),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), 1500),
      ),
    ]);

    expect(result).toMatchObject({
      configuration: {
        site_name: "CoCalc",
        dns: "127.0.0.1:9100",
        is_launchpad: true,
      },
      registration: true,
      strategies: [{ name: "email", public: true }],
      ollama: {},
      custom_openai: {},
    });
  });

  it("does not block forever when vanity lookup hangs", async () => {
    mockGetLaunchpadCloudflaredStatus.mockResolvedValue({
      enabled: true,
      running: true,
      hostname: "lite4b.cocalc.ai",
      error: null,
    });
    mockGetPoolQuery.mockImplementation(() => new Promise(() => {}));

    const { WebappConfiguration, clear_cache } =
      await import("./webapp-configuration");
    clear_cache();
    const config = new WebappConfiguration({
      db: { _query: jest.fn() } as any,
    });

    const result = await Promise.race([
      config.get({
        host: "lite4b.cocalc.ai",
        country: "XX",
      } as any),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), 1500),
      ),
    ]);

    expect(result).toMatchObject({
      configuration: {
        site_name: "CoCalc",
        dns: "lite4b.cocalc.ai",
        is_launchpad: true,
      },
      registration: true,
      strategies: [{ name: "email", public: true }],
      ollama: {},
      custom_openai: {},
    });
  });
});
