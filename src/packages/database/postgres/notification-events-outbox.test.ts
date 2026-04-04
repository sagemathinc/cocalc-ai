/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import {
  appendMentionNotificationOutboxEvent,
  loadMentionNotificationOutboxPayload,
  mentionNotificationId,
} from "./notification-events-outbox";

const LOCAL_BAY_ID = "bay-local";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const MENTION_TIME = new Date("2026-04-03T23:00:00.000Z");
const MENTION_PATH = "notes/chat.md";

describe("notification events outbox", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(
      "TRUNCATE notification_events_outbox, mentions, projects, accounts CASCADE",
    );
  });

  afterAll(async () => {
    await testCleanup();
  });

  async function seedMention(target = TARGET_ACCOUNT_ID): Promise<void> {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES
         ($1, 'Source', 'User', NOW(), 'source@example.com', $4),
         ($2, 'Target', 'User', NOW(), 'target@example.com', $4),
         ($3, 'Other', 'User', NOW(), 'other@example.com', 'bay-other')`,
      [
        SOURCE_ACCOUNT_ID,
        TARGET_ACCOUNT_ID,
        "44444444-4444-4444-8444-444444444444",
        LOCAL_BAY_ID,
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
          [TARGET_ACCOUNT_ID]: { group: "collaborator" },
        }),
        LOCAL_BAY_ID,
      ],
    );
    await getPool().query(
      `INSERT INTO mentions
         (time, project_id, path, source, target, description, fragment_id, priority, users)
       VALUES
         ($1, $2, $3, $4, $5, 'please review this', 'chat=true,id=1', 2,
          $6::JSONB)`,
      [
        MENTION_TIME,
        PROJECT_ID,
        MENTION_PATH,
        SOURCE_ACCOUNT_ID,
        target,
        JSON.stringify({
          [target]: { read: false, saved: true },
        }),
      ],
    );
  }

  it("loads a mention payload and appends it to the notification outbox", async () => {
    await seedMention();

    await expect(
      loadMentionNotificationOutboxPayload({
        time: MENTION_TIME,
        project_id: PROJECT_ID,
        path: MENTION_PATH,
        target: TARGET_ACCOUNT_ID,
        default_bay_id: LOCAL_BAY_ID,
      }),
    ).resolves.toMatchObject({
      account_id: TARGET_ACCOUNT_ID,
      notification_id: mentionNotificationId({
        time: MENTION_TIME,
        project_id: PROJECT_ID,
        path: MENTION_PATH,
        target: TARGET_ACCOUNT_ID,
      }),
      kind: "mention",
      project_id: PROJECT_ID,
      owning_bay_id: LOCAL_BAY_ID,
      summary: {
        path: MENTION_PATH,
        source: SOURCE_ACCOUNT_ID,
        target: TARGET_ACCOUNT_ID,
        priority: 2,
        description: "please review this",
        fragment_id: "chat=true,id=1",
      },
      read_state: {
        read: false,
        saved: true,
      },
      created_at: MENTION_TIME.toISOString(),
      updated_at: MENTION_TIME.toISOString(),
    });

    const event_id = await appendMentionNotificationOutboxEvent({
      time: MENTION_TIME,
      project_id: PROJECT_ID,
      path: MENTION_PATH,
      target: TARGET_ACCOUNT_ID,
      default_bay_id: LOCAL_BAY_ID,
      created_at: new Date("2026-04-04T00:00:00.000Z"),
    });

    expect(event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const { rows } = await getPool().query(
      `SELECT account_id, notification_id, project_id, owning_bay_id, kind,
              event_type, payload_json, published_at
         FROM notification_events_outbox
        WHERE event_id = $1`,
      [event_id],
    );
    expect(rows).toEqual([
      {
        account_id: TARGET_ACCOUNT_ID,
        notification_id: mentionNotificationId({
          time: MENTION_TIME,
          project_id: PROJECT_ID,
          path: MENTION_PATH,
          target: TARGET_ACCOUNT_ID,
        }),
        project_id: PROJECT_ID,
        owning_bay_id: LOCAL_BAY_ID,
        kind: "mention",
        event_type: "notification.mention_upserted",
        payload_json: expect.objectContaining({
          account_id: TARGET_ACCOUNT_ID,
          read_state: {
            read: false,
            saved: true,
          },
          updated_at: "2026-04-04T00:00:00.000Z",
        }),
        published_at: null,
      },
    ]);
  });

  it("ignores non-account targets when appending mention notification events", async () => {
    await seedMention("everyone");
    await expect(
      appendMentionNotificationOutboxEvent({
        time: MENTION_TIME,
        project_id: PROJECT_ID,
        path: MENTION_PATH,
        target: "everyone",
      }),
    ).resolves.toBeNull();
  });
});
