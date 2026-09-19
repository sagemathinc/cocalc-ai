/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details.
 */
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import type {
  MonthlyCollectionApi,
  MonthlyCollectionConsent,
  MonthlyCollectionTerms,
} from "@cocalc/util/monthly-collection";
import {
  normalizeMonthlyCollectionTerms,
  MONTHLY_COLLECTION_TERMS,
} from "@cocalc/util/monthly-collection";
import { fundingId } from "@cocalc/util/compute-funding";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { createNotificationEventGraphInTransaction } from "@cocalc/database/postgres/notifications-core";
import { requireFundingAccountTransaction } from "@cocalc/server/compute/funding/backing";
import {
  monthlyCollectionApprovalAvailable,
  fundingApprovalPubliclyReady,
  proposeMonthlyCollectionApproval,
  getMonthlyCollectionApproval,
} from "@cocalc/server/compute/funding/approvals";
import { hasCardPaymentMethod } from "./stripe/get-payment-methods";
import { getServerSettings } from "@cocalc/database/settings";
import { isBillingAuthorityEnabled } from "@cocalc/server/purchases/billing-authority/config";
import {
  billingAccountsTable,
  ensureBillingAccount,
} from "@cocalc/server/purchases/billing-account";

export async function readMonthlyCollection(
  account_id: string,
  db: Pick<PoolClient, "query"> = getPool(),
) {
  await ensureBillingAccount(account_id, db);
  const table = billingAccountsTable();
  const {
    rows: [row],
  } = await db.query(
    `SELECT monthly_collection, stripe_usage_subscription, home_bay_id, banned, deleted FROM ${table} WHERE account_id=$1`,
    [account_id],
  );
  if (!row || row.banned || row.deleted)
    throw Error("Account is unavailable for monthly collection");
  const consent: MonthlyCollectionConsent = row.monthly_collection ?? {
    enabled: false,
    version: 0,
    terms_version: 1,
  };
  return {
    consent,
    home_bay_id: row.home_bay_id ?? getConfiguredBayId(),
    legacy_enabled:
      row.monthly_collection == null && !!row.stripe_usage_subscription,
  };
}
async function actorHome(value?: string) {
  const account_id = fundingId(value, "Signed-in account");
  if (isBillingAuthorityEnabled()) return { account_id };
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  if (!home_bay_id) throw Error("Account home is unavailable");
  return {
    account_id,
    remote:
      home_bay_id === getConfiguredBayId()
        ? undefined
        : createInterBayAccountLocalClient({
            client: getInterBayFabricClient(),
            dest_bay: home_bay_id,
          }),
  };
}
export const getMonthlyCollection: MonthlyCollectionApi["getMonthlyCollection"] =
  async (opts = {}) => {
    const { account_id, remote } = await actorHome(opts.account_id);
    if (remote) return remote.getMonthlyCollection({ account_id });
    const state = await readMonthlyCollection(account_id);
    const available =
      monthlyCollectionApprovalAvailable() &&
      (await fundingApprovalPubliclyReady());
    const pending = [] as Awaited<
      ReturnType<MonthlyCollectionApi["getMonthlyCollection"]>
    >["pending"];
    if (available) {
      const { rows } = await getPool().query(
        "SELECT id FROM course_funding_approval_intents WHERE payer_account_id=$1 AND terms->>'kind'='monthlyCollection' AND applied_at IS NULL AND expires_at>clock_timestamp() AND (terms->>'expected_version')::bigint=$2 ORDER BY created_at DESC LIMIT 10",
        [account_id, state.consent.version],
      );
      for (const row of rows)
        pending.push(
          await getMonthlyCollectionApproval({
            payer_account_id: account_id,
            intent_id: row.id,
          }),
        );
    }
    const { rows: attention } = await getPool().query(
      `SELECT id FROM statements WHERE account_id=$1 AND paid_purchase_id IS NULL
       AND (monthly_collection->>'state'='requires_review' OR
         (monthly_collection->>'state' IN ('claimed','issued') AND automatic_payment<clock_timestamp()-interval '10 minutes')) ORDER BY time LIMIT 20`,
      [account_id],
    );
    return {
      ...state,
      available,
      pending,
      attention_statement_ids: attention.map((s) => s.id),
    };
  };
export const proposeMonthlyCollection: MonthlyCollectionApi["proposeMonthlyCollection"] =
  async (opts) => {
    const { account_id, remote } = await actorHome(opts.account_id);
    if (remote) return remote.proposeMonthlyCollection({ ...opts, account_id });
    return proposeMonthlyCollectionApproval({
      payer_account_id: account_id,
      operation_id: fundingId(opts.operation_id, "Operation"),
      terms: normalizeMonthlyCollectionTerms(opts.terms),
    });
  };
export async function reviewMonthlyCollection(
  account_id: string,
  terms: MonthlyCollectionTerms,
) {
  normalizeMonthlyCollectionTerms(terms);
  const { consent } = await readMonthlyCollection(account_id);
  if (consent.version !== terms.expected_version)
    throw Error("Monthly collection changed. Refresh and review again.");
  if (terms.enabled) {
    const settings = await getServerSettings();
    if (
      !settings.stripe_secret_key ||
      !settings.stripe_publishable_key ||
      !(await hasCardPaymentMethod(account_id))
    )
      throw Error("Add a saved card before enabling monthly collection.");
  }
}
export async function applyMonthlyCollection(
  db: PoolClient,
  account_id: string,
  terms: MonthlyCollectionTerms,
  intent_id: string,
) {
  requireFundingAccountTransaction(db, account_id);
  normalizeMonthlyCollectionTerms(terms);
  const { consent, home_bay_id } = await readMonthlyCollection(account_id, db);
  if (consent.version !== terms.expected_version)
    throw Error("Monthly collection changed. Refresh and review again.");
  const next: MonthlyCollectionConsent = {
    enabled: terms.enabled,
    version: consent.version + 1,
    terms_version: 1,
    updated_at: new Date().toISOString(),
  };
  const table = billingAccountsTable();
  await db.query(
    `UPDATE ${table} SET monthly_collection=$2::jsonb WHERE account_id=$1`,
    [account_id, JSON.stringify(next)],
  );
  const summary = {
    notice_type: "billing_monthly_collection",
    title: `Monthly collection ${next.enabled ? "enabled" : "disabled"}`,
    body_markdown: next.enabled
      ? MONTHLY_COLLECTION_TERMS
      : "Future automatic monthly collection is disabled. Already-started payments and amounts owed are unchanged. Postpaid compute may stop when automatic billing is no longer eligible.",
    severity: "info",
    action_link: "/settings/balance",
    action_label: "View billing",
  };
  await createNotificationEventGraphInTransaction({
    db,
    input: {
      event_id: intent_id,
      kind: "account_notice",
      source_bay_id: getConfiguredBayId(),
      origin_kind: "system",
      actor_account_id: account_id,
      payload_json: summary,
      targets: [
        {
          target_account_id: account_id,
          target_home_bay_id: home_bay_id,
          dedupe_key: `monthly-collection:${intent_id}`,
          summary_json: summary,
        },
      ],
    },
  });
  return { monthly_collection: next };
}
