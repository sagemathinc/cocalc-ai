/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import api from "@cocalc/frontend/client/api";
import {
  applyMembershipChange,
  getMembershipChangeQuote,
} from "@cocalc/frontend/purchases/api";

import MembershipPurchaseModal from "./membership-purchase-modal";

let mockEmailVerificationRequired = false;

jest.mock("antd", () => {
  const Box = ({
    children,
    message,
    title,
  }: {
    children?: ReactNode;
    message?: ReactNode;
    title?: ReactNode;
  }) => (
    <section>
      {title}
      {message}
      {children}
    </section>
  );
  return {
    Alert: Box,
    Button: ({ children, href, onClick, target, type }: any) =>
      href ? (
        <a href={href} target={target}>
          {children}
        </a>
      ) : (
        <button data-type={type} onClick={onClick} type="button">
          {children}
        </button>
      ),
    Flex: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Modal: ({ children, open, title }: any) =>
      open ? (
        <section>
          <h1>{title}</h1>
          {children}
        </section>
      ) : null,
    Space: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Spin: () => <div>loading</div>,
    Typography: {
      Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    },
  };
});

jest.mock("@cocalc/frontend/client/api", () => jest.fn());

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction: (fn: () => Promise<void>) => fn(),
  }),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/purchases/payments", () => () => null);

jest.mock("@cocalc/frontend/purchases/api", () => ({
  applyMembershipChange: jest.fn(),
  getMembershipChangeQuote: jest.fn(),
}));

jest.mock("@cocalc/frontend/purchases/stripe-payment", () => ({
  __esModule: true,
  default: () => <div>stripe payment</div>,
  AddPaymentMethodModal: ({ onFinished }: { onFinished: () => void }) => (
    <section>
      <div>local add payment method modal</div>
      <button onClick={onFinished} type="button">
        Finish adding payment method
      </button>
    </section>
  ),
}));

jest.mock("@cocalc/frontend/app/verify-email-banner", () => ({
  useEmailVerificationRequired: () => mockEmailVerificationRequired,
  VerifyEmailRequiredPanel: ({ description, title }: any) => (
    <section>
      <h2>{title}</h2>
      <div>{description}</div>
    </section>
  ),
}));

jest.mock("./membership-pricing-chooser", () => ({
  MembershipBillingSelector: () => <div>billing selector</div>,
  MembershipPricingTierGrid: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  MembershipPricingTierTile: ({ onClick, tier }: any) => (
    <button onClick={onClick} type="button">
      {tier.label ?? tier.id}
    </button>
  ),
  filterMembershipTiersForBillingInterval: (tiers: unknown[]) => tiers,
  isFreeMembershipTier: (tier: any) =>
    Number(tier.price_monthly) === 0 && Number(tier.price_yearly) === 0,
  membershipPriceValue: (value: unknown) => Number(value),
}));

describe("MembershipPurchaseModal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEmailVerificationRequired = false;
    jest.mocked(api).mockImplementation(async (endpoint: string) => {
      if (endpoint === "purchases/get-membership") {
        return { class: "free", source: "free" };
      }
      if (endpoint === "purchases/get-membership-tiers") {
        return {
          tiers: [
            {
              id: "free",
              label: "Free",
              price_monthly: 0,
              price_yearly: 0,
              store_visible: true,
            },
            {
              id: "standard",
              label: "Standard",
              price_monthly: 24,
              price_yearly: 216,
              store_visible: true,
              trial_days: 7,
            },
          ],
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });
  });

  it("requires email verification before upgrading membership", () => {
    mockEmailVerificationRequired = true;

    render(<MembershipPurchaseModal open onClose={jest.fn()} />);

    expect(
      screen.getByText("Verify your email before upgrading membership"),
    ).toBeTruthy();
    expect(screen.queryByText("billing selector")).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });

  it("opens payment-method collection in place for trial memberships", async () => {
    jest
      .mocked(getMembershipChangeQuote)
      .mockResolvedValueOnce({
        allowed: false,
        change: "upgrade",
        charge: 0,
        price: 216,
        trial_available: true,
        trial_days: 7,
        trial_requires_payment_method: true,
      } as any)
      .mockResolvedValueOnce({
        allowed: true,
        change: "upgrade",
        charge: 0,
        price: 216,
        trial_available: true,
        trial_days: 7,
      } as any);

    render(<MembershipPurchaseModal open onClose={jest.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Standard" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add payment method to start free trial",
      }),
    );

    expect(screen.getByText("local add payment method modal")).toBeTruthy();
    fireEvent.click(screen.getByText("Finish adding payment method"));

    await waitFor(() => {
      expect(getMembershipChangeQuote).toHaveBeenCalledTimes(2);
    });
    expect(
      screen.queryByText("local add payment method modal"),
    ).not.toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));

    await waitFor(() => {
      expect(screen.getByText("Membership updated.")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(applyMembershipChange).toHaveBeenCalledWith({
      allow_downgrade: true,
      class: "standard",
      interval: "year",
    });
    expect(getMembershipChangeQuote).toHaveBeenCalledTimes(2);
  });
});
