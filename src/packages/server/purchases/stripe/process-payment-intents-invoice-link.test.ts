/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockGetConn = jest.fn();
const mockGetStripeCustomerId = jest.fn();
const mockCurrentStripeSite = jest.fn();
const mockCreateCredit = jest.fn();
const mockApplyMembershipChange = jest.fn();
const mockSend = jest.fn();
const mockSupport = jest.fn();
const mockUrl = jest.fn();
const mockName = jest.fn();
const mockAdminAlert = jest.fn();
const mockGetBalance = jest.fn();
const mockPurchaseMembershipPackage = jest.fn();
const mockAssignMembershipPackageSeat = jest.fn();
const mockVerifyDirectStudentCourseProduct = jest.fn();
const mockSetStripeCustomerId = jest.fn();
const mockIsValidAccount = jest.fn();

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetConn(...args),
}));

jest.mock("./util", () => ({
  currentStripeSite: (...args: any[]) => mockCurrentStripeSite(...args),
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

jest.mock("@cocalc/server/membership/packages", () => ({
  assignMembershipPackageSeat: (...args: any[]) =>
    mockAssignMembershipPackageSeat(...args),
}));

jest.mock("@cocalc/server/purchases/direct-student-course-product", () => ({
  verifyDirectStudentCourseProduct: (...args: any[]) =>
    mockVerifyDirectStudentCourseProduct(...args),
  verifyDirectStudentCourseProducts: jest.fn(),
}));

jest.mock("@cocalc/database/postgres/stripe", () => ({
  setStripeCustomerId: (...args: any[]) => mockSetStripeCustomerId(...args),
}));

jest.mock("@cocalc/server/accounts/is-valid-account", () => ({
  __esModule: true,
  default: (...args: any[]) => mockIsValidAccount(...args),
}));

import processPaymentIntents, {
  processAllRecentPaymentIntents,
} from "./process-payment-intents";
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
    customers: {
      retrieve: jest.fn(),
    },
    paymentIntents: {
      retrieve: jest.fn(),
      search: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConn.mockResolvedValue(stripe);
    mockGetStripeCustomerId.mockResolvedValue("cus_123");
    mockCurrentStripeSite.mockResolvedValue("cocalc.ai");
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
    mockAssignMembershipPackageSeat.mockResolvedValue({
      id: "assignment-1",
      package_id: "package-1",
      account_id: "acct-1",
    });
    mockSetStripeCustomerId.mockResolvedValue(undefined);
    mockIsValidAccount.mockResolvedValue(true);
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
    stripe.customers.retrieve.mockResolvedValue({
      id: "cus_123",
      deleted: false,
      metadata: { account_id: "acct-1" },
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
    stripe.paymentIntents.search.mockResolvedValue({ data: [] });
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
    expect(mockAssignMembershipPackageSeat).toHaveBeenCalledWith({
      package_id: "package-1",
      account_id: "acct-1",
      assigned_by_account_id: "acct-1",
      metadata: expect.objectContaining({
        direct_student_purchase: true,
        verified_student_course_purchase: true,
      }),
    });
    expect(stripe.paymentIntents.update).toHaveBeenLastCalledWith("pi_123", {
      metadata: expect.objectContaining({
        credit_id: 101,
        processed: "true",
      }),
    });
  });

  it("processes direct student course package payment intents without an invoice", async () => {
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
    stripe.invoicePayments.list.mockResolvedValue({ data: [] });
    stripe.paymentIntents.retrieve.mockResolvedValue({
      customer: "cus_123",
      id: "pi_direct_course",
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
        payment_intent_id: "pi_direct_course",
        strict: true,
      }),
    ).resolves.toBe(1);

    expect(stripe.invoices.retrieve).not.toHaveBeenCalled();
    expect(mockCreateCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acct-1",
        invoice_id: "pi_direct_course",
        description: expect.objectContaining({
          line_items: [],
          purpose: MEMBERSHIP_PACKAGE_PURCHASE,
        }),
      }),
    );
    expect(mockPurchaseMembershipPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acct-1",
        fulfillment_id: "pi_direct_course",
      }),
    );
    expect(mockAssignMembershipPackageSeat).toHaveBeenCalledWith({
      package_id: "package-1",
      account_id: "acct-1",
      assigned_by_account_id: "acct-1",
      metadata: expect.objectContaining({
        direct_student_purchase: true,
        verified_student_course_purchase: true,
      }),
    });
    expect(stripe.paymentIntents.update).toHaveBeenLastCalledWith(
      "pi_direct_course",
      {
        metadata: expect.objectContaining({
          credit_id: 101,
          processed: "true",
        }),
      },
    );
  });

  it("processes payment intents when optional invoice metadata points to a missing Stripe invoice", async () => {
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
    stripe.invoices.retrieve.mockRejectedValue(
      Object.assign(new Error("No such invoice: 'in_missing'"), {
        code: "resource_missing",
        param: "invoice",
      }),
    );
    stripe.paymentIntents.retrieve.mockResolvedValue({
      customer: "cus_123",
      id: "pi_missing_invoice",
      invoice: "in_missing",
      metadata: {
        account_id: "acct-1",
        invoice_id: "in_missing",
        membership_package_product: JSON.stringify(product),
        purpose: MEMBERSHIP_PACKAGE_PURCHASE,
        total_excluding_tax_usd: "1800",
      },
      status: "succeeded",
    });

    await expect(
      processPaymentIntents({
        account_id: "acct-1",
        payment_intent_id: "pi_missing_invoice",
        strict: true,
      }),
    ).resolves.toBe(1);

    expect(stripe.invoices.retrieve).toHaveBeenCalledWith("in_missing");
    expect(mockCreateCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acct-1",
        invoice_id: "pi_missing_invoice",
      }),
    );
    expect(mockPurchaseMembershipPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acct-1",
        fulfillment_id: "pi_missing_invoice",
      }),
    );
  });

  it("processes succeeded payments on verified duplicate Stripe customers", async () => {
    mockGetStripeCustomerId.mockResolvedValue("cus_current");
    stripe.customers.retrieve.mockResolvedValue({
      id: "cus_paid_duplicate",
      deleted: false,
      metadata: { account_id: "acct-1" },
    });
    stripe.invoicePayments.list.mockResolvedValue({ data: [] });
    stripe.paymentIntents.retrieve.mockResolvedValue({
      customer: "cus_paid_duplicate",
      id: "pi_duplicate_customer",
      metadata: {
        account_id: "acct-1",
        allow_downgrade: "true",
        membership_class: "pro",
        membership_interval: "month",
        purpose: MEMBERSHIP_CHANGE,
        total_excluding_tax_usd: "500",
      },
      status: "succeeded",
    });

    await expect(
      processPaymentIntents({
        account_id: "acct-1",
        payment_intent_id: "pi_duplicate_customer",
        strict: true,
      }),
    ).resolves.toBe(1);

    expect(stripe.customers.retrieve).toHaveBeenCalledWith(
      "cus_paid_duplicate",
    );
    expect(mockSetStripeCustomerId).toHaveBeenCalledWith(
      "acct-1",
      "cus_paid_duplicate",
    );
    expect(mockApplyMembershipChange).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acct-1",
      }),
    );
  });

  it("continues missed-payment maintenance after one payment fails", async () => {
    mockGetStripeCustomerId.mockImplementation(async ({ account_id }) =>
      account_id === "acct-good" ? "cus_good" : "cus_current",
    );
    stripe.customers.retrieve.mockResolvedValue({
      id: "cus_wrong",
      deleted: false,
      metadata: { account_id: "somebody-else" },
    });
    stripe.invoicePayments.list.mockResolvedValue({ data: [] });
    stripe.paymentIntents.search.mockResolvedValue({
      data: [
        {
          customer: "cus_wrong",
          id: "pi_bad",
          metadata: {
            account_id: "acct-bad",
            allow_downgrade: "true",
            membership_class: "pro",
            membership_interval: "month",
            purpose: MEMBERSHIP_CHANGE,
            total_excluding_tax_usd: "500",
          },
          status: "succeeded",
        },
        {
          customer: "cus_foreign",
          id: "pi_foreign",
          metadata: {
            account_id: "acct-foreign",
            allow_downgrade: "true",
            cocalc_site: "cocalc.com",
            membership_class: "pro",
            membership_interval: "month",
            purpose: MEMBERSHIP_CHANGE,
            total_excluding_tax_usd: "500",
          },
          status: "succeeded",
        },
        {
          customer: "cus_legacy_foreign",
          id: "pi_legacy_foreign",
          metadata: {
            account_id: "acct-legacy-foreign",
            allow_downgrade: "true",
            membership_class: "pro",
            membership_interval: "month",
            purpose: MEMBERSHIP_CHANGE,
            total_excluding_tax_usd: "500",
          },
          status: "succeeded",
        },
        {
          customer: "cus_good",
          id: "pi_good",
          metadata: {
            account_id: "acct-good",
            allow_downgrade: "true",
            membership_class: "pro",
            membership_interval: "month",
            purpose: MEMBERSHIP_CHANGE,
            total_excluding_tax_usd: "500",
          },
          status: "succeeded",
        },
      ],
    });
    mockIsValidAccount.mockImplementation(async (account_id) => {
      return account_id !== "acct-legacy-foreign";
    });

    await expect(processAllRecentPaymentIntents()).resolves.toBe(1);

    expect(mockAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Issue Processing a User Payment Before Credit",
      }),
    );
    expect(mockApplyMembershipChange).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acct-good",
      }),
    );
    expect(mockApplyMembershipChange).not.toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acct-legacy-foreign",
      }),
    );
  });

  it("paginates missed-payment maintenance past foreign Stripe payments", async () => {
    mockGetStripeCustomerId.mockImplementation(async ({ account_id }) =>
      account_id === "acct-good" ? "cus_good" : "cus_current",
    );
    stripe.invoicePayments.list.mockResolvedValue({ data: [] });
    const foreignPayments = Array.from({ length: 100 }, (_, i) => ({
      customer: `cus_foreign_${i}`,
      id: `pi_foreign_${i}`,
      metadata: {
        account_id: `acct-foreign-${i}`,
        allow_downgrade: "true",
        cocalc_site: "cocalc.com",
        membership_class: "pro",
        membership_interval: "month",
        purpose: MEMBERSHIP_CHANGE,
        total_excluding_tax_usd: "500",
      },
      status: "succeeded",
    }));
    stripe.paymentIntents.search.mockImplementation(async ({ page }) => {
      if (!page) {
        return {
          data: foreignPayments,
          has_more: true,
          next_page: "page-2",
        };
      }
      return {
        data: [
          {
            customer: "cus_good",
            id: "pi_good_on_second_page",
            metadata: {
              account_id: "acct-good",
              allow_downgrade: "true",
              membership_class: "pro",
              membership_interval: "month",
              purpose: MEMBERSHIP_CHANGE,
              total_excluding_tax_usd: "500",
            },
            status: "succeeded",
          },
        ],
        has_more: false,
        next_page: null,
      };
    });

    await expect(processAllRecentPaymentIntents()).resolves.toBe(1);

    expect(stripe.paymentIntents.search).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 100,
      }),
    );
    expect(stripe.paymentIntents.search).toHaveBeenCalledWith(
      expect.objectContaining({
        page: "page-2",
      }),
    );
    expect(mockApplyMembershipChange).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acct-good",
      }),
    );
  });
});
