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
                notification_email_outbox,
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
    path?: string;
    display_path?: string;
    created_at?: string;
    notification_reason?: "mention" | "thread_follow";
  }) {
    const path = opts?.path ?? "work/chat.chat";
    return await createNotificationEventGraph({
      kind: "mention",
      source_bay_id: LOCAL_BAY_ID,
      source_project_id: PROJECT_ID,
      source_path: path,
      source_fragment_id: "thread=1",
      actor_account_id: SOURCE_ACCOUNT_ID,
      origin_kind: "project",
      payload_json: {
        description: opts?.description ?? "initial mention",
        priority: "normal",
        notification_reason: opts?.notification_reason ?? "mention",
      },
      created_at: opts?.created_at ?? "2026-04-04T00:00:00.000Z",
      targets: [
        {
          target_account_id: opts?.target_account_id ?? LOCAL_ACCOUNT_ID,
          target_home_bay_id: opts?.target_home_bay_id ?? LOCAL_BAY_ID,
          notification_id: opts?.notification_id ?? NOTIFICATION_ID,
          summary_json: {
            description: opts?.description ?? "initial mention",
            path,
            notification_reason: opts?.notification_reason ?? "mention",
            ...(opts?.display_path ? { display_path: opts.display_path } : {}),
          },
        },
      ],
    });
  }

  async function setNotificationEmailMode(
    category: string,
    mode: string,
  ): Promise<void> {
    await getPool().query(
      `UPDATE accounts
          SET other_settings = jsonb_build_object(
                'notification_preferences',
                jsonb_build_object(
                  'email',
                  jsonb_build_object($2::TEXT, $3::TEXT)
                )
              )
        WHERE account_id = $1::UUID`,
      [LOCAL_ACCOUNT_ID, category, mode],
    );
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

  it("uses chat reply subject copy for followed-thread notifications", async () => {
    await seedAccounts();
    await appendMentionOutboxRow({
      notification_reason: "thread_follow",
      description: "New reply in a chat thread you follow.",
      path: "work/chat.chat",
    });

    await drainAccountNotificationIndexProjection({
      bay_id: LOCAL_BAY_ID,
      limit: 10,
      dry_run: false,
    });

    const { rows } = await getPool().query(
      "SELECT subject FROM notification_email_outbox",
    );
    expect(rows).toEqual([{ subject: "CoCalc chat reply in work/chat.chat" }]);
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
        summary: expect.objectContaining({
          description: "initial mention",
          path: "work/chat.chat",
        }),
        read_state: {},
      }),
    );

    await expect(
      getPool().query(
        `SELECT notification_id, target_account_id, actor_account_id,
                responsible_account_id, category, lane, delivery_mode,
                recipient_email, subject, status
           FROM notification_email_outbox
          WHERE notification_id = $1`,
        [NOTIFICATION_ID],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          notification_id: NOTIFICATION_ID,
          target_account_id: LOCAL_ACCOUNT_ID,
          actor_account_id: SOURCE_ACCOUNT_ID,
          responsible_account_id: SOURCE_ACCOUNT_ID,
          category: "mentions",
          lane: "notification",
          delivery_mode: "immediate",
          recipient_email: "local@example.com",
          subject: "CoCalc mention in work/chat.chat",
          status: "queued",
        },
      ],
    });

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
        summary: expect.objectContaining({
          description: "updated mention summary",
          path: "work/chat.chat",
        }),
        read_state: {
          read: true,
        },
      }),
    ]);

    const emailRows = await getPool().query(
      `SELECT email_id
         FROM notification_email_outbox
        WHERE notification_id = $1`,
      [NOTIFICATION_ID],
    );
    expect(emailRows.rows).toHaveLength(1);
  });

  it("keeps in-app notifications when email delivery is off", async () => {
    await seedAccounts();
    await setNotificationEmailMode("mentions", "off");
    await appendMentionOutboxRow();

    await drainAccountNotificationIndexProjection({
      bay_id: LOCAL_BAY_ID,
      limit: 10,
      dry_run: false,
    });

    await expect(
      listProjectedNotificationsForAccount({
        account_id: LOCAL_ACCOUNT_ID,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        notification_id: NOTIFICATION_ID,
      }),
    ]);
    await expect(
      getPool().query(
        `SELECT delivery_mode, status
           FROM notification_email_outbox
          WHERE notification_id = $1`,
        [NOTIFICATION_ID],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          delivery_mode: "off",
          status: "skipped_preference",
        },
      ],
    });
  });

  it("skips in-app notifications and email when delivery is none", async () => {
    await seedAccounts();
    await setNotificationEmailMode("mentions", "none");
    await appendMentionOutboxRow();

    await expect(
      drainAccountNotificationIndexProjection({
        bay_id: LOCAL_BAY_ID,
        limit: 10,
        dry_run: false,
      }),
    ).resolves.toMatchObject({
      applied_events: 1,
      inserted_rows: 0,
      affected_account_ids: [],
      affected_notifications: [],
    });

    await expect(
      getPool().query(
        `SELECT notification_id
           FROM account_notification_index
          WHERE account_id = $1`,
        [LOCAL_ACCOUNT_ID],
      ),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      getPool().query(
        `SELECT email_id
           FROM notification_email_outbox
          WHERE notification_id = $1`,
        [NOTIFICATION_ID],
      ),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      getPool().query(
        `SELECT published_at IS NOT NULL AS published
           FROM notification_target_outbox
          WHERE notification_id = $1`,
        [NOTIFICATION_ID],
      ),
    ).resolves.toMatchObject({ rows: [{ published: true }] });
  });

  it("uses display_path for queued mention email subjects", async () => {
    await seedAccounts();
    await appendMentionOutboxRow({
      path: "/home/user/b.chat",
      display_path: "b.chat",
    });

    await drainAccountNotificationIndexProjection({
      bay_id: LOCAL_BAY_ID,
      limit: 10,
      dry_run: false,
    });

    await expect(
      getPool().query(
        `SELECT subject
           FROM notification_email_outbox
          WHERE notification_id = $1`,
        [NOTIFICATION_ID],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          subject: "CoCalc mention in b.chat",
        },
      ],
    });
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
