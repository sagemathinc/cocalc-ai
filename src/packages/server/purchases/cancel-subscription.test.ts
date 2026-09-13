/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockPoolQuery = jest.fn();
const mockSend = jest.fn();
const mockAdminAlert = jest.fn();
const mockRecordMembershipAnalyticsEvent = jest.fn();
const mockLockAccountSpending = jest.fn();
const mockClient = {
  query: (...args: any[]) => mockPoolQuery(...args),
  release: jest.fn(),
};

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => mockClient,
  getTransactionClient: jest.fn(async () => mockClient),
}));

jest.mock("./lock-account-spending", () => ({
  lockAccountSpending: (...args: any[]) => mockLockAccountSpending(...args),
}));

jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args: any[]) => mockSend(...args),
  name: jest.fn().mockResolvedValue("Test User"),
  support: jest.fn().mockResolvedValue("Support"),
  url: jest.fn(async (path) => path),
}));

jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args: any[]) => mockAdminAlert(...args),
}));

jest.mock("@cocalc/server/membership/analytics", () => ({
  recordMembershipAnalyticsEvent: (...args: any[]) =>
    mockRecordMembershipAnalyticsEvent(...args),
}));

import cancelSubscription from "./cancel-subscription";

describe("cancelSubscription", () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockLockAccountSpending.mockReset().mockResolvedValue(undefined);
    mockSend.mockReset().mockResolvedValue(undefined);
    mockAdminAlert.mockReset().mockResolvedValue(undefined);
    mockRecordMembershipAnalyticsEvent.mockReset().mockResolvedValue(true);
    mockClient.release.mockReset();
  });

  it("does not send a cancellation notification when the account does not own the subscription", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(
      cancelSubscription({
        account_id: "wrong-account",
        subscription_id: 7,
      }),
    ).rejects.toThrow("You do not have a subscription with id 7.");

    expect(mockPoolQuery).toHaveBeenCalledTimes(4);
    expect(mockPoolQuery).toHaveBeenLastCalledWith("ROLLBACK");
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockAdminAlert).not.toHaveBeenCalled();
  });

  it("sends a cancellation notification after canceling the owned subscription", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            account_id: "owner-account",
            canceled_reason: "user request",
            cost: 10,
            interval: "month",
          },
        ],
      });

    await cancelSubscription({
      account_id: "owner-account",
      subscription_id: 8,
      reason: "user request",
    });

    expect(mockPoolQuery).toHaveBeenCalledTimes(5);
    expect(mockLockAccountSpending).toHaveBeenCalledWith(
      mockClient,
      "owner-account",
    );
    expect(mockLockAccountSpending.mock.invocationCallOrder[0]).toBeLessThan(
      mockPoolQuery.mock.invocationCallOrder[0],
    );
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to_ids: ["owner-account"],
        subject: "Subscription Id=8 Canceled",
      }),
    );
    expect(mockAdminAlert).toHaveBeenCalled();
  });

  it("records membership cancellation analytics with an occurrence-specific key", async () => {
    jest.useFakeTimers({
      now: new Date("2026-07-01T12:34:56.789Z"),
    });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            current_period_end: new Date("2026-08-01T00:00:00.000Z"),
            current_period_start: new Date("2026-07-01T00:00:00.000Z"),
            interval: "month",
            metadata: {
              class: "standard",
              trial: true,
              type: "membership",
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            account_id: "owner-account",
            canceled_reason: "user request",
            cost: 10,
            interval: "month",
          },
        ],
      });

    try {
      await cancelSubscription({
        account_id: "owner-account",
        subscription_id: 9,
        reason: "user request",
      });
    } finally {
      jest.useRealTimers();
    }

    expect(mockRecordMembershipAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "owner-account",
        event_key: "subscription:9:canceled:2026-07-01T12:34:56.789Z",
        event_type: "membership_canceled",
        membership_class: "standard",
        subscription_id: 9,
        trial_status: "canceled",
      }),
    );
  });

  it("rejects cancellation while a membership renewal is due", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ subscription_id: 10 }],
    });

    await expect(
      cancelSubscription({
        account_id: "owner-account",
        subscription_id: 10,
        reason: "user request",
      }),
    ).rejects.toThrow(/is renewing/);

    expect(mockPoolQuery).toHaveBeenCalledTimes(3);
    expect(mockPoolQuery).toHaveBeenLastCalledWith("ROLLBACK");
    expect(mockSend).not.toHaveBeenCalled();
  });
});
