/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getPool from "@cocalc/database/pool";
import adminAlert from "@cocalc/server/messages/admin-alert";
import {
  BUSINESS_TAX_ID_REFUSAL_PREFIX,
  renewalAttemptClaimableSql,
  RENEWAL_PAYMENT_GRACE_MS,
} from "./subscription-renewal-attempts";

const DEFAULT_WARNING_MINUTES = 10;
const DEFAULT_CRITICAL_MINUTES = 24 * 60;
const ALERT_DEDUP_MINUTES = 24 * 60;
const MAX_ALERT_ROWS = 100;

interface DelayedRenewalRow {
  attempt_id: string;
  subscription_id: number;
  account_id: string;
  state: string;
  not_before: Date;
  age_minutes: number;
  attempt_count: number;
  payment_intent_id?: string;
  stripe_invoice_id?: string;
  last_error?: string;
  // whether a renewal pass may claim it (claimDueSubscriptionRenewalAttempts
  // skips banned, deleted and billing-frozen accounts)
  claimable: boolean;
}

export interface SubscriptionRenewalHealthThresholds {
  warningMinutes: number;
  criticalMinutes: number;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return;
  }
  return parsed;
}

export function getSubscriptionRenewalHealthThresholds(
  maintenance: any,
): SubscriptionRenewalHealthThresholds {
  const warningMinutes =
    positiveNumber(maintenance?.renewal_warning_minutes) ??
    DEFAULT_WARNING_MINUTES;
  const criticalMinutes = Math.max(
    warningMinutes,
    positiveNumber(maintenance?.renewal_critical_minutes) ??
      DEFAULT_CRITICAL_MINUTES,
  );
  return { warningMinutes, criticalMinutes };
}

function markdownCell(value: unknown): string {
  return `${value ?? ""}`.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function delayedRenewalTable(
  rows: DelayedRenewalRow[],
  criticalMinutes: number,
): string {
  const header =
    "| Severity | Age | Account | Subscription | Attempt | State | Tries | PaymentIntent | Last error |\n" +
    "| --- | ---: | --- | ---: | --- | --- | ---: | --- | --- |";
  const body = rows.slice(0, MAX_ALERT_ROWS).map((row) => {
    const severity =
      row.age_minutes >= criticalMinutes ? "CRITICAL" : "Warning";
    return `| ${severity} | ${Math.floor(row.age_minutes)}m | ${markdownCell(
      row.account_id,
    )} | ${row.subscription_id} | ${markdownCell(row.attempt_id)} | ${markdownCell(
      row.state,
    )} | ${row.attempt_count} | ${markdownCell(
      row.payment_intent_id,
    )} | ${markdownCell(row.last_error)} |`;
  });
  return [header, ...body].join("\n");
}

export async function alertDelayedSubscriptionRenewals(): Promise<number> {
  const claimable = await renewalAttemptClaimableSql("$4");
  const { subscription_maintenance: maintenance } = await getServerSettings();
  const { warningMinutes, criticalMinutes } =
    getSubscriptionRenewalHealthThresholds(maintenance);
  const { rows } = await getPool().query<DelayedRenewalRow>(
    `SELECT a.id AS attempt_id,
            a.subscription_id,
            a.account_id,
            a.state,
            a.not_before,
            EXTRACT(EPOCH FROM (NOW() - a.not_before)) / 60 AS age_minutes,
            a.attempt_count,
            a.payment_intent_id,
            a.stripe_invoice_id,
            a.last_error,
            ${claimable.sql} AS claimable
       FROM subscription_renewal_attempts a
       JOIN subscriptions s
         ON s.id=a.subscription_id
        AND s.account_id=a.account_id
        AND s.metadata->>'type'='membership'
        AND s.status='active'
        AND s.current_period_end=a.period_end
      WHERE a.state IN ('scheduled','processing')
        AND a.not_before <= NOW() - ($1 * INTERVAL '1 minute')
        -- Waiting for the customer during the grace period is expected, not
        -- an operational delay, as long as they were notified and the
        -- periodic recheck is not overdue.
        AND NOT (
          a.customer_action_required_at IS NOT NULL AND
          a.customer_action_notified_at IS NOT NULL AND
          a.not_before > NOW() - ($2 * INTERVAL '1 millisecond') AND
          a.next_attempt_at > NOW() - ($1 * INTERVAL '1 minute')
        )
        -- Likewise for a renewal waiting for a VAT number, as long as the
        -- customer was sent the notice for this renewal.
        AND NOT (
          LEFT(COALESCE(a.last_error, ''), LENGTH($3)) = $3 AND
          a.business_tax_id_notified_at IS NOT NULL AND
          a.not_before > NOW() - ($2 * INTERVAL '1 millisecond') AND
          a.next_attempt_at > NOW() - ($1 * INTERVAL '1 minute')
        )
      ORDER BY a.not_before, a.subscription_id`,
    [
      warningMinutes,
      RENEWAL_PAYMENT_GRACE_MS,
      BUSINESS_TAX_ID_REFUSAL_PREFIX,
      ...(claimable.bay != null ? [claimable.bay] : []),
    ],
  );
  if (rows.length === 0) {
    return 0;
  }
  const critical = rows.some(
    ({ age_minutes }) => Number(age_minutes) >= criticalMinutes,
  );
  const hidden = Math.max(0, rows.length - MAX_ALERT_ROWS);
  // Overdue renewals that a pass could claim but none has picked up at all:
  // most likely other renewals are being processed (or retried) ahead of
  // them. Renewals no pass may claim are counted separately.
  const neverTried = rows.filter(
    ({ attempt_count, claimable }) => claimable && Number(attempt_count) === 0,
  ).length;
  const unclaimable = rows.filter(({ claimable }) => !claimable).length;
  const starvation =
    (neverTried > 0
      ? `\n- **Never tried yet: ${neverTried}.** These are overdue and claimable but no renewal pass has attempted them, most likely because other renewals are taking every pass (head-of-line blocking): check the renewals with many tries.`
      : "") +
    (unclaimable > 0
      ? `\n- Not claimable: ${unclaimable} (this bay's renewal worker may not claim them: the account is banned, deleted or has billing frozen, or, without the billing authority, the account or its funding authority belongs to another bay or is inactive).`
      : "");
  const body = `Automatic personal membership renewals are taking longer than expected.

- Affected renewals: ${rows.length}${starvation}
- Oldest age: ${Math.floor(Number(rows[0].age_minutes))} minutes
- Warning threshold: ${warningMinutes} minutes
- Critical threshold: ${criticalMinutes} minutes

${delayedRenewalTable(rows, criticalMinutes)}
${hidden > 0 ? `\n${hidden} additional affected renewals are omitted.` : ""}`;
  await adminAlert({
    subject: critical
      ? "CRITICAL: Personal membership renewal processing is delayed"
      : "Personal membership renewal processing is delayed",
    body,
    dedupBySubject: true,
    dedupMinutes: ALERT_DEDUP_MINUTES,
  });
  return rows.length;
}
