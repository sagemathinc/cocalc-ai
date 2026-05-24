/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockPoolQuery = jest.fn();
const mockGetTransactionClient = jest.fn();
const mockCreatePurchase = jest.fn();
const mockSend = jest.fn();
const mockAdminAlert = jest.fn();
const mockGetBalance = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: mockPoolQuery }),
  getTransactionClient: (...args) => mockGetTransactionClient(...args),
}));

jest.mock("./create-purchase", () => ({
  __esModule: true,
  default: (...args) => mockCreatePurchase(...args),
}));

jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args) => mockSend(...args),
  name: jest.fn().mockResolvedValue("User"),
  support: jest.fn().mockResolvedValue("Support"),
  url: jest.fn(async (path) => path),
}));

jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args) => mockAdminAlert(...args),
}));

jest.mock("./get-balance", () => ({
  __esModule: true,
  default: (...args) => mockGetBalance(...args),
}));

describe("resume subscription ownership checks", () => {
  const ownerAccountId = "11111111-1111-4111-8111-111111111111";
  const attackerAccountId = "22222222-2222-4222-8222-222222222222";
  const subscriptionId = 7;

  beforeEach(() => {
    jest.resetModules();
    mockPoolQuery.mockReset().mockResolvedValue({
      rows: [
        {
          id: subscriptionId,
          account_id: ownerAccountId,
          metadata: { type: "membership", class: "pro" },
          cost: 99,
          interval: "month",
          current_period_end: new Date("2026-01-01T00:00:00Z"),
          status: "canceled",
        },
      ],
    });
    mockGetTransactionClient.mockReset();
    mockCreatePurchase.mockReset();
    mockSend.mockReset();
    mockAdminAlert.mockReset();
    mockGetBalance.mockReset();
  });

  it("does not disclose resume cost for another account's subscription", async () => {
    const { costToResumeSubscription } = await import("./resume-subscription");

    await expect(
      costToResumeSubscription({
        account_id: attackerAccountId,
        subscription_id: subscriptionId,
      }),
    ).rejects.toThrow("you must be signed in as the owner of the subscription");

    expect(mockGetTransactionClient).not.toHaveBeenCalled();
    expect(mockCreatePurchase).not.toHaveBeenCalled();
  });

  it("does not create a purchase before verifying resume ownership", async () => {
    const { default: resumeSubscription } =
      await import("./resume-subscription");

    await expect(
      resumeSubscription({
        account_id: attackerAccountId,
        subscription_id: subscriptionId,
      }),
    ).rejects.toThrow("you must be signed in as the owner of the subscription");

    expect(mockGetTransactionClient).not.toHaveBeenCalled();
    expect(mockCreatePurchase).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockAdminAlert).not.toHaveBeenCalled();
    expect(mockGetBalance).not.toHaveBeenCalled();
  });
});
