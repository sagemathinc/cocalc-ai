/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Environment loading ignores only the one-way refusal for password_kdf;
// any other failure (e.g. the database) still stops the load.

import { PASSWORD_KDF_ONE_WAY_ERROR } from "@cocalc/util/db-schema/password-kdf";
import { load_server_settings_from_env } from "./server-settings";

const ENV = "COCALC_SETTING_PASSWORD_KDF";

function fakeDb(error?: string) {
  const writes: string[] = [];
  return {
    writes,
    db: {
      async_query: async () => undefined,
      set_server_setting: (opts: { name: string; value: string; cb }) => {
        writes.push(`${opts.name}=${opts.value}`);
        opts.cb(error);
      },
    } as any,
  };
}

describe("password_kdf from the environment", () => {
  afterEach(() => {
    delete process.env[ENV];
  });

  it("logs and ignores a stale legacy value refused as one-way", async () => {
    process.env[ENV] = "legacy";
    const { db, writes } = fakeDb(PASSWORD_KDF_ONE_WAY_ERROR);
    await expect(load_server_settings_from_env(db)).resolves.toBeUndefined();
    expect(writes).toEqual(["password_kdf=legacy"]);
  });

  it("stops loading on any other failure, e.g. setting scrypt", async () => {
    process.env[ENV] = "scrypt";
    const { db } = fakeDb("connection terminated");
    await expect(load_server_settings_from_env(db)).rejects.toEqual(
      "connection terminated",
    );
  });
});
