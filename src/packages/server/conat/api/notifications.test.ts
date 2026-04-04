/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  counts,
  createAccountNotice,
  createMention,
  list,
  markRead,
} from "./notifications";

const LOCAL_BAY_ID = "bay-0";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_TARGET_ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const ADMIN_ACCOUNT_ID = "55555555-5555-4555-8555-555555555555";

describe("conat notifications api", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(
      `TRUNCATE notification_target_outbox,
                notification_targets,
                notification_events,
                projects,
                accounts
         CASCADE`,
    );
  });

  afterAll(async () => {
    await getPool().end();
  });

  async function seedMentionContext() {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id, groups)
       VALUES
         ($1, 'Actor', 'User', NOW(), 'actor@example.com', $5, ARRAY[]::TEXT[]),
         ($2, 'Target', 'One', NOW(), 'target1@example.com', $5, ARRAY[]::TEXT[]),
         ($3, 'Target', 'Two', NOW(), 'target2@example.com', 'bay-1', ARRAY[]::TEXT[]),
         ($4, 'Admin', 'User', NOW(), 'admin@example.com', $5, ARRAY['admin']::TEXT[])`,
      [
        ACTOR_ACCOUNT_ID,
        TARGET_ACCOUNT_ID,
        OTHER_TARGET_ACCOUNT_ID,
        ADMIN_ACCOUNT_ID,
        LOCAL_BAY_ID,
      ],
    );
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, users, owning_bay_id, created, last_edited, deleted)
       VALUES
         ($1, 'Mention Project', $2::JSONB, $3, NOW(), NOW(), FALSE)`,
      [
        PROJECT_ID,
        JSON.stringify({
          [ACTOR_ACCOUNT_ID]: { group: "owner" },
          [TARGET_ACCOUNT_ID]: { group: "collaborator" },
          [OTHER_TARGET_ACCOUNT_ID]: { group: "collaborator" },
        }),
        LOCAL_BAY_ID,
      ],
    );
  }

  it("creates mention notifications for collaborator targets", async () => {
    await seedMentionContext();

    await expect(
      createMention({
        account_id: ACTOR_ACCOUNT_ID,
        source_project_id: PROJECT_ID,
        source_path: "work/chat.chat",
        source_fragment_id: "thread=1",
        target_account_ids: [TARGET_ACCOUNT_ID, OTHER_TARGET_ACCOUNT_ID],
        description: "Harald mentioned you in chat",
        priority: "high",
        stable_source_id: "chat-message-1",
      }),
    ).resolves.toMatchObject({
      kind: "mention",
      source_bay_id: LOCAL_BAY_ID,
      target_count: 2,
      targets: [
        expect.objectContaining({
          target_account_id: TARGET_ACCOUNT_ID,
          target_home_bay_id: LOCAL_BAY_ID,
        }),
        expect.objectContaining({
          target_account_id: OTHER_TARGET_ACCOUNT_ID,
          target_home_bay_id: "bay-1",
        }),
      ],
    });

    const { rows } = await getPool().query(
      `SELECT kind, source_project_id, source_path, source_fragment_id,
              actor_account_id, origin_kind, payload_json
         FROM notification_events`,
    );
    expect(rows).toEqual([
      {
        kind: "mention",
        source_project_id: PROJECT_ID,
        source_path: "work/chat.chat",
        source_fragment_id: "thread=1",
        actor_account_id: ACTOR_ACCOUNT_ID,
        origin_kind: "project",
        payload_json: {
          description: "Harald mentioned you in chat",
          priority: "high",
          stable_source_id: "chat-message-1",
        },
      },
    ]);
  });

  it("requires admin for account notices", async () => {
    await seedMentionContext();

    await expect(
      createAccountNotice({
        account_id: ACTOR_ACCOUNT_ID,
        target_account_ids: [TARGET_ACCOUNT_ID],
        severity: "info",
        title: "Scheduled maintenance",
        body_markdown: "We will be performing maintenance tonight.",
      }),
    ).rejects.toThrow("only admin may create account notices");

    await expect(
      createAccountNotice({
        account_id: ADMIN_ACCOUNT_ID,
        target_account_ids: [TARGET_ACCOUNT_ID],
        severity: "warning",
        title: "Scheduled maintenance",
        body_markdown: "We will be performing maintenance tonight.",
        origin_label: "Admin",
        action_link: "/status",
        action_label: "Open status page",
        dedupe_key: "maintenance-2026-04-04",
      }),
    ).resolves.toMatchObject({
      kind: "account_notice",
      source_bay_id: LOCAL_BAY_ID,
      target_count: 1,
      targets: [
        expect.objectContaining({
          target_account_id: TARGET_ACCOUNT_ID,
          target_home_bay_id: LOCAL_BAY_ID,
        }),
      ],
    });
  });

  it("lists projected notifications, returns counts, and marks rows read", async () => {
    await seedMentionContext();
    await getPool().query(
      `INSERT INTO account_notification_index
         (account_id, notification_id, kind, project_id, summary, read_state,
          created_at, updated_at)
       VALUES
         ($1, $2, 'mention', $4, $5::JSONB, $6::JSONB, $7, $7),
         ($1, $3, 'account_notice', NULL, $8::JSONB, $9::JSONB, $10, $10)`,
      [
        ACTOR_ACCOUNT_ID,
        "66666666-6666-4666-8666-666666666666",
        "77777777-7777-4777-8777-777777777777",
        PROJECT_ID,
        JSON.stringify({
          description: "mention row",
          path: "work/chat.chat",
        }),
        JSON.stringify({
          read: false,
          saved: false,
        }),
        new Date("2026-04-04T00:00:00.000Z"),
        JSON.stringify({
          title: "notice row",
        }),
        JSON.stringify({
          read: false,
          saved: true,
        }),
        new Date("2026-04-04T01:00:00.000Z"),
      ],
    );

    await expect(
      list({
        account_id: ACTOR_ACCOUNT_ID,
        state: "saved",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "account_notice",
      }),
    ]);

    await expect(
      counts({
        account_id: ACTOR_ACCOUNT_ID,
      }),
    ).resolves.toEqual({
      total: 2,
      unread: 2,
      saved: 1,
      archived: 0,
      by_kind: {
        account_notice: {
          total: 1,
          unread: 1,
          saved: 1,
          archived: 0,
        },
        mention: {
          total: 1,
          unread: 1,
          saved: 0,
          archived: 0,
        },
      },
    });

    await expect(
      markRead({
        account_id: ACTOR_ACCOUNT_ID,
        notification_ids: [
          "66666666-6666-4666-8666-666666666666",
          "77777777-7777-4777-8777-777777777777",
        ],
      }),
    ).resolves.toEqual({
      updated_count: 2,
    });

    await expect(
      counts({
        account_id: ACTOR_ACCOUNT_ID,
      }),
    ).resolves.toEqual({
      total: 2,
      unread: 0,
      saved: 1,
      archived: 0,
      by_kind: {
        account_notice: {
          total: 1,
          unread: 0,
          saved: 1,
          archived: 0,
        },
        mention: {
          total: 1,
          unread: 0,
          saved: 0,
          archived: 0,
        },
      },
    });
  });
});
