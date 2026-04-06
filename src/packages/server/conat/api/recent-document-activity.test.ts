/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { listRecentDocumentActivity } from "./projects";

const LOCAL_BAY_ID = "bay-0";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";

describe("conat recent document activity api", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(
      `TRUNCATE file_access_log,
                projects,
                accounts
         CASCADE`,
    );
  });

  afterAll(async () => {
    await getPool().end();
  });

  async function seed() {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id, groups)
       VALUES
         ($1, 'Alice', 'Example', NOW(), 'alice@example.com', $3, ARRAY[]::TEXT[]),
         ($2, 'Bob', 'Example', NOW(), 'bob@example.com', $3, ARRAY[]::TEXT[])`,
      [ACCOUNT_ID, OTHER_ACCOUNT_ID, LOCAL_BAY_ID],
    );
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, users, owning_bay_id, created, last_edited, deleted)
       VALUES
         ($1, 'Project', $3::JSONB, $5, NOW(), NOW(), FALSE),
         ($2, 'Other', $4::JSONB, $5, NOW(), NOW(), FALSE)`,
      [
        PROJECT_ID,
        OTHER_PROJECT_ID,
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
        }),
        JSON.stringify({
          [OTHER_ACCOUNT_ID]: { group: "owner" },
        }),
        LOCAL_BAY_ID,
      ],
    );
    await getPool().query(
      `INSERT INTO file_access_log
         (id, project_id, account_id, filename, time, expire)
       VALUES
         ($1, $2, $3, 'recent.ipynb', $4, NOW() + interval '30 days'),
         ($5, $2, $6, 'recent.ipynb', $7, NOW() + interval '30 days'),
         ($8, $2, $3, 'older.ipynb',  $9, NOW() + interval '30 days'),
         ($10, $11, $6, 'hidden.ipynb', $4, NOW() + interval '30 days')`,
      [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        PROJECT_ID,
        ACCOUNT_ID,
        new Date("2026-04-05T06:00:00.000Z"),
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        OTHER_ACCOUNT_ID,
        new Date("2026-04-05T07:00:00.000Z"),
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        new Date("2026-03-01T06:00:00.000Z"),
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        OTHER_PROJECT_ID,
      ],
    );
  }

  it("lists recent entries only for projects visible to the account", async () => {
    await seed();

    const rows = await listRecentDocumentActivity({
      account_id: ACCOUNT_ID,
      limit: 10,
      max_age_s: 14 * 24 * 60 * 60,
    });

    expect(rows.map((row) => row.path)).toEqual(["recent.ipynb"]);
    expect(rows[0].project_id).toBe(PROJECT_ID);
    expect(rows[0].recent_account_ids).toEqual([OTHER_ACCOUNT_ID, ACCOUNT_ID]);
  });
});
