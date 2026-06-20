/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockPoolQuery = jest.fn();
const mockSend = jest.fn();
const mockAdminAlert = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => mockPoolQuery(...args) }),
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

import cancelSubscription from "./cancel-subscription";

describe("cancelSubscription", () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockSend.mockReset().mockResolvedValue(undefined);
    mockAdminAlert.mockReset().mockResolvedValue(undefined);
  });

  it("does not send a cancellation notification when the account does not own the subscription", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(
      cancelSubscription({
        account_id: "wrong-account",
        subscription_id: 7,
      }),
    ).rejects.toThrow("You do not have a subscription with id 7.");

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockAdminAlert).not.toHaveBeenCalled();
  });

  it("sends a cancellation notification after canceling the owned subscription", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
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

    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to_ids: ["owner-account"],
        subject: "Subscription Id=8 Canceled",
      }),
    );
    expect(mockAdminAlert).toHaveBeenCalled();
  });
});
