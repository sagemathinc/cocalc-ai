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
    const { init } = await import("../../sqlite/user-query");
    init({ filename: process.env.COCALC_LITE_SQLITE_FILENAME, seed: false });
    return {
      ...(await import("../../api")),
      ...(await import("../../sqlite/database")),
    };
  }

  it("persists the local OpenAI API key through the actual dispatcher", async () => {
    const { hubApi, getRow } = await setup();

    await expect(
      hubApi.system.setSiteSettings({
        account_id: ACCOUNT_ID,
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
});
