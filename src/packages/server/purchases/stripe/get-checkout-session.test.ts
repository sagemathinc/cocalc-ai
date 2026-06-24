/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockGetConn = jest.fn();
const mockGetStripeCustomerId = jest.fn();
const mockSanityCheckAmount = jest.fn();
const mockCurrentStripeSite = jest.fn();
const mockAssertPaymentCheckoutAllowed = jest.fn();

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetConn(...args),
}));

jest.mock("./util", () => ({
  assertValidUserMetadata: jest.requireActual("./util").assertValidUserMetadata,
  currentStripeSite: (...args: any[]) => mockCurrentStripeSite(...args),
  getStripeCustomerId: (...args: any[]) => mockGetStripeCustomerId(...args),
  getStripeLineItems: (lineItems) => ({
    lineItemsWithoutCredit: lineItems,
    total_excluding_tax_usd: lineItems.reduce(
      (total, item) => total + Math.round(item.amount * 100),
      0,
    ),
  }),
  sanityCheckAmount: (...args: any[]) => mockSanityCheckAmount(...args),
}));

jest.mock("@cocalc/server/messages/send", () => ({
  url: jest.fn(async () => "https://staging.cocalc.ai"),
}));

jest.mock("@cocalc/server/launch/kill-switches", () => ({
  assertPaymentCheckoutAllowed: (...args: any[]) =>
    mockAssertPaymentCheckoutAllowed(...args),
}));

import getCheckoutSession from "./get-checkout-session";

describe("getCheckoutSession", () => {
  const stripe = {
    checkout: {
      sessions: {
        create: jest.fn(),
        expire: jest.fn(),
        list: jest.fn(),
      },
    },
  };

  const lineItems = [{ description: "Course membership", amount: 5 }];

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConn.mockResolvedValue(stripe);
    mockGetStripeCustomerId.mockResolvedValue("cus_123");
    mockSanityCheckAmount.mockResolvedValue(undefined);
    mockCurrentStripeSite.mockResolvedValue("staging.cocalc.ai");
    mockAssertPaymentCheckoutAllowed.mockResolvedValue(undefined);
    stripe.checkout.sessions.create.mockImplementation(async (params) => ({
      id: "cs_new",
      client_secret: "cs_new_secret",
      created: Math.floor(Date.now() / 1000),
      metadata: params.metadata,
    }));
    stripe.checkout.sessions.expire.mockResolvedValue({});
    stripe.checkout.sessions.list.mockResolvedValue({ data: [] });
  });

  it("reuses a matching open embedded checkout session instead of expiring it", async () => {
    let createdMetadata;
    stripe.checkout.sessions.create.mockImplementationOnce(async (params) => {
      createdMetadata = params.metadata;
      return {
        id: "cs_new",
        client_secret: "cs_new_secret",
        metadata: params.metadata,
      };
    });

    await expect(
      getCheckoutSession({
        account_id: "acct-1",
        description: "Buy course membership",
        lineItems,
        metadata: { membership_package_product: "product-a" },
        purpose: "membership-package-purchase",
      }),
    ).resolves.toEqual({
      clientSecret: "cs_new_secret",
      sessionId: "cs_new",
    });

    stripe.checkout.sessions.list.mockResolvedValueOnce({
      data: [
        {
          id: "cs_existing",
          client_secret: "cs_existing_secret",
          created: Math.floor(Date.now() / 1000),
          metadata: createdMetadata,
        },
      ],
    });

    await expect(
      getCheckoutSession({
        account_id: "acct-1",
        description: "Buy course membership",
        lineItems,
        metadata: { membership_package_product: "product-a" },
        purpose: "membership-package-purchase",
      }),
    ).resolves.toEqual({
      clientSecret: "cs_existing_secret",
      sessionId: "cs_existing",
    });

    expect(createdMetadata).toMatchObject({
      account_id: "acct-1",
      cocalc_site: "staging.cocalc.ai",
      lineItems: JSON.stringify(lineItems),
      membership_package_product: "product-a",
      purpose: "membership-package-purchase",
    });
    expect(createdMetadata.checkout_key).toMatch(/^[a-f0-9]{64}$/);
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  it("expires same-price sessions with different purchase metadata", async () => {
    let oldMetadata;
    stripe.checkout.sessions.create.mockImplementationOnce(async (params) => {
      oldMetadata = params.metadata;
      return {
        id: "cs_old",
        client_secret: "cs_old_secret",
        metadata: params.metadata,
      };
    });

    await getCheckoutSession({
      account_id: "acct-1",
      description: "Buy course membership",
      lineItems,
      metadata: { membership_package_product: "product-a" },
      purpose: "membership-package-purchase",
    });

    stripe.checkout.sessions.list.mockResolvedValueOnce({
      data: [
        {
          id: "cs_old",
          client_secret: "cs_old_secret",
          created: Math.floor(Date.now() / 1000),
          metadata: oldMetadata,
        },
      ],
    });

    await expect(
      getCheckoutSession({
        account_id: "acct-1",
        description: "Buy course membership",
        lineItems,
        metadata: { membership_package_product: "product-b" },
        purpose: "membership-package-purchase",
      }),
    ).resolves.toEqual({
      clientSecret: "cs_new_secret",
      sessionId: "cs_new",
    });

    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_old");
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
  });
});
