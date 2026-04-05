/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { listProjectLog } from "./projects";

const LOCAL_BAY_ID = "bay-0";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

describe("conat project log api", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(
      `TRUNCATE project_log,
                projects,
                accounts
         CASCADE`,
    );
  });

  afterAll(async () => {
    await getPool().end();
  });

  async function seedProjectLog() {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id, groups)
       VALUES
         ($1, 'Alice', 'Example', NOW(), 'alice@example.com', $2, ARRAY[]::TEXT[])`,
      [ACCOUNT_ID, LOCAL_BAY_ID],
    );
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, users, owning_bay_id, created, last_edited, deleted)
       VALUES
         ($1, 'Project', $2::JSONB, $3, NOW(), NOW(), FALSE)`,
      [
        PROJECT_ID,
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
        }),
        LOCAL_BAY_ID,
      ],
    );
    await getPool().query(
      `INSERT INTO project_log
         (id, project_id, account_id, time, event)
       VALUES
         ($1, $4, $5, $6, $7::JSONB),
         ($2, $4, $5, $8, $9::JSONB),
         ($3, $4, $5, $10, $11::JSONB)`,
      [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
        PROJECT_ID,
        ACCOUNT_ID,
        new Date("2026-04-05T06:00:00.000Z"),
        JSON.stringify({ event: "set", title: "Newest" }),
        new Date("2026-04-05T05:00:00.000Z"),
        JSON.stringify({ event: "set", title: "Middle" }),
        new Date("2026-04-05T04:00:00.000Z"),
        JSON.stringify({ event: "set", title: "Oldest" }),
      ],
    );
  }

  it("lists newest entries, older pages, and missing newer entries", async () => {
    await seedProjectLog();

    const firstPage = await listProjectLog({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      limit: 2,
    });
    expect(firstPage.entries.map((row) => row.id)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    ]);
    expect(firstPage.has_more).toBe(true);

    const olderPage = await listProjectLog({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      limit: 2,
      older_than: {
        id: firstPage.entries[1].id,
        time: firstPage.entries[1].time,
      },
    });
    expect(olderPage.entries.map((row) => row.id)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    ]);
    expect(olderPage.has_more).toBe(false);

    await getPool().query(
      `INSERT INTO project_log
         (id, project_id, account_id, time, event)
       VALUES
         ($1, $2, $3, $4, $5::JSONB)`,
      [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
        PROJECT_ID,
        ACCOUNT_ID,
        new Date("2026-04-05T06:30:00.000Z"),
        JSON.stringify({ event: "set", title: "Newest Again" }),
      ],
    );

    const newerPage = await listProjectLog({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      limit: 10,
      newer_than: {
        id: firstPage.entries[0].id,
        time: firstPage.entries[0].time,
      },
    });
    expect(newerPage.entries.map((row) => row.id)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
    ]);
    expect(newerPage.has_more).toBe(false);
  });
});
