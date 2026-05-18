/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { send, sendSystemNotice } from "./messages";

const ADMIN_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";

describe("conat messages api", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(`TRUNCATE messages, projects, accounts CASCADE`);
  });

  afterAll(async () => {
    await getPool().end();
  });

  async function seedAccounts() {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id, groups)
       VALUES
         ($1, 'Admin', 'User', NOW(), 'admin@example.com', 'bay-0', ARRAY['admin']::TEXT[]),
         ($2, 'Target', 'User', NOW(), 'target@example.com', 'bay-0', ARRAY[]::TEXT[]),
         ($3, 'Normal', 'User', NOW(), 'normal@example.com', 'bay-0', ARRAY[]::TEXT[]),
         ($4, 'Other', 'User', NOW(), 'other@example.com', 'bay-0', ARRAY[]::TEXT[])`,
      [ADMIN_ACCOUNT_ID, TARGET_ACCOUNT_ID, USER_ACCOUNT_ID, OTHER_ACCOUNT_ID],
    );
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, users, owning_bay_id, created, last_edited, deleted)
       VALUES
         ($1, 'Message Project', $2::JSONB, 'bay-0', NOW(), NOW(), FALSE)`,
      [
        PROJECT_ID,
        JSON.stringify({
          [USER_ACCOUNT_ID]: { group: "owner" },
          [TARGET_ACCOUNT_ID]: { group: "collaborator" },
        }),
      ],
    );
  }

  it("sends user messages only to collaborators", async () => {
    await seedAccounts();

    const id = await send({
      account_id: USER_ACCOUNT_ID,
      to_ids: [TARGET_ACCOUNT_ID, "target@example.com"],
      subject: "Question",
      body: "Please look at this.",
    });

    expect(typeof id).toBe("number");
    const { rows } = await getPool().query(
      `SELECT from_id, to_ids, subject, body, system_notice
         FROM messages
        ORDER BY id DESC
        LIMIT 1`,
    );
    expect(rows).toEqual([
      {
        from_id: USER_ACCOUNT_ID,
        to_ids: [TARGET_ACCOUNT_ID],
        subject: "Question",
        body: "Please look at this.",
        system_notice: false,
      },
    ]);

    await expect(
      send({
        account_id: USER_ACCOUNT_ID,
        to_ids: [OTHER_ACCOUNT_ID],
        subject: "Spam",
        body: "No shared project.",
      }),
    ).rejects.toThrow("message recipients must be collaborators");
  });

  it("requires admin to send a system notice", async () => {
    await seedAccounts();

    await expect(
      sendSystemNotice({
        account_id: USER_ACCOUNT_ID,
        to_ids: [TARGET_ACCOUNT_ID],
        subject: "Maintenance",
        body: "Tonight",
      }),
    ).rejects.toThrow("only admin may send system notices");
  });

  it("sends a system notice without a user sender and resolves email targets", async () => {
    await seedAccounts();

    const id = await sendSystemNotice({
      account_id: ADMIN_ACCOUNT_ID,
      to_ids: [TARGET_ACCOUNT_ID, "target@example.com"],
      subject: "Maintenance",
      body: "Tonight",
      dedupMinutes: 10,
    });

    expect(typeof id).toBe("number");
    const { rows } = await getPool().query(
      `SELECT from_id, to_ids, subject, body, system_notice
         FROM messages
        ORDER BY id DESC
        LIMIT 1`,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        from_id: expect.any(String),
        to_ids: [TARGET_ACCOUNT_ID],
        subject: "Maintenance",
        body: "Tonight",
        system_notice: true,
      }),
    ]);
    expect(rows[0].from_id).not.toBe(ADMIN_ACCOUNT_ID);
  });
});
