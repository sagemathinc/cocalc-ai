/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { uuid } from "@cocalc/util/misc";
import { before, after, getPool } from "@cocalc/server/test";
import { SUBSCRIPTION_RENEWAL } from "@cocalc/util/db-schema/purchases";
import {
  createTestAccount,
  createTestMembershipSubscription,
} from "@cocalc/server/purchases/test-data";

const mockCreatePaymentIntent = jest.fn();
const mockGetStripeCustomerId = jest.fn();
const mockGetServerSettings = jest.fn();
const mockSend = jest.fn();
const mockSupport = jest.fn();
const mockUrl = jest.fn();
const mockUseBalanceTowardSubscriptions = jest.fn();

jest.mock("./create-payment-intent", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCreatePaymentIntent(...args),
}));

jest.mock("./util", () => ({
  getStripeCustomerId: (...args: any[]) => mockGetStripeCustomerId(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => mockGetServerSettings(...args),
}));

jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args: any[]) => mockSend(...args),
  support: (...args: any[]) => mockSupport(...args),
  url: (...args: any[]) => mockUrl(...args),
}));

jest.mock("../subscription-renewal-notice", () => ({
  useBalanceTowardSubscriptions: (...args: any[]) =>
    mockUseBalanceTowardSubscriptions(...args),
}));

import createSubscriptionPayment from "./create-subscription-payment";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("createSubscriptionPayment", () => {
  beforeEach(async () => {
    await getPool().query("DELETE FROM subscriptions");
    mockCreatePaymentIntent.mockReset().mockResolvedValue({
      hosted_invoice_url: "https://stripe.example/invoice",
      payment_intent: "pi_renewal",
    });
    mockGetStripeCustomerId.mockReset().mockResolvedValue("cus_123");
    mockGetServerSettings.mockReset().mockResolvedValue({
      site_name: "CoCalc",
    });
    mockSend.mockReset().mockResolvedValue(undefined);
    mockSupport.mockReset().mockResolvedValue("support");
    mockUrl.mockReset().mockImplementation(async (path) => path);
    mockUseBalanceTowardSubscriptions.mockReset().mockResolvedValue(false);
  });

  it("does not process immediately before the renewal payment state is recorded", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { cost, subscription_id } = await createTestMembershipSubscription(
      account_id,
      {
        cost: 72,
      },
    );

    await createSubscriptionPayment({
      account_id,
      subscription_id,
    });

    expect(mockCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id,
        force: true,
        metadata: {
          subscription_id: `${subscription_id}`,
        },
        processImmediately: false,
        purpose: SUBSCRIPTION_RENEWAL,
      }),
    );

    const { rows } = await getPool().query(
      "SELECT payment FROM subscriptions WHERE id=$1",
      [subscription_id],
    );
    expect(rows[0].payment).toMatchObject({
      amount: cost,
      payment_intent_id: "pi_renewal",
      status: "active",
      subscription_id,
    });
  });
});
