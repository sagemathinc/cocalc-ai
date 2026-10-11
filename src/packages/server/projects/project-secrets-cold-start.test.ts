/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Right after a hub restart the per-process schema setup has not run yet, but
// the tables exist. The first secret writes run in REPEATABLE READ
// transactions alongside the background setup; none may fail (they did, with
// "could not serialize access due to concurrent update", on lite2b).
// PGlite has one connection and serializes transactions, so this needs a real
// server.

import getPool, {
  initEphemeralDatabase,
  isPgliteEnabled,
} from "@cocalc/database/pool";

jest.mock("@cocalc/backend/data", () => ({
  // The real database settings: this test needs a real server.
  ...jest.requireActual("@cocalc/backend/data"),
  __esModule: true,
  secrets: "/tmp/cocalc-test-secrets",
}));

jest.mock("@cocalc/util/master-key-lifecycle", () => ({
  __esModule: true,
  ...jest.requireActual("@cocalc/util/master-key-lifecycle"),
  deriveSiteMasterKey: (key: Buffer) => key,
  deriveSiteMasterKeyring: (keyring: any[]) => keyring,
  getOrCreateSiteMasterKey: async () => Buffer.alloc(32, 7),
  getSiteMasterKeyring: async () => [
    { id: "smk_test", role: "active", key: Buffer.alloc(32, 7) },
  ],
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "77777777-7777-4777-8777-777777777777";

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 15000);

afterAll(async () => {
  await getPool().end();
});

(isPgliteEnabled() ? it.skip : it)(
  "accepts writes before the setup has finished in this process",
  async () => {
    await getPool().query(
      "INSERT INTO projects (project_id, title, users, last_edited) VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING",
      [
        PROJECT_ID,
        "Cold start",
        JSON.stringify({ [ACCOUNT_ID]: { group: "owner" } }),
      ],
    );
    // Create the tables, as on a running site.
    await jest.requireActual("./project-secrets").ensureProjectSecretsSchema();
    // A fresh copy of the module: its setup has not run, as after a restart.
    let secrets: typeof import("./project-secrets") | undefined;
    jest.isolateModules(() => {
      secrets = require("./project-secrets");
    });
    // One at a time, as on lite2b, where each of these failed. (Concurrent
    // writes to one project can conflict on its runtime generation row in any
    // case: REPEATABLE READ.)
    const errors: string[] = [];
    for (const [name, value] of [
      ["COLD_1", "v1"],
      ["COLD_2", "v2"],
      ["COLD_1", "again"],
      ["COLD_3", "v3"],
    ]) {
      try {
        await secrets!.setProjectSecret({
          project_id: PROJECT_ID,
          name,
          value,
          account_id: ACCOUNT_ID,
        });
      } catch (err) {
        errors.push(`${name}: ${err}`);
      }
    }
    expect(errors).toEqual([]);
    expect(
      (await secrets!.listProjectSecrets({ project_id: PROJECT_ID }))
        .map(({ name }) => name)
        .sort(),
    ).toEqual(["COLD_1", "COLD_2", "COLD_3"]);
  },
);
