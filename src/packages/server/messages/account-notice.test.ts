/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { mirrorSystemMessageToAccountNotice } from "./account-notice";

const SUPPORT_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_TARGET_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";

describe("server messages account notice bridge", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE notification_target_outbox,
                notification_targets,
                notification_events,
                accounts
         CASCADE`,
    );
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES
         ($1, 'CoCalc', 'Support', NOW(), 'support@example.com', 'bay-0'),
         ($2, 'Target', 'One', NOW(), 'target1@example.com', 'bay-0'),
         ($3, 'Target', 'Two', NOW(), 'target2@example.com', 'bay-1')`,
      [SUPPORT_ACCOUNT_ID, TARGET_ACCOUNT_ID, OTHER_TARGET_ACCOUNT_ID],
    );
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("mirrors a system message into account notice notifications", async () => {
    await mirrorSystemMessageToAccountNotice({
      from_id: SUPPORT_ACCOUNT_ID,
      to_ids: [TARGET_ACCOUNT_ID, OTHER_TARGET_ACCOUNT_ID],
      subject: "Billing notice",
      body: "Please update your payment method.",
      message_id: 17,
    });

    const { rows: events } = await getPool().query(
      `SELECT kind, actor_account_id, origin_kind, payload_json
         FROM notification_events`,
    );
    expect(events).toEqual([
      {
        kind: "account_notice",
        actor_account_id: SUPPORT_ACCOUNT_ID,
        origin_kind: "system",
        payload_json: {
          title: "Billing notice",
          body_markdown: "Please update your payment method.",
          severity: "info",
          origin_label: "Messages",
          message_id: 17,
        },
      },
    ]);

    const { rows: targets } = await getPool().query(
      `SELECT target_account_id, target_home_bay_id, dedupe_key
         FROM notification_targets
        ORDER BY target_account_id ASC`,
    );
    expect(targets).toEqual([
      {
        target_account_id: TARGET_ACCOUNT_ID,
        target_home_bay_id: "bay-0",
        dedupe_key: "system-message:17:22222222-2222-4222-8222-222222222222",
      },
      {
        target_account_id: OTHER_TARGET_ACCOUNT_ID,
        target_home_bay_id: "bay-1",
        dedupe_key: "system-message:17:33333333-3333-4333-8333-333333333333",
      },
    ]);
  });
});
