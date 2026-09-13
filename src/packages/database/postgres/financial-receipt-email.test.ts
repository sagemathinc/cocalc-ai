import {
  isFinancialReceipt,
  verifiedFinancialReceiptEmail,
} from "./financial-receipt-email";
import { revalidateNotificationEmail } from "./notification-email-outbox";
import type { NotificationEmailOutboxRow } from "./notification-email-outbox";

const account = {
  home_bay_id: "home",
  email_address: "primary@example.test",
  email_address_verified: { "primary@example.test": Date.now() },
  banned: false,
  deleted: false,
};
const row = {
  target_account_id: "11111111-1111-4111-8111-111111111111",
  category: "billing",
  delivery_mode: "immediate",
  recipient_email: account.email_address,
  summary_json: {
    summary: { notice_type: "billing_course_funding_receipt" },
    financial_receipt_home_bay_id: "home",
  },
} as NotificationEmailOutboxRow;
const financial_home = { current: "home", local: "home" };
const skip = { action: "skip", status: "skipped_unverified" };

it("requires explicitly verified primary, never NULL legacy verification or another address", () => {
  expect(verifiedFinancialReceiptEmail(account)).toBe(account.email_address);
  for (const email_address_verified of [
    null,
    {},
    { "old@example.test": true },
    { "primary@example.test": false },
  ])
    expect(
      verifiedFinancialReceiptEmail({ ...account, email_address_verified }),
    ).toBeNull();
  expect(
    verifiedFinancialReceiptEmail({ ...account, banned: true }),
  ).toBeNull();
});
it.each([
  undefined,
  { deleted: true },
  { banned: true },
  { home_bay_id: "moved" },
  { email_address_verified: null },
  { email_address_verified: {} },
  {
    email_address: "new@example.test",
    email_address_verified: { "new@example.test": true },
  },
])("rechecks destination state at send time: %j", async (change) => {
  const db = {
    query: jest
      .fn()
      .mockResolvedValue({ rows: change ? [{ ...account, ...change }] : [] }),
  };
  expect(
    await revalidateNotificationEmail({ row, db, financial_home }),
  ).toMatchObject(skip);
});
it("sends verified receipts only on current directory AND local account home", async () => {
  const db = { query: jest.fn().mockResolvedValue({ rows: [account] }) };
  expect(
    await revalidateNotificationEmail({ row, db, financial_home }),
  ).toEqual({ action: "send" });
  for (const home of [
    undefined,
    { current: "moved", local: "home" },
    { current: "moved", local: "moved" },
    { current: "", local: "home" },
  ])
    expect(
      await revalidateNotificationEmail({ row, db, financial_home: home }),
    ).toMatchObject(skip);
  expect(
    await revalidateNotificationEmail({
      row: { ...row, delivery_mode: "digest" },
      db,
      financial_home,
    }),
  ).toMatchObject(skip);
});
it("leaves legacy notices unchanged and recognizes only explicit financial receipt types", async () => {
  const db = { query: jest.fn() };
  for (const notice_type of [
    "billing_invoice",
    "billing_receipt",
    "security_alert",
    undefined,
  ]) {
    expect(isFinancialReceipt({ notice_type })).toBe(false);
    expect(
      await revalidateNotificationEmail({
        row: { ...row, summary_json: { summary: { notice_type } } },
        db,
      }),
    ).toEqual({ action: "send" });
  }
  expect(db.query).not.toHaveBeenCalled();
  expect(
    isFinancialReceipt({ notice_type: "billing_credit_transfer_receipt" }),
  ).toBe(true);
});
