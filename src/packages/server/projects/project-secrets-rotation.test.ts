/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Project secrets during a site master key rotation: values still under the
// retired key are readable, and project hosts are only ever sent values they
// can decrypt with the active key they receive.

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  decryptProjectSecretValue,
  encryptProjectSecretValue,
} from "@cocalc/util/project-secrets";

const ACTIVE = Buffer.alloc(32, 31);
const RETIRED = Buffer.alloc(32, 32);

jest.mock("@cocalc/backend/data", () => ({
  __esModule: true,
  secrets: "/tmp/cocalc-test-secrets",
}));

jest.mock("@cocalc/util/master-key-lifecycle", () => ({
  __esModule: true,
  ...jest.requireActual("@cocalc/util/master-key-lifecycle"),
  deriveSiteMasterKeyring: (keyring: any[]) => keyring,
  getSiteMasterKeyring: async () => [
    { id: "smk_active", role: "active", key: Buffer.alloc(32, 31) },
    { id: "smk_retired", role: "retired", key: Buffer.alloc(32, 32) },
  ],
}));

import {
  getProjectSecretsForRuntime,
  getProjectSecretsRuntimeCache,
  listProjectSecrets,
} from "./project-secrets";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

describe("project secrets across a site master key rotation", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
    await getPool().query(
      "INSERT INTO projects (project_id, title, users, last_edited) VALUES ($1, 'p', $2, NOW())",
      [PROJECT_ID, JSON.stringify({ [ACCOUNT_ID]: { group: "owner" } })],
    );
    // Creates the tables.
    await listProjectSecrets({ project_id: PROJECT_ID });
    await getPool().query(
      `INSERT INTO project_secrets (project_id, name, encrypted_value, value_bytes)
       VALUES ($1, 'OLD', $2, 3)`,
      [
        PROJECT_ID,
        JSON.stringify(
          encryptProjectSecretValue({
            project_id: PROJECT_ID,
            name: "OLD",
            value: "old",
            key: RETIRED,
          }),
        ),
      ],
    );
  }, 15000);

  afterAll(async () => {
    await getPool().end();
  });

  it("reads a value still encrypted under the retired key", async () => {
    await expect(
      getProjectSecretsForRuntime({ project_id: PROJECT_ID }),
    ).resolves.toEqual({ OLD: "old" });
  });

  it("sends hosts the value rewrapped under the active key it sends", async () => {
    const cache = await getProjectSecretsRuntimeCache({
      project_id: PROJECT_ID,
    });
    expect(Buffer.from(cache.key_base64, "base64").equals(ACTIVE)).toBe(true);
    expect(
      decryptProjectSecretValue({
        project_id: PROJECT_ID,
        name: "OLD",
        encrypted: cache.entries[0].encrypted_value,
        key: ACTIVE,
      }),
    ).toBe("old");
  });
});
