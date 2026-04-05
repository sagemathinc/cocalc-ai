/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { db } from "@cocalc/database";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_PROJECT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-04-04T16:30:00.000Z");

describe("projection-backed read paths", () => {
  let database: any;
  let publishProjectFeedMock: jest.Mock;

  beforeAll(async () => {
    await initEphemeralDatabase({});
    database = db();
  }, 15000);

  beforeEach(() => {
    publishProjectFeedMock = jest.fn(async () => undefined);
    database.publishProjectAccountFeedEventsBestEffort = publishProjectFeedMock;
  });

  afterEach(async () => {
    delete process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS;
    delete process.env.COCALC_ACCOUNT_NOTIFICATION_INDEX_MENTION_READS;
    if (database != null) {
      delete database.publishProjectAccountFeedEventsBestEffort;
    }
    await getPool().query(
      "TRUNCATE account_project_index, account_notification_index, mentions, projects, accounts CASCADE",
    );
  });

  afterAll(async () => {
    await testCleanup(database);
  });

  async function runUserQuery<T = any>(query: object, options: object[] = []) {
    return await new Promise<T>((resolve, reject) => {
      database.user_query({
        account_id: ACCOUNT_ID,
        query,
        options,
        cb: (err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        },
      });
    });
  }

  it.each(["prefer", "only"])(
    "executes projection-backed projects user_query in %s mode against pglite",
    async (mode) => {
      process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS = mode;

      await getPool().query(
        `INSERT INTO accounts
           (account_id, first_name, last_name, created, email_address, home_bay_id)
         VALUES
           ($1, 'Local', 'User', NOW(), 'local@example.com', 'bay-0')`,
        [ACCOUNT_ID],
      );
      await getPool().query(
        `INSERT INTO projects
           (project_id, title, users, created, last_edited, deleted)
         VALUES
           ($1, 'Projected Project', $2::JSONB, NOW(), NOW(), FALSE)`,
        [
          PROJECT_ID,
          JSON.stringify({
            [ACCOUNT_ID]: { group: "owner" },
          }),
        ],
      );
      await getPool().query(
        `INSERT INTO account_project_index
           (account_id, project_id, owning_bay_id, host_id, title, description,
            users_summary, state_summary, last_activity_at, last_opened_at,
            is_hidden, sort_key, updated_at)
         VALUES
           ($1, $2, 'bay-0', NULL, 'Projected Project', '',
            $3::JSONB, '{}'::JSONB, NULL, NULL, FALSE, $4, $4)`,
        [
          ACCOUNT_ID,
          PROJECT_ID,
          JSON.stringify({
            [ACCOUNT_ID]: { group: "owner" },
          }),
          NOW,
        ],
      );

      const result = await runUserQuery<{
        projects?: Array<{ project_id?: string; title?: string }>;
      }>(
        {
          projects: [{ project_id: null, title: null }],
        },
        [{ limit: 10 }],
      );

      expect(result.projects).toEqual([
        expect.objectContaining({
          project_id: PROJECT_ID,
          title: "Projected Project",
        }),
      ]);
    },
  );

  it("publishes immediate project account-feed invalidation after a projects set query", async () => {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES
         ($1, 'Local', 'User', NOW(), 'local@example.com', 'bay-0')`,
      [ACCOUNT_ID],
    );
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, users, created, last_edited, deleted)
       VALUES
         ($1, 'Projected Project', $2::JSONB, NOW(), NOW(), FALSE)`,
      [
        PROJECT_ID,
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
        }),
      ],
    );

    await runUserQuery({
      projects: {
        project_id: PROJECT_ID,
        title: "Updated Title",
      },
    });

    expect(publishProjectFeedMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
    });
  });

  it.each(["prefer", "only"])(
    "keeps mentions user_query project-scoped in %s mode",
    async (mode) => {
      process.env.COCALC_ACCOUNT_NOTIFICATION_INDEX_MENTION_READS = mode;

      await getPool().query(
        `INSERT INTO accounts
           (account_id, first_name, last_name, created, email_address, home_bay_id)
         VALUES
           ($1, 'Target', 'User', NOW(), 'target@example.com', 'bay-0'),
           ($2, 'Other', 'User', NOW(), 'other@example.com', 'bay-0')`,
        [ACCOUNT_ID, OTHER_ACCOUNT_ID],
      );
      await getPool().query(
        `INSERT INTO projects
           (project_id, title, users, created, last_edited, deleted)
         VALUES
           ($1, 'Visible Mentions', $3::JSONB, NOW(), NOW(), FALSE),
           ($2, 'Hidden Mentions', $4::JSONB, NOW(), NOW(), FALSE)`,
        [
          PROJECT_ID,
          OTHER_PROJECT_ID,
          JSON.stringify({
            [ACCOUNT_ID]: { group: "owner" },
          }),
          JSON.stringify({
            [OTHER_ACCOUNT_ID]: { group: "owner" },
          }),
        ],
      );
      await getPool().query(
        `INSERT INTO mentions
           (time, project_id, path, source, target, description, fragment_id, users)
         VALUES
           ($1, $2, '/a.chat', $3::UUID, $4::TEXT, 'self mention', 'frag-a', '{}'::JSONB),
           ($1, $2, '/b.chat', $5::UUID, $6::TEXT, 'other mention in same project', 'frag-b', '{}'::JSONB),
           ($1, $7, '/c.chat', $5::UUID, $4::TEXT, 'inaccessible project mention', 'frag-c', '{}'::JSONB)`,
        [
          NOW,
          PROJECT_ID,
          ACCOUNT_ID,
          ACCOUNT_ID,
          OTHER_ACCOUNT_ID,
          OTHER_ACCOUNT_ID,
          OTHER_PROJECT_ID,
        ],
      );

      const result = await runUserQuery<{
        mentions?: Array<{
          project_id?: string;
          path?: string;
          target?: string;
        }>;
      }>(
        {
          mentions: [
            {
              time: null,
              project_id: null,
              path: null,
              target: null,
            },
          ],
        },
        [{ limit: 10 }],
      );

      expect(result.mentions).toEqual([
        expect.objectContaining({
          project_id: PROJECT_ID,
          path: "/a.chat",
          target: ACCOUNT_ID,
        }),
        expect.objectContaining({
          project_id: PROJECT_ID,
          path: "/b.chat",
          target: OTHER_ACCOUNT_ID,
        }),
      ]);
    },
  );
});
