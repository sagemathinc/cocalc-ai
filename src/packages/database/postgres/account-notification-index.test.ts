/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import {
  listProjectedNotificationsForAccount,
  rebuildAccountNotificationIndex,
} from "./account-notification-index";

const LOCAL_BAY_ID = "bay-local";
const OTHER_BAY_ID = "bay-other";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = "33333333-3333-4333-8333-333333333333";
const PROJECT_B = "44444444-4444-4444-8444-444444444444";

describe("account_notification_index rebuild", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(
      "TRUNCATE account_notification_index, mentions, projects, accounts CASCADE",
    );
  });

  afterAll(async () => {
    await testCleanup();
  });

  async function seedBaseRows(home_bay_id = LOCAL_BAY_ID): Promise<void> {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES
         ($1, 'Target', 'User', NOW(), 'target@example.com', $4),
         ($2, 'Source', 'User', NOW(), 'source@example.com', $4),
         ($3, 'Other', 'User', NOW(), 'other@example.com', $5)`,
      [
        ACCOUNT_ID,
        SOURCE_ACCOUNT_ID,
        "55555555-5555-4555-8555-555555555555",
        home_bay_id,
        OTHER_BAY_ID,
      ],
    );
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, users, owning_bay_id, created, last_edited, deleted)
       VALUES
         ($1, 'Project A', $3::JSONB, $4, NOW(), NOW(), FALSE),
         ($2, 'Project B', $3::JSONB, $4, NOW(), NOW(), FALSE)`,
      [
        PROJECT_A,
        PROJECT_B,
        JSON.stringify({
          [SOURCE_ACCOUNT_ID]: { group: "owner" },
          [ACCOUNT_ID]: { group: "collaborator" },
        }),
        LOCAL_BAY_ID,
      ],
    );
    await getPool().query(
      `INSERT INTO mentions
         (time, project_id, path, source, target, description, fragment_id, priority, users)
       VALUES
         ($1, $3, 'chat/a.md', $2, $4, 'unread mention', 'chat=true,id=a', 1,
          $5::JSONB),
         ($6, $7, 'chat/b.md', $2, $4, 'saved mention', 'chat=true,id=b', 2,
          $8::JSONB)`,
      [
        new Date("2026-04-03T22:00:00.000Z"),
        SOURCE_ACCOUNT_ID,
        PROJECT_A,
        ACCOUNT_ID,
        JSON.stringify({
          [ACCOUNT_ID]: { read: false, saved: false },
        }),
        new Date("2026-04-03T23:00:00.000Z"),
        PROJECT_B,
        JSON.stringify({
          [ACCOUNT_ID]: { read: true, saved: true },
        }),
      ],
    );
  }

  it("rebuilds projected mention notifications for a home-bay account", async () => {
    await seedBaseRows();

    await expect(
      rebuildAccountNotificationIndex({
        account_id: ACCOUNT_ID,
        bay_id: LOCAL_BAY_ID,
      }),
    ).resolves.toMatchObject({
      bay_id: LOCAL_BAY_ID,
      target_account_id: ACCOUNT_ID,
      dry_run: true,
      existing_rows: 0,
      source_rows: 2,
      unread_rows: 1,
      saved_rows: 1,
      deleted_rows: 0,
      inserted_rows: 0,
    });

    await expect(
      rebuildAccountNotificationIndex({
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
      unread_rows: 1,
      saved_rows: 1,
      deleted_rows: 0,
      inserted_rows: 2,
    });

    await expect(
      listProjectedNotificationsForAccount({
        account_id: ACCOUNT_ID,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "mention",
        project_id: PROJECT_B,
        summary: expect.objectContaining({
          path: "chat/b.md",
          description: "saved mention",
        }),
        read_state: {
          read: true,
          saved: true,
        },
      }),
      expect.objectContaining({
        kind: "mention",
        project_id: PROJECT_A,
        summary: expect.objectContaining({
          path: "chat/a.md",
          description: "unread mention",
        }),
        read_state: {
          read: false,
          saved: false,
        },
      }),
    ]);
  });

  it("rejects accounts homed in another bay", async () => {
    await seedBaseRows(OTHER_BAY_ID);

    await expect(
      rebuildAccountNotificationIndex({
        account_id: ACCOUNT_ID,
        bay_id: LOCAL_BAY_ID,
      }),
    ).rejects.toThrow(
      `account '${ACCOUNT_ID}' is not homed in bay '${LOCAL_BAY_ID}'`,
    );
  });
});
