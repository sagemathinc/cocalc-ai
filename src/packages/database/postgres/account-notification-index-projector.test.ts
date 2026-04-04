/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import {
  drainAccountNotificationIndexProjection,
  getAccountNotificationIndexProjectionBacklogStatus,
} from "./account-notification-index-projector";
import { listProjectedNotificationsForAccount } from "./account-notification-index";
import { appendMentionNotificationOutboxEvent } from "./notification-events-outbox";

const LOCAL_BAY_ID = "bay-local";
const OTHER_BAY_ID = "bay-other";
const LOCAL_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const REMOTE_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const MENTION_TIME = new Date("2026-04-03T23:00:00.000Z");
const MENTION_PATH = "chat/project.md";

describe("account_notification_index projector", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(
      "TRUNCATE account_notification_index, notification_events_outbox, mentions, projects, accounts CASCADE",
    );
  });

  afterAll(async () => {
    await testCleanup();
  });

  async function seedBaseRows(target = LOCAL_ACCOUNT_ID): Promise<void> {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES
         ($1, 'Local', 'User', NOW(), 'local@example.com', $4),
         ($2, 'Remote', 'User', NOW(), 'remote@example.com', $5),
         ($3, 'Source', 'User', NOW(), 'source@example.com', $4)`,
      [
        LOCAL_ACCOUNT_ID,
        REMOTE_ACCOUNT_ID,
        SOURCE_ACCOUNT_ID,
        LOCAL_BAY_ID,
        OTHER_BAY_ID,
      ],
    );
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, users, owning_bay_id, created, last_edited, deleted)
       VALUES
         ($1, 'Mentioned Project', $2::JSONB, $3, NOW(), NOW(), FALSE)`,
      [
        PROJECT_ID,
        JSON.stringify({
          [SOURCE_ACCOUNT_ID]: { group: "owner" },
          [LOCAL_ACCOUNT_ID]: { group: "collaborator" },
          [REMOTE_ACCOUNT_ID]: { group: "collaborator" },
        }),
        LOCAL_BAY_ID,
      ],
    );
    await getPool().query(
      `INSERT INTO mentions
         (time, project_id, path, source, target, description, fragment_id, priority, users)
       VALUES
         ($1, $2, $3, $4, $5, 'initial mention', 'chat=true,id=1', 1,
          $6::JSONB)`,
      [
        MENTION_TIME,
        PROJECT_ID,
        MENTION_PATH,
        SOURCE_ACCOUNT_ID,
        target,
        JSON.stringify({
          [target]: { read: false, saved: false },
        }),
      ],
    );
  }

  it("supports dry-run drains without mutating projection or outbox state", async () => {
    await seedBaseRows();
    await appendMentionNotificationOutboxEvent({
      time: MENTION_TIME,
      project_id: PROJECT_ID,
      path: MENTION_PATH,
      target: LOCAL_ACCOUNT_ID,
      default_bay_id: LOCAL_BAY_ID,
    });

    await expect(
      drainAccountNotificationIndexProjection({
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
        "notification.mention_upserted": 1,
      },
    });

    const indexRows = await getPool().query(
      "SELECT * FROM account_notification_index WHERE account_id = $1",
      [LOCAL_ACCOUNT_ID],
    );
    expect(indexRows.rows).toHaveLength(0);
  });

  it("reports unpublished notification projector lag and per-type counts", async () => {
    await seedBaseRows();
    await appendMentionNotificationOutboxEvent({
      time: MENTION_TIME,
      project_id: PROJECT_ID,
      path: MENTION_PATH,
      target: LOCAL_ACCOUNT_ID,
      default_bay_id: LOCAL_BAY_ID,
      created_at: new Date("2026-04-03T23:00:00.000Z"),
    });
    await getPool().query(
      `UPDATE mentions
          SET users = $2::JSONB
        WHERE time = $1
          AND project_id = $3
          AND path = $4
          AND target = $5`,
      [
        MENTION_TIME,
        JSON.stringify({
          [LOCAL_ACCOUNT_ID]: { read: true, saved: true },
        }),
        PROJECT_ID,
        MENTION_PATH,
        LOCAL_ACCOUNT_ID,
      ],
    );
    await appendMentionNotificationOutboxEvent({
      time: MENTION_TIME,
      project_id: PROJECT_ID,
      path: MENTION_PATH,
      target: LOCAL_ACCOUNT_ID,
      default_bay_id: LOCAL_BAY_ID,
      created_at: new Date("2026-04-03T23:45:00.000Z"),
    });

    await expect(
      getAccountNotificationIndexProjectionBacklogStatus({
        bay_id: LOCAL_BAY_ID,
        now: new Date("2026-04-04T00:00:00.000Z"),
      }),
    ).resolves.toEqual({
      bay_id: LOCAL_BAY_ID,
      checked_at: "2026-04-04T00:00:00.000Z",
      unpublished_events: 2,
      unpublished_event_types: {
        "notification.mention_upserted": 2,
      },
      oldest_unpublished_event_at: "2026-04-03T23:00:00.000Z",
      newest_unpublished_event_at: "2026-04-03T23:45:00.000Z",
      oldest_unpublished_event_age_ms: 60 * 60 * 1000,
      newest_unpublished_event_age_ms: 15 * 60 * 1000,
    });
  });

  it("projects local-home notifications and updates read_state on later mention events", async () => {
    await seedBaseRows();
    await appendMentionNotificationOutboxEvent({
      time: MENTION_TIME,
      project_id: PROJECT_ID,
      path: MENTION_PATH,
      target: LOCAL_ACCOUNT_ID,
      default_bay_id: LOCAL_BAY_ID,
    });

    await expect(
      drainAccountNotificationIndexProjection({
        bay_id: LOCAL_BAY_ID,
        limit: 10,
        dry_run: false,
      }),
    ).resolves.toMatchObject({
      applied_events: 1,
      inserted_rows: 1,
      deleted_rows: 0,
      event_types: {
        "notification.mention_upserted": 1,
      },
    });

    await expect(
      listProjectedNotificationsForAccount({
        account_id: LOCAL_ACCOUNT_ID,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        project_id: PROJECT_ID,
        read_state: {
          read: false,
          saved: false,
        },
      }),
    ]);

    await getPool().query(
      `UPDATE mentions
          SET users = $2::JSONB
        WHERE time = $1
          AND project_id = $3
          AND path = $4
          AND target = $5`,
      [
        MENTION_TIME,
        JSON.stringify({
          [LOCAL_ACCOUNT_ID]: { read: true, saved: true },
        }),
        PROJECT_ID,
        MENTION_PATH,
        LOCAL_ACCOUNT_ID,
      ],
    );
    await appendMentionNotificationOutboxEvent({
      time: MENTION_TIME,
      project_id: PROJECT_ID,
      path: MENTION_PATH,
      target: LOCAL_ACCOUNT_ID,
      default_bay_id: LOCAL_BAY_ID,
      created_at: new Date("2026-04-04T00:00:00.000Z"),
    });

    await expect(
      drainAccountNotificationIndexProjection({
        bay_id: LOCAL_BAY_ID,
        limit: 10,
        dry_run: false,
      }),
    ).resolves.toMatchObject({
      applied_events: 1,
      inserted_rows: 1,
      deleted_rows: 0,
    });

    await expect(
      listProjectedNotificationsForAccount({
        account_id: LOCAL_ACCOUNT_ID,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        read_state: {
          read: true,
          saved: true,
        },
      }),
    ]);
  });

  it("ignores events for accounts homed in another bay", async () => {
    await seedBaseRows(REMOTE_ACCOUNT_ID);
    await appendMentionNotificationOutboxEvent({
      time: MENTION_TIME,
      project_id: PROJECT_ID,
      path: MENTION_PATH,
      target: REMOTE_ACCOUNT_ID,
      default_bay_id: LOCAL_BAY_ID,
    });

    await expect(
      drainAccountNotificationIndexProjection({
        bay_id: LOCAL_BAY_ID,
        limit: 10,
        dry_run: false,
      }),
    ).resolves.toMatchObject({
      applied_events: 1,
      inserted_rows: 0,
      deleted_rows: 0,
    });

    const indexRows = await getPool().query(
      "SELECT * FROM account_notification_index WHERE account_id = $1",
      [REMOTE_ACCOUNT_ID],
    );
    expect(indexRows.rows).toHaveLength(0);
  });
});
