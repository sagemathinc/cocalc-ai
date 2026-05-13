/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";

jest.mock("@cocalc/backend/data", () => ({
  __esModule: true,
  secrets: "/tmp/cocalc-test-secrets",
}));

jest.mock("@cocalc/util/master-key-lifecycle", () => ({
  __esModule: true,
  deriveSiteMasterKey: (key: Buffer) => key,
  getOrCreateSiteMasterKey: async () => Buffer.alloc(32, 7),
}));

import {
  copyProjectSecrets,
  deleteProjectSecret,
  getProjectSecretsForRuntime,
  listProjectSecrets,
  setProjectSecret,
} from "./project-secrets";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

async function insertAccountAndProject(project_id: string) {
  await getPool().query(
    "INSERT INTO accounts (account_id, created, email_address) VALUES ($1, NOW(), $2) ON CONFLICT DO NOTHING",
    [ACCOUNT_ID, `${ACCOUNT_ID}@example.com`],
  );
  await getPool().query(
    "INSERT INTO projects (project_id, title, users, last_edited) VALUES ($1, $2, $3, NOW())",
    [
      project_id,
      "Secret Test Project",
      JSON.stringify({
        [ACCOUNT_ID]: { group: "owner" },
      }),
    ],
  );
}

describe("project secrets database helpers", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  beforeEach(async () => {
    await getPool().query("DELETE FROM projects");
    await getPool().query("DELETE FROM accounts");
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("stores write-only metadata and deletes secrets", async () => {
    await insertAccountAndProject(SOURCE_PROJECT_ID);

    await expect(
      setProjectSecret({
        project_id: SOURCE_PROJECT_ID,
        name: "API_KEY",
        value: "secret",
        account_id: ACCOUNT_ID,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        project_id: SOURCE_PROJECT_ID,
        name: "API_KEY",
        value_bytes: 6,
        created_by: ACCOUNT_ID,
        updated_by: ACCOUNT_ID,
      }),
    );

    expect(await listProjectSecrets({ project_id: SOURCE_PROJECT_ID })).toEqual(
      [
        expect.objectContaining({
          project_id: SOURCE_PROJECT_ID,
          name: "API_KEY",
          value_bytes: 6,
        }),
      ],
    );
    await expect(
      getProjectSecretsForRuntime({ project_id: SOURCE_PROJECT_ID }),
    ).resolves.toEqual({ API_KEY: "secret" });

    await expect(
      deleteProjectSecret({
        project_id: SOURCE_PROJECT_ID,
        name: "API_KEY",
        account_id: ACCOUNT_ID,
      }),
    ).resolves.toBe(true);

    await expect(
      listProjectSecrets({ project_id: SOURCE_PROJECT_ID }),
    ).resolves.toEqual([]);
  });

  it("copies secrets between projects without exposing values", async () => {
    await insertAccountAndProject(SOURCE_PROJECT_ID);
    await insertAccountAndProject(TARGET_PROJECT_ID);

    await setProjectSecret({
      project_id: SOURCE_PROJECT_ID,
      name: "DEPLOY_KEY",
      value: "private-key",
      account_id: ACCOUNT_ID,
    });

    await expect(
      copyProjectSecrets({
        source_project_id: SOURCE_PROJECT_ID,
        target_project_id: TARGET_PROJECT_ID,
        names: ["DEPLOY_KEY"],
        account_id: ACCOUNT_ID,
      }),
    ).resolves.toEqual({
      copied: ["DEPLOY_KEY"],
      conflicts: [],
      missing: [],
    });

    await expect(
      listProjectSecrets({ project_id: TARGET_PROJECT_ID }),
    ).resolves.toEqual([
      expect.objectContaining({
        project_id: TARGET_PROJECT_ID,
        name: "DEPLOY_KEY",
        value_bytes: 11,
      }),
    ]);

    await expect(
      copyProjectSecrets({
        source_project_id: SOURCE_PROJECT_ID,
        target_project_id: TARGET_PROJECT_ID,
        names: ["DEPLOY_KEY"],
        account_id: ACCOUNT_ID,
      }),
    ).resolves.toEqual({
      copied: [],
      conflicts: ["DEPLOY_KEY"],
      missing: [],
    });
  });
});
