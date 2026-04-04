/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import {
  createNotificationEventGraph,
  resolveNotificationTargetHomeBays,
} from "./notifications-core";

const SOURCE_BAY_ID = "bay-source";
const HOME_BAY_ID = "bay-home";
const OTHER_HOME_BAY_ID = "bay-other";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_TARGET_ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";

describe("notifications core", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(
      `TRUNCATE notification_target_outbox,
                notification_targets,
                notification_events,
                accounts
         CASCADE`,
    );
  });

  afterAll(async () => {
    await testCleanup();
  });

  async function seedAccounts() {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES
         ($1, 'Actor', 'User', NOW(), 'actor@example.com', $2),
         ($3, 'Target', 'One', NOW(), 'target-one@example.com', $4),
         ($5, 'Target', 'Two', NOW(), 'target-two@example.com', $6)`,
      [
        ACTOR_ACCOUNT_ID,
        SOURCE_BAY_ID,
        TARGET_ACCOUNT_ID,
        HOME_BAY_ID,
        OTHER_TARGET_ACCOUNT_ID,
        OTHER_HOME_BAY_ID,
      ],
    );
  }

  it("resolves account home bays for notification targets", async () => {
    await seedAccounts();

    await expect(
      resolveNotificationTargetHomeBays({
        account_ids: [TARGET_ACCOUNT_ID, OTHER_TARGET_ACCOUNT_ID],
        default_bay_id: "bay-default",
      }),
    ).resolves.toEqual({
      [TARGET_ACCOUNT_ID]: HOME_BAY_ID,
      [OTHER_TARGET_ACCOUNT_ID]: OTHER_HOME_BAY_ID,
    });
  });

  it("creates a notification event, targets, and outbox rows transactionally", async () => {
    await seedAccounts();

    const created = await createNotificationEventGraph({
      kind: "mention",
      source_bay_id: SOURCE_BAY_ID,
      source_project_id: PROJECT_ID,
      source_path: "work/chat.chat",
      source_fragment_id: "thread=1",
      actor_account_id: ACTOR_ACCOUNT_ID,
      origin_kind: "project",
      payload_json: {
        description: "Harald mentioned you in chat",
        priority: "normal",
      },
      created_at: "2026-04-04T22:00:00.000Z",
      targets: [
        {
          target_account_id: TARGET_ACCOUNT_ID,
          target_home_bay_id: HOME_BAY_ID,
          dedupe_key: `mention:${PROJECT_ID}:thread=1:${TARGET_ACCOUNT_ID}`,
          summary_json: {
            description: "Harald mentioned you in chat",
            path: "work/chat.chat",
          },
        },
        {
          target_account_id: OTHER_TARGET_ACCOUNT_ID,
          target_home_bay_id: OTHER_HOME_BAY_ID,
          summary_json: {
            description: "Harald mentioned you in chat",
            path: "work/chat.chat",
          },
        },
      ],
    });

    expect(created.event).toMatchObject({
      kind: "mention",
      source_bay_id: SOURCE_BAY_ID,
      source_project_id: PROJECT_ID,
      source_path: "work/chat.chat",
      source_fragment_id: "thread=1",
      actor_account_id: ACTOR_ACCOUNT_ID,
      origin_kind: "project",
      payload_json: {
        description: "Harald mentioned you in chat",
        priority: "normal",
      },
    });
    expect(created.targets).toHaveLength(2);
    expect(created.outbox).toHaveLength(2);

    const { rows: events } = await getPool().query(
      `SELECT kind, source_bay_id, source_project_id, source_path,
              source_fragment_id, actor_account_id, origin_kind, payload_json
         FROM notification_events`,
    );
    expect(events).toEqual([
      {
        kind: "mention",
        source_bay_id: SOURCE_BAY_ID,
        source_project_id: PROJECT_ID,
        source_path: "work/chat.chat",
        source_fragment_id: "thread=1",
        actor_account_id: ACTOR_ACCOUNT_ID,
        origin_kind: "project",
        payload_json: {
          description: "Harald mentioned you in chat",
          priority: "normal",
        },
      },
    ]);

    const { rows: targets } = await getPool().query(
      `SELECT target_account_id, target_home_bay_id, notification_id, dedupe_key
         FROM notification_targets
        ORDER BY target_account_id ASC`,
    );
    expect(targets).toEqual([
      {
        target_account_id: TARGET_ACCOUNT_ID,
        target_home_bay_id: HOME_BAY_ID,
        notification_id: created.targets[0].notification_id,
        dedupe_key: `mention:${PROJECT_ID}:thread=1:${TARGET_ACCOUNT_ID}`,
      },
      {
        target_account_id: OTHER_TARGET_ACCOUNT_ID,
        target_home_bay_id: OTHER_HOME_BAY_ID,
        notification_id: created.targets[1].notification_id,
        dedupe_key: null,
      },
    ]);

    const { rows: outbox } = await getPool().query(
      `SELECT target_account_id, target_home_bay_id, notification_id, kind,
              event_type, payload_json, published_at
         FROM notification_target_outbox
        ORDER BY target_account_id ASC`,
    );
    expect(outbox).toEqual([
      {
        target_account_id: TARGET_ACCOUNT_ID,
        target_home_bay_id: HOME_BAY_ID,
        notification_id: created.targets[0].notification_id,
        kind: "mention",
        event_type: "notification.upserted",
        payload_json: expect.objectContaining({
          notification_id: created.targets[0].notification_id,
          kind: "mention",
          source_bay_id: SOURCE_BAY_ID,
          source_project_id: PROJECT_ID,
          target_account_id: TARGET_ACCOUNT_ID,
          summary: {
            description: "Harald mentioned you in chat",
            path: "work/chat.chat",
          },
          event_payload: {
            description: "Harald mentioned you in chat",
            priority: "normal",
          },
        }),
        published_at: null,
      },
      {
        target_account_id: OTHER_TARGET_ACCOUNT_ID,
        target_home_bay_id: OTHER_HOME_BAY_ID,
        notification_id: created.targets[1].notification_id,
        kind: "mention",
        event_type: "notification.upserted",
        payload_json: expect.objectContaining({
          notification_id: created.targets[1].notification_id,
          kind: "mention",
          source_bay_id: SOURCE_BAY_ID,
          source_project_id: PROJECT_ID,
          target_account_id: OTHER_TARGET_ACCOUNT_ID,
          summary: {
            description: "Harald mentioned you in chat",
            path: "work/chat.chat",
          },
          event_payload: {
            description: "Harald mentioned you in chat",
            priority: "normal",
          },
        }),
        published_at: null,
      },
    ]);
  });
});
