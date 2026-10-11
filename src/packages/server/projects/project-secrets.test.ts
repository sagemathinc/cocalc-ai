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
  ...jest.requireActual("@cocalc/util/master-key-lifecycle"),
  deriveSiteMasterKey: (key: Buffer) => key,
  deriveSiteMasterKeyring: (keyring: any[]) => keyring,
  getOrCreateSiteMasterKey: async () => Buffer.alloc(32, 7),
  getSiteMasterKeyring: async () => [
    { id: "smk_test", role: "active", key: Buffer.alloc(32, 7) },
  ],
}));

import {
  copyProjectSecrets,
  deleteProjectSecret,
  exportProjectSecretsForCopy,
  getProjectSecretsRuntimeCache,
  getProjectSecretsForRuntime,
  importProjectSecretsForCopy,
  installCourseManagedProjectSecrets,
  listCourseShareableSecrets,
  listProjectSecrets,
  removeCourseManagedProjectSecrets,
  setProjectSecretCourseSharing,
  setProjectSecret,
  validateCourseSecretTargetAssociation,
} from "./project-secrets";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const COURSE_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_ID = "55555555-5555-4555-8555-555555555555";
const GRANT_ID = "66666666-6666-4666-8666-666666666666";

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
      getProjectSecretsRuntimeCache({ project_id: SOURCE_PROJECT_ID }),
    ).resolves.toEqual({
      key_base64: Buffer.alloc(32, 7).toString("base64"),
      generation: 1,
      entries: [
        expect.objectContaining({
          name: "API_KEY",
          value_bytes: 6,
          encrypted_value: expect.objectContaining({
            cipher: "aes-256-gcm",
            data_base64: expect.any(String),
          }),
        }),
      ],
    });

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

  it("excludes project-specific deploy identities from broad copies", async () => {
    await insertAccountAndProject(SOURCE_PROJECT_ID);
    await insertAccountAndProject(TARGET_PROJECT_ID);
    await setProjectSecret({
      project_id: SOURCE_PROJECT_ID,
      name: "SSH_PRIVATE_KEY",
      value: "must-not-be-cloned",
      account_id: ACCOUNT_ID,
    });
    await setProjectSecret({
      project_id: SOURCE_PROJECT_ID,
      name: "API_KEY",
      value: "copy-me",
      account_id: ACCOUNT_ID,
    });

    await expect(
      copyProjectSecrets({
        source_project_id: SOURCE_PROJECT_ID,
        target_project_id: TARGET_PROJECT_ID,
        exclude_names: ["SSH_PRIVATE_KEY"],
        account_id: ACCOUNT_ID,
      }),
    ).resolves.toEqual({
      copied: ["API_KEY"],
      conflicts: [],
      missing: [],
    });
    await expect(
      listProjectSecrets({ project_id: TARGET_PROJECT_ID }),
    ).resolves.toEqual([
      expect.objectContaining({ name: "API_KEY", value_bytes: 7 }),
    ]);
  });

  it("can refuse to overwrite an existing secret", async () => {
    await insertAccountAndProject(SOURCE_PROJECT_ID);

    await setProjectSecret({
      project_id: SOURCE_PROJECT_ID,
      name: "SSH_PRIVATE_KEY",
      value: "first",
      account_id: ACCOUNT_ID,
    });

    await expect(
      setProjectSecret({
        project_id: SOURCE_PROJECT_ID,
        name: "SSH_PRIVATE_KEY",
        value: "second",
        account_id: ACCOUNT_ID,
        overwrite: false,
      }),
    ).rejects.toThrow("project secret SSH_PRIVATE_KEY already exists");

    await expect(
      getProjectSecretsForRuntime({ project_id: SOURCE_PROJECT_ID }),
    ).resolves.toEqual({ SSH_PRIVATE_KEY: "first" });
  });

  it("exports plaintext for trusted inter-bay copy and imports re-encrypted values", async () => {
    await insertAccountAndProject(SOURCE_PROJECT_ID);
    await insertAccountAndProject(TARGET_PROJECT_ID);

    await setProjectSecret({
      project_id: SOURCE_PROJECT_ID,
      name: "API_KEY",
      value: "secret",
      account_id: ACCOUNT_ID,
    });

    await expect(
      exportProjectSecretsForCopy({
        project_id: SOURCE_PROJECT_ID,
        names: ["API_KEY", "MISSING"],
      }),
    ).resolves.toEqual({
      secrets: { API_KEY: "secret" },
      missing: ["MISSING"],
    });

    await expect(
      importProjectSecretsForCopy({
        project_id: TARGET_PROJECT_ID,
        secrets: { API_KEY: "secret" },
        account_id: ACCOUNT_ID,
      }),
    ).resolves.toEqual({
      copied: ["API_KEY"],
      conflicts: [],
      missing: [],
    });

    await expect(
      getProjectSecretsForRuntime({ project_id: TARGET_PROJECT_ID }),
    ).resolves.toEqual({ API_KEY: "secret" });
  });

  it("defaults course eligibility off and only decrypts explicitly eligible names", async () => {
    await insertAccountAndProject(SOURCE_PROJECT_ID);
    const created = await setProjectSecret({
      project_id: SOURCE_PROJECT_ID,
      name: "OPENAI_API_KEY",
      value: "source-value",
      account_id: ACCOUNT_ID,
    });
    expect(created.allow_course_sharing).toBe(false);
    await expect(
      listCourseShareableSecrets({ project_id: SOURCE_PROJECT_ID }),
    ).resolves.toEqual([]);

    await setProjectSecretCourseSharing({
      project_id: SOURCE_PROJECT_ID,
      name: "OPENAI_API_KEY",
      allow: true,
      account_id: ACCOUNT_ID,
    });
    await expect(
      listCourseShareableSecrets({ project_id: SOURCE_PROJECT_ID }),
    ).resolves.toEqual([
      expect.objectContaining({
        name: "OPENAI_API_KEY",
        allow_course_sharing: true,
      }),
    ]);
  });

  it("installs only provenance-matched course secrets and protects them from generic mutation", async () => {
    await insertAccountAndProject(SOURCE_PROJECT_ID);
    await insertAccountAndProject(TARGET_PROJECT_ID);
    await getPool().query("UPDATE projects SET course=$1 WHERE project_id=$2", [
      JSON.stringify({
        type: "student",
        project_id: SOURCE_PROJECT_ID,
        path: "class/test.course",
      }),
      TARGET_PROJECT_ID,
    ]);

    await expect(
      installCourseManagedProjectSecrets({
        project_id: TARGET_PROJECT_ID,
        course_project_id: SOURCE_PROJECT_ID,
        course_id: COURSE_ID,
        course_path: "class/test.course",
        policy_id: POLICY_ID,
        secrets: [
          {
            name: "OPENAI_API_KEY",
            value: "first",
            source_revision: 1,
            grant_id: GRANT_ID,
          },
        ],
        account_id: ACCOUNT_ID,
      }),
    ).resolves.toEqual({
      copied: ["OPENAI_API_KEY"],
      unchanged: [],
      conflicts: [],
    });
    await expect(
      setProjectSecret({
        project_id: TARGET_PROJECT_ID,
        name: "OPENAI_API_KEY",
        value: "unmanaged-replacement",
        account_id: ACCOUNT_ID,
      }),
    ).rejects.toThrow("managed by a course");
    await expect(
      deleteProjectSecret({
        project_id: TARGET_PROJECT_ID,
        name: "OPENAI_API_KEY",
        account_id: ACCOUNT_ID,
      }),
    ).rejects.toThrow("managed by a course");

    await expect(
      installCourseManagedProjectSecrets({
        project_id: TARGET_PROJECT_ID,
        course_project_id: SOURCE_PROJECT_ID,
        course_id: COURSE_ID,
        course_path: "class/test.course",
        policy_id: POLICY_ID,
        secrets: [
          {
            name: "OPENAI_API_KEY",
            value: "second",
            source_revision: 2,
            grant_id: GRANT_ID,
          },
        ],
        account_id: ACCOUNT_ID,
      }),
    ).resolves.toEqual({
      copied: ["OPENAI_API_KEY"],
      unchanged: [],
      conflicts: [],
    });
    await expect(
      getProjectSecretsForRuntime({ project_id: TARGET_PROJECT_ID }),
    ).resolves.toEqual({ OPENAI_API_KEY: "second" });

    await expect(
      removeCourseManagedProjectSecrets({
        project_id: TARGET_PROJECT_ID,
        policy_id: POLICY_ID,
        account_id: ACCOUNT_ID,
      }),
    ).resolves.toEqual({ removed: ["OPENAI_API_KEY"] });
  });

  it("rejects course-managed installation when the target association differs", async () => {
    await insertAccountAndProject(SOURCE_PROJECT_ID);
    await insertAccountAndProject(TARGET_PROJECT_ID);
    await getPool().query("UPDATE projects SET course=$1 WHERE project_id=$2", [
      JSON.stringify({
        type: "student",
        project_id: SOURCE_PROJECT_ID,
        path: "other.course",
      }),
      TARGET_PROJECT_ID,
    ]);
    await expect(
      installCourseManagedProjectSecrets({
        project_id: TARGET_PROJECT_ID,
        course_project_id: SOURCE_PROJECT_ID,
        course_id: COURSE_ID,
        course_path: "test.course",
        policy_id: POLICY_ID,
        secrets: [
          {
            name: "KEY",
            value: "value",
            source_revision: 1,
            grant_id: GRANT_ID,
          },
        ],
        account_id: ACCOUNT_ID,
      }),
    ).rejects.toThrow("not linked to this course");
  });

  it("validates target course association without trusting caller-supplied identity", async () => {
    await insertAccountAndProject(SOURCE_PROJECT_ID);
    await insertAccountAndProject(TARGET_PROJECT_ID);
    await getPool().query("UPDATE projects SET course=$1 WHERE project_id=$2", [
      JSON.stringify({
        type: "student",
        project_id: SOURCE_PROJECT_ID,
        path: "class/test.course",
      }),
      TARGET_PROJECT_ID,
    ]);
    await expect(
      validateCourseSecretTargetAssociation({
        project_id: TARGET_PROJECT_ID,
        course_project_id: SOURCE_PROJECT_ID,
        course_path: "class/test.course",
      }),
    ).resolves.toBe("eligible");
    await expect(
      validateCourseSecretTargetAssociation({
        project_id: TARGET_PROJECT_ID,
        course_project_id: SOURCE_PROJECT_ID,
        course_path: "other.course",
      }),
    ).resolves.toBe("wrong_course_path");
    await getPool().query(
      "UPDATE projects SET deleted=TRUE WHERE project_id=$1",
      [TARGET_PROJECT_ID],
    );
    await expect(
      validateCourseSecretTargetAssociation({
        project_id: TARGET_PROJECT_ID,
        course_project_id: SOURCE_PROJECT_ID,
        course_path: "class/test.course",
      }),
    ).resolves.toBe("not_found");
  });
});
