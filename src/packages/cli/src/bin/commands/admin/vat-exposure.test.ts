/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { VatExposureReportPage } from "@cocalc/conat/hub/api/purchases";

import {
  collectVatExposureReport,
  formatVatExposureReport,
} from "./vat-exposure";

const row = (subscription_id: number) => ({
  account_id: `account-${subscription_id}`,
  subscription_id,
  current_period_end: "2026-11-01T00:00:00.000Z",
  reason: "missing",
  country: "DE",
  stripe_customer: "stored" as const,
});

const emptyPage = (
  next_after_subscription_id: number | null,
): VatExposureReportPage => ({
  checked: 1,
  no_stripe_customer: 0,
  affected: [],
  paid_without_check: [],
  stripe_errors: [],
  next_after_subscription_id,
});

test("vat-exposure reads every page and adds up the totals", async () => {
  const pages: Record<number, VatExposureReportPage> = {
    0: {
      checked: 2,
      no_stripe_customer: 1,
      affected: [row(1)],
      paid_without_check: [{ ...row(5), funding: "balance" }],
      stripe_errors: [],
      next_after_subscription_id: 2,
    },
    2: {
      checked: 2,
      no_stripe_customer: 0,
      affected: [row(4)],
      paid_without_check: [],
      stripe_errors: [
        { account_id: "account-3", subscription_id: 3, error: "boom" },
      ],
      next_after_subscription_id: null,
    },
  };
  const calls: number[] = [];
  const report = await collectVatExposureReport({
    page: async (after) => {
      calls.push(after);
      return pages[after];
    },
    maxMs: 60_000,
  });
  assert.deepEqual(calls, [0, 2]);
  assert.equal(report.checked, 4);
  assert.equal(report.no_stripe_customer, 1);
  assert.equal(report.affected_count, 2);
  assert.equal(report.paid_without_check_count, 1);
  assert.equal(report.stripe_error_count, 1);
  assert.equal(report.incomplete, false);
  assert.equal(report.next_after_subscription_id, null);
  const text = formatVatExposureReport(report);
  assert.match(text, /Would be refused at renewal: 2/);
  assert.ok(
    text.includes(
      "account-4\t4\t2026-11-01T00:00:00.000Z\tmissing\tDE\tstored",
    ),
  );
  assert.ok(
    text.includes(
      "account-5\t5\t2026-11-01T00:00:00.000Z\tmissing\tDE\tbalance",
    ),
  );
  assert.ok(text.includes("account-3\t3\tboom"));
});

test("vat-exposure stops when the time is up and says it is incomplete", async () => {
  let t = 0;
  let calls = 0;
  const report = await collectVatExposureReport({
    page: async (after) => {
      calls += 1;
      t += 10_000;
      return emptyPage(after + 1);
    },
    maxMs: 25_000,
    now: () => t,
  });
  assert.equal(calls, 3);
  assert.equal(report.incomplete, true);
  assert.equal(report.next_after_subscription_id, 3);
  assert.match(formatVatExposureReport(report), /INCOMPLETE/);
});

test("vat-exposure refuses a page that does not advance", async () => {
  await assert.rejects(
    collectVatExposureReport({
      page: async () => emptyPage(0),
      maxMs: 60_000,
    }),
    /did not advance/,
  );
});
