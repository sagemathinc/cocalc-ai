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
import {
  listProjectedNotificationsForAccount,
  setProjectedNotificationReadState,
} from "./account-notification-index";
import { createNotificationEventGraph } from "./notifications-core";

const LOCAL_BAY_ID = "bay-local";
const OTHER_BAY_ID = "bay-other";
const LOCAL_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const REMOTE_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const NOTIFICATION_ID = "55555555-5555-4555-8555-555555555555";

describe("account_notification_index projector", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(
      `TRUNCATE account_notification_index,
                notification_target_outbox,
                notification_targets,
                notification_events,
                accounts
         CASCADE`,
    );
  });

  afterAll(async () => {
    await testCleanup();
  });

  async function seedAccounts(): Promise<void> {
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
  }

  async function appendMentionOutboxRow(opts?: {
    target_account_id?: string;
    target_home_bay_id?: string;
    notification_id?: string;
    description?: string;
    created_at?: string;
  }) {
    return await createNotificationEventGraph({
      kind: "mention",
      source_bay_id: LOCAL_BAY_ID,
      source_project_id: PROJECT_ID,
      source_path: "work/chat.chat",
      source_fragment_id: "thread=1",
      actor_account_id: SOURCE_ACCOUNT_ID,
      origin_kind: "project",
      payload_json: {
        description: opts?.description ?? "initial mention",
        priority: "normal",
      },
      created_at: opts?.created_at ?? "2026-04-04T00:00:00.000Z",
      targets: [
        {
          target_account_id: opts?.target_account_id ?? LOCAL_ACCOUNT_ID,
          target_home_bay_id: opts?.target_home_bay_id ?? LOCAL_BAY_ID,
          notification_id: opts?.notification_id ?? NOTIFICATION_ID,
          summary_json: {
            description: opts?.description ?? "initial mention",
            path: "work/chat.chat",
          },
        },
      ],
    });
  }

  it("supports dry-run drains without mutating projection or outbox state", async () => {
    await seedAccounts();
    await appendMentionOutboxRow();

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
      affected_account_ids: [LOCAL_ACCOUNT_ID],
      event_types: {
        "notification.upserted": 1,
      },
    });

    const indexRows = await getPool().query(
      "SELECT * FROM account_notification_index WHERE account_id = $1",
      [LOCAL_ACCOUNT_ID],
    );
    expect(indexRows.rows).toHaveLength(0);
  });

  it("reports unpublished notification projector lag and per-type counts", async () => {
    await seedAccounts();
    await appendMentionOutboxRow({
      created_at: "2026-04-03T23:00:00.000Z",
    });
    await appendMentionOutboxRow({
      notification_id: "66666666-6666-4666-8666-666666666666",
      created_at: "2026-04-03T23:45:00.000Z",
      description: "later mention",
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
        "notification.upserted": 2,
      },
      oldest_unpublished_event_at: "2026-04-03T23:00:00.000Z",
      newest_unpublished_event_at: "2026-04-03T23:45:00.000Z",
      oldest_unpublished_event_age_ms: 60 * 60 * 1000,
      newest_unpublished_event_age_ms: 15 * 60 * 1000,
    });
  });

  it("projects local-home notifications and preserves read_state on later upserts", async () => {
    await seedAccounts();
    await appendMentionOutboxRow();

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
      affected_account_ids: [LOCAL_ACCOUNT_ID],
      event_types: {
        "notification.upserted": 1,
      },
    });

    const [firstRow] = await listProjectedNotificationsForAccount({
      account_id: LOCAL_ACCOUNT_ID,
      limit: 10,
    });
    expect(firstRow).toEqual(
      expect.objectContaining({
        notification_id: NOTIFICATION_ID,
        project_id: PROJECT_ID,
        summary: {
          description: "initial mention",
          path: "work/chat.chat",
        },
        read_state: {},
      }),
    );

    await setProjectedNotificationReadState({
      account_id: LOCAL_ACCOUNT_ID,
      notification_ids: [NOTIFICATION_ID],
      read: true,
    });
    await appendMentionOutboxRow({
      notification_id: NOTIFICATION_ID,
      description: "updated mention summary",
      created_at: "2026-04-04T00:15:00.000Z",
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
      affected_account_ids: [LOCAL_ACCOUNT_ID],
    });

    await expect(
      listProjectedNotificationsForAccount({
        account_id: LOCAL_ACCOUNT_ID,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        notification_id: NOTIFICATION_ID,
        summary: {
          description: "updated mention summary",
          path: "work/chat.chat",
        },
        read_state: {
          read: true,
        },
      }),
    ]);
  });

  it("ignores events for accounts homed in another bay", async () => {
    await seedAccounts();
    await appendMentionOutboxRow({
      target_account_id: REMOTE_ACCOUNT_ID,
      target_home_bay_id: OTHER_BAY_ID,
      notification_id: "77777777-7777-4777-8777-777777777777",
    });

    await expect(
      drainAccountNotificationIndexProjection({
        bay_id: LOCAL_BAY_ID,
        limit: 10,
        dry_run: false,
      }),
    ).resolves.toMatchObject({
      applied_events: 0,
      inserted_rows: 0,
      deleted_rows: 0,
      affected_account_ids: [],
    });

    const indexRows = await getPool().query(
      "SELECT * FROM account_notification_index WHERE account_id = $1",
      [REMOTE_ACCOUNT_ID],
    );
    expect(indexRows.rows).toHaveLength(0);
  });
});
