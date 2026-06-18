/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, {
  getTransactionClient,
  type PoolClient,
} from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { TEAM_LICENSE_RENEWAL } from "@cocalc/util/db-schema/purchases";
import {
  moneyRound2Down,
  moneyToCurrency,
  toDecimal,
  type MoneyValue,
} from "@cocalc/util/money";
import createPurchase from "@cocalc/server/purchases/create-purchase";
import getBalance from "@cocalc/server/purchases/get-balance";
import { assertPurchaseAllowed } from "@cocalc/server/purchases/is-purchase-allowed";
import createPaymentIntent from "./stripe/create-payment-intent";
import send, { support, url } from "@cocalc/server/messages/send";
import adminAlert from "@cocalc/server/messages/admin-alert";
import { getUser } from "./statements/email-statement";
import { useBalanceTowardTeamLicenses } from "./subscription-renewal-notice";
import {
  applyTeamLicenseSeatConfiguration,
  getTeamLicenseOverviewForOwner,
  getTeamLicenseRenewalQuote,
  markTeamLicensePastDue,
  resolveTeamLicenseQuote,
} from "@cocalc/server/membership/team-licenses";

const logger = getLogger("purchases:team-license");
const ALLOWED_SLACK = 0.01;

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function normalizeTargets(target_seats?: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(target_seats ?? {}).map(([key, value]) => [
      key,
      Math.max(0, Math.floor(Number(value) || 0)),
    ]),
  );
}

export async function purchaseTeamLicenseChange({
  account_id,
  target_seats,
  amount,
}: {
  account_id: string;
  target_seats: Record<string, number>;
  amount?: MoneyValue;
}) {
  logger.debug("purchaseTeamLicenseChange", {
    account_id,
    target_seats,
    amount,
  });
  const normalizedTargets = normalizeTargets(target_seats);
  const quote = await resolveTeamLicenseQuote({
    owner_account_id: account_id,
    target_seats: normalizedTargets,
  });
  if (quote.total_price <= 0) {
    throw Error("team license change has no seats to purchase");
  }
  const client = await getTransactionClient();
  try {
    await assertPurchaseAllowed({
      account_id,
      service: "membership",
      cost: quote.total_price,
      client,
      amount,
    });
    const purchase_id = await createPurchase({
      account_id,
      service: "membership",
      cost: quote.total_price,
      unrounded_cost: quote.total_price,
      description: {
        type: "team-license-change",
        target_seats: normalizedTargets,
        line_items: quote.line_items,
        interval: quote.interval,
      },
      tag: "team-license-change",
      period_start: new Date(quote.current_period_start),
      period_end: new Date(quote.current_period_end),
      client,
    });
    const overview = await applyTeamLicenseSeatConfiguration({
      owner_account_id: account_id,
      target_seats: normalizedTargets,
      latest_purchase_id: purchase_id,
      client,
    });
    await client.query("COMMIT");
    return overview;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function createTeamLicenseRenewalPayment({
  team_license_id,
  owner_account_id,
  return_url,
}: {
  team_license_id: string;
  owner_account_id: string;
  return_url?: string;
}) {
  logger.debug("createTeamLicenseRenewalPayment", {
    team_license_id,
    owner_account_id,
  });
  const quote = await getTeamLicenseRenewalQuote({ team_license_id });
  if (quote.license.owner_account_id !== owner_account_id) {
    throw Error("team license owner mismatch");
  }
  if (toDecimal(quote.total_price).lte(0)) {
    throw Error("team license renewal amount must be positive");
  }
  let paymentIntentId = "";
  try {
    if (
      (await useBalanceTowardTeamLicenses(owner_account_id)) &&
      toDecimal(await getBalance({ account_id: owner_account_id })).gte(
        toDecimal(quote.total_price),
      )
    ) {
      await processTeamLicenseRenewal({
        account_id: owner_account_id,
        amount: quote.total_price,
        paymentIntent: { metadata: { team_license_id } },
      });
      return;
    }
    const { payment_intent, hosted_invoice_url } = await createPaymentIntent({
      account_id: owner_account_id,
      purpose: TEAM_LICENSE_RENEWAL,
      description: "Renew team license",
      lineItems: quote.line_items,
      return_url,
      metadata: {
        team_license_id,
      },
      force: true,
      processImmediately: false,
    });
    paymentIntentId = payment_intent;
    const payment = {
      payment_intent_id: payment_intent,
      team_license_id,
      amount: toDecimal(quote.total_price).toNumber(),
      created: Date.now(),
      status: "active",
      new_period_start: quote.next_period_start.toISOString(),
      new_period_end: quote.next_period_end.toISOString(),
    };
    await getPool().query(
      `
        UPDATE team_licenses
           SET payment=$2::jsonb,
               last_renewal_attempt_at=NOW(),
               updated=NOW()
         WHERE id=$1
           AND owner_account_id=$3
      `,
      [team_license_id, payment, owner_account_id],
    );
    await send({
      to_ids: [owner_account_id],
      subject: "Team License Renewal Started",
      body: `
CoCalc has started renewing your team license for ${moneyToCurrency(
        quote.total_price,
      )}.

- Paid through now: ${formatDate(quote.license.current_period_end)}
- Renewal invoice: ${hosted_invoice_url}
- Manage team license: ${await url("settings", "team-licenses")}

${await support()}
`,
    });
    return { payment_intent, hosted_invoice_url };
  } catch (err) {
    await markTeamLicenseRenewalPastDueAndNotify({
      team_license_id,
      owner_account_id,
      payment_intent_id: paymentIntentId || undefined,
      err,
    });
    throw err;
  }
}

export async function processTeamLicenseRenewal({
  account_id,
  paymentIntent,
  amount,
  client,
}: {
  account_id: string;
  paymentIntent: { id?: string; metadata?: Record<string, string> };
  amount: MoneyValue;
  client?: PoolClient;
}) {
  const team_license_id = `${paymentIntent.metadata?.team_license_id ?? ""}`;
  if (!team_license_id) {
    throw Error("team license renewal metadata is missing team_license_id");
  }
  const ownedClient = client == null ? await getTransactionClient() : undefined;
  const dbClient = client ?? ownedClient!;
  let committed = false;
  try {
    const quote = await getTeamLicenseRenewalQuote({
      team_license_id,
      client: dbClient,
    });
    if (quote.license.owner_account_id !== account_id) {
      throw Error("team license owner mismatch");
    }
    if (toDecimal(amount).add(ALLOWED_SLACK).lt(toDecimal(quote.total_price))) {
      throw Error("team license renewal payment is less than renewal cost");
    }
    const purchase_id = await createPurchase({
      account_id,
      service: "membership",
      cost: quote.total_price,
      unrounded_cost: quote.total_price,
      description: {
        type: "team-license-renewal",
        team_license_id,
        line_items: quote.line_items,
        interval: "year",
      },
      tag: "team-license-renewal",
      period_start: quote.next_period_start,
      period_end: quote.next_period_end,
      client: dbClient,
    });
    await dbClient.query(
      `
        UPDATE team_licenses
           SET status='active',
               current_period_start=$2,
               current_period_end=$3,
               latest_purchase_id=$4,
               payment=NULL,
               updated=NOW()
         WHERE id=$1
           AND owner_account_id=$5
      `,
      [
        team_license_id,
        quote.next_period_start,
        quote.next_period_end,
        purchase_id,
        account_id,
      ],
    );
    if (ownedClient) {
      await ownedClient.query("COMMIT");
      committed = true;
    }
    await sendTeamLicenseRenewedNotification({
      account_id,
      team_license_id,
      next_period_end: quote.next_period_end,
      total_price: quote.total_price,
    });
  } catch (err) {
    if (ownedClient && !committed) {
      await ownedClient.query("ROLLBACK");
    }
    throw err;
  } finally {
    ownedClient?.release();
  }
}

async function sendTeamLicenseRenewedNotification({
  account_id,
  team_license_id,
  next_period_end,
  total_price,
}: {
  account_id: string;
  team_license_id: string;
  next_period_end: Date;
  total_price: MoneyValue;
}) {
  try {
    await send({
      to_ids: [account_id],
      subject: "Team License Renewed",
      body: `
Your CoCalc team license has been renewed through ${formatDate(
        next_period_end,
      )}.

- Amount: ${moneyToCurrency(moneyRound2Down(toDecimal(total_price)))}
- Manage team license: ${await url("settings", "team-licenses")}

${await support()}
`,
    });
  } catch (err) {
    logger.warn("failed to send team license renewal notification", {
      account_id,
      team_license_id,
      err,
    });
  }
}

export async function processTeamLicenseRenewalFailure({
  account_id,
  paymentIntent,
}: {
  account_id: string;
  paymentIntent: { id?: string; metadata?: Record<string, string> };
}) {
  const team_license_id = `${paymentIntent.metadata?.team_license_id ?? ""}`;
  if (!team_license_id) {
    throw Error("team license renewal metadata is missing team_license_id");
  }
  await markTeamLicenseRenewalPastDueAndNotify({
    team_license_id,
    owner_account_id: account_id,
    payment_intent_id: paymentIntent.id,
    err: "renewal payment was canceled",
  });
}

async function markTeamLicenseRenewalPastDueAndNotify({
  team_license_id,
  owner_account_id,
  payment_intent_id,
  err,
}: {
  team_license_id: string;
  owner_account_id: string;
  payment_intent_id?: string;
  err: unknown;
}) {
  const license = await markTeamLicensePastDue({
    team_license_id,
    payment: {
      payment_intent_id,
      status: "canceled",
      error: `${err}`,
      updated: Date.now(),
    },
  });
  const user = await getUser(owner_account_id).catch(() => ({
    name: owner_account_id,
  }));
  await send({
    to_ids: [owner_account_id],
    subject: "Team License Renewal Problem",
    body: `
CoCalc could not renew your team license.

Your team's existing membership seats are still active for now, but the license
expired on ${formatDate(license.current_period_end)}. Please update billing or
contact support to avoid losing access later.

- Manage team license: ${await url("settings", "team-licenses")}
- Payments: ${await url("settings", "payments")}

${await support()}
`,
    dedupMinutes: 60 * 24,
  });
  adminAlert({
    subject: "Team license renewal failed",
    body: `
Team license renewal failed and was marked past_due.

- Team license id: ${team_license_id}
- Owner: ${user.name}, account_id=${owner_account_id}
- Paid through: ${formatDate(license.current_period_end)}
- Payment intent: ${payment_intent_id ?? "none"}
- Error: ${err}
`,
    dedupMinutes: 60,
  });
}

export async function getDueTeamLicensesForRenewal(): Promise<
  { id: string; owner_account_id: string }[]
> {
  const { rows } = await getPool().query<{
    id: string;
    owner_account_id: string;
  }>(
    `
      SELECT id, owner_account_id
        FROM team_licenses
       WHERE status='active'
         AND current_period_end <= NOW()
         AND COALESCE(payment#>>'{status}', '') != 'active'
       ORDER BY current_period_end ASC
    `,
  );
  return rows;
}

export async function getTeamLicenseForOwnerAfterChange({
  account_id,
}: {
  account_id: string;
}) {
  return await getTeamLicenseOverviewForOwner({ owner_account_id: account_id });
}
