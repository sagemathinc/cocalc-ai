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
  affected_count: number;
  affected: VatExposureRow[];
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
    affected_count: 0,
    affected: [],
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
    report.affected.push(...result.affected);
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
  report.stripe_error_count = report.stripe_errors.length;
  return report;
}

export function formatVatExposureReport(report: VatExposureReport): string {
  const lines = [
    `Active memberships checked: ${report.checked}`,
    `Would be refused at renewal: ${report.affected_count}`,
    `Stripe errors: ${report.stripe_error_count}`,
    `Without a Stripe customer (not refused): ${report.no_stripe_customer}`,
  ];
  if (report.incomplete) {
    lines.push(
      `INCOMPLETE: stopped after subscription ${report.next_after_subscription_id}; raise --max-seconds to check the rest`,
    );
  }
  if (report.affected.length > 0) {
    lines.push(
      "",
      "account_id\tsubscription_id\tnext_renewal\treason\tcountry",
    );
    for (const row of report.affected) {
      lines.push(
        [
          row.account_id,
          row.subscription_id,
          row.current_period_end,
          row.reason,
          row.country,
        ].join("\t"),
      );
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
