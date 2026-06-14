/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import StripePayment, {
  AddPaymentMethodButton,
  BillingSetupModal,
} from "./stripe-payment";
import {
  createPaymentIntent,
  createSetupIntent,
  getCustomerSession,
  getPaymentMethods,
  getStripeCustomer,
  setStripeCustomer,
} from "./api";

let mockStripeEnabled = false;
let mockEmailVerificationRequired = false;

jest.mock("antd", () => {
  const Box = ({
    children,
    description,
    message,
    title,
  }: {
    children?: ReactNode;
    description?: ReactNode;
    message?: ReactNode;
    title?: ReactNode;
  }) => (
    <section>
      {title}
      {message}
      {description}
      {children}
    </section>
  );
  return {
    Alert: Box,
    Button: ({ children, disabled, onClick }: any) => (
      <button disabled={disabled} onClick={onClick} type="button">
        {children}
      </button>
    ),
    Card: Box,
    Divider: () => <hr />,
    Modal: Box,
    Space: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Spin: () => <div>loading</div>,
    Table: ({ columns, dataSource }: any) => (
      <table>
        <tbody>
          {dataSource.map((row: any) => (
            <tr key={row.key}>
              {columns.map((column: any) => (
                <td key={column.key}>
                  {column.render
                    ? column.render(row[column.dataIndex], row)
                    : row[column.dataIndex]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ),
  };
});

jest.mock("@stripe/react-stripe-js", () => ({
  AddressElement: ({ onReady }: any) => {
    const React = jest.requireActual("react");
    React.useEffect(() => {
      onReady?.();
    }, [onReady]);
    return <div>Stripe address element</div>;
  },
  EmbeddedCheckout: () => null,
  EmbeddedCheckoutProvider: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  Elements: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PaymentElement: () => <div>Stripe payment element</div>,
  useElements: () => ({
    getElement: (type: string) =>
      type === "address"
        ? {
            getValue: jest.fn().mockResolvedValue({
              complete: true,
              value: {
                address: {
                  city: "San Francisco",
                  country: "US",
                  line1: "1 Main St",
                  postal_code: "94105",
                  state: "CA",
                },
                name: "Ada Lovelace",
              },
            }),
          }
        : null,
  }),
  useStripe: () => ({ confirmSetup: jest.fn() }),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => mockStripeEnabled,
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  ...jest.requireActual("@cocalc/frontend/auth/fresh-auth"),
  FreshAuthModal: ({ onCancel, onSuccess, open }: any) =>
    open ? (
      <section>
        <div>Confirm security action</div>
        <button onClick={onCancel} type="button">
          Cancel fresh auth
        </button>
        <button
          onClick={async () => {
            await onSuccess();
          }}
          type="button"
        >
          Verify fresh auth
        </button>
      </section>
    ) : null,
}));

jest.mock("@cocalc/frontend/billing/stripe", () => ({
  loadStripe: () => null,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/components/error", () => () => null);

jest.mock("@cocalc/frontend/app/verify-email-banner", () => ({
  useEmailVerificationRequired: () => mockEmailVerificationRequired,
  VerifyEmailRequiredPanel: ({ description, title }: any) => (
    <section>
      <h2>{title}</h2>
      <div>{description}</div>
    </section>
  ),
}));

jest.mock("./api", () => ({
  createPaymentIntent: jest.fn(),
  createSetupIntent: jest.fn(),
  getCheckoutSession: jest.fn(),
  getCustomerSession: jest.fn(),
  getPaymentMethods: jest.fn(),
  getStripeCustomer: jest.fn(),
  processPaymentIntents: jest.fn(),
  setStripeCustomer: jest.fn(),
}));

describe("StripePayment", () => {
  beforeEach(() => {
    mockStripeEnabled = false;
    mockEmailVerificationRequired = false;
    jest.mocked(createPaymentIntent).mockReset();
    jest.mocked(createSetupIntent).mockReset();
    jest
      .mocked(createSetupIntent)
      .mockResolvedValue({ clientSecret: "seti_test_secret" } as any);
    jest.mocked(getCustomerSession).mockReset();
    jest.mocked(getCustomerSession).mockResolvedValue({});
    jest.mocked(getPaymentMethods).mockReset();
    jest.mocked(getStripeCustomer).mockReset();
    jest.mocked(getStripeCustomer).mockResolvedValue({
      address: {},
      name: "Ada Lovelace",
    });
    jest.mocked(setStripeCustomer).mockReset();
    jest.mocked(setStripeCustomer).mockResolvedValue(undefined);
  });

  it("requires email verification before rendering purchase controls", () => {
    mockEmailVerificationRequired = true;

    render(
      <StripePayment
        description="Membership change"
        lineItems={[{ description: "Basic membership, annual", amount: 72 }]}
        purpose="membership-change"
      />,
    );

    expect(
      screen.getByText("Verify your email before purchasing"),
    ).toBeTruthy();
    expect(screen.queryByText("Basic membership, annual")).toBeNull();
    expect(getPaymentMethods).not.toHaveBeenCalled();
  });

  it("renders the description and full line-item table by default", () => {
    render(
      <StripePayment
        description="Membership change"
        lineItems={[{ description: "Basic membership, annual", amount: 72 }]}
        purpose="membership-change"
      />,
    );

    expect(screen.getByText("Membership change")).toBeTruthy();
    expect(screen.getByText("Basic membership, annual")).toBeTruthy();
    expect(screen.getByText("Amount due (excluding tax)")).toBeTruthy();
  });

  it("can render only the amount due without the visible title", () => {
    render(
      <StripePayment
        description="Membership change"
        lineItems={[{ description: "Basic membership, annual", amount: 72 }]}
        purpose="membership-change"
        summaryMode="total-only"
        title={null}
      />,
    );

    expect(screen.queryByText("Membership change")).toBeNull();
    expect(screen.queryByText("Basic membership, annual")).toBeNull();
    expect(
      screen.getByText(/Amount due \(excluding tax\) \$72\.00/),
    ).toBeTruthy();
  });

  it("keeps one-click purchase disabled while fresh-auth workflow is pending", async () => {
    mockStripeEnabled = true;
    const freshAuthError: any = new Error("fresh auth is required");
    freshAuthError.code = "fresh_auth_required";
    jest.mocked(createPaymentIntent).mockRejectedValueOnce(freshAuthError);
    jest.mocked(getPaymentMethods).mockResolvedValue({ data: [{}] } as any);
    render(
      <StripePayment
        description="Membership change"
        lineItems={[{ description: "Pro membership, annual", amount: 1440 }]}
        purpose="membership-change"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Buy Now With 1-Click")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Buy Now With 1-Click"));

    await waitFor(() => {
      expect(screen.getByText("Confirm security action")).toBeTruthy();
    });

    const button = screen
      .getByText("Buy Now With 1-Click")
      .closest("button") as HTMLButtonElement | null;
    expect(button?.disabled).toBe(true);
    expect(screen.getByText("loading")).toBeTruthy();
  });

  it("adds a payment method without requiring fresh auth", async () => {
    render(<AddPaymentMethodButton />);

    fireEvent.click(screen.getByText(/Add Payment Method/));
    await waitFor(() => {
      expect(screen.getByText("Stripe address element")).toBeTruthy();
    });
    fireEvent.click(await screen.findByText("Save Address"));

    await waitFor(() => {
      expect(screen.getByText("Stripe payment element")).toBeTruthy();
    });
    expect(setStripeCustomer).toHaveBeenCalledWith({
      address: {
        city: "San Francisco",
        country: "US",
        line1: "1 Main St",
        postal_code: "94105",
        state: "CA",
      },
      name: "Ada Lovelace",
    });
    expect(createSetupIntent).toHaveBeenCalledWith({
      description: "Add a new payment method.",
    });
    expect(getCustomerSession).not.toHaveBeenCalled();
    expect(screen.queryByText("Confirm security action")).toBeNull();
  });

  it("skips billing details when adding a payment method with saved address", async () => {
    jest.mocked(getStripeCustomer).mockResolvedValueOnce({
      address: {
        city: "San Francisco",
        country: "US",
        line1: "1 Main St",
        postal_code: "94105",
        state: "CA",
      },
      name: "Ada Lovelace",
    });

    render(<AddPaymentMethodButton />);

    fireEvent.click(screen.getByText(/Add Payment Method/));

    await waitFor(() => {
      expect(screen.getByText("Stripe payment element")).toBeTruthy();
    });
    expect(screen.queryByText("Stripe address element")).toBeNull();
    expect(setStripeCustomer).not.toHaveBeenCalled();
    expect(createSetupIntent).toHaveBeenCalledWith({
      description: "Add a new payment method.",
    });
  });

  it("requires email verification before adding a payment method", async () => {
    mockEmailVerificationRequired = true;

    render(<AddPaymentMethodButton />);

    fireEvent.click(screen.getByText(/Add Payment Method/));
    await waitFor(() => {
      expect(screen.getByText("Stripe address element")).toBeTruthy();
    });
    const saveAddress = (await screen.findByText("Save Address")).closest(
      "button",
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(saveAddress.disabled).toBe(false);
    });
    fireEvent.click(saveAddress);

    await waitFor(() => {
      expect(
        screen.getByText("Verify your email before adding a payment method"),
      ).toBeTruthy();
    });
    expect(createSetupIntent).not.toHaveBeenCalled();
  });

  it("can collect billing details without requiring another payment method", async () => {
    const onFinished = jest.fn();

    render(
      <BillingSetupModal
        onCancel={jest.fn()}
        onFinished={onFinished}
        requirePaymentMethod={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Stripe address element")).toBeTruthy();
    });
    fireEvent.click(await screen.findByText("Save Address"));

    await waitFor(() => {
      expect(onFinished).toHaveBeenCalled();
    });
    expect(screen.queryByText("Stripe payment element")).toBeNull();
    expect(createSetupIntent).not.toHaveBeenCalled();
    expect(getCustomerSession).not.toHaveBeenCalled();
  });
});
