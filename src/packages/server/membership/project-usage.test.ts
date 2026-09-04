/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { before, after, getPool } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import { createTestAccount } from "@cocalc/server/purchases/test-data";
import {
  getProjectCollaborationAccountId,
  getProjectUserAccountIds,
  getProjectUsageAccountId,
  setProjectUsageAccountId,
} from "./project-usage";

beforeAll(async () => {
  await before();
}, 15000);
afterAll(after);

describe("project usage attribution", () => {
  const owner_account_id = uuid();
  const student_account_id = uuid();
  const explicit_usage_account_id = uuid();
  const project_id = uuid();
  const course_project_id = uuid();
  const guarded_project_id = uuid();

  beforeAll(async () => {
    await createTestAccount(owner_account_id);
    await createTestAccount(student_account_id);
    await createTestAccount(explicit_usage_account_id);
    await getPool().query(
      `INSERT INTO projects (project_id, title, users, last_edited)
       VALUES ($1, $2, $3::jsonb, NOW())`,
      [
        project_id,
        "Usage attribution test",
        JSON.stringify({
          [owner_account_id]: { group: "owner" },
        }),
      ],
    );
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, users, usage_account_id, last_edited)
       VALUES ($1, $2, $3::jsonb, $4, NOW())`,
      [
        course_project_id,
        "Parent course",
        JSON.stringify({
          [owner_account_id]: { group: "owner" },
        }),
        explicit_usage_account_id,
      ],
    );
    await getPool().query(
      `INSERT INTO projects (project_id, title, users, course, last_edited)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, NOW())`,
      [
        guarded_project_id,
        "Guarded course usage attribution",
        JSON.stringify({ [owner_account_id]: { group: "owner" } }),
        JSON.stringify({
          type: "student",
          project_id: course_project_id,
          email_address: "student@example.com",
        }),
      ],
    );
  });

  it("defaults usage attribution to the owner", async () => {
    await expect(getProjectUsageAccountId(project_id)).resolves.toBe(
      owner_account_id,
    );
  });

  it("lists every project user for sole-owner abuse attribution", async () => {
    await expect(getProjectUserAccountIds(project_id)).resolves.toEqual([
      owner_account_id,
    ]);
    await getPool().query(
      "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
      [
        project_id,
        JSON.stringify({
          [owner_account_id]: { group: "owner" },
          [student_account_id]: { group: "collaborator" },
        }),
      ],
    );
    await expect(getProjectUserAccountIds(project_id)).resolves.toEqual(
      [owner_account_id, student_account_id].sort(),
    );
    await getPool().query(
      "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
      [project_id, JSON.stringify({ [owner_account_id]: { group: "owner" } })],
    );
  });

  it("falls back to the student course account when configured", async () => {
    await getPool().query(
      "UPDATE projects SET course=$2::jsonb, usage_account_id=NULL WHERE project_id=$1",
      [
        project_id,
        JSON.stringify({
          type: "student",
          account_id: student_account_id,
          project_id,
          path: ".course",
          datastore: false,
        }),
      ],
    );
    const { rows } = await getPool().query(
      "SELECT course, usage_account_id FROM projects WHERE project_id=$1",
      [project_id],
    );
    expect(rows[0]?.course?.account_id).toBe(student_account_id);
    expect(rows[0]?.course?.type).toBe("student");
    expect(rows[0]?.usage_account_id).toBeNull();
    await expect(getProjectUsageAccountId(project_id)).resolves.toBe(
      student_account_id,
    );
  });

  it("prefers an explicit usage_account_id over the course account", async () => {
    await setProjectUsageAccountId({
      project_id,
      account_id: explicit_usage_account_id,
    });
    const { rows } = await getPool().query(
      "SELECT course, usage_account_id FROM projects WHERE project_id=$1",
      [project_id],
    );
    expect(rows[0]?.course?.account_id).toBe(student_account_id);
    expect(rows[0]?.usage_account_id).toBe(explicit_usage_account_id);
    await expect(getProjectUsageAccountId(project_id)).resolves.toBe(
      explicit_usage_account_id,
    );
  });

  it("atomically rejects stale course recipient attribution", async () => {
    await expect(
      setProjectUsageAccountId({
        project_id: guarded_project_id,
        account_id: student_account_id,
        expected_course_project_id: course_project_id,
        expected_course_email_address: "STUDENT@example.com",
      }),
    ).resolves.toBe(true);
    await getPool().query(
      `UPDATE projects
          SET course = jsonb_set(course, '{email_address}', $2::jsonb),
              usage_account_id = NULL
        WHERE project_id=$1`,
      [guarded_project_id, JSON.stringify("other@example.com")],
    );
    await expect(
      setProjectUsageAccountId({
        project_id: guarded_project_id,
        account_id: student_account_id,
        expected_course_project_id: course_project_id,
        expected_course_email_address: "student@example.com",
      }),
    ).resolves.toBe(false);
  });

  it("accepts the expected account if an email-only course project is claimed", async () => {
    await getPool().query(
      `UPDATE projects
          SET course = course || jsonb_build_object('account_id', $2::text),
              usage_account_id = NULL
        WHERE project_id=$1`,
      [guarded_project_id, student_account_id],
    );
    await expect(
      setProjectUsageAccountId({
        project_id: guarded_project_id,
        account_id: student_account_id,
        expected_course_project_id: course_project_id,
        expected_course_email_address: "student@example.com",
      }),
    ).resolves.toBe(true);
  });

  it("attributes managed-project collaboration to the parent course", async () => {
    await getPool().query(
      "UPDATE projects SET course=$2::jsonb WHERE project_id=$1",
      [
        project_id,
        JSON.stringify({
          type: "student",
          account_id: student_account_id,
          project_id: course_project_id,
          path: "class.course",
          datastore: false,
        }),
      ],
    );
    await expect(getProjectCollaborationAccountId(project_id)).resolves.toBe(
      explicit_usage_account_id,
    );
  });
});
