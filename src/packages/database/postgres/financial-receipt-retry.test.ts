/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import {
  enqueueNotificationEmail,
  claimQueuedNotificationEmails,
  markFinancialReceiptEmailFailed,
} from "./notification-email-outbox";
import type { NotificationEmailStatus } from "./notification-email-outbox";
import {
  financialReceiptRetryDelayMs,
  FINANCIAL_RECEIPT_MAX_ATTEMPTS,
} from "./financial-receipt-email";

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 15000);
afterEach(async () => {
  await getPool().query("TRUNCATE notification_email_outbox");
});
afterAll(async () => {
  await testCleanup();
});

async function seed({
  status = "failed",
  attempt = 1,
  age_minutes = 2,
  notice_type = "billing_course_funding_receipt",
  mode = "immediate",
}: {
  status?: NotificationEmailStatus;
  attempt?: number;
  age_minutes?: number;
  notice_type?: string;
  mode?: "immediate" | "digest";
} = {}) {
  const id = await enqueueNotificationEmail({
    target_account_id: randomUUID(),
    category: "billing",
    lane: "critical",
    delivery_mode: mode,
    recipient_email: "verified@example.test",
    subject: "Receipt",
    status,
    summary_json: { summary: { notice_type } },
  });
  // Clock/state fixtures in an ephemeral database, never live outbox repair.
  await getPool().query(
    `UPDATE notification_email_outbox SET attempt_count=$2,
    updated_at=NOW()-$3::double precision*interval '1 minute',
    scheduled_at=NOW()-interval '1 day' WHERE email_id=$1`,
    [id, attempt, age_minutes],
  );
  return id;
}

it("computes bounded exponential delay and validates attempts", () => {
  expect([1, 2, 3, 6, 7, 12, 100].map(financialReceiptRetryDelayMs)).toEqual([
    60000, 120000, 240000, 1920000, 3600000, 3600000, 3600000,
  ]);
  for (const attempt of [0, -1, 1.5, NaN])
    expect(() => financialReceiptRetryDelayMs(attempt)).toThrow();
});

it("recovers existing failed/no-backend financial rows but leaves legacy and terminal rows alone", async () => {
  const eligible = await seed();
  const noBackend = await seed({
    status: "skipped_no_backend",
    notice_type: "billing_credit_transfer_receipt",
  });
  for (const status of [
    "sent",
    "skipped_unverified",
    "skipped_preference",
    "skipped_no_recipient",
  ] as const)
    await seed({ status });
  await seed({ notice_type: "billing_invoice" });
  await seed({ mode: "digest" });
  const rows = await claimQueuedNotificationEmails();
  expect(rows.map((r) => r.email_id).sort()).toEqual(
    [eligible, noBackend].sort(),
  );
  expect(
    rows.every((r) => r.attempt_count === 2 && r.status === "sending"),
  ).toBe(true);
  expect(await claimQueuedNotificationEmails()).toHaveLength(0);
});

it("enforces backoff for pre-upgrade failures even when scheduled_at is already due", async () => {
  await seed({ age_minutes: 0.5 });
  await seed({ attempt: 2, age_minutes: 1.5 });
  await seed({ attempt: 9, age_minutes: 59 });
  const due = await seed({ attempt: 9, age_minutes: 61 });
  expect(
    (await claimQueuedNotificationEmails()).map((r) => r.email_id),
  ).toEqual([due]);
});

it("persists the next retry and failure reason without replacing receipt identity", async () => {
  const id = await seed({ status: "sending", attempt: 2 });
  await markFinancialReceiptEmailFailed({
    email_id: id,
    attempt_count: 2,
    error: "help_email missing",
  });
  const {
    rows: [row],
  } = await getPool().query(
    "SELECT *,extract(epoch FROM scheduled_at-updated_at)*1000 AS delay FROM notification_email_outbox WHERE email_id=$1",
    [id],
  );
  expect(row.status).toBe("failed");
  expect(row.last_error).toBe("help_email missing");
  expect(Number(row.delay)).toBe(120000);
  expect(row.attempt_count).toBe(2);
  expect(await claimQueuedNotificationEmails({ db: getPool() })).toHaveLength(
    0,
  );
});

it("never overwrites a newer claim or resurrects sent/unverified decisions", async () => {
  const newer = await seed({ status: "sending", attempt: 3 });
  const sent = await seed({ status: "sent", attempt: 2 });
  const unverified = await seed({ status: "skipped_unverified", attempt: 2 });
  const legacy = await seed({
    status: "sending",
    attempt: 2,
    notice_type: "billing_invoice",
  });
  for (const id of [newer, sent, unverified, legacy])
    await markFinancialReceiptEmailFailed({
      email_id: id,
      attempt_count: 2,
      error: "late sender",
    });
  const { rows } = await getPool().query(
    "SELECT status,last_error FROM notification_email_outbox ORDER BY created_at",
  );
  expect(rows.map((r) => r.status)).toEqual([
    "sending",
    "sent",
    "skipped_unverified",
    "sending",
  ]);
  expect(rows.every((r) => r.last_error == null)).toBe(true);
});

it("caps attempts, finalizes an abandoned last attempt, and preserves legacy queued behavior", async () => {
  await seed({ attempt: FINANCIAL_RECEIPT_MAX_ATTEMPTS, age_minutes: 120 });
  const abandoned = await seed({
    status: "sending",
    attempt: FINANCIAL_RECEIPT_MAX_ATTEMPTS,
    age_minutes: 20,
  });
  const legacy = await seed({
    status: "queued",
    notice_type: "billing_invoice",
    attempt: 20,
  });
  expect(
    (await claimQueuedNotificationEmails()).map((r) => r.email_id),
  ).toEqual([legacy]);
  const {
    rows: [row],
  } = await getPool().query(
    "SELECT status FROM notification_email_outbox WHERE email_id=$1",
    [abandoned],
  );
  expect(row.status).toBe("failed");
});

it("claims an eligible retry once across competing workers and honors financial rehome freeze", async () => {
  const id = await seed();
  const batches = await Promise.all([
    claimQueuedNotificationEmails(),
    claimQueuedNotificationEmails(),
  ]);
  expect(batches.flat().map((r) => r.email_id)).toEqual([id]);
  const frozen = await seed();
  const {
    rows: [row],
  } = await getPool().query(
    "SELECT target_account_id FROM notification_email_outbox WHERE email_id=$1",
    [frozen],
  );
  await getPool().query(
    "INSERT INTO account_funding_authorities (payer_account_id,epoch,home_bay_id,state) VALUES ($1,gen_random_uuid(),'test-home','frozen')",
    [row.target_account_id],
  );
  try {
    expect(await claimQueuedNotificationEmails()).toHaveLength(0);
  } finally {
    await getPool().query(
      "DELETE FROM account_funding_authorities WHERE payer_account_id=$1",
      [row.target_account_id],
    );
  }
});
