/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import {
  drainAccountCollaboratorIndexProjection,
  getAccountCollaboratorIndexProjectionBacklogStatus,
} from "./account-collaborator-index-projector";
import { listProjectedCollaboratorsForAccount } from "./account-collaborator-index";
import { appendProjectOutboxEventForProject } from "./project-events-outbox";

const LOCAL_BAY_ID = "bay-local";
const OTHER_BAY_ID = "bay-other";
const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_C = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_D = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";

describe("account_collaborator_index projector", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(
      "TRUNCATE account_collaborator_index, project_events_outbox, projects, accounts CASCADE",
    );
  });

  afterAll(async () => {
    await testCleanup();
  });

  async function seedBaseRows(): Promise<void> {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id, profile)
       VALUES
         ($1, 'Alpha', 'Local', NOW(), 'alpha@example.com', $5, '{"image":"a.png"}'::JSONB),
         ($2, 'Beta', 'Local', NOW(), 'beta@example.com', $5, '{"image":"b.png"}'::JSONB),
         ($3, 'Gamma', 'Remote', NOW(), 'gamma@example.com', $6, '{"image":"c.png"}'::JSONB),
         ($4, 'Delta', 'Local', NOW(), 'delta@example.com', $5, '{"image":"d.png"}'::JSONB)`,
      [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C, ACCOUNT_D, LOCAL_BAY_ID, OTHER_BAY_ID],
    );
    await getPool().query(
      `INSERT INTO projects
        (project_id, title, description, users, owning_bay_id, created, last_edited, deleted)
       VALUES
        ($1, 'Projected Project', 'for collaborator projector', $2::JSONB, $3, NOW(), NOW(), FALSE)`,
      [
        PROJECT_ID,
        JSON.stringify({
          [ACCOUNT_A]: { group: "owner" },
          [ACCOUNT_B]: { group: "collaborator" },
          [ACCOUNT_C]: { group: "collaborator" },
        }),
        LOCAL_BAY_ID,
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
      drainAccountCollaboratorIndexProjection({
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
      feed_events: expect.any(Array),
      event_types: {
        "project.created": 1,
      },
    });

    const indexRows = await getPool().query(
      "SELECT * FROM account_collaborator_index WHERE account_id = $1",
      [ACCOUNT_A],
    );
    expect(indexRows.rows).toHaveLength(0);

    const outboxRows = await getPool().query(
      "SELECT published_at FROM project_events_outbox WHERE project_id = $1",
      [PROJECT_ID],
    );
    expect(outboxRows.rows).toEqual([{ published_at: null }]);
  });

  it("reports unpublished collaborator projector lag and per-type counts", async () => {
    await seedBaseRows();
    await appendProjectOutboxEventForProject({
      event_type: "project.created",
      project_id: PROJECT_ID,
      default_bay_id: LOCAL_BAY_ID,
    });
    await getPool().query(
      `UPDATE project_events_outbox
          SET created_at = $2
        WHERE project_id = $1
          AND event_type = 'project.created'`,
      [PROJECT_ID, new Date("2026-04-03T23:00:00.000Z")],
    );
    await getPool().query(
      `UPDATE projects
          SET users = $2::JSONB
        WHERE project_id = $1`,
      [
        PROJECT_ID,
        JSON.stringify({
          [ACCOUNT_A]: { group: "owner" },
          [ACCOUNT_C]: { group: "collaborator" },
        }),
      ],
    );
    await appendProjectOutboxEventForProject({
      event_type: "project.membership_changed",
      project_id: PROJECT_ID,
      default_bay_id: LOCAL_BAY_ID,
    });
    await getPool().query(
      `UPDATE project_events_outbox
          SET created_at = $2
        WHERE project_id = $1
          AND event_type = 'project.membership_changed'`,
      [PROJECT_ID, new Date("2026-04-03T23:45:00.000Z")],
    );

    await expect(
      getAccountCollaboratorIndexProjectionBacklogStatus({
        bay_id: LOCAL_BAY_ID,
        now: new Date("2026-04-04T00:00:00.000Z"),
      }),
    ).resolves.toEqual({
      bay_id: LOCAL_BAY_ID,
      checked_at: "2026-04-04T00:00:00.000Z",
      unpublished_events: 2,
      unpublished_event_types: {
        "project.created": 1,
        "project.membership_changed": 1,
      },
      oldest_unpublished_event_at: "2026-04-03T23:00:00.000Z",
      newest_unpublished_event_at: "2026-04-03T23:45:00.000Z",
      oldest_unpublished_event_age_ms: 60 * 60 * 1000,
      newest_unpublished_event_age_ms: 15 * 60 * 1000,
    });
  });

  it("rebuilds impacted local-home accounts on membership changes and deletes", async () => {
    await seedBaseRows();
    await appendProjectOutboxEventForProject({
      event_type: "project.created",
      project_id: PROJECT_ID,
      default_bay_id: LOCAL_BAY_ID,
    });

    await expect(
      drainAccountCollaboratorIndexProjection({
        bay_id: LOCAL_BAY_ID,
        limit: 10,
        dry_run: false,
      }),
    ).resolves.toMatchObject({
      applied_events: 1,
      feed_events: expect.any(Array),
      event_types: {
        "project.created": 1,
      },
    });

    await expect(
      listProjectedCollaboratorsForAccount({
        account_id: ACCOUNT_A,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        collaborator_account_id: ACCOUNT_A,
        common_project_count: 1,
      }),
      expect.objectContaining({
        collaborator_account_id: ACCOUNT_B,
        common_project_count: 1,
      }),
      expect.objectContaining({
        collaborator_account_id: ACCOUNT_C,
        common_project_count: 1,
      }),
    ]);

    const createdDrain = await drainAccountCollaboratorIndexProjection({
      bay_id: LOCAL_BAY_ID,
      limit: 10,
      dry_run: true,
    });
    expect(createdDrain.feed_events).toEqual([]);
    await expect(
      listProjectedCollaboratorsForAccount({
        account_id: ACCOUNT_B,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        collaborator_account_id: ACCOUNT_A,
        common_project_count: 1,
      }),
      expect.objectContaining({
        collaborator_account_id: ACCOUNT_B,
        common_project_count: 1,
      }),
      expect.objectContaining({
        collaborator_account_id: ACCOUNT_C,
        common_project_count: 1,
      }),
    ]);

    await getPool().query(
      `UPDATE projects
          SET users = $2::JSONB
        WHERE project_id = $1`,
      [
        PROJECT_ID,
        JSON.stringify({
          [ACCOUNT_A]: { group: "owner" },
          [ACCOUNT_C]: { group: "collaborator" },
          [ACCOUNT_D]: { group: "collaborator" },
        }),
      ],
    );
    await appendProjectOutboxEventForProject({
      event_type: "project.membership_changed",
      project_id: PROJECT_ID,
      default_bay_id: LOCAL_BAY_ID,
    });

    await expect(
      drainAccountCollaboratorIndexProjection({
        bay_id: LOCAL_BAY_ID,
        limit: 10,
        dry_run: false,
      }),
    ).resolves.toMatchObject({
      applied_events: 1,
      feed_events: expect.arrayContaining([
        expect.objectContaining({
          type: "collaborator.upsert",
          account_id: ACCOUNT_A,
          collaborator: expect.objectContaining({
            collaborator_account_id: ACCOUNT_D,
          }),
        }),
        expect.objectContaining({
          type: "collaborator.remove",
          account_id: ACCOUNT_A,
          collaborator_account_id: ACCOUNT_B,
        }),
      ]),
      event_types: {
        "project.membership_changed": 1,
      },
    });

    await expect(
      listProjectedCollaboratorsForAccount({
        account_id: ACCOUNT_A,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        collaborator_account_id: ACCOUNT_A,
        common_project_count: 1,
      }),
      expect.objectContaining({
        collaborator_account_id: ACCOUNT_D,
        common_project_count: 1,
      }),
      expect.objectContaining({
        collaborator_account_id: ACCOUNT_C,
        common_project_count: 1,
      }),
    ]);
    await expect(
      listProjectedCollaboratorsForAccount({
        account_id: ACCOUNT_B,
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      listProjectedCollaboratorsForAccount({
        account_id: ACCOUNT_D,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        collaborator_account_id: ACCOUNT_A,
        common_project_count: 1,
      }),
      expect.objectContaining({
        collaborator_account_id: ACCOUNT_D,
        common_project_count: 1,
      }),
      expect.objectContaining({
        collaborator_account_id: ACCOUNT_C,
        common_project_count: 1,
      }),
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
      drainAccountCollaboratorIndexProjection({
        bay_id: LOCAL_BAY_ID,
        limit: 10,
        dry_run: false,
      }),
    ).resolves.toMatchObject({
      applied_events: 1,
      feed_events: expect.arrayContaining([
        expect.objectContaining({
          type: "collaborator.remove",
          account_id: ACCOUNT_A,
          collaborator_account_id: ACCOUNT_C,
        }),
      ]),
      event_types: {
        "project.deleted": 1,
      },
    });

    await expect(
      listProjectedCollaboratorsForAccount({
        account_id: ACCOUNT_A,
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      listProjectedCollaboratorsForAccount({
        account_id: ACCOUNT_D,
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });
});
