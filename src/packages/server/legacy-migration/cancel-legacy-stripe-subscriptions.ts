/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import getStripe from "@cocalc/server/stripe/connection";

const CANCELLABLE_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
]);
const CONFIRM = "cancel-legacy-stripe-subscriptions";

type Options = {
  apply: boolean;
  accountIds: string[];
  legacyAccountIds: string[];
  stripeCustomerIds: string[];
  limit?: number;
  onlyApplied: boolean;
  includeNonLegacy: boolean;
  confirm?: string;
};

type Candidate = {
  legacy_account_id: string;
  account_id: string | null;
  email_address: string | null;
  stripe_customer_id: string;
  legacy_stripe_customer: Record<string, any> | null;
  financial_applied: boolean;
};

type ListedSubscription = {
  id: string;
  status: string;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean | null;
  metadata?: Record<string, string> | null;
  legacy_upgrade: boolean;
  summary: string;
};

let poolUsed = false;

function pool() {
  poolUsed = true;
  return getPool();
}

function usage(): never {
  console.log(`Usage:
  node packages/server/dist/legacy-migration/cancel-legacy-stripe-subscriptions.js [options]

Lists or cancels active Stripe subscriptions attached to legacy cocalc.com
Stripe customer ids imported into legacy_migration_accounts.

Options:
  --apply                         Cancel matching Stripe subscriptions. Without
                                  this, the script is dry-run only.
  --confirm ${CONFIRM}
                                  Required with --apply.
  --account-id <uuid>             Restrict to a cocalc.ai account id. Repeatable.
  --legacy-account-id <uuid>      Restrict to a legacy cocalc.com account id.
                                  Repeatable.
  --stripe-customer-id <id>       Restrict to a legacy Stripe customer id.
                                  Repeatable.
  --limit <n>                     Consider at most n legacy Stripe customers.
  --include-unapplied             With --apply, also cancel for legacy financial
                                  records that have not been applied yet.
                                  Dry-runs always show unapplied rows unless
                                  --only-applied is passed.
  --only-applied                  Only include rows with applied financial
                                  migration claims.
  --include-non-legacy            Include active Stripe subscriptions that do
                                  not look like legacy upgrade plans. By
                                  default only subscriptions with no
                                  metadata.service are listed/canceled.
  --help                          Show this help.
`);
  process.exit(0);
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    apply: false,
    accountIds: [],
    legacyAccountIds: [],
    stripeCustomerIds: [],
    onlyApplied: false,
    includeNonLegacy: false,
  };
  let includeUnapplied = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--include-unapplied") {
      includeUnapplied = true;
      continue;
    }
    if (arg === "--only-applied") {
      options.onlyApplied = true;
      continue;
    }
    if (arg === "--include-non-legacy") {
      options.includeNonLegacy = true;
      continue;
    }
    const value = argv[++i];
    if (value == null || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    if (arg === "--confirm") {
      options.confirm = value;
    } else if (arg === "--account-id") {
      options.accountIds.push(value);
    } else if (arg === "--legacy-account-id") {
      options.legacyAccountIds.push(value);
    } else if (arg === "--stripe-customer-id") {
      options.stripeCustomerIds.push(value);
    } else if (arg === "--limit") {
      options.limit = positiveInt(value, arg);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (options.apply && includeUnapplied && options.onlyApplied) {
    throw new Error("--include-unapplied conflicts with --only-applied");
  }
  if (options.apply && !includeUnapplied) {
    options.onlyApplied = true;
  }
  if (options.apply && options.confirm !== CONFIRM) {
    throw new Error(`--apply requires --confirm ${CONFIRM}`);
  }
  return options;
}

async function candidates(options: Options): Promise<Candidate[]> {
  const clauses = ["COALESCE(legacy.stripe_customer_id, '') <> ''"];
  const params: unknown[] = [];
  if (options.onlyApplied) {
    clauses.push("claims.legacy_account_id IS NOT NULL");
  }
  if (options.accountIds.length > 0) {
    params.push(options.accountIds);
    clauses.push(`links.account_id = ANY($${params.length}::uuid[])`);
  }
  if (options.legacyAccountIds.length > 0) {
    params.push(options.legacyAccountIds);
    clauses.push(`legacy.legacy_account_id = ANY($${params.length}::text[])`);
  }
  if (options.stripeCustomerIds.length > 0) {
    params.push(options.stripeCustomerIds);
    clauses.push(`legacy.stripe_customer_id = ANY($${params.length}::text[])`);
  }
  const limit =
    options.limit != null
      ? `LIMIT ${positiveInt(`${options.limit}`, "--limit")}`
      : "";
  const { rows } = await pool().query<Candidate>(
    `
    SELECT DISTINCT ON (legacy.stripe_customer_id)
           legacy.legacy_account_id,
           links.account_id,
           legacy.email_address,
           legacy.stripe_customer_id,
           legacy.metadata->'stripe_customer' AS legacy_stripe_customer,
           (claims.legacy_account_id IS NOT NULL) AS financial_applied
      FROM legacy_migration_accounts legacy
      LEFT JOIN legacy_migration_account_links links
        ON links.legacy_account_id=legacy.legacy_account_id
      LEFT JOIN legacy_migration_financial_claims claims
        ON claims.legacy_account_id=legacy.legacy_account_id
       AND claims.status='applied'
     WHERE ${clauses.join(" AND ")}
     ORDER BY legacy.stripe_customer_id,
              (claims.legacy_account_id IS NOT NULL) DESC,
              links.account_id NULLS LAST,
              legacy.legacy_account_id
     ${limit}
    `,
    params,
  );
  return rows;
}

function subscriptionSummary(sub: any): string {
  const items = sub.items.data
    .map((item) => {
      const price = item.price;
      const amount =
        price.unit_amount == null
          ? ""
          : `$${(price.unit_amount / 100).toFixed(2)}`;
      return [
        price.nickname,
        price.lookup_key,
        price.id,
        amount,
        price.recurring?.interval,
      ]
        .filter(Boolean)
        .join("/");
    })
    .filter(Boolean);
  return items.join(", ") || "no price items";
}

function isLegacyUpgradeSubscription(sub: any): boolean {
  return sub?.metadata?.service == null || sub?.metadata?.service === "";
}

async function listCancellableSubscriptions({
  stripe,
  customer,
  includeNonLegacy,
}: {
  stripe: Awaited<ReturnType<typeof getStripe>>;
  customer: string;
  includeNonLegacy: boolean;
}): Promise<ListedSubscription[]> {
  const result: ListedSubscription[] = [];
  for await (const sub of stripe.subscriptions.list({
    customer,
    status: "all",
    limit: 100,
  })) {
    const subscription = sub as any;
    if (!CANCELLABLE_STATUSES.has(sub.status)) {
      continue;
    }
    const legacy_upgrade = isLegacyUpgradeSubscription(sub);
    if (!legacy_upgrade && !includeNonLegacy) {
      continue;
    }
    result.push({
      id: sub.id,
      status: sub.status,
      current_period_end: subscription.current_period_end,
      cancel_at_period_end: subscription.cancel_at_period_end,
      metadata: sub.metadata,
      legacy_upgrade,
      summary: subscriptionSummary(sub),
    });
  }
  return result;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const stripe = await getStripe();
  const rows = await candidates(options);
  console.log(
    `${options.apply ? "apply" : "dry-run"}: checking ${rows.length.toLocaleString()} legacy Stripe customer(s)`,
  );
  let customersWithSubscriptions = 0;
  let subscriptionsFound = 0;
  let subscriptionsCanceled = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const subscriptions = await listCancellableSubscriptions({
        stripe,
        customer: row.stripe_customer_id,
        includeNonLegacy: options.includeNonLegacy,
      });
      if (subscriptions.length === 0) {
        continue;
      }
      customersWithSubscriptions += 1;
      subscriptionsFound += subscriptions.length;
      console.log(
        [
          row.stripe_customer_id,
          `legacy_account=${row.legacy_account_id}`,
          `account=${row.account_id ?? ""}`,
          `email=${row.email_address ?? ""}`,
          `financial_applied=${row.financial_applied}`,
          `subscriptions=${subscriptions.length}`,
        ].join(" "),
      );
      for (const sub of subscriptions) {
        console.log(
          `  ${options.apply ? "cancel" : "would_cancel"} ${sub.id} status=${sub.status} legacy_upgrade=${sub.legacy_upgrade} period_end=${sub.current_period_end ?? ""} cancel_at_period_end=${sub.cancel_at_period_end ?? ""} ${sub.summary}`,
        );
        if (options.apply) {
          await stripe.subscriptions.cancel(sub.id);
          subscriptionsCanceled += 1;
        }
      }
    } catch (err) {
      failed += 1;
      console.error(`${row.stripe_customer_id} failed: ${err}`);
    }
  }
  console.log(
    [
      "done:",
      `customers_with_subscriptions=${customersWithSubscriptions}`,
      `subscriptions_found=${subscriptionsFound}`,
      `subscriptions_canceled=${subscriptionsCanceled}`,
      `failed=${failed}`,
    ].join(" "),
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (poolUsed) {
      await getPool().end();
    }
  });
