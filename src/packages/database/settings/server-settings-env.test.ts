/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { load_server_settings_from_env } from "./server-settings";

function fakeDb() {
  return {
    async_query: jest.fn(async () => ({ rows: [] })),
    set_server_setting: jest.fn((opts: { cb: (err?: unknown) => void }) =>
      opts.cb(),
    ),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("server settings from the environment", () => {
  it("refuses the federated connector gate, before writing anything", async () => {
    process.env.COCALC_SETTING_SITE_NAME = "Fake";
    process.env.COCALC_SETTING_FEDERATED_CLI_CONNECTORS = "gcloud";
    const db = fakeDb();
    await expect(load_server_settings_from_env(db as any)).rejects.toThrow(
      /COCALC_SETTING_FEDERATED_CLI_CONNECTORS is not allowed/,
    );
    expect(db.async_query).not.toHaveBeenCalled();
    expect(db.set_server_setting).not.toHaveBeenCalled();
  });

  it.each(["FEDERATED_BROKER_SIGNER", "FEDERATED_ISSUER_KEY_PINS"])(
    "refuses COCALC_SETTING_%s too",
    async (name) => {
      process.env[`COCALC_SETTING_${name}`] = "x";
      const db = fakeDb();
      await expect(load_server_settings_from_env(db as any)).rejects.toThrow(
        /is not allowed/,
      );
      expect(db.async_query).not.toHaveBeenCalled();
    },
  );

  it("still loads other settings", async () => {
    process.env.COCALC_SETTING_SITE_NAME = "Fake";
    const db = fakeDb();
    await load_server_settings_from_env(db as any);
    expect(db.set_server_setting).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "site_name",
        value: "Fake",
        readonly: true,
      }),
    );
  });
});
