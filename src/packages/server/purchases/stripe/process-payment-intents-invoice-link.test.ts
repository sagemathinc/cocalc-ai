/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockGetConn = jest.fn();
const mockGetStripeCustomerId = jest.fn();
const mockCreateCredit = jest.fn();
const mockApplyMembershipChange = jest.fn();
const mockSend = jest.fn();
const mockSupport = jest.fn();
const mockUrl = jest.fn();
const mockName = jest.fn();
const mockAdminAlert = jest.fn();
const mockGetBalance = jest.fn();
const mockPurchaseMembershipPackage = jest.fn();
const mockVerifyDirectStudentCourseProduct = jest.fn();

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetConn(...args),
}));

jest.mock("./util", () => ({
  getAccountIdFromStripeCustomerId: jest.fn(),
  getStripeCustomerId: (...args: any[]) => mockGetStripeCustomerId(...args),
}));

jest.mock("@cocalc/server/purchases/create-credit", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCreateCredit(...args),
}));

jest.mock("../membership-change", () => ({
  applyMembershipChange: (...args: any[]) => mockApplyMembershipChange(...args),
}));

jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args: any[]) => mockSend(...args),
  name: (...args: any[]) => mockName(...args),
  support: (...args: any[]) => mockSupport(...args),
  url: (...args: any[]) => mockUrl(...args),
}));

jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args: any[]) => mockAdminAlert(...args),
}));

jest.mock("@cocalc/server/purchases/get-balance", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetBalance(...args),
}));

jest.mock("@cocalc/server/purchases/membership-package", () => ({
  __esModule: true,
  default: (...args: any[]) => mockPurchaseMembershipPackage(...args),
  purchaseMembershipPackages: jest.fn(),
}));

jest.mock("@cocalc/server/purchases/direct-student-course-product", () => ({
  verifyDirectStudentCourseProduct: (...args: any[]) =>
    mockVerifyDirectStudentCourseProduct(...args),
  verifyDirectStudentCourseProducts: jest.fn(),
}));

import processPaymentIntents from "./process-payment-intents";
import {
  MEMBERSHIP_CHANGE,
  MEMBERSHIP_PACKAGE_PURCHASE,
} from "@cocalc/util/db-schema/purchases";

describe("processPaymentIntents invoice-payment links", () => {
  const stripe = {
    invoicePayments: {
      list: jest.fn(),
    },
    invoices: {
      retrieve: jest.fn(),
    },
    paymentIntents: {
      retrieve: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConn.mockResolvedValue(stripe);
    mockGetStripeCustomerId.mockResolvedValue("cus_123");
    mockCreateCredit.mockResolvedValue(101);
    mockApplyMembershipChange.mockResolvedValue({});
    mockSend.mockResolvedValue(undefined);
    mockSupport.mockResolvedValue("support");
    mockUrl.mockResolvedValue("settings/payments");
    mockName.mockResolvedValue("Ada <ada@example.com>");
    mockGetBalance.mockResolvedValue(0);
    mockPurchaseMembershipPackage.mockResolvedValue({
      package_id: "package-1",
      purchase_id: 202,
    });
    mockVerifyDirectStudentCourseProduct.mockImplementation(
      async ({ product }) => ({
        ...product,
        metadata: {
          ...product.metadata,
          verified_student_course_purchase: true,
        },
      }),
    );
    stripe.invoicePayments.list.mockResolvedValue({
      data: [
        {
          invoice: "in_123",
          is_default: true,
          status: "paid",
        },
      ],
    });
    stripe.invoices.retrieve.mockResolvedValue({
      customer: "cus_123",
      id: "in_123",
      lines: { data: [] },
    });
    stripe.paymentIntents.retrieve.mockResolvedValue({
      customer: "cus_123",
      id: "pi_123",
      metadata: {
        account_id: "acct-1",
        allow_downgrade: "true",
        membership_class: "pro",
        membership_interval: "month",
        purpose: MEMBERSHIP_CHANGE,
        total_excluding_tax_usd: "4666",
      },
      status: "succeeded",
    });
    stripe.paymentIntents.update.mockResolvedValue({});
  });

  it("processes invoice-created payment intents without a top-level invoice field", async () => {
    await expect(
      processPaymentIntents({
        account_id: "acct-1",
        payment_intent_id: "pi_123",
        strict: true,
      }),
    ).resolves.toBe(1);

    expect(stripe.invoicePayments.list).toHaveBeenCalledWith({
      payment: {
        payment_intent: "pi_123",
        type: "payment_intent",
      },
      limit: 10,
    });
    expect(stripe.invoices.retrieve).toHaveBeenCalledWith("in_123");
    expect(mockApplyMembershipChange).toHaveBeenCalledWith({
      account_id: "acct-1",
      allowDowngrade: true,
      interval: "month",
      paymentAmount: expect.anything(),
      storeVisibleOnly: true,
      targetClass: "pro",
    });
    expect(stripe.paymentIntents.update).toHaveBeenLastCalledWith("pi_123", {
      metadata: expect.objectContaining({
        credit_id: 101,
        invoice_id: "in_123",
        processed: "true",
      }),
    });
  });

  it("verifies direct student course package products before Stripe fulfillment", async () => {
    const product = {
      type: "membership-package",
      kind: "course",
      membership_class: "student1",
      seat_count: 1,
      course_project_id: "course-project-1",
      metadata: {
        direct_student_purchase: true,
        grant_source: "student-course-purchase",
        project_id: "student-project-1",
        course_project_id: "course-project-1",
      },
    };
    stripe.paymentIntents.retrieve.mockResolvedValue({
      customer: "cus_123",
      id: "pi_123",
      metadata: {
        account_id: "acct-1",
        membership_package_product: JSON.stringify(product),
        purpose: MEMBERSHIP_PACKAGE_PURCHASE,
        total_excluding_tax_usd: "1800",
      },
      status: "succeeded",
    });

    await expect(
      processPaymentIntents({
        account_id: "acct-1",
        payment_intent_id: "pi_123",
        strict: true,
      }),
    ).resolves.toBe(1);

    expect(mockVerifyDirectStudentCourseProduct).toHaveBeenCalledWith({
      account_id: "acct-1",
      product,
    });
    expect(mockPurchaseMembershipPackage).toHaveBeenCalledWith({
      account_id: "acct-1",
      fulfillment_id: "pi_123",
      product: {
        ...product,
        metadata: {
          ...product.metadata,
          verified_student_course_purchase: true,
        },
      },
      amount: expect.anything(),
    });
    expect(stripe.paymentIntents.update).toHaveBeenLastCalledWith("pi_123", {
      metadata: expect.objectContaining({
        credit_id: 101,
        processed: "true",
      }),
    });
  });
});
