/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import dayjs from "dayjs";

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  createTestAccount,
  createTestMembershipSubscription,
} from "./test-data";

const mockCreateSubscriptionPayment = jest.fn();
const mockSend = jest.fn();
const mockSendCancelNotification = jest.fn();

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({
    site_name: "CoCalc",
    subscription_maintenance: { renewal_mode: "active" },
  }),
}));
jest.mock("./stripe/create-subscription-payment", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCreateSubscriptionPayment(...args),
  processSubscriptionRenewalFailure: jest.fn(),
}));
jest.mock("./cancel-subscription", () => ({
  sendCancelNotification: (...args: any[]) =>
    mockSendCancelNotification(...args),
}));
jest.mock("@cocalc/server/purchases/billing-authority/context", () => ({
  registerBillingAuthorityAccount: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args: any[]) => mockSend(...args),
  support: async () => "",
  url: async (path: string) => path,
}));

import maintainSubscriptionRenewals from "./subscription-renewal-worker";
import {
  BUSINESS_TAX_ID_REFUSAL_PREFIX,
  claimDueSubscriptionRenewalAttempts,
  completeSubscriptionRenewalAttempt,
  deferSubscriptionRenewalAttemptForCustomer,
  RENEWAL_ATTEMPT_RETRY_MS,
  RENEWAL_CUSTOMER_ACTION_RECHECK_MS,
} from "./subscription-renewal-attempts";

const taxRefusal = () =>
  Object.assign(new Error("a VAT ID is required"), {
    code: "business_tax_id_required",
  });

beforeAll(async () => {
  await before({ noConat: true });
}, 15_000);
afterAll(after);

async function dueRenewal(end = dayjs().subtract(1, "hour").toDate()) {
  const account_id = uuid();
  await createTestAccount(account_id);
  const { subscription_id } = await createTestMembershipSubscription(
    account_id,
    { start: dayjs(end).subtract(1, "month").toDate(), end },
  );
  return { account_id, subscription_id };
}

async function recheckNow(subscription_id: number) {
  await getPool().query(
    `UPDATE subscription_renewal_attempts
        SET next_attempt_at=NOW() - INTERVAL '1 second'
      WHERE subscription_id=$1`,
    [subscription_id],
  );
}

async function subscriptionStatus(subscription_id: number) {
  const { rows } = await getPool().query(
    "SELECT status FROM subscriptions WHERE id=$1",
    [subscription_id],
  );
  return rows[0]?.status;
}

async function attemptOf(subscription_id: number) {
  const { rows } = await getPool().query(
    `SELECT *, EXTRACT(EPOCH FROM (next_attempt_at - NOW())) * 1000 AS wait_ms
       FROM subscription_renewal_attempts WHERE subscription_id=$1`,
    [subscription_id],
  );
  return rows[0];
}

describe("subscription renewal worker", () => {
  beforeEach(async () => {
    await getPool().query("DELETE FROM subscription_renewal_attempts");
    await getPool().query("DELETE FROM subscriptions");
    await getPool().query("DELETE FROM business_tax_id_notices");
    mockCreateSubscriptionPayment.mockReset();
    mockSend.mockReset();
    mockSendCancelNotification.mockReset();
  });

  it("waits for the customer when the business tax ID check refuses a renewal", async () => {
    const { subscription_id } = await dueRenewal();
    mockCreateSubscriptionPayment.mockRejectedValue(taxRefusal());

    await maintainSubscriptionRenewals({ max_attempts: 1 });

    const attempt = await attemptOf(subscription_id);
    expect(mockCreateSubscriptionPayment).toHaveBeenCalledTimes(1);
    // rechecked hours later, not every minute
    expect(attempt.state).toBe("scheduled");
    expect(Number(attempt.wait_ms)).toBeGreaterThan(
      RENEWAL_CUSTOMER_ACTION_RECHECK_MS - 60_000,
    );
    expect(attempt.last_error.startsWith(BUSINESS_TAX_ID_REFUSAL_PREFIX)).toBe(
      true,
    );
    // the card/bank action state is untouched
    expect(attempt.customer_action_required_at).toBeNull();
    expect(attempt.customer_action_notified_at).toBeNull();
    expect(await subscriptionStatus(subscription_id)).toBe("active");
    // the customer is told what to do, which subscription, and until when
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [{ subject, body, dedupBySubject }] = mockSend.mock.calls[0];
    expect(subject).toContain(`Id ${subscription_id}`);
    expect(dedupBySubject).toBe(true);
    expect(body).toContain("VAT number");
    expect(body).toContain("payment-methods");
    expect(body).toMatch(/stays active until .+ will be canceled/s);
    // and the generic weekly notice is claimed, so it is not sent as well
    const { rows } = await getPool().query(
      "SELECT 1 FROM business_tax_id_notices WHERE account_id=$1",
      [attempt.account_id],
    );
    expect(rows.length).toBe(1);
  });

  it("does not notify again on the next recheck the same day", async () => {
    const { subscription_id } = await dueRenewal();
    mockCreateSubscriptionPayment.mockRejectedValue(taxRefusal());
    await maintainSubscriptionRenewals({ max_attempts: 1 });
    await recheckNow(subscription_id);
    await maintainSubscriptionRenewals({ max_attempts: 1 });

    expect(mockCreateSubscriptionPayment).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("waits a day after the generic VAT notice before sending its own", async () => {
    const { account_id, subscription_id } = await dueRenewal();
    await getPool().query(
      `INSERT INTO business_tax_id_notices (account_id, notified_at)
       VALUES ($1, NOW() - INTERVAL '2 hours')`,
      [account_id],
    );
    mockCreateSubscriptionPayment.mockRejectedValue(taxRefusal());
    await maintainSubscriptionRenewals({ max_attempts: 1 });
    expect(mockSend).not.toHaveBeenCalled();
    expect((await attemptOf(subscription_id)).state).toBe("scheduled");

    await getPool().query(
      `UPDATE business_tax_id_notices SET notified_at=NOW() - INTERVAL '25 hours'
        WHERE account_id=$1`,
      [account_id],
    );
    await recheckNow(subscription_id);
    await maintainSubscriptionRenewals({ max_attempts: 1 });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("renews on the next recheck once a VAT number is on file", async () => {
    const { subscription_id } = await dueRenewal();
    mockCreateSubscriptionPayment.mockRejectedValue(taxRefusal());
    await maintainSubscriptionRenewals({ max_attempts: 1 });

    // the customer adds a VAT number: the check passes and the renewal is paid
    mockCreateSubscriptionPayment.mockReset();
    mockCreateSubscriptionPayment.mockImplementation(
      async ({ renewal_attempt_id }) => {
        await completeSubscriptionRenewalAttempt({
          attempt_id: renewal_attempt_id,
          state: "succeeded",
        });
        return {};
      },
    );
    await recheckNow(subscription_id);
    await maintainSubscriptionRenewals({ max_attempts: 1 });

    expect(mockCreateSubscriptionPayment).toHaveBeenCalledTimes(1);
    expect((await attemptOf(subscription_id)).state).toBe("succeeded");
    expect(await subscriptionStatus(subscription_id)).toBe("active");
    expect(mockSendCancelNotification).not.toHaveBeenCalled();
  });

  it("cancels the subscription if it is still refused when the grace period ends", async () => {
    const { subscription_id } = await dueRenewal(
      dayjs().subtract(8, "day").toDate(),
    );
    mockCreateSubscriptionPayment.mockRejectedValue(taxRefusal());

    await maintainSubscriptionRenewals({ max_attempts: 1 });

    const attempt = await attemptOf(subscription_id);
    expect(attempt.state).toBe("failed");
    expect(attempt.last_error.startsWith(BUSINESS_TAX_ID_REFUSAL_PREFIX)).toBe(
      true,
    );
    expect(await subscriptionStatus(subscription_id)).toBe("canceled");
    expect(mockSendCancelNotification).toHaveBeenCalledWith({
      subscription_id,
      alertAdmin: false,
    });
    // the cancellation notice is the customer's message, not the VAT notice
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("releases the account credit set aside for a refused renewal", async () => {
    const { subscription_id } = await dueRenewal();
    await getPool().query(
      `UPDATE subscription_renewal_attempts SET balance_applied=4.5
        WHERE subscription_id=$1`,
      [subscription_id],
    );
    mockCreateSubscriptionPayment.mockRejectedValue(taxRefusal());

    await maintainSubscriptionRenewals({ max_attempts: 1 });

    const attempt = await attemptOf(subscription_id);
    expect(attempt.state).toBe("scheduled");
    expect(attempt.balance_applied).toBeNull();
  });

  it("still sends the card action notice after the VAT ID is fixed", async () => {
    const { subscription_id } = await dueRenewal();
    mockCreateSubscriptionPayment.mockRejectedValue(taxRefusal());
    await maintainSubscriptionRenewals({ max_attempts: 1 });

    // the customer adds a VAT ID; the next try's card is declined
    await recheckNow(subscription_id);
    const [claimed] = await claimDueSubscriptionRenewalAttempts({ limit: 1 });
    expect(claimed.subscription_id).toBe(subscription_id);
    const result = await deferSubscriptionRenewalAttemptForCustomer({
      attempt_id: claimed.id,
      error: "Stripe payment is requires_payment_method",
    });
    expect(result).toEqual({ deferred: true, needsNotice: true });
  });

  it("retries other failures with backoff", async () => {
    const { subscription_id } = await dueRenewal();
    mockCreateSubscriptionPayment.mockRejectedValue(new Error("stripe down"));

    await maintainSubscriptionRenewals({ max_attempts: 1 });

    const attempt = await attemptOf(subscription_id);
    expect(attempt.state).toBe("processing");
    expect(attempt.customer_action_required_at).toBeNull();
    expect(Number(attempt.wait_ms)).toBeGreaterThan(
      RENEWAL_ATTEMPT_RETRY_MS - 10_000,
    );
    expect(Number(attempt.wait_ms)).toBeLessThanOrEqual(
      RENEWAL_ATTEMPT_RETRY_MS,
    );
  });
});
