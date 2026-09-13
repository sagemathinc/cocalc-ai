import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

const ACCOUNT_ID = "00000000-1000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "00000000-1000-4000-8000-000000000002";

describe("lite hub site settings", () => {
  const prevSqlite = process.env.COCALC_LITE_SQLITE_FILENAME;
  const prevAccountId = process.env.COCALC_ACCOUNT_ID;

  beforeEach(() => {
    jest.resetModules();
    process.env.COCALC_ACCOUNT_ID = ACCOUNT_ID;
  });

  afterEach(async () => {
    const { close } = await import("../../sqlite/user-query");
    close();
    if (prevSqlite == null) delete process.env.COCALC_LITE_SQLITE_FILENAME;
    else process.env.COCALC_LITE_SQLITE_FILENAME = prevSqlite;
    if (prevAccountId == null) delete process.env.COCALC_ACCOUNT_ID;
    else process.env.COCALC_ACCOUNT_ID = prevAccountId;
  });

  async function setup() {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lite-settings-api-"));
    process.env.COCALC_LITE_SQLITE_FILENAME = path.join(tmp, "lite.sqlite3");
    const userQueryModule = await import("../../sqlite/user-query");
    const { init } = userQueryModule;
    init({ filename: process.env.COCALC_LITE_SQLITE_FILENAME, seed: false });
    const freshAuth = await import("../../../site-settings-fresh-auth");
    freshAuth.configureLiteSiteSettingsFreshAuth("lite-access-token");
    return {
      ...(await import("../../api")),
      ...(await import("../../sqlite/database")),
      userQuery: userQueryModule.default,
      ...freshAuth,
    };
  }

  it("persists the local OpenAI API key through the actual dispatcher", async () => {
    const { authorizeLiteSiteSettings, hubApi, getRow } = await setup();
    const { fresh_auth_token } = authorizeLiteSiteSettings({
      access_token: "lite-access-token",
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
    });

    await expect(
      hubApi.system.setSiteSettings({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        fresh_auth_token,
        settings: [{ name: "openai_api_key", value: "sk-test" }],
      }),
    ).resolves.toMatchObject({ count: 1 });

    expect(
      getRow("server_settings", JSON.stringify({ name: "openai_api_key" })),
    ).toEqual({ name: "openai_api_key", value: "sk-test" });
  });

  it("rejects unrelated settings and non-local accounts", async () => {
    const { hubApi } = await setup();

    await expect(
      hubApi.system.setSiteSettings({
        account_id: ACCOUNT_ID,
        settings: [{ name: "stripe_secret_key", value: "secret" }],
      }),
    ).rejects.toThrow("not allowed in lite mode");
    await expect(
      hubApi.system.setSiteSettings({
        account_id: OTHER_ACCOUNT_ID,
        settings: [{ name: "openai_api_key", value: "sk-test" }],
      }),
    ).rejects.toThrow("local lite account");
  });

  it("requires a one-use authorization grant bound to the browser", async () => {
    const { authorizeLiteSiteSettings, hubApi } = await setup();
    const { fresh_auth_token } = authorizeLiteSiteSettings({
      access_token: "lite-access-token",
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
    });

    await expect(
      hubApi.system.setSiteSettings({
        account_id: ACCOUNT_ID,
        browser_id: "browser-2",
        fresh_auth_token,
        settings: [{ name: "openai_api_key", value: "sk-test" }],
      }),
    ).rejects.toThrow("fresh Lite authorization");
    await expect(
      hubApi.system.setSiteSettings({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        fresh_auth_token,
        settings: [{ name: "openai_api_key", value: "sk-test" }],
      }),
    ).rejects.toThrow("fresh Lite authorization");
  });

  it("rejects an incorrect Lite access token", async () => {
    const { authorizeLiteSiteSettings } = await setup();
    expect(() =>
      authorizeLiteSiteSettings({
        access_token: "incorrect-token",
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
      }),
    ).toThrow("invalid or unavailable");
  });

  it("blocks account and project principals from mutating protected tables", async () => {
    const { getRow, userQuery } = await setup();
    for (const principal of [
      { account_id: ACCOUNT_ID },
      { project_id: "00000000-2000-4000-8000-000000000001" },
    ]) {
      expect(() =>
        userQuery({
          ...principal,
          query: {
            site_settings: {
              name: "openai_api_key",
              value: "attacker-controlled",
            },
          },
          options: [{ set: true }],
        }),
      ).toThrow("dedicated domain API");
    }
    expect(
      getRow("server_settings", JSON.stringify({ name: "openai_api_key" })),
    ).toBeUndefined();
  });
});
