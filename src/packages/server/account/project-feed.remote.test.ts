/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  applyAccountProjectFeedRemoveOnHomeBay,
  applyAccountProjectFeedUpsertOnHomeBay,
} from "./project-feed";

jest.mock("./feed", () => ({
  publishAccountFeedEventBestEffort: jest.fn(async () => undefined),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const HOST_ID = "33333333-3333-4333-8333-333333333333";

describe("server/account/project-feed remote home-bay apply", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query("TRUNCATE account_project_index, accounts CASCADE");
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("upserts and removes account_project_index rows from forwarded events", async () => {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES
         ($1, 'Remote', 'Home', NOW(), 'remote-home@example.com', 'bay-1')`,
      [ACCOUNT_ID],
    );

    await applyAccountProjectFeedUpsertOnHomeBay({
      type: "project.upsert",
      ts: Date.UTC(2026, 3, 8, 23, 30, 0),
      account_id: ACCOUNT_ID,
      project: {
        project_id: PROJECT_ID,
        title: "Shared Project",
        description: "available from another bay",
        name: null,
        theme: null,
        host_id: HOST_ID,
        owning_bay_id: "bay-0",
        users: {
          [ACCOUNT_ID]: { group: "collaborator" },
        },
        state: {
          state: "running",
        },
        last_active: {
          [ACCOUNT_ID]: "2026-04-08T23:25:00.000Z",
        },
        last_edited: "2026-04-08T23:20:00.000Z",
        deleted: false,
      },
    });

    await expect(
      getPool().query(
        `SELECT project_id, owning_bay_id, host_id, title, description, is_hidden
           FROM account_project_index
          WHERE account_id = $1`,
        [ACCOUNT_ID],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          project_id: PROJECT_ID,
          owning_bay_id: "bay-0",
          host_id: HOST_ID,
          title: "Shared Project",
          description: "available from another bay",
          is_hidden: false,
        },
      ],
    });

    await applyAccountProjectFeedRemoveOnHomeBay({
      type: "project.remove",
      ts: Date.UTC(2026, 3, 8, 23, 31, 0),
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      reason: "membership_removed",
    });

    await expect(
      getPool().query(
        `SELECT COUNT(*)::INT AS count
           FROM account_project_index
          WHERE account_id = $1
            AND project_id = $2`,
        [ACCOUNT_ID, PROJECT_ID],
      ),
    ).resolves.toMatchObject({
      rows: [{ count: 0 }],
    });
  });
});
