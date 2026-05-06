/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { delay } from "awaiting";
import { before, after, getPool } from "@cocalc/server/test";
import createProject from "@cocalc/server/projects/create";
import { uuid } from "@cocalc/util/misc";
import { createTestAccount } from "@cocalc/server/purchases/test-data";
import {
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
  let project_id: string;

  beforeAll(async () => {
    await createTestAccount(owner_account_id);
    await createTestAccount(student_account_id);
    await createTestAccount(explicit_usage_account_id);
    project_id = await createProject({
      account_id: owner_account_id,
      title: "Usage attribution test",
    });
    await delay(300);
  });

  it("defaults usage attribution to the owner", async () => {
    await expect(getProjectUsageAccountId(project_id)).resolves.toBe(
      owner_account_id,
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
    await delay(300);
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
    await delay(300);
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
});
