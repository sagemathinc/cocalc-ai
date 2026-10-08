/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const getEducatorOffers = jest.fn();
const openSupport = jest.fn();

jest.mock("@cocalc/frontend/purchases/api", () => ({
  getEducatorOffers: (...args) => getEducatorOffers(...args),
  getMembershipPackageQuote: jest.fn(),
  isPurchaseAllowed: jest.fn(),
  processPaymentIntents: jest.fn(),
  purchaseMembershipPackages: jest.fn(),
}));
jest.mock("@cocalc/frontend/support/open", () => ({
  __esModule: true,
  default: (...args) => openSupport(...args),
}));
jest.mock("@cocalc/frontend/purchases/stripe-payment", () => () => null);
jest.mock("@cocalc/frontend/purchases/payments", () => () => null);
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction: async (fn) => {
      await fn();
      return true;
    },
  }),
}));
jest.mock("@cocalc/frontend/components", () => ({
  TimeAgo: () => <span>time-ago</span>,
}));
jest.mock(
  "./membership-purchase-modal",
  () => (props: any) =>
    props.open ? <div>subscribe {props.initialTargetClass}</div> : null,
);
jest.mock("./settings-card", () => ({
  SettingsCard: ({ title, children }) => (
    <section aria-label={title}>{children}</section>
  ),
}));

import { EducatorOffersCard } from "./educator-offers";

const TIER = {
  membership_class: "educator",
  label: "Educator",
  store_description: "For teaching",
  price_monthly: 25,
  price_yearly: 225,
  term_price: 60,
  term_days: 122,
};

describe("EducatorOffersCard", () => {
  beforeEach(() => {
    getEducatorOffers.mockReset();
    openSupport.mockReset();
  });

  it("offers subscription and term purchase to eligible educators", async () => {
    getEducatorOffers.mockResolvedValue({
      eligibility: {
        eligible: true,
        reason: "academic_domain",
        email_address: "prof@ucla.edu",
      },
      tiers: [TIER],
    });
    render(<EducatorOffersCard />);
    expect(
      await screen.findByText(
        /\$25\.00\/month · \$225\.00\/year · \$60\.00 for one 122-day term/,
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Subscribe to Educator" }),
    );
    expect(screen.getByText("subscribe educator")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Buy one term of Educator" }),
    ).toBeTruthy();
  });

  it("explains ineligibility and lets the user request manual approval", async () => {
    getEducatorOffers.mockResolvedValue({
      eligibility: {
        eligible: false,
        reason: "not_academic",
        email_address: "teacher@gmail.com",
        message: "Educational memberships require a verified academic email.",
      },
      tiers: [TIER],
    });
    render(<EducatorOffersCard />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Request manual approval" }),
    );
    expect(openSupport).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "purchase",
        body: expect.stringContaining("teacher@gmail.com"),
      }),
    );
    expect(screen.queryByRole("button", { name: /Buy one term/ })).toBeNull();
  });

  it("renders nothing when no tier is offered to instructors", async () => {
    getEducatorOffers.mockResolvedValue({
      eligibility: { eligible: false, reason: "no_offers" },
      tiers: [],
    });
    const { container } = render(<EducatorOffersCard />);
    await waitFor(() => expect(getEducatorOffers).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
