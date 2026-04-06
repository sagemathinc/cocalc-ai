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
      `TRUNCATE file_use,
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
      `INSERT INTO file_use
         (id, project_id, path, last_edited, users)
       VALUES
         ($1, $3, 'recent.ipynb', $5, $7::JSONB),
         ($2, $3, 'older.ipynb',  $6, $8::JSONB),
         ($4, $9, 'hidden.ipynb', $5, $7::JSONB)`,
      [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        PROJECT_ID,
        "cccccccccccccccccccccccccccccccccccccccc",
        new Date("2026-04-05T06:00:00.000Z"),
        new Date("2026-03-01T06:00:00.000Z"),
        JSON.stringify({
          [ACCOUNT_ID]: { edit: "2026-04-05T06:00:00.000Z" },
        }),
        JSON.stringify({
          [ACCOUNT_ID]: { edit: "2026-03-01T06:00:00.000Z" },
        }),
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
  });
});
