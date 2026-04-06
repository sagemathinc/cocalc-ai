/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { updateUnreadMessageCount } from "@cocalc/database/postgres/changefeed/messages";
import get from "./get";

const TARGET_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const DIRECT_SENDER_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const SUPPORT_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";

describe("server messages get", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({ reset: true });
  }, 15000);

  beforeEach(async () => {
    await getPool().query(`TRUNCATE messages, accounts CASCADE`);
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address)
       VALUES
         ($1, 'Target', 'User', NOW(), 'target@example.com'),
         ($2, 'Direct', 'Sender', NOW(), 'sender@example.com'),
         ($3, 'CoCalc', 'Support', NOW(), 'support@example.com')`,
      [TARGET_ACCOUNT_ID, DIRECT_SENDER_ACCOUNT_ID, SUPPORT_ACCOUNT_ID],
    );
    await getPool().query(
      `INSERT INTO messages
         (from_id, to_ids, subject, body, system_notice, sent)
       VALUES
         ($1, ARRAY[$2]::UUID[], 'System notice', 'This belongs in notifications', TRUE, NOW()),
         ($3, ARRAY[$2]::UUID[], 'Direct hello', 'This is a real message', FALSE, NOW())`,
      [SUPPORT_ACCOUNT_ID, TARGET_ACCOUNT_ID, DIRECT_SENDER_ACCOUNT_ID],
    );
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("filters system notices out of the received messages list", async () => {
    const rows = await get({
      account_id: TARGET_ACCOUNT_ID,
      type: "received",
    });
    expect(rows.map(({ subject }) => subject)).toEqual(["Direct hello"]);
  });

  it("excludes system notices from unread message counts", async () => {
    const unread = await updateUnreadMessageCount({
      account_id: TARGET_ACCOUNT_ID,
    });
    expect(unread).toBe(1);

    const { rows } = await getPool().query(
      `SELECT unread_message_count
         FROM accounts
        WHERE account_id = $1`,
      [TARGET_ACCOUNT_ID],
    );
    expect(rows[0]?.unread_message_count).toBe(1);
  });
});
