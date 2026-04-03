/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { rebuildAccountProjectIndex } from "./account-project-index";

const LOCAL_BAY_ID = "bay-local";
const OTHER_BAY_ID = "bay-other";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_VISIBLE = "22222222-2222-4222-8222-222222222222";
const PROJECT_HIDDEN = "33333333-3333-4333-8333-333333333333";

describe("account_project_index rebuild", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(
      "TRUNCATE account_project_index, projects, accounts CASCADE",
    );
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("rebuilds projected project summaries for a home-bay account", async () => {
    await getPool().query(
      `INSERT INTO accounts (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES ($1, 'Test', 'User', NOW(), 'test-user@example.com', $2)`,
      [ACCOUNT_ID, LOCAL_BAY_ID],
    );
    await getPool().query(
      `INSERT INTO projects
        (project_id, title, description, users, state, host_id, owning_bay_id, last_edited, last_active, created)
       VALUES
        ($1, 'Visible Project', 'shown', $3, $4, $5, $6, NOW(), $7, NOW()),
        ($2, 'Hidden Project', 'hidden', $8, $9, NULL, NULL, NOW(), $10, NOW())`,
      [
        PROJECT_VISIBLE,
        PROJECT_HIDDEN,
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
        }),
        JSON.stringify({ state: "running" }),
        "44444444-4444-4444-8444-444444444444",
        LOCAL_BAY_ID,
        JSON.stringify({
          [ACCOUNT_ID]: "2026-04-03T22:00:00.000Z",
        }),
        JSON.stringify({
          [ACCOUNT_ID]: { group: "collaborator", hide: true },
        }),
        JSON.stringify({ state: "stopped" }),
        JSON.stringify({
          [ACCOUNT_ID]: "2026-04-03T21:00:00.000Z",
        }),
      ],
    );

    await expect(
      rebuildAccountProjectIndex({
        account_id: ACCOUNT_ID,
        bay_id: LOCAL_BAY_ID,
      }),
    ).resolves.toMatchObject({
      bay_id: LOCAL_BAY_ID,
      target_account_id: ACCOUNT_ID,
      dry_run: true,
      existing_rows: 0,
      source_rows: 2,
      visible_rows: 1,
      hidden_rows: 1,
      deleted_rows: 0,
      inserted_rows: 0,
    });

    await expect(
      rebuildAccountProjectIndex({
        account_id: ACCOUNT_ID,
        bay_id: LOCAL_BAY_ID,
        dry_run: false,
      }),
    ).resolves.toMatchObject({
      bay_id: LOCAL_BAY_ID,
      target_account_id: ACCOUNT_ID,
      dry_run: false,
      existing_rows: 0,
      source_rows: 2,
      visible_rows: 1,
      hidden_rows: 1,
      deleted_rows: 0,
      inserted_rows: 2,
    });

    const { rows } = await getPool().query(
      `SELECT project_id, owning_bay_id, host_id, title, description, is_hidden,
              users_summary, state_summary
         FROM account_project_index
        WHERE account_id = $1
        ORDER BY project_id`,
      [ACCOUNT_ID],
    );
    expect(rows).toEqual([
      {
        project_id: PROJECT_VISIBLE,
        owning_bay_id: LOCAL_BAY_ID,
        host_id: "44444444-4444-4444-8444-444444444444",
        title: "Visible Project",
        description: "shown",
        is_hidden: false,
        users_summary: {
          [ACCOUNT_ID]: { group: "owner" },
        },
        state_summary: { state: "running" },
      },
      {
        project_id: PROJECT_HIDDEN,
        owning_bay_id: LOCAL_BAY_ID,
        host_id: null,
        title: "Hidden Project",
        description: "hidden",
        is_hidden: true,
        users_summary: {
          [ACCOUNT_ID]: { group: "collaborator", hide: true },
        },
        state_summary: { state: "stopped" },
      },
    ]);
  });

  it("rejects accounts homed in another bay", async () => {
    await getPool().query(
      `INSERT INTO accounts (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES ($1, 'Wrong', 'Bay', NOW(), 'wrong-bay@example.com', $2)`,
      [ACCOUNT_ID, OTHER_BAY_ID],
    );

    await expect(
      rebuildAccountProjectIndex({
        account_id: ACCOUNT_ID,
        bay_id: LOCAL_BAY_ID,
      }),
    ).rejects.toThrow(
      `account '${ACCOUNT_ID}' is not homed in bay '${LOCAL_BAY_ID}'`,
    );
  });
});
