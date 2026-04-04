/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { drainAccountProjectIndexProjection } from "./account-project-index-projector";
import { appendProjectOutboxEventForProject } from "./project-events-outbox";

const LOCAL_BAY_ID = "bay-local";
const OTHER_BAY_ID = "bay-other";
const ACCOUNT_LOCAL = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const HOST_ID = "44444444-4444-4444-8444-444444444444";

describe("account_project_index projector", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(
      "TRUNCATE account_project_index, project_events_outbox, projects, accounts CASCADE",
    );
  });

  afterAll(async () => {
    await testCleanup();
  });

  async function seedBaseRows(): Promise<void> {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES
         ($1, 'Local', 'User', NOW(), 'local-user@example.com', $3),
         ($2, 'Other', 'User', NOW(), 'other-user@example.com', $4)`,
      [ACCOUNT_LOCAL, ACCOUNT_OTHER, LOCAL_BAY_ID, OTHER_BAY_ID],
    );
    await getPool().query(
      `INSERT INTO projects
        (project_id, title, description, users, state, host_id, owning_bay_id,
         created, last_edited, last_active)
       VALUES
        ($1, 'Projected Project', 'from outbox',
         $2::JSONB, $3::JSONB, $4, $5, NOW(), NOW(), $6::JSONB)`,
      [
        PROJECT_ID,
        JSON.stringify({
          [ACCOUNT_LOCAL]: { group: "owner" },
          [ACCOUNT_OTHER]: { group: "collaborator" },
        }),
        JSON.stringify({ state: "running" }),
        HOST_ID,
        LOCAL_BAY_ID,
        JSON.stringify({
          [ACCOUNT_LOCAL]: "2026-04-03T23:30:00.000Z",
          [ACCOUNT_OTHER]: "2026-04-03T23:20:00.000Z",
        }),
      ],
    );
  }

  it("supports dry-run drains without mutating projection or outbox state", async () => {
    await seedBaseRows();
    await appendProjectOutboxEventForProject({
      event_type: "project.created",
      project_id: PROJECT_ID,
      default_bay_id: LOCAL_BAY_ID,
    });

    await expect(
      drainAccountProjectIndexProjection({
        bay_id: LOCAL_BAY_ID,
        limit: 10,
        dry_run: true,
      }),
    ).resolves.toMatchObject({
      bay_id: LOCAL_BAY_ID,
      dry_run: true,
      requested_limit: 10,
      scanned_events: 1,
      applied_events: 1,
      inserted_rows: 1,
      deleted_rows: 0,
      event_types: {
        "project.created": 1,
      },
    });

    const indexRows = await getPool().query(
      "SELECT * FROM account_project_index WHERE project_id = $1",
      [PROJECT_ID],
    );
    expect(indexRows.rows).toHaveLength(0);

    const outboxRows = await getPool().query(
      "SELECT published_at FROM project_events_outbox WHERE project_id = $1",
      [PROJECT_ID],
    );
    expect(outboxRows.rows).toEqual([{ published_at: null }]);
  });

  it("projects local-home collaborators, preserves last_opened_at, and deletes on project.deleted", async () => {
    await seedBaseRows();
    await appendProjectOutboxEventForProject({
      event_type: "project.created",
      project_id: PROJECT_ID,
      default_bay_id: LOCAL_BAY_ID,
    });

    await expect(
      drainAccountProjectIndexProjection({
        bay_id: LOCAL_BAY_ID,
        limit: 10,
        dry_run: false,
      }),
    ).resolves.toMatchObject({
      applied_events: 1,
      inserted_rows: 1,
      deleted_rows: 0,
      event_types: {
        "project.created": 1,
      },
    });

    const firstRows = await getPool().query(
      `SELECT account_id, project_id, owning_bay_id, host_id, title, description,
              is_hidden, last_opened_at
         FROM account_project_index
        ORDER BY account_id`,
      [],
    );
    expect(firstRows.rows).toEqual([
      {
        account_id: ACCOUNT_LOCAL,
        project_id: PROJECT_ID,
        owning_bay_id: LOCAL_BAY_ID,
        host_id: HOST_ID,
        title: "Projected Project",
        description: "from outbox",
        is_hidden: false,
        last_opened_at: null,
      },
    ]);

    await getPool().query(
      `UPDATE account_project_index
          SET last_opened_at = $2
        WHERE account_id = $1
          AND project_id = $3`,
      [ACCOUNT_LOCAL, new Date("2026-04-03T23:45:00.000Z"), PROJECT_ID],
    );
    await getPool().query(
      `UPDATE projects
          SET state = $2::JSONB
        WHERE project_id = $1`,
      [PROJECT_ID, JSON.stringify({ state: "stopped" })],
    );
    await appendProjectOutboxEventForProject({
      event_type: "project.state_changed",
      project_id: PROJECT_ID,
      default_bay_id: LOCAL_BAY_ID,
    });

    await expect(
      drainAccountProjectIndexProjection({
        bay_id: LOCAL_BAY_ID,
        limit: 10,
        dry_run: false,
      }),
    ).resolves.toMatchObject({
      applied_events: 1,
      inserted_rows: 1,
      deleted_rows: 1,
      event_types: {
        "project.state_changed": 1,
      },
    });

    const updatedRows = await getPool().query(
      `SELECT account_id, last_opened_at, state_summary
         FROM account_project_index
        WHERE project_id = $1`,
      [PROJECT_ID],
    );
    expect(updatedRows.rows).toEqual([
      {
        account_id: ACCOUNT_LOCAL,
        last_opened_at: new Date("2026-04-03T23:45:00.000Z"),
        state_summary: { state: "stopped" },
      },
    ]);

    await getPool().query(
      `UPDATE projects
          SET deleted = TRUE
        WHERE project_id = $1`,
      [PROJECT_ID],
    );
    await appendProjectOutboxEventForProject({
      event_type: "project.deleted",
      project_id: PROJECT_ID,
      default_bay_id: LOCAL_BAY_ID,
    });

    await expect(
      drainAccountProjectIndexProjection({
        bay_id: LOCAL_BAY_ID,
        limit: 10,
        dry_run: false,
      }),
    ).resolves.toMatchObject({
      applied_events: 1,
      inserted_rows: 0,
      deleted_rows: 1,
      event_types: {
        "project.deleted": 1,
      },
    });

    const deletedRows = await getPool().query(
      "SELECT * FROM account_project_index WHERE project_id = $1",
      [PROJECT_ID],
    );
    expect(deletedRows.rows).toHaveLength(0);

    const publishedRows = await getPool().query(
      `SELECT event_type, published_at IS NOT NULL AS published
         FROM project_events_outbox
        ORDER BY created_at, event_id`,
      [],
    );
    expect(publishedRows.rows).toEqual([
      { event_type: "project.created", published: true },
      { event_type: "project.state_changed", published: true },
      { event_type: "project.deleted", published: true },
    ]);
  });
});
