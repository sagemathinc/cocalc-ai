/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { resolveNotificationDeliveryPolicy } from "./notification-delivery-policy";

describe("notification delivery policy", () => {
  it("routes direct mentions through mention notification email charged to actor", () => {
    expect(
      resolveNotificationDeliveryPolicy({
        kind: "mention",
        actor_account_id: "actor",
        target_account_id: "target",
        preferences: {
          email: {
            mentions: "digest",
          },
        },
      }),
    ).toMatchObject({
      category: "mentions",
      lane: "notification",
      delivery_mode: "digest",
      creates_in_app: true,
      required: false,
      responsible_account_id: "actor",
    });
  });

  it("routes followed chat thread replies separately from direct mentions", () => {
    expect(
      resolveNotificationDeliveryPolicy({
        kind: "mention",
        actor_account_id: "actor",
        target_account_id: "target",
        summary: {
          notification_reason: "thread_follow",
        },
        preferences: {
          email: {
            chat_replies: "none",
          },
        },
      }),
    ).toMatchObject({
      category: "chat_replies",
      delivery_mode: "none",
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
      creates_in_app: true,
    });
  });

  it("routes onboarding continuations through transactional status delivery", () => {
    expect(
      resolveNotificationDeliveryPolicy({
        kind: "account_notice",
        target_account_id: "target",
        summary: { notice_type: "onboarding_day_one" },
        preferences: { email: { onboarding: "off" } },
      }),
    ).toMatchObject({
      category: "onboarding",
      lane: "transactional",
      delivery_mode: "off",
      creates_in_app: true,
      required: false,
      responsible_account_id: null,
    });
  });

  it("honors a legacy first-project email decline", () => {
    expect(
      resolveNotificationDeliveryPolicy({
        kind: "account_notice",
        target_account_id: "target",
        summary: { notice_type: "onboarding_day_one" },
        preferences: { email: { product: "off" } },
        onboarding_email_declined: true,
      }),
    ).toMatchObject({
      category: "onboarding",
      delivery_mode: "off",
    });

    expect(
      resolveNotificationDeliveryPolicy({
        kind: "account_notice",
        target_account_id: "target",
        summary: { notice_type: "onboarding_day_one" },
        preferences: { email: { onboarding: "immediate" } },
        onboarding_email_declined: true,
      }),
    ).toMatchObject({
      category: "onboarding",
      delivery_mode: "immediate",
    });
  });

  it("allows optional mention categories to disable all delivery", () => {
    expect(
      resolveNotificationDeliveryPolicy({
        kind: "mention",
        actor_account_id: "actor",
        target_account_id: "target",
        preferences: {
          email: {
            mentions: "none",
          },
        },
      }),
    ).toMatchObject({
      category: "mentions",
      delivery_mode: "none",
      creates_in_app: false,
      required: false,
    });
  });

  it("routes project access requests to the access request category", () => {
    expect(
      resolveNotificationDeliveryPolicy({
        kind: "account_notice",
        actor_account_id: "requester",
        target_account_id: "manager",
        summary: {
          notice_type: "project_access_request",
        },
        preferences: {
          email: {
            access_requests: "none",
          },
        },
      }),
    ).toMatchObject({
      category: "access_requests",
      lane: "transactional",
      delivery_mode: "none",
      creates_in_app: false,
      required: false,
      responsible_account_id: null,
    });
  });

  it("routes site-license membership notices to membership requests", () => {
    expect(
      resolveNotificationDeliveryPolicy({
        kind: "account_notice",
        origin_kind: "admin",
        target_account_id: "member",
        summary: {
          origin_label: "Site licenses",
        },
        preferences: {
          email: {
            membership_requests: "off",
          },
        },
      }),
    ).toMatchObject({
      category: "membership_requests",
      lane: "transactional",
      delivery_mode: "immediate",
      creates_in_app: true,
      required: false,
      responsible_account_id: null,
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
    ).toMatchObject({
      category: "billing",
      lane: "critical",
      delivery_mode: "immediate",
      creates_in_app: true,
      required: true,
      responsible_account_id: null,
    });
  });

  it("keeps Codex inbox and delayed email policy independent", () => {
    expect(
      resolveNotificationDeliveryPolicy({
        kind: "account_notice",
        target_account_id: "target",
        summary: { notice_type: "codex_attention" },
        preferences_v2: {
          version: 2,
          ai: {
            events: {
              attention: {
                inbox: false,
                toast: true,
                browser: true,
                email: "unresolved_after_delay",
                email_delay_minutes: 7,
              },
            },
          },
        },
      }),
    ).toMatchObject({
      category: "ai",
      creates_in_app: false,
      delivery_mode: "immediate",
      email_delay_ms: 7 * 60_000,
    });
  });
});
