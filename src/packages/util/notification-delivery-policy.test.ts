/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { resolveNotificationDeliveryPolicy } from "./notification-delivery-policy";

describe("notification delivery policy", () => {
  it("routes mentions through collaboration notification email charged to actor", () => {
    expect(
      resolveNotificationDeliveryPolicy({
        kind: "mention",
        actor_account_id: "actor",
        target_account_id: "target",
        preferences: {
          email: {
            collaboration: "digest",
          },
        },
      }),
    ).toEqual({
      category: "collaboration",
      lane: "notification",
      delivery_mode: "digest",
      required: false,
      responsible_account_id: "actor",
    });
  });

  it("defaults Codex completion notices to AI email off", () => {
    expect(
      resolveNotificationDeliveryPolicy({
        kind: "account_notice",
        target_account_id: "target",
        summary: {
          notice_type: "codex_turn_completion",
        },
      }),
    ).toMatchObject({
      category: "ai",
      lane: "notification",
      delivery_mode: "off",
    });
  });

  it("forces billing notices to critical immediate without user charge", () => {
    expect(
      resolveNotificationDeliveryPolicy({
        kind: "account_notice",
        actor_account_id: "support",
        target_account_id: "target",
        summary: {
          title: "Dedicated host billing needs attention",
        },
        preferences: {
          email: {
            billing: "off",
          },
        },
      }),
    ).toEqual({
      category: "billing",
      lane: "critical",
      delivery_mode: "immediate",
      required: true,
      responsible_account_id: null,
    });
  });
});
