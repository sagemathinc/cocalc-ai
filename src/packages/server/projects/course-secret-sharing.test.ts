/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";

jest.mock("@cocalc/backend/data", () => ({
  __esModule: true,
  secrets: "/tmp/cocalc-course-secret-test",
}));

jest.mock("@cocalc/util/master-key-lifecycle", () => ({
  __esModule: true,
  ...jest.requireActual("@cocalc/util/master-key-lifecycle"),
  deriveSiteMasterKey: (key: Buffer) => key,
  deriveSiteMasterKeyring: (keyring: any[]) => keyring,
  getOrCreateSiteMasterKey: async () => Buffer.alloc(32, 12),
  getSiteMasterKeyring: async () => [
    { id: "smk_test", role: "active", key: Buffer.alloc(32, 12) },
  ],
}));

import {
  approveCourseSecretRecipients,
  assertCourseSecretPolicyGeneration,
  beginCourseSecretRun,
  getCourseSecretPolicyState,
  revokeCourseSecretPolicy,
  revokeCourseSecretRecipients,
  setCourseSecretGrants,
  setCourseSecretPolicyEnabled,
} from "./course-secret-sharing";
import {
  setProjectSecret,
  setProjectSecretCourseSharing,
} from "./project-secrets";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const COURSE_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const STUDENT_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const COURSE_ID = "55555555-5555-4555-8555-555555555555";
const COURSE_PATH = "courses/security.course";
const CANARY = "course-secret-canary-value-never-store-here";

async function insertProject(project_id: string): Promise<void> {
  await getPool().query(
    `INSERT INTO projects(project_id,title,users,last_edited)
     VALUES ($1,'Course Secret Test',$2,NOW())`,
    [project_id, JSON.stringify({ [ACCOUNT_ID]: { group: "owner" } })],
  );
}

describe("course secret sharing policy", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15_000);

  beforeEach(async () => {
    await getPool().query("DELETE FROM projects");
    await getPool().query("DELETE FROM accounts");
    await getPool().query(
      `INSERT INTO accounts(account_id,created,email_address)
       VALUES ($1,NOW(),$2)`,
      [ACCOUNT_ID, "course-secret@example.com"],
    );
    await insertProject(COURSE_PROJECT_ID);
    await insertProject(STUDENT_PROJECT_ID);
    await insertProject(OTHER_PROJECT_ID);
    await setProjectSecret({
      project_id: COURSE_PROJECT_ID,
      name: "OPENAI_API_KEY",
      value: CANARY,
      account_id: ACCOUNT_ID,
    });
    await setProjectSecretCourseSharing({
      project_id: COURSE_PROJECT_ID,
      name: "OPENAI_API_KEY",
      allow: true,
      account_id: ACCOUNT_ID,
    });
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("creates an inert policy and rejects a copied identity at another path", async () => {
    await expect(
      getCourseSecretPolicyState({
        course_project_id: COURSE_PROJECT_ID,
        course_id: COURSE_ID,
        course_path: COURSE_PATH,
      }),
    ).resolves.toBeNull();

    const state = await setCourseSecretGrants({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      names: ["OPENAI_API_KEY"],
      account_id: ACCOUNT_ID,
    });
    expect(state.policy.enabled).toBe(false);
    expect(state.grants).toEqual([
      expect.objectContaining({ name: "OPENAI_API_KEY", enabled: true }),
    ]);
    expect(state.recipients).toEqual([]);

    await expect(
      getCourseSecretPolicyState({
        course_project_id: COURSE_PROJECT_ID,
        course_id: COURSE_ID,
        course_path: "copied.course",
      }),
    ).rejects.toThrow("bound to another path");
  });

  it("pins policy generation and never approves a new project implicitly", async () => {
    let state = await setCourseSecretGrants({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      names: ["OPENAI_API_KEY"],
      account_id: ACCOUNT_ID,
    });
    state = await approveCourseSecretRecipients({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      recipients: [{ target_project_id: STUDENT_PROJECT_ID }],
      account_id: ACCOUNT_ID,
    });
    expect(
      state.recipients.filter(({ revoked_at }) => revoked_at == null),
    ).toEqual([
      expect.objectContaining({ target_project_id: STUDENT_PROJECT_ID }),
    ]);
    expect(
      state.recipients.some(
        ({ target_project_id }) => target_project_id === OTHER_PROJECT_ID,
      ),
    ).toBe(false);

    state = await setCourseSecretPolicyEnabled({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      enabled: true,
      account_id: ACCOUNT_ID,
    });
    const run = await beginCourseSecretRun({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      account_id: ACCOUNT_ID,
      mode: "sync",
    });
    expect(run.run.policy_generation).toBe(state.policy.generation);

    await revokeCourseSecretRecipients({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      target_project_ids: [STUDENT_PROJECT_ID],
      account_id: ACCOUNT_ID,
    });
    await expect(
      assertCourseSecretPolicyGeneration({
        policy_id: run.policy.policy_id,
        generation: run.run.policy_generation,
      }),
    ).rejects.toThrow("changed during synchronization");
  });

  it("invalidates an in-flight run when a selected source secret changes", async () => {
    await setCourseSecretGrants({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      names: ["OPENAI_API_KEY"],
      account_id: ACCOUNT_ID,
    });
    await approveCourseSecretRecipients({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      recipients: [{ target_project_id: STUDENT_PROJECT_ID }],
      account_id: ACCOUNT_ID,
    });
    await setCourseSecretPolicyEnabled({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      enabled: true,
      account_id: ACCOUNT_ID,
    });
    const run = await beginCourseSecretRun({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      account_id: ACCOUNT_ID,
      mode: "sync",
    });

    await setProjectSecret({
      project_id: COURSE_PROJECT_ID,
      name: "OPENAI_API_KEY",
      value: `${CANARY}-rotated`,
      account_id: ACCOUNT_ID,
    });

    await expect(
      assertCourseSecretPolicyGeneration({
        policy_id: run.policy.policy_id,
        generation: run.run.policy_generation,
      }),
    ).rejects.toThrow("changed during synchronization");
  });

  it("retains historical grants and recipients for cleanup after revocation", async () => {
    await setCourseSecretGrants({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      names: ["OPENAI_API_KEY"],
      account_id: ACCOUNT_ID,
    });
    await approveCourseSecretRecipients({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      recipients: [{ target_project_id: STUDENT_PROJECT_ID }],
      account_id: ACCOUNT_ID,
    });
    await revokeCourseSecretRecipients({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      target_project_ids: [STUDENT_PROJECT_ID],
      account_id: ACCOUNT_ID,
    });
    await revokeCourseSecretPolicy({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      account_id: ACCOUNT_ID,
    });

    const cleanup = await beginCourseSecretRun({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      account_id: ACCOUNT_ID,
      mode: "cleanup",
    });
    expect(cleanup.grants.map(({ name }) => name)).toEqual(["OPENAI_API_KEY"]);
    expect(
      cleanup.recipients.map(({ target_project_id }) => target_project_id),
    ).toEqual([STUDENT_PROJECT_ID]);
    await expect(
      assertCourseSecretPolicyGeneration({
        policy_id: cleanup.policy.policy_id,
        generation: cleanup.run.policy_generation,
        allow_disabled: true,
        allow_revoked: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("stores no plaintext value in policy, grant, recipient, run, or audit rows", async () => {
    await setCourseSecretGrants({
      course_project_id: COURSE_PROJECT_ID,
      course_id: COURSE_ID,
      course_path: COURSE_PATH,
      names: ["OPENAI_API_KEY"],
      account_id: ACCOUNT_ID,
    });
    const tables = [
      "course_secret_policies",
      "course_secret_grants",
      "course_secret_recipients",
      "course_secret_sync_runs",
      "course_secret_sync_results",
      "course_secret_audit_events",
    ];
    for (const table of tables) {
      const { rows } = await getPool().query(`SELECT * FROM ${table}`);
      expect(JSON.stringify(rows)).not.toContain(CANARY);
    }
  });
});
