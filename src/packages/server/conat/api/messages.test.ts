/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { sendSystemNotice } from "./messages";

const ADMIN_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";

describe("conat messages api", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(`TRUNCATE messages, accounts CASCADE`);
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
         ($3, 'Normal', 'User', NOW(), 'normal@example.com', 'bay-0', ARRAY[]::TEXT[])`,
      [ADMIN_ACCOUNT_ID, TARGET_ACCOUNT_ID, USER_ACCOUNT_ID],
    );
  }

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
        to_ids: [TARGET_ACCOUNT_ID, TARGET_ACCOUNT_ID],
        subject: "Maintenance",
        body: "Tonight",
        system_notice: true,
      }),
    ]);
    expect(rows[0].from_id).not.toBe(ADMIN_ACCOUNT_ID);
  });
});
