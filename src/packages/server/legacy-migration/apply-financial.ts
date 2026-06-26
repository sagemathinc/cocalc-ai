/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import {
  applyAutomaticFinancialMigration,
  ensureVerifiedEmailLinksForAllAccounts,
  financialMigrationCandidateAccountIds,
  previewFinancialMigration,
} from ".";

type Options = {
  accountIds: string[];
  dryRun: boolean;
  limit?: number;
  skipLinkBackfill: boolean;
};

let poolUsed = false;

function pool() {
  poolUsed = true;
  return getPool();
}

function usage(): never {
  console.log(`Usage:
  node packages/server/dist/legacy-migration/apply-financial.js [options]

Options:
  --account-id <uuid>       Apply only this account. Can be given more than once.
  --limit <n>               Apply at most n candidate accounts. Default: server default.
  --dry-run                 Print what would be applied without writing changes.
  --skip-link-backfill      Do not rebuild verified-email legacy account links first.
  --help                    Show this help.
`);
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    accountIds: [],
    dryRun: false,
    skipLinkBackfill: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--skip-link-backfill") {
      options.skipLinkBackfill = true;
      continue;
    }
    const value = argv[++i];
    if (value == null || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    if (arg === "--account-id") {
      options.accountIds.push(value);
    } else if (arg === "--limit") {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = n;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  pool();
  if (!options.skipLinkBackfill) {
    const changed = await ensureVerifiedEmailLinksForAllAccounts();
    console.log(`verified-email legacy links refreshed: ${changed}`);
  }
  const accountIds =
    options.accountIds.length > 0
      ? options.accountIds
      : await financialMigrationCandidateAccountIds({ limit: options.limit });
  console.log(
    `${options.dryRun ? "dry-run: " : ""}financial migration candidates: ${accountIds.length}`,
  );
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  for (const account_id of accountIds) {
    try {
      if (options.dryRun) {
        const preview = await previewFinancialMigration({ account_id });
        console.log(
          [
            account_id,
            `legacy_accounts=${preview.legacy_accounts.length}`,
            `pending_credit=${preview.pending_credit_amount}`,
            `active_subscriptions=${preview.active_subscription_count}`,
            `stripe_customer=${preview.stripe_customer_id ?? ""}`,
            `can_apply=${preview.can_apply}`,
          ].join(" "),
        );
        skipped += preview.can_apply ? 0 : 1;
        continue;
      }
      const result = await applyAutomaticFinancialMigration({ account_id });
      if (result.claimed_legacy_account_ids.length === 0) {
        skipped += 1;
      } else {
        applied += 1;
      }
      console.log(
        [
          account_id,
          `claimed=${result.claimed_legacy_account_ids.length}`,
          `credit=${result.credit_amount}`,
          `subscription_id=${result.subscription_id ?? ""}`,
          `stripe_customer=${result.stripe_customer_id ?? ""}`,
        ].join(" "),
      );
    } catch (err) {
      failed += 1;
      console.error(`${account_id} failed: ${err}`);
    }
  }
  console.log(`done: applied=${applied} skipped=${skipped} failed=${failed}`);
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
