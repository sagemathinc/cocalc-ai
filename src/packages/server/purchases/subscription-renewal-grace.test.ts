/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// A renewal payment that needs the customer (declined card, or the bank asks
// them to authenticate) must not end the membership immediately: the payment
// stays open, benefits continue for a grace period, and the customer is told
// once. Only after the grace period does the subscription get canceled.

import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import dayjs from "dayjs";
import {
  createTestAccount,
  createTestMembershipSubscription,
} from "./test-data";
import {
  RENEWAL_CUSTOMER_ACTION_RECHECK_MS,
  scheduleMissingSubscriptionRenewalAttempts,
} from "./subscription-renewal-attempts";

const mockRetrievePaymentIntent = jest.fn();
const mockRetrieveInvoice = jest.fn();
const mockCancelPaymentIntent = jest.fn();
const mockProcessFailure = jest.fn();
const mockProcessPaymentIntents = jest.fn();
const mockSend = jest.fn();
const mockCreateSubscriptionPayment = jest.fn();

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: async () => ({
    paymentIntents: {
      retrieve: (...args: any[]) => mockRetrievePaymentIntent(...args),
    },
    invoices: { retrieve: (...args: any[]) => mockRetrieveInvoice(...args) },
  }),
}));

jest.mock("./stripe/create-subscription-payment", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCreateSubscriptionPayment(...args),
  processSubscriptionRenewalFailure: (...args: any[]) =>
    mockProcessFailure(...args),
}));

jest.mock("./stripe/create-payment-intent", () => ({
  cancelPaymentIntent: (...args: any[]) => mockCancelPaymentIntent(...args),
}));

jest.mock("./stripe/process-payment-intents", () => ({
  __esModule: true,
  default: (...args: any[]) => mockProcessPaymentIntents(...args),
}));

jest.mock("@cocalc/server/purchases/billing-authority/context", () => ({
  registerBillingAuthorityAccount: async () => {},
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({
    site_name: "CoCalc",
    subscription_maintenance: { renewal_mode: "active" },
  }),
}));

jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args: any[]) => mockSend(...args),
  url: async (...args: any[]) => args.join("/"),
  support: async () => "support",
}));

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

async function setupDueRenewal(
  periodEnd: Date,
  { bound = true }: { bound?: boolean } = {},
) {
  const account_id = uuid();
  await createTestAccount(account_id);
  const { subscription_id } = await createTestMembershipSubscription(
    account_id,
    { start: dayjs(periodEnd).subtract(1, "month").toDate(), end: periodEnd },
  );
  await scheduleMissingSubscriptionRenewalAttempts();
  const payment_intent_id = `pi_${uuid().replaceAll("-", "")}`;
  if (!bound) {
    return { account_id, subscription_id, payment_intent_id };
  }
  await getPool().query(
    `UPDATE subscription_renewal_attempts
        SET payment_intent_id=$2, stripe_invoice_id='in_test'
      WHERE subscription_id=$1`,
    [subscription_id, payment_intent_id],
  );
  return { account_id, subscription_id, payment_intent_id };
}

async function attemptRow(subscription_id: number) {
  const { rows } = await getPool().query(
    `SELECT a.state, a.customer_action_required_at IS NOT NULL AS waiting,
            a.customer_action_notified_at IS NOT NULL AS notified,
            EXTRACT(EPOCH FROM (a.next_attempt_at - NOW())) * 1000 AS next_in_ms,
            a.last_error, s.status
       FROM subscription_renewal_attempts a
       JOIN subscriptions s ON s.id=a.subscription_id
      WHERE a.subscription_id=$1`,
    [subscription_id],
  );
  return rows[0];
}

async function runWorker() {
  const { default: maintainSubscriptionRenewals } =
    await import("./subscription-renewal-worker");
  await maintainSubscriptionRenewals();
}

describe("subscription renewal grace period", () => {
  beforeEach(async () => {
    await getPool().query("DELETE FROM subscription_renewal_attempts");
    await getPool().query("DELETE FROM subscriptions");
    for (const m of [
      mockRetrievePaymentIntent,
      mockRetrieveInvoice,
      mockCancelPaymentIntent,
      mockProcessFailure,
      mockProcessPaymentIntents,
      mockSend,
      mockCreateSubscriptionPayment,
    ]) {
      m.mockReset();
    }
    mockRetrieveInvoice.mockResolvedValue({
      hosted_invoice_url: "https://invoice.example/pay",
    });
  });

  it.each(["requires_action", "requires_payment_method"])(
    "keeps the payment open and the subscription active when it %s",
    async (status) => {
      const { account_id, subscription_id, payment_intent_id } =
        await setupDueRenewal(dayjs().subtract(1, "minute").toDate());
      mockRetrievePaymentIntent.mockResolvedValue({
        id: payment_intent_id,
        status,
      });

      await runWorker();

      expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
      expect(mockProcessFailure).not.toHaveBeenCalled();
      const row = await attemptRow(subscription_id);
      expect(row).toEqual(
        expect.objectContaining({
          state: "scheduled",
          status: "active",
          waiting: true,
          notified: true,
        }),
      );
      // Rechecked later, not every minute.
      expect(Number(row.next_in_ms)).toBeGreaterThan(
        RENEWAL_CUSTOMER_ACTION_RECHECK_MS - 60_000,
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      const message = mockSend.mock.calls[0][0];
      expect(message.to_ids).toEqual([account_id]);
      expect(message.subject).toContain("Action needed");
      expect(message.body).toContain("https://invoice.example/pay");
      expect(message.body).toContain("stays active until");

      // The membership is still in force while the attempt is open.
      const { rows } = await getPool().query(
        `SELECT 1 FROM subscriptions s
           JOIN subscription_renewal_attempts a ON a.subscription_id=s.id
          WHERE s.id=$1 AND s.status='active'
            AND a.state IN ('scheduled','processing') AND a.not_before <= NOW()`,
        [subscription_id],
      );
      expect(rows.length).toBe(1);
    },
  );

  it("notifies the customer only once across rechecks", async () => {
    const { subscription_id, payment_intent_id } = await setupDueRenewal(
      dayjs().subtract(1, "hour").toDate(),
    );
    mockRetrievePaymentIntent.mockResolvedValue({
      id: payment_intent_id,
      status: "requires_action",
    });
    await runWorker();
    await getPool().query(
      "UPDATE subscription_renewal_attempts SET next_attempt_at=NOW() WHERE subscription_id=$1",
      [subscription_id],
    );
    await runWorker();

    expect(mockRetrievePaymentIntent).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockProcessFailure).not.toHaveBeenCalled();
  });

  it("completes the renewal when the customer pays during the grace period", async () => {
    const { subscription_id, payment_intent_id } = await setupDueRenewal(
      dayjs().subtract(2, "days").toDate(),
    );
    mockRetrievePaymentIntent.mockResolvedValue({
      id: payment_intent_id,
      status: "requires_action",
    });
    await runWorker();
    await getPool().query(
      "UPDATE subscription_renewal_attempts SET next_attempt_at=NOW() WHERE subscription_id=$1",
      [subscription_id],
    );
    mockRetrievePaymentIntent.mockResolvedValue({
      id: payment_intent_id,
      status: "succeeded",
    });
    await runWorker();

    expect(mockProcessPaymentIntents).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent_id, strict: true }),
    );
    expect(mockProcessFailure).not.toHaveBeenCalled();
  });

  it("cancels after the grace period ends", async () => {
    const { payment_intent_id } = await setupDueRenewal(
      dayjs().subtract(8, "days").toDate(),
    );
    mockRetrievePaymentIntent.mockResolvedValue({
      id: payment_intent_id,
      status: "requires_payment_method",
    });

    await runWorker();

    expect(mockCancelPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ id: payment_intent_id }),
    );
    expect(mockProcessFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntent: expect.objectContaining({ status: "canceled" }),
      }),
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("treats an already canceled payment as final", async () => {
    const { payment_intent_id } = await setupDueRenewal(
      dayjs().subtract(1, "minute").toDate(),
    );
    mockRetrievePaymentIntent.mockResolvedValue({
      id: payment_intent_id,
      status: "canceled",
    });

    await runWorker();

    expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
    expect(mockProcessFailure).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("includes the payment link when the payment was created in this run", async () => {
    const { subscription_id, payment_intent_id } = await setupDueRenewal(
      dayjs().subtract(1, "minute").toDate(),
      { bound: false },
    );
    // Like the real implementation, creating the payment binds the payment
    // intent and its invoice to the attempt in the database.
    mockCreateSubscriptionPayment.mockImplementation(async () => {
      await getPool().query(
        `UPDATE subscription_renewal_attempts
            SET payment_intent_id=$2, stripe_invoice_id='in_new'
          WHERE subscription_id=$1`,
        [subscription_id, payment_intent_id],
      );
      return { payment_intent_id };
    });
    mockRetrievePaymentIntent.mockResolvedValue({
      id: payment_intent_id,
      status: "requires_action",
    });

    await runWorker();

    expect(mockRetrieveInvoice).toHaveBeenCalledWith("in_new");
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].body).toContain(
      "https://invoice.example/pay",
    );
  });

  it("retries the notice on the next recheck when sending fails", async () => {
    const { subscription_id, payment_intent_id } = await setupDueRenewal(
      dayjs().subtract(1, "hour").toDate(),
    );
    mockRetrievePaymentIntent.mockResolvedValue({
      id: payment_intent_id,
      status: "requires_payment_method",
    });
    mockSend.mockRejectedValueOnce(new Error("mail is down"));

    await runWorker();
    expect(await attemptRow(subscription_id)).toEqual(
      expect.objectContaining({ waiting: true, notified: false }),
    );

    const recheck = () =>
      getPool().query(
        "UPDATE subscription_renewal_attempts SET next_attempt_at=NOW() WHERE subscription_id=$1",
        [subscription_id],
      );
    await recheck();
    await runWorker();
    expect(await attemptRow(subscription_id)).toEqual(
      expect.objectContaining({ waiting: true, notified: true }),
    );
    expect(mockSend).toHaveBeenCalledTimes(2);

    await recheck();
    await runWorker();
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("does not hold an authorized payment awaiting capture", async () => {
    const { payment_intent_id } = await setupDueRenewal(
      dayjs().subtract(1, "minute").toDate(),
    );
    mockRetrievePaymentIntent.mockResolvedValue({
      id: payment_intent_id,
      status: "requires_capture",
    });

    await runWorker();

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockProcessFailure).toHaveBeenCalledTimes(1);
  });
});
