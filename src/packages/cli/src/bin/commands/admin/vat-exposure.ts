/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// `cocalc admin purchase vat-exposure`: reads the server's paged VAT exposure
// report until every active membership is checked or the time runs out.

import type {
  VatExposureReportPage,
  VatExposureRow,
} from "@cocalc/conat/hub/api/purchases";

export interface VatExposureReport {
  checked: number;
  no_stripe_customer: number;
  not_claimable: number;
  affected_count: number;
  affected: VatExposureRow[];
  paid_without_check_count: number;
  paid_without_check: VatExposureReportPage["paid_without_check"];
  stripe_error_count: number;
  stripe_errors: VatExposureReportPage["stripe_errors"];
  // Set when the time ran out before every active membership was checked.
  incomplete: boolean;
  next_after_subscription_id: number | null;
}

export async function collectVatExposureReport({
  page,
  maxMs,
  now = Date.now,
}: {
  page: (after_subscription_id: number) => Promise<VatExposureReportPage>;
  maxMs: number;
  now?: () => number;
}): Promise<VatExposureReport> {
  const deadline = now() + maxMs;
  const report: VatExposureReport = {
    checked: 0,
    no_stripe_customer: 0,
    not_claimable: 0,
    affected_count: 0,
    affected: [],
    paid_without_check_count: 0,
    paid_without_check: [],
    stripe_error_count: 0,
    stripe_errors: [],
    incomplete: false,
    next_after_subscription_id: null,
  };
  let after = 0;
  for (;;) {
    const result = await page(after);
    report.checked += result.checked;
    report.no_stripe_customer += result.no_stripe_customer;
    report.not_claimable += result.not_claimable ?? 0;
    report.affected.push(...result.affected);
    report.paid_without_check.push(...(result.paid_without_check ?? []));
    report.stripe_errors.push(...result.stripe_errors);
    const next = result.next_after_subscription_id;
    if (next == null) break;
    if (next <= after) {
      throw new Error("the VAT exposure report did not advance");
    }
    after = next;
    if (now() >= deadline) {
      report.incomplete = true;
      report.next_after_subscription_id = next;
      break;
    }
  }
  report.affected_count = report.affected.length;
  report.paid_without_check_count = report.paid_without_check.length;
  report.stripe_error_count = report.stripe_errors.length;
  return report;
}

function rowLine(row: VatExposureRow, last: string): string {
  return [
    row.account_id,
    row.subscription_id,
    row.current_period_end,
    row.reason,
    row.country,
    last,
  ].join("\t");
}

export function formatVatExposureReport(report: VatExposureReport): string {
  const lines = [
    `Active memberships checked: ${report.checked}`,
    `Would be refused at renewal: ${report.affected_count}`,
    `Would be refused if checked, but the next renewal skips the check (open payment, balance or below minimum): ${report.paid_without_check_count}`,
    `Stripe errors: ${report.stripe_error_count}`,
    `Without a Stripe customer (not refused): ${report.no_stripe_customer}`,
    `Not renewed by this bay (banned, deleted, billing frozen, another bay's, or renewal attempt closed): ${report.not_claimable}`,
  ];
  if (report.incomplete) {
    lines.push(
      `INCOMPLETE: stopped after subscription ${report.next_after_subscription_id}; raise --max-seconds to check the rest`,
    );
  }
  if (report.affected.length > 0) {
    lines.push(
      "",
      "Would be refused at renewal:",
      "account_id\tsubscription_id\tnext_renewal\treason\tcountry\tstripe_customer",
    );
    for (const row of report.affected) {
      lines.push(rowLine(row, row.stripe_customer));
    }
  }
  if (report.paid_without_check.length > 0) {
    lines.push(
      "",
      "Next renewal skips the check (refused if checked):",
      "account_id\tsubscription_id\tnext_renewal\treason\tcountry\tfunding",
    );
    for (const row of report.paid_without_check) {
      lines.push(rowLine(row, row.funding));
    }
  }
  if (report.stripe_errors.length > 0) {
    lines.push("", "Stripe errors (account_id\tsubscription_id\terror):");
    for (const row of report.stripe_errors) {
      lines.push(`${row.account_id}\t${row.subscription_id}\t${row.error}`);
    }
  }
  return lines.join("\n");
}
