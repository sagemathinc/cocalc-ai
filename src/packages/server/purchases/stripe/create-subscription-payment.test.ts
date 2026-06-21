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

import createSubscriptionPayment, {
  processSubscriptionRenewal,
} from "./create-subscription-payment";

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

  it("does not duplicate renewal purchases when a payment intent is retried", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { subscription_id } = await createTestMembershipSubscription(
      account_id,
      {
        cost: 72,
        status: "past_due",
      },
    );
    const newExpiresMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await getPool().query("UPDATE subscriptions SET payment=$2 WHERE id=$1", [
      subscription_id,
      {
        new_expires_ms: newExpiresMs,
        payment_intent_id: "pi_retry",
        status: "active",
      },
    ]);

    const paymentIntent = {
      metadata: { subscription_id: `${subscription_id}` },
    };
    await processSubscriptionRenewal({
      account_id,
      paymentIntent,
      amount: 72,
    });
    await processSubscriptionRenewal({
      account_id,
      paymentIntent,
      amount: 72,
    });

    const { rows: purchases } = await getPool().query(
      `SELECT id
         FROM purchases
        WHERE account_id=$1
          AND service='membership'
          AND description->>'type'='membership'
          AND (description->>'subscription_id')::int=$2`,
      [account_id, subscription_id],
    );
    expect(purchases).toHaveLength(1);

    const { rows: subscriptions } = await getPool().query(
      "SELECT latest_purchase_id, payment FROM subscriptions WHERE id=$1",
      [subscription_id],
    );
    expect(subscriptions[0].latest_purchase_id).toBe(purchases[0].id);
    expect(subscriptions[0].payment).toMatchObject({ status: "paid" });
  });
});
