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
import { drainAccountProjectIndexProjection } from "./account-project-index-projector";
import {
  listProjectedCollaboratorsForAccount,
  lockAccountCollaboratorProjection,
} from "./account-collaborator-index";
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

  (process.env.COCALC_TEST_USE_PGLITE === "1" ? it.skip : it)(
    "holds account projection locks until commit, not until one account is updated",
    async () => {
      const first = await getPool().connect();
      const second = await getPool().connect();
      try {
        await first.query("BEGIN");
        await second.query("BEGIN");
        await lockAccountCollaboratorProjection(first, [ACCOUNT_B, ACCOUNT_A]);
        const sql =
          "SELECT pg_try_advisory_xact_lock(hashtext($1::text), hashtext($2::text)) AS acquired";
        const args = ["account-collaborator-index", ACCOUNT_A];
        expect((await second.query(sql, args)).rows[0].acquired).toBe(false);
        await first.query("COMMIT");
        expect((await second.query(sql, args)).rows[0].acquired).toBe(true);
      } finally {
        await first.query("ROLLBACK");
        await second.query("ROLLBACK");
        first.release();
        second.release();
      }
    },
  );

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
      `SELECT published_at, collaborator_index_pending, collaborator_index_published_at
         FROM project_events_outbox
        WHERE project_id = $1`,
      [PROJECT_ID],
    );
    expect(outboxRows.rows).toEqual([
      {
        published_at: null,
        collaborator_index_pending: true,
        collaborator_index_published_at: null,
      },
    ]);
  });

  it("leaves unrelated collaborator pairs untouched and tolerates replay", async () => {
    await seedBaseRows();
    const otherProject = "66666666-6666-4666-8666-666666666666";
    await getPool().query(
      `INSERT INTO projects (project_id, users, owning_bay_id)
      VALUES ($1,$2::jsonb,$3)`,
      [
        otherProject,
        JSON.stringify({
          [ACCOUNT_A]: { group: "owner" },
          [ACCOUNT_D]: { group: "collaborator" },
        }),
        LOCAL_BAY_ID,
      ],
    );
    for (const project_id of [PROJECT_ID, otherProject]) {
      await appendProjectOutboxEventForProject({
        event_type: "project.created",
        project_id,
        default_bay_id: LOCAL_BAY_ID,
      });
    }
    await drainAccountCollaboratorIndexProjection({
      bay_id: LOCAL_BAY_ID,
      dry_run: false,
    });
    await getPool().query(
      `UPDATE account_collaborator_index SET updated_at='2020-01-01'
      WHERE account_id=$1 AND collaborator_account_id=$2`,
      [ACCOUNT_A, ACCOUNT_D],
    );
    await getPool().query(
      "UPDATE projects SET users=users-$2::text WHERE project_id=$1",
      [PROJECT_ID, ACCOUNT_B],
    );
    await appendProjectOutboxEventForProject({
      event_type: "project.membership_changed",
      project_id: PROJECT_ID,
      default_bay_id: LOCAL_BAY_ID,
    });
    await drainAccountCollaboratorIndexProjection({
      bay_id: LOCAL_BAY_ID,
      dry_run: false,
    });
    await getPool().query(
      "UPDATE project_events_outbox SET collaborator_index_pending=TRUE WHERE project_id=$1",
      [PROJECT_ID],
    );
    await drainAccountCollaboratorIndexProjection({
      bay_id: LOCAL_BAY_ID,
      dry_run: false,
    });
    const untouched = await getPool().query(
      `SELECT common_project_count, updated_at FROM account_collaborator_index
      WHERE account_id=$1 AND collaborator_account_id=$2`,
      [ACCOUNT_A, ACCOUNT_D],
    );
    expect(untouched.rows).toEqual([
      { common_project_count: 1, updated_at: new Date("2020-01-01T00:00:00Z") },
    ]);
    const removed = await getPool().query(
      `SELECT * FROM account_collaborator_index
      WHERE account_id=$1 AND collaborator_account_id=$2`,
      [ACCOUNT_A, ACCOUNT_B],
    );
    expect(removed.rows).toEqual([]);
  });

  it.each(["project", "collaborator"] as const)(
    "does not lose either delivery when the %s projector runs first",
    async (firstProjector) => {
      await seedBaseRows();
      await appendProjectOutboxEventForProject({
        event_type: "project.created",
        project_id: PROJECT_ID,
        default_bay_id: LOCAL_BAY_ID,
      });

      const drainProject = async () =>
        await drainAccountProjectIndexProjection({
          bay_id: LOCAL_BAY_ID,
          limit: 10,
          dry_run: false,
        });
      const drainCollaborator = async () =>
        await drainAccountCollaboratorIndexProjection({
          bay_id: LOCAL_BAY_ID,
          limit: 10,
          dry_run: false,
        });
      if (firstProjector === "project") {
        await drainProject();
        await drainCollaborator();
      } else {
        await drainCollaborator();
        await drainProject();
      }

      const projectRows = await getPool().query(
        `SELECT account_id
           FROM account_project_index
          WHERE project_id = $1
          ORDER BY account_id`,
        [PROJECT_ID],
      );
      expect(projectRows.rows).toEqual([
        { account_id: ACCOUNT_A },
        { account_id: ACCOUNT_B },
      ]);
      await expect(
        listProjectedCollaboratorsForAccount({
          account_id: ACCOUNT_A,
          limit: 10,
        }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            collaborator_account_id: ACCOUNT_B,
            common_project_count: 1,
          }),
        ]),
      );

      const outboxRows = await getPool().query(
        `SELECT published_at, collaborator_index_pending, collaborator_index_published_at
           FROM project_events_outbox
          WHERE project_id = $1`,
        [PROJECT_ID],
      );
      expect(outboxRows.rows).toEqual([
        {
          published_at: expect.any(Date),
          collaborator_index_pending: false,
          collaborator_index_published_at: expect.any(Date),
        },
      ]);
    },
  );

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

  it("ignores owner-only project.created events", async () => {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES
         ($1, 'Alpha', 'Local', NOW(), 'alpha@example.com', $2)`,
      [ACCOUNT_A, LOCAL_BAY_ID],
    );
    await getPool().query(
      `INSERT INTO projects
        (project_id, title, description, users, owning_bay_id, created, last_edited, deleted)
       VALUES
        ($1, 'Owner Only', 'no collaborators', $2::JSONB, $3, NOW(), NOW(), FALSE)`,
      [
        PROJECT_ID,
        JSON.stringify({
          [ACCOUNT_A]: { group: "owner" },
        }),
        LOCAL_BAY_ID,
      ],
    );
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
      inserted_rows: 0,
      deleted_rows: 0,
      feed_events: [],
      event_types: {
        "project.created": 1,
      },
    });

    await expect(
      listProjectedCollaboratorsForAccount({
        account_id: ACCOUNT_A,
        limit: 10,
      }),
    ).resolves.toEqual([]);
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
            account_id: ACCOUNT_D,
            name: "Delta Local",
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
        collaborator_account_id: ACCOUNT_C,
        common_project_count: 1,
      }),
      expect.objectContaining({
        collaborator_account_id: ACCOUNT_D,
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
        collaborator_account_id: ACCOUNT_C,
        common_project_count: 1,
      }),
      expect.objectContaining({
        collaborator_account_id: ACCOUNT_D,
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

  it("uses the outbox event time for collaborator feed events during delayed drains", async () => {
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

    await expect(
      drainAccountCollaboratorIndexProjection({
        bay_id: LOCAL_BAY_ID,
        limit: 10,
        dry_run: false,
      }),
    ).resolves.toMatchObject({
      feed_events: expect.arrayContaining([
        expect.objectContaining({
          type: "collaborator.upsert",
          account_id: ACCOUNT_A,
          ts: Date.parse("2026-04-03T23:00:00.000Z"),
        }),
      ]),
    });
  });
});
