import getLogger from "@cocalc/backend/logger";
import getPool, {
  getTransactionClient,
  type PoolClient,
} from "@cocalc/database/pool";
import { SUBSCRIPTION_RENEWAL } from "@cocalc/util/db-schema/purchases";
import {
  moneyRound2Down,
  moneyRoundToCents,
  moneyToCurrency,
  toDecimal,
  type MoneyValue,
} from "@cocalc/util/money";
import dayjs from "dayjs";
import type { Subscription } from "@cocalc/util/db-schema/subscriptions";
import createPaymentIntent from "./create-payment-intent";
import getBalance from "@cocalc/server/purchases/get-balance";
import send, { support, url } from "@cocalc/server/messages/send";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { sendCancelNotification } from "../cancel-subscription";
import getConn from "@cocalc/server/stripe/connection";
import createPurchase from "@cocalc/server/purchases/create-purchase";
import { useBalanceTowardSubscriptions } from "../subscription-renewal-notice";
import {
  recordMembershipAnalyticsEvent,
  recordMembershipPurchaseCompleted,
} from "@cocalc/server/membership/analytics";
import {
  consumePendingMembershipPlanChange,
  recordPersonalMembershipPeriod,
} from "@cocalc/server/membership/personal-allocation-analytics";
import type {
  MembershipMetadata,
  PendingMembershipPlanChange,
} from "@cocalc/util/db-schema/subscriptions";
import { refreshAccountBalanceAndPublishBestEffort } from "@cocalc/server/purchases/refresh-balance";
import { getMembershipTierById } from "@cocalc/server/membership/tiers";
import type { SubscriptionRenewalAttempt } from "@cocalc/util/db-schema/subscription-renewal-attempts";
import { stripeToDecimal } from "@cocalc/util/stripe/calc";
import {
  bindSubscriptionRenewalPaymentIntent,
  cancelOpenSubscriptionRenewalAttempts,
  claimSubscriptionRenewalAttempt,
  completeSubscriptionRenewalAttempt,
  getSubscriptionRenewalAttempt,
  scheduleSubscriptionRenewalAttempt,
  scheduleSubscriptionRenewalAttempt as scheduleNextRenewalAttempt,
  setSubscriptionPaymentFromAttempt,
} from "../subscription-renewal-attempts";
import { lockMembershipSubscriptionAccount } from "../membership-subscription-guard";

// nothing should ever be this small, but just in case:
const MIN_SUBSCRIPTION_AMOUNT = 1;
const SUBSCRIPTION_PAYMENT_SLACK = 0.01;
const MAX_LEGACY_PAYMENT_PERIOD_DRIFT_MS = 15 * 60 * 1000;

const logger = getLogger("purchases:stripe:create-subscription-payment");

type RenewalFunding = {
  balanceApplied: number;
  payNow: boolean;
};

function validatedBalanceApplied({
  balanceApplied,
  renewalAmount,
}: {
  balanceApplied: MoneyValue | null | undefined;
  renewalAmount: ReturnType<typeof toDecimal>;
}): ReturnType<typeof toDecimal> {
  const value = toDecimal(balanceApplied ?? 0);
  if (
    value.lt(0) ||
    (value.gt(0) && value.gte(renewalAmount)) ||
    !moneyRoundToCents(value).eq(value)
  ) {
    throw Error("invalid account balance allocation for subscription renewal");
  }
  return value;
}

export async function hasOpenPaygPurchases({
  account_id,
  client,
}: {
  account_id: string;
  client: PoolClient;
}): Promise<boolean> {
  const { rows } = await client.query<{ open: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM purchases
        WHERE account_id=$1
          AND cost IS NULL
          AND (cost_per_hour IS NOT NULL OR cost_so_far IS NOT NULL)
     ) AS open`,
    [account_id],
  );
  return rows[0]?.open === true;
}

async function prepareRenewalFunding({
  account_id,
  amount,
  attempt_id,
}: {
  account_id: string;
  amount: number;
  attempt_id: string;
}): Promise<RenewalFunding> {
  const amountValue = toDecimal(amount);
  if (amountValue.lte(MIN_SUBSCRIPTION_AMOUNT)) {
    return { balanceApplied: 0, payNow: true };
  }

  const useBalance = await useBalanceTowardSubscriptions(account_id);
  const client = await getTransactionClient();
  try {
    await lockMembershipSubscriptionAccount({ account_id, client });
    const { rows } = await client.query<SubscriptionRenewalAttempt>(
      `SELECT *
         FROM subscription_renewal_attempts
        WHERE id=$1 AND account_id=$2
        FOR UPDATE`,
      [attempt_id, account_id],
    );
    const attempt = rows[0];
    if (!attempt || !["scheduled", "processing"].includes(attempt.state)) {
      throw Error("subscription does not have an active renewal attempt");
    }

    if (attempt.balance_applied != null) {
      const balanceApplied = validatedBalanceApplied({
        balanceApplied: attempt.balance_applied,
        renewalAmount: amountValue,
      });
      await client.query("COMMIT");
      return {
        balanceApplied: balanceApplied.toNumber(),
        payNow: false,
      };
    }

    // Never change the funding split after Stripe state may exist.
    if (attempt.payment_intent_id) {
      await client.query(
        `UPDATE subscription_renewal_attempts
            SET balance_applied=0, updated_at=NOW()
          WHERE id=$1`,
        [attempt_id],
      );
      await client.query("COMMIT");
      return { balanceApplied: 0, payNow: false };
    }

    let balanceApplied = toDecimal(0);
    if (useBalance) {
      const balance = toDecimal(
        await getBalance({ account_id, client, noSave: true }),
      );
      if (balance.gte(amountValue)) {
        await client.query("COMMIT");
        return { balanceApplied: 0, payNow: true };
      }
      if (
        balance.gt(0) &&
        attempt.funding_version === 1 &&
        !(await hasOpenPaygPurchases({ account_id, client }))
      ) {
        balanceApplied = moneyRoundToCents(balance);
      }
    }

    const cardAmount = amountValue.sub(balanceApplied);
    if (balanceApplied.gt(0) && cardAmount.lte(MIN_SUBSCRIPTION_AMOUNT)) {
      // Stripe cannot reliably collect tiny invoice remainders. Preserve the
      // existing behavior that permits a very small negative balance instead.
      await client.query("COMMIT");
      return { balanceApplied: 0, payNow: true };
    }

    await client.query(
      `UPDATE subscription_renewal_attempts
          SET balance_applied=$2, updated_at=NOW()
        WHERE id=$1`,
      [attempt_id, balanceApplied.toString()],
    );
    await client.query("COMMIT");
    return { balanceApplied: balanceApplied.toNumber(), payNow: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function renewalMembershipTerms({
  metadata,
  interval,
}: {
  metadata: any;
  interval: "month" | "year";
}): {
  membershipClass: string;
  interval: "month" | "year";
  metadata: MembershipMetadata;
  pendingPlanChange?: PendingMembershipPlanChange;
} {
  if (
    metadata?.type === "membership" &&
    metadata?.source_id === "legacy-migration" &&
    metadata?.grant === true &&
    metadata?.renewal_configured === true
  ) {
    const membershipClass = cleanString(metadata.renewal_class);
    if (membershipClass) {
      const renewalInterval =
        metadata.renewal_interval === "month" ||
        metadata.renewal_interval === "year"
          ? metadata.renewal_interval
          : interval;
      const consumed = consumePendingMembershipPlanChange({
        ...metadata,
        class: membershipClass,
        grant: false,
        legacy_migration_grant_converted_at: new Date().toISOString(),
      });
      return {
        membershipClass,
        interval: renewalInterval,
        metadata: consumed.metadata,
        pendingPlanChange: consumed.pending,
      };
    }
  }
  const consumed = consumePendingMembershipPlanChange(metadata);
  return {
    membershipClass: metadata.class,
    interval,
    metadata: consumed.metadata,
    pendingPlanChange: consumed.pending,
  };
}

async function membershipRenewalDescription({
  membershipClass,
  interval,
  client,
}: {
  membershipClass: string;
  interval: "month" | "year";
  client?: PoolClient;
}): Promise<string> {
  const tier = await getMembershipTierById({ id: membershipClass, client });
  const label = cleanString(tier?.label) ?? membershipClass;
  return `${label} membership renewal, ${
    interval == "month" ? "monthly" : "annual"
  }`;
}

function legacyPaymentMatchesAttempt({
  payment,
  attempt,
  subscription_id,
}: {
  payment: any;
  attempt: SubscriptionRenewalAttempt;
  subscription_id: number;
}): boolean {
  try {
    const targetPeriodEnd = new Date(attempt.target_period_end).valueOf();
    const legacyPeriodEnd = Number(payment?.new_expires_ms);
    return (
      payment?.status === "active" &&
      payment?.renewal_attempt_id == null &&
      cleanString(payment?.payment_intent_id) != null &&
      Number(payment?.subscription_id) === subscription_id &&
      toDecimal(payment?.amount).eq(toDecimal(attempt.amount)) &&
      legacyPeriodEnd >= targetPeriodEnd &&
      legacyPeriodEnd - targetPeriodEnd <= MAX_LEGACY_PAYMENT_PERIOD_DRIFT_MS
    );
  } catch {
    return false;
  }
}

async function adoptLegacyRenewalPaymentIntent({
  payment,
  attempt,
  account_id,
  subscription_id,
}: {
  payment: any;
  attempt: SubscriptionRenewalAttempt;
  account_id: string;
  subscription_id: number;
}): Promise<string | undefined> {
  if (
    !legacyPaymentMatchesAttempt({
      payment,
      attempt,
      subscription_id,
    })
  ) {
    return;
  }
  const paymentIntentId = cleanString(payment.payment_intent_id)!;
  const stripe = await getConn();
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const metadata = paymentIntent.metadata ?? {};
  const existingAttemptId = cleanString(metadata.renewal_attempt_id);
  let stripeAmountMatches = false;
  try {
    stripeAmountMatches = toDecimal(
      stripeToDecimal(metadata.total_excluding_tax_usd),
    ).eq(toDecimal(attempt.amount));
  } catch {
    // Missing or malformed Stripe metadata must fail closed.
  }
  if (
    cleanString(metadata.account_id) !== account_id ||
    Number(metadata.subscription_id) !== subscription_id ||
    cleanString(metadata.purpose) !== SUBSCRIPTION_RENEWAL ||
    !stripeAmountMatches ||
    (existingAttemptId != null && existingAttemptId !== attempt.id)
  ) {
    throw Error(
      "legacy renewal payment intent does not match the durable renewal attempt",
    );
  }
  await stripe.paymentIntents.update(paymentIntentId, {
    metadata: {
      ...metadata,
      renewal_attempt_id: attempt.id,
    },
  });
  await bindSubscriptionRenewalPaymentIntent({
    account_id,
    attempt_id: attempt.id,
    payment_intent_id: paymentIntentId,
    stripe_invoice_id: cleanString(metadata.invoice_id),
    subscription_id,
  });
  return paymentIntentId;
}

export default async function createSubscriptionPayment({
  account_id,
  subscription_id,
  renewal_attempt_id,
  return_url,
}: {
  account_id: string;
  subscription_id: number;
  renewal_attempt_id?: string;
  return_url?;
}): Promise<{ payment_intent_id?: string }> {
  logger.debug("createSubscriptionPayment", { account_id, subscription_id });

  const attempt = await prepareSubscriptionRenewalAttempt({
    account_id,
    subscription_id,
    renewal_attempt_id,
  });
  if (attempt.payment_intent_id) {
    return { payment_intent_id: attempt.payment_intent_id };
  }
  const pool = getPool();
  const { rows: subscriptions } = await pool.query(
    "SELECT payment, cost, metadata, interval, current_period_end, latest_purchase_id, status FROM subscriptions WHERE account_id=$1 AND id=$2",
    [account_id, subscription_id],
  );
  if (subscriptions.length == 0) {
    throw Error(`You do not have a subscription with id ${subscription_id}.`);
  }
  const {
    payment,
    cost: amountRaw,
    metadata,
    interval,
    current_period_end,
    status,
  } = subscriptions[0] as Subscription;
  const amountValue = toDecimal(attempt.amount ?? amountRaw ?? 0);

  if (metadata?.type != "membership") {
    throw Error("subscription must be for a membership");
  }
  if (status != "active") {
    throw Error("subscription is not active");
  }
  if (
    new Date(current_period_end).valueOf() !==
    new Date(attempt.period_end).valueOf()
  ) {
    throw Error("renewal attempt does not match the current billing period");
  }
  if (
    payment != null &&
    payment.status == "active" &&
    payment.renewal_attempt_id !== attempt.id
  ) {
    const adoptedPaymentIntentId = await adoptLegacyRenewalPaymentIntent({
      payment,
      attempt,
      account_id,
      subscription_id,
    });
    if (adoptedPaymentIntentId) {
      return { payment_intent_id: adoptedPaymentIntentId };
    }
    throw Error(
      "There is a current outstanding active payment -- either cancel it or pay it",
    );
  }
  const new_expires_ms = new Date(attempt.target_period_end).valueOf();
  const renewalTerms = renewalMembershipTerms({ metadata, interval });
  const renewalDescription = await membershipRenewalDescription({
    membershipClass: renewalTerms.membershipClass,
    interval: renewalTerms.interval,
  });

  const funding = await prepareRenewalFunding({
    account_id,
    amount: amountValue.toNumber(),
    attempt_id: attempt.id,
  });
  const balanceAppliedValue = toDecimal(funding.balanceApplied);
  const cardAmountValue = amountValue.sub(balanceAppliedValue);
  const lineItems = [
    {
      description: `${renewalDescription} (subscription Id=${subscription_id})`,
      amount: amountValue.toNumber(),
    },
  ];
  if (balanceAppliedValue.gt(0)) {
    lineItems.push({
      description: "Account balance applied to subscription renewal",
      amount: balanceAppliedValue.neg().toNumber(),
    });
  }

  const { site_name } = await getServerSettings();

  if (funding.payNow) {
    // Instead of trying to charge their credit card (etc.), we just
    // directly extend their subscription for another period using credit
    // on their account, possibly going negative (in case of MIN_SUBSCRIPTION_AMOUNT).
    // If that happens, they will get billed some other way, or be required to fix
    // that in order to make future purchases.
    // completely pay with credit -- we just process the renewal assuming money is there already.

    // we use one transaction so if anything goes awry, it is ALL rolled back.
    const client = await getTransactionClient();
    try {
      await setSubscriptionPaymentFromAttempt({ attempt, client });
      const result = await processSubscriptionRenewal({
        account_id,
        paymentIntent: {
          metadata: {
            subscription_id,
            renewal_attempt_id: attempt.id,
          },
        },
        amount: amountValue.toNumber(),
        client,
      });
      if (result.status !== "renewed") {
        throw Error(`subscription renewal was skipped: ${result.reason}`);
      }
      // it worked -- so commit it
      await client.query("COMMIT");
      await refreshAccountBalanceAndPublishBestEffort({ account_id });
    } catch (err) {
      logger.debug("error renewing subscription", err);
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    // It worked! Tell the user.
    await send({
      to_ids: [account_id],
      subject: `${site_name} Subscription Renewal: Id ${subscription_id}`,
      body: `Your ${site_name} subscription (id=${subscription_id}) has been renewed for ${moneyToCurrency(amountValue)} using credit on your account.  Your subscription is now fully paid through ${new Date(new_expires_ms)}. \n\n- Account Balance: ${moneyToCurrency(
        moneyRound2Down(toDecimal(await getBalance({ account_id }))),
      )}`,
    });
    return {};
  }

  const { payment_intent: payment_intent_id, hosted_invoice_url } =
    await createPaymentIntent({
      account_id,
      purpose: SUBSCRIPTION_RENEWAL,
      description: renewalDescription,
      lineItems,
      return_url,
      metadata: {
        subscription_id: `${subscription_id}`,
        renewal_attempt_id: attempt.id,
        balance_applied_usd: balanceAppliedValue.toFixed(2),
        renewal_total_usd: amountValue.toFixed(2),
      },
      force: true,
      processImmediately: false,
      idempotencyKeyPrefix: `subscription-renewal:${attempt.id}`,
      allowedPaymentMethodTypes: ["card"],
    });
  await send({
    to_ids: [account_id],
    subject: `${site_name} Subscription Renewal: Id ${subscription_id}`,
    body: `
${site_name} has started renewing your ${moneyToCurrency(amountValue)}/${interval} subscription (id=${subscription_id}).

${moneyToCurrency(balanceAppliedValue)} will be paid from your account balance and ${moneyToCurrency(cardAmountValue)} will be collected from your payment method.

- [Membership Status](${await url(`/settings/membership`)})

- Hosted Invoice: ${hosted_invoice_url}

- [All Payments](${await url("settings", "payments")})

- [All Purchases](${await url("settings", "purchases")})


${await support()}`,
  });
  return { payment_intent_id };
}

async function prepareSubscriptionRenewalAttempt({
  account_id,
  subscription_id,
  renewal_attempt_id,
}: {
  account_id: string;
  subscription_id: number;
  renewal_attempt_id?: string;
}): Promise<SubscriptionRenewalAttempt> {
  const client = await getTransactionClient();
  let committed = false;
  try {
    await lockMembershipSubscriptionAccount({ account_id, client });
    let attempt: SubscriptionRenewalAttempt | undefined;
    if (renewal_attempt_id) {
      attempt = await getSubscriptionRenewalAttempt({
        attempt_id: renewal_attempt_id,
        client,
        forUpdate: true,
      });
    } else {
      renewal_attempt_id = await scheduleSubscriptionRenewalAttempt({
        account_id,
        subscription_id,
        client,
      });
      if (renewal_attempt_id) {
        attempt = await claimSubscriptionRenewalAttempt({
          attempt_id: renewal_attempt_id,
          account_id,
          subscription_id,
          client,
        });
      }
    }
    if (
      !attempt ||
      attempt.account_id !== account_id ||
      attempt.subscription_id !== subscription_id ||
      !["scheduled", "processing"].includes(attempt.state)
    ) {
      throw Error("subscription does not have an active renewal attempt");
    }
    const { rows: subscriptions } = await client.query<{
      current_period_end: Date;
      status: string;
    }>(
      `SELECT current_period_end, status
         FROM subscriptions
        WHERE id=$1
          AND account_id=$2
          AND metadata->>'type'='membership'
        FOR UPDATE`,
      [subscription_id, account_id],
    );
    const subscription = subscriptions[0];
    if (
      subscription?.status !== "active" ||
      new Date(subscription.current_period_end).valueOf() !==
        new Date(attempt.period_end).valueOf()
    ) {
      await cancelOpenSubscriptionRenewalAttempts({
        account_id,
        subscription_id,
        reason: "Subscription is no longer active for this renewal period",
        client,
      });
      await client.query("COMMIT");
      committed = true;
      throw Error("subscription does not match the active renewal attempt");
    }
    await client.query("COMMIT");
    committed = true;
    return attempt;
  } catch (err) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    throw err;
  } finally {
    client.release();
  }
}

export type SubscriptionRenewalResult =
  | { status: "renewed" }
  | {
      status: "skipped";
      reason:
        | "subscription-not-active"
        | "renewal-attempt-missing"
        | "renewal-attempt-terminal"
        | "payment-superseded";
    };

export async function processSubscriptionRenewal({
  account_id,
  paymentIntent,
  amount,
  client,
}: {
  account_id: string;
  paymentIntent: {
    id?: string;
    metadata: {
      subscription_id: number | string;
      credit_id?: number | string;
      renewal_attempt_id?: string;
    };
  };
  amount: number;
  client?: PoolClient;
}): Promise<SubscriptionRenewalResult> {
  const { subscription_id, renewal_attempt_id } = paymentIntent?.metadata ?? {};
  logger.debug("processSubscriptionRenewal", {
    account_id,
    amount,
    subscription_id,
  });
  const amountValue = toDecimal(amount);
  const subscriptionId =
    typeof subscription_id != "number"
      ? parseInt(subscription_id)
      : subscription_id;
  const transaction = client ?? (await getTransactionClient());
  const useTransaction = client == null;
  try {
    const { rows: subscriptions } = await transaction.query(
      "SELECT payment, cost, metadata, interval, latest_purchase_id, status FROM subscriptions WHERE account_id=$1 AND id=$2 FOR UPDATE",
      [account_id, subscriptionId],
    );
    if (subscriptions.length == 0) {
      throw Error(`You do not have a subscription with id ${subscription_id}.`);
    }
    const { cost, metadata, interval, latest_purchase_id, status } =
      subscriptions[0];
    const costValue = toDecimal(cost);
    const renewalTerms = renewalMembershipTerms({ metadata, interval });
    let { payment } = subscriptions[0];
    const attempt = renewal_attempt_id
      ? await getSubscriptionRenewalAttempt({
          attempt_id: renewal_attempt_id,
          client: transaction,
          forUpdate: true,
        })
      : undefined;
    logger.debug("processSubscriptionRenewal", {
      payment,
      cost,
      metadata,
      interval,
    });
    if (metadata?.type != "membership") {
      throw Error("subscription must be for a membership");
    }
    if (status !== "active") {
      logger.debug("ignoring renewal callback for canceled subscription", {
        subscription_id: subscriptionId,
      });
      if (useTransaction) {
        await transaction.query("COMMIT");
      }
      return { status: "skipped", reason: "subscription-not-active" };
    }
    if (renewal_attempt_id && !attempt) {
      logger.debug("ignoring callback for missing renewal attempt", {
        renewal_attempt_id,
        subscription_id: subscriptionId,
      });
      if (useTransaction) {
        await transaction.query("COMMIT");
      }
      return { status: "skipped", reason: "renewal-attempt-missing" };
    }
    if (attempt) {
      if (
        attempt.account_id !== account_id ||
        attempt.subscription_id !== subscriptionId
      ) {
        throw Error("renewal attempt does not belong to this subscription");
      }
      if (attempt.state === "succeeded") {
        if (useTransaction) {
          await transaction.query("COMMIT");
        }
        return { status: "renewed" };
      }
      if (attempt.state === "failed" || attempt.state === "canceled") {
        logger.debug("ignoring callback for terminal renewal attempt", {
          renewal_attempt_id,
          state: attempt.state,
        });
        if (useTransaction) {
          await transaction.query("COMMIT");
        }
        return { status: "skipped", reason: "renewal-attempt-terminal" };
      }
      if (
        paymentIntent.id &&
        attempt.payment_intent_id &&
        paymentIntent.id !== attempt.payment_intent_id
      ) {
        logger.debug("ignoring superseded renewal callback", {
          renewal_attempt_id,
          payment_intent_id: paymentIntent.id,
          expected_payment_intent_id: attempt.payment_intent_id,
        });
        if (useTransaction) {
          await transaction.query("COMMIT");
        }
        return { status: "skipped", reason: "payment-superseded" };
      }
      if (!payment) {
        await setSubscriptionPaymentFromAttempt({
          attempt,
          payment_intent_id: paymentIntent.id,
          client: transaction,
        });
        payment = {
          renewal_attempt_id: attempt.id,
          payment_intent_id:
            paymentIntent.id ?? attempt.payment_intent_id ?? undefined,
          status: "active",
          new_expires_ms: new Date(attempt.target_period_end).valueOf(),
        };
      }
    }
    if (
      paymentIntent.id &&
      payment?.payment_intent_id &&
      paymentIntent.id !== payment.payment_intent_id
    ) {
      logger.debug("ignoring callback that does not own the renewal payment", {
        subscription_id: subscriptionId,
        payment_intent_id: paymentIntent.id,
        expected_payment_intent_id: payment.payment_intent_id,
      });
      if (useTransaction) {
        await transaction.query("COMMIT");
      }
      return { status: "skipped", reason: "payment-superseded" };
    }
    if (payment?.status == "paid") {
      if (useTransaction) {
        await transaction.query("COMMIT");
      }
      return { status: "renewed" };
    }
    const expectedAmount = attempt ? toDecimal(attempt.amount) : costValue;
    const balanceApplied = validatedBalanceApplied({
      balanceApplied: attempt?.balance_applied,
      renewalAmount: expectedAmount,
    });
    if (
      amountValue
        .add(balanceApplied)
        .add(SUBSCRIPTION_PAYMENT_SLACK)
        .lt(expectedAmount)
    ) {
      logger.debug("processSubscriptionRenewal: SUSPICIOUS! -- not doing it.");
      throw Error(
        `subscription costs a lot more than payment -- contact support.`,
      );
    }
    if (balanceApplied.gt(0)) {
      const availableBalance = toDecimal(
        await getBalance({
          account_id,
          client: transaction,
          noSave: true,
        }),
      );
      if (availableBalance.add(SUBSCRIPTION_PAYMENT_SLACK).lt(expectedAmount)) {
        throw Error(
          "account balance allocated to this subscription renewal is no longer available",
        );
      }
    }

    if (payment == null || (payment?.new_expires_ms ?? 0) < Date.now()) {
      // I've read through all the code and this "is" impossible, given
      // postgresql semantics, etc.  I also can't reproduce it by putting
      // in delays.   However, payment==null *did* happen in production
      // once, so we just do it manually in this case :-(
      // We also ensure new_expires_ms is in the future so the period update
      // happens for sure.
      const new_expires_ms = addInterval(new Date(), interval).valueOf();
      payment = { new_expires_ms };
    }

    const end = attempt
      ? new Date(attempt.target_period_end)
      : new Date(payment.new_expires_ms);
    const periodStart = subtractInterval(end, renewalTerms.interval);
    const creditId = positiveInteger(paymentIntent.metadata.credit_id);

    const purchase_id = await createPurchase({
      account_id,
      service: "membership",
      description: {
        type: "membership",
        subscription_id: subscriptionId,
        ...(creditId != null ? { credit_id: creditId } : {}),
        class: renewalTerms.membershipClass,
        interval: renewalTerms.interval,
      },
      client: transaction,
      cost: expectedAmount,
      period_start: periodStart,
      period_end: end,
    });

    logger.debug(
      "processSubscriptionRenewal: mark payment done, and update period",
    );
    payment.status = "paid";
    logger.debug(
      "UPDATE subscriptions SET payment=$5, status='active',current_period_start=$1,current_period_end=$2,latest_purchase_id=$3 WHERE id=$4 AND account_id=$6",
      [
        subtractInterval(end, interval),
        end,
        purchase_id,
        subscriptionId,
        payment,
        account_id,
      ],
    );

    const update = await transaction.query(
      "UPDATE subscriptions SET payment=$5, status='active',current_period_start=$1,current_period_end=$2,latest_purchase_id=$3,metadata=$7,interval=$8 WHERE id=$4 AND account_id=$6",
      [
        periodStart,
        end,
        purchase_id,
        subscriptionId,
        payment,
        account_id,
        renewalTerms.metadata,
        renewalTerms.interval,
      ],
    );
    if (update.rowCount != 1) {
      throw Error(`You do not have a subscription with id ${subscription_id}.`);
    }
    if (attempt) {
      await completeSubscriptionRenewalAttempt({
        attempt_id: attempt.id,
        state: "succeeded",
        client: transaction,
      });
      await scheduleNextRenewalAttempt({
        account_id,
        subscription_id: subscriptionId,
        client: transaction,
      });
    }
    const isTrialConversion =
      metadata.trial === true && latest_purchase_id == null;
    const lifecycle = isTrialConversion
      ? "first_paid"
      : renewalTerms.pendingPlanChange
        ? "plan_change"
        : "renewal";
    await recordPersonalMembershipPeriod({
      account_id,
      subscription_id: subscriptionId,
      purchase_id,
      membership_class: renewalTerms.membershipClass,
      billing_interval: renewalTerms.interval,
      lifecycle,
      allocation_start: periodStart,
      allocation_end: end,
      revenue: expectedAmount,
      previous_membership_class:
        renewalTerms.pendingPlanChange?.previous_class ?? null,
      previous_billing_interval:
        renewalTerms.pendingPlanChange?.previous_interval ?? null,
      tier_change: renewalTerms.pendingPlanChange ? "downgrade" : "none",
      client: transaction,
    });
    await recordMembershipAnalyticsEvent({
      event_key: `subscription:${subscriptionId}:renewed:${purchase_id}`,
      event_type: "membership_renewed",
      account_id,
      membership_class: renewalTerms.membershipClass,
      source: "subscription",
      interval: renewalTerms.interval,
      subscription_id: subscriptionId,
      purchase_id,
      amount: expectedAmount,
      period_start: periodStart,
      period_end: end,
      trial_status: isTrialConversion ? "converted" : "none",
      client: transaction,
    });
    await recordMembershipPurchaseCompleted({
      account_id,
      subscription_id: subscriptionId,
      purchase_id,
      membership_class: renewalTerms.membershipClass,
      interval: renewalTerms.interval,
      amount: expectedAmount,
      period_start: periodStart,
      period_end: end,
      trial_status: isTrialConversion ? "converted" : "none",
      client: transaction,
    });
    if (isTrialConversion) {
      await recordMembershipAnalyticsEvent({
        event_key: `subscription:${subscriptionId}:trial-converted:${purchase_id}`,
        event_type: "trial_converted",
        account_id,
        membership_class: renewalTerms.membershipClass,
        source: "trial",
        interval: renewalTerms.interval,
        subscription_id: subscriptionId,
        purchase_id,
        period_start: periodStart,
        period_end: end,
        trial_days: metadata.trial_days ?? null,
        trial_status: "converted",
        client: transaction,
      });
    }
    if (useTransaction) {
      await transaction.query("COMMIT");
      await refreshAccountBalanceAndPublishBestEffort({ account_id });
    }
    return { status: "renewed" };
  } catch (err) {
    if (useTransaction) {
      await transaction.query("ROLLBACK");
    }
    throw err;
  } finally {
    if (useTransaction) {
      transaction.release();
    }
  }
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// add the interval to the date.  The day of the month (and time) should be unchanged
function addInterval(expires: Date, interval: "month" | "year"): Date {
  if (interval != "month" && interval != "year") {
    throw Error(`interval must be 'month' or 'year' but it is "${interval}"`);
  }
  let newExpires = dayjs(expires);
  return newExpires.add(1, interval).toDate();
}

function subtractInterval(expires: Date, interval: "month" | "year"): Date {
  if (interval != "month" && interval != "year") {
    throw Error(`interval must be 'month' or 'year' but it is "${interval}"`);
  }
  let newExpires = dayjs(expires);
  return newExpires.subtract(1, interval).toDate();
}

// We set payment status to canceled and cancel automatic renewal. The user can
// configure a new membership at current rates later.
export async function processSubscriptionRenewalFailure({
  account_id,
  paymentIntent,
}: {
  account_id: string;
  paymentIntent;
}) {
  const { subscription_id, renewal_attempt_id } = paymentIntent?.metadata ?? {};
  if (!subscription_id) {
    throw Error(
      `invalid paymentIntent ${paymentIntent?.id} -- metadata must contain subscription_id`,
    );
  }
  const id =
    typeof subscription_id != "number"
      ? parseInt(subscription_id)
      : subscription_id;
  const client = await getTransactionClient();
  let changed = false;
  try {
    const attempt = renewal_attempt_id
      ? await getSubscriptionRenewalAttempt({
          attempt_id: renewal_attempt_id,
          client,
          forUpdate: true,
        })
      : undefined;
    if (renewal_attempt_id && !attempt) {
      logger.debug("ignoring failure for missing renewal attempt", {
        renewal_attempt_id,
        subscription_id: id,
      });
      await client.query("COMMIT");
      return;
    }
    if (attempt) {
      if (attempt.account_id !== account_id || attempt.subscription_id !== id) {
        throw Error("renewal attempt does not belong to this subscription");
      }
      if (attempt.state === "succeeded") {
        await client.query("COMMIT");
        return;
      }
      if (attempt.state === "failed" || attempt.state === "canceled") {
        await client.query("COMMIT");
        return;
      }
      if (
        paymentIntent.id &&
        attempt.payment_intent_id &&
        paymentIntent.id !== attempt.payment_intent_id
      ) {
        logger.debug("ignoring superseded renewal failure", {
          renewal_attempt_id,
          payment_intent_id: paymentIntent.id,
          expected_payment_intent_id: attempt.payment_intent_id,
        });
        await client.query("COMMIT");
        return;
      }
    }
    const result = await client.query(
      `UPDATE subscriptions
          SET payment=jsonb_set(
                COALESCE(payment, '{}'::jsonb),
                '{status}',
                '"canceled"'
              ),
              status='canceled',
              canceled_at=NOW(),
              canceled_reason='The renewal payment failed.'
        WHERE id=$1
          AND account_id=$2
          AND (
            $3::text IS NULL OR
            payment#>>'{payment_intent_id}' IS NULL OR
            payment#>>'{payment_intent_id}'=$3
          )`,
      [id, account_id, cleanString(paymentIntent?.id) ?? null],
    );
    if (result.rowCount != 1) {
      const owner = await client.query(
        "SELECT 1 FROM subscriptions WHERE id=$1 AND account_id=$2",
        [id, account_id],
      );
      if (owner.rowCount != 1) {
        throw Error(
          `You do not have a subscription with id ${subscription_id}.`,
        );
      }
      logger.debug("ignoring superseded renewal failure payment", {
        subscription_id: id,
        payment_intent_id: paymentIntent?.id,
      });
      await client.query("COMMIT");
      return;
    }
    if (attempt) {
      await completeSubscriptionRenewalAttempt({
        attempt_id: attempt.id,
        state: "failed",
        error: `Stripe payment ${paymentIntent?.status ?? "failed"}`,
        client,
      });
    }
    await client.query("COMMIT");
    changed = true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  if (changed) {
    await sendCancelNotification({
      subscription_id: id,
      alertAdmin: false,
    });
  }
}
