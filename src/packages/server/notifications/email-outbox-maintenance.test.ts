/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  sendDailyNotificationDigestBatch,
  sendQueuedNotificationEmailBatch,
} from "./email-outbox-maintenance";
import { getServerSettings } from "@cocalc/database/settings";

const claimQueuedNotificationEmails = jest.fn();
const claimDigestNotificationEmails = jest.fn();
const markNotificationEmailSent = jest.fn();
const markNotificationEmailsSent = jest.fn();
const markNotificationEmailFailed = jest.fn();
const markNotificationEmailStatus = jest.fn();

jest.mock("@cocalc/database/postgres/notification-email-outbox", () => ({
  claimQueuedNotificationEmails: (...args: unknown[]) =>
    claimQueuedNotificationEmails(...args),
  claimDigestNotificationEmails: (...args: unknown[]) =>
    claimDigestNotificationEmails(...args),
  markNotificationEmailSent: (...args: unknown[]) =>
    markNotificationEmailSent(...args),
  markNotificationEmailsSent: (...args: unknown[]) =>
    markNotificationEmailsSent(...args),
  markNotificationEmailFailed: (...args: unknown[]) =>
    markNotificationEmailFailed(...args),
  markNotificationEmailStatus: (...args: unknown[]) =>
    markNotificationEmailStatus(...args),
}));

jest.mock("@cocalc/database/settings", () => ({
  getServerSettings: jest.fn(async () => ({
    help_email: "help@example.com",
    site_name: "CoCalc",
  })),
}));

jest.mock("@cocalc/server/hub/site-url", () =>
  jest.fn(async (path: string) => `https://cocalc.test/${path}`),
);

const getServerSettingsMock = getServerSettings as jest.MockedFunction<
  typeof getServerSettings
>;

const ROW = {
  email_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  notification_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  event_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  target_account_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  actor_account_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  responsible_account_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  category: "collaboration",
  lane: "notification",
  delivery_mode: "immediate",
  recipient_email: "user@example.com",
  subject: "CoCalc mention in chat",
  summary_json: {
    summary: {
      description: "You were mentioned.",
      path: "chat.chat",
    },
  },
  status: "sending",
  scheduled_at: new Date("2026-05-10T00:00:00.000Z"),
  sent_at: null,
  attempt_count: 1,
  last_error: null,
  created_at: new Date("2026-05-10T00:00:00.000Z"),
  updated_at: new Date("2026-05-10T00:00:00.000Z"),
} as const;

describe("notification email outbox maintenance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getServerSettingsMock.mockResolvedValue({
      help_email: "help@example.com",
      site_name: "CoCalc",
    } as any);
    markNotificationEmailSent.mockResolvedValue(undefined);
    markNotificationEmailsSent.mockResolvedValue(undefined);
    markNotificationEmailFailed.mockResolvedValue(undefined);
    markNotificationEmailStatus.mockResolvedValue(undefined);
    claimQueuedNotificationEmails.mockResolvedValue([]);
    claimDigestNotificationEmails.mockResolvedValue([]);
  });

  it("sends claimed immediate notification email and marks it sent", async () => {
    claimQueuedNotificationEmails.mockResolvedValue([ROW]);
    const sender = jest.fn(async () => undefined);

    await expect(
      sendQueuedNotificationEmailBatch({
        sender,
        emailConfigured: jest.fn(async () => true),
        sendLimitChecker: jest.fn(async () => ({ allowed: true })),
      }),
    ).resolves.toEqual({
      claimed: 1,
      sent: 1,
      skipped_no_backend: 0,
      failed: 0,
    });

    expect(sender).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
        subject: "CoCalc mention in chat",
        categories: ["notification-collaboration", "notification"],
      }),
      ROW.responsible_account_id,
      "notification",
    );
    expect(markNotificationEmailSent).toHaveBeenCalledWith({
      email_id: ROW.email_id,
    });
  });

  it("marks rows skipped when the lane has no backend", async () => {
    claimQueuedNotificationEmails.mockResolvedValue([ROW]);

    await expect(
      sendQueuedNotificationEmailBatch({
        sender: jest.fn(async () => undefined),
        emailConfigured: jest.fn(async () => false),
        sendLimitChecker: jest.fn(async () => ({ allowed: true })),
      }),
    ).resolves.toMatchObject({
      claimed: 1,
      sent: 0,
      skipped_no_backend: 1,
      failed: 0,
    });

    expect(markNotificationEmailStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        email_id: ROW.email_id,
        status: "skipped_no_backend",
      }),
    );
  });

  it("marks immediate rows failed when help_email is not configured", async () => {
    claimQueuedNotificationEmails.mockResolvedValue([ROW]);
    getServerSettingsMock.mockResolvedValue({
      help_email: "",
      site_name: "CoCalc",
    } as any);
    const sender = jest.fn(async () => undefined);

    await expect(
      sendQueuedNotificationEmailBatch({
        sender,
        emailConfigured: jest.fn(async () => true),
        sendLimitChecker: jest.fn(async () => ({ allowed: true })),
      }),
    ).resolves.toMatchObject({
      claimed: 1,
      sent: 0,
      failed: 1,
    });

    expect(sender).not.toHaveBeenCalled();
    expect(markNotificationEmailFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        email_id: ROW.email_id,
        error: expect.objectContaining({
          message:
            "notification email requires the site setting help_email to be configured",
        }),
      }),
    );
  });

  it("marks rows skipped when the responsible account is over its send limit", async () => {
    claimQueuedNotificationEmails.mockResolvedValue([ROW]);
    const sender = jest.fn(async () => undefined);

    await expect(
      sendQueuedNotificationEmailBatch({
        sender,
        emailConfigured: jest.fn(async () => true),
        sendLimitChecker: jest.fn(async () => ({
          allowed: false,
          blocked_by: "5h",
          notification_email_sent_5h: 11,
          notification_email_sent_7d: 11,
          notification_email_send_limit_5h: 10,
          notification_email_send_limit_7d: 40,
        })),
      }),
    ).resolves.toMatchObject({
      claimed: 1,
      sent: 0,
      failed: 1,
    });

    expect(sender).not.toHaveBeenCalled();
    expect(markNotificationEmailStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        email_id: ROW.email_id,
        status: "skipped_rate_limited",
      }),
    );
  });

  it("sends one digest email for claimed digest rows", async () => {
    const digestRows = [
      { ...ROW, email_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" },
      {
        ...ROW,
        email_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        subject: "Second digest item",
        summary_json: {
          summary: {
            description: "Another item.",
            path: "other.chat",
          },
        },
      },
    ];
    claimDigestNotificationEmails.mockResolvedValue(digestRows);
    const sender = jest.fn(async () => undefined);

    await expect(
      sendDailyNotificationDigestBatch({
        force: true,
        sender,
        emailConfigured: jest.fn(async () => true),
        sendLimitChecker: jest.fn(async () => ({ allowed: true })),
      }),
    ).resolves.toMatchObject({
      claimed: 2,
      digests_sent: 1,
      rows_sent: 2,
      failed: 0,
    });

    expect(sender).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
        subject: "Daily CoCalc notification digest (2)",
        categories: ["notification-digest", "notification"],
      }),
      undefined,
      "notification",
    );
    expect(markNotificationEmailsSent).toHaveBeenCalledWith({
      email_ids: [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      ],
    });
  });

  it("marks digest rows failed when help_email is not configured", async () => {
    const digestRows = [
      { ...ROW, email_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" },
      {
        ...ROW,
        email_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        subject: "Second digest item",
      },
    ];
    claimDigestNotificationEmails.mockResolvedValue(digestRows);
    getServerSettingsMock.mockResolvedValue({
      help_email: "",
      site_name: "CoCalc",
    } as any);
    const sender = jest.fn(async () => undefined);

    await expect(
      sendDailyNotificationDigestBatch({
        force: true,
        sender,
        emailConfigured: jest.fn(async () => true),
        sendLimitChecker: jest.fn(async () => ({ allowed: true })),
      }),
    ).resolves.toMatchObject({
      claimed: 2,
      digests_sent: 0,
      rows_sent: 0,
      failed: 2,
    });

    expect(sender).not.toHaveBeenCalled();
    expect(markNotificationEmailFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        email_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        error: expect.objectContaining({
          message:
            "notification email requires the site setting help_email to be configured",
        }),
      }),
    );
    expect(markNotificationEmailFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        email_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        error: expect.objectContaining({
          message:
            "notification email requires the site setting help_email to be configured",
        }),
      }),
    );
  });
});
