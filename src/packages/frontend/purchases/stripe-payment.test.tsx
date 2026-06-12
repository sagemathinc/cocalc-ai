/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import StripePayment, { AddPaymentMethodButton } from "./stripe-payment";
import { createSetupIntent } from "./api";

let mockFreshAuthOpen = false;
let mockFreshAuthOnCancel = jest.fn();
let mockFreshAuthOnSuccess = jest.fn();
let mockRunFreshAuthAction = jest.fn(async (fn: () => Promise<void>) => {
  await fn();
  return true;
});

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
    Button: ({ children, onClick }: any) => (
      <button onClick={onClick} type="button">
        {children}
      </button>
    ),
    Card: Box,
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
  EmbeddedCheckout: () => null,
  EmbeddedCheckoutProvider: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  Elements: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PaymentElement: () => <div>Stripe payment element</div>,
  useElements: () => ({}),
  useStripe: () => ({ confirmSetup: jest.fn() }),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => false,
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
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
            onCancel();
          }}
          type="button"
        >
          Verify fresh auth
        </button>
      </section>
    ) : null,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {
      open: mockFreshAuthOpen,
      onCancel: mockFreshAuthOnCancel,
      onSuccess: mockFreshAuthOnSuccess,
    },
    runFreshAuthAction: mockRunFreshAuthAction,
  }),
}));

jest.mock("@cocalc/frontend/billing/stripe", () => ({
  loadStripe: () => null,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/components/error", () => () => null);

jest.mock("./api", () => ({
  createPaymentIntent: jest.fn(),
  createSetupIntent: jest.fn(),
  getCheckoutSession: jest.fn(),
  getCustomerSession: jest.fn(),
  getPaymentMethods: jest.fn(),
  processPaymentIntents: jest.fn(),
}));

describe("StripePayment", () => {
  beforeEach(() => {
    mockFreshAuthOpen = false;
    mockFreshAuthOnCancel = jest.fn(() => {
      mockFreshAuthOpen = false;
    });
    mockFreshAuthOnSuccess = jest.fn(async () => {
      mockFreshAuthOpen = false;
    });
    mockRunFreshAuthAction = jest.fn(async (fn: () => Promise<void>) => {
      await fn();
      return true;
    });
    jest.mocked(createSetupIntent).mockReset();
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

  it("shows fresh auth prompt when adding a payment method requires it", async () => {
    const freshAuthError: any = new Error("fresh auth is required");
    freshAuthError.code = "fresh_auth_required";
    jest.mocked(createSetupIntent).mockRejectedValueOnce(freshAuthError);
    mockRunFreshAuthAction = jest.fn(async (fn: () => Promise<void>) => {
      try {
        await fn();
        return true;
      } catch (err: any) {
        if (err?.code !== "fresh_auth_required") {
          throw err;
        }
        mockFreshAuthOpen = true;
        return false;
      }
    });

    render(<AddPaymentMethodButton />);

    fireEvent.click(screen.getByText(/Add Payment Method/));

    await waitFor(() => {
      expect(screen.getByText("Confirm security action")).toBeTruthy();
    });
    expect(
      screen.getByText("Confirm this security action to add a payment method."),
    ).toBeTruthy();
    expect(createSetupIntent).toHaveBeenCalledWith({
      description: "Add a new payment method.",
    });
  });

  it("continues to Stripe setup after successful fresh auth while adding a payment method", async () => {
    const freshAuthError: any = new Error("fresh auth is required");
    freshAuthError.code = "fresh_auth_required";
    jest
      .mocked(createSetupIntent)
      .mockRejectedValueOnce(freshAuthError)
      .mockResolvedValueOnce({ clientSecret: "seti_test_secret" });
    mockRunFreshAuthAction = jest.fn(async (fn: () => Promise<void>) => {
      try {
        await fn();
        return true;
      } catch (err: any) {
        if (err?.code !== "fresh_auth_required") {
          throw err;
        }
        mockFreshAuthOpen = true;
        mockFreshAuthOnSuccess = jest.fn(async () => {
          mockFreshAuthOpen = false;
          await fn();
        });
        return false;
      }
    });

    render(<AddPaymentMethodButton />);

    fireEvent.click(screen.getByText(/Add Payment Method/));
    await waitFor(() => {
      expect(screen.getByText("Confirm security action")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Verify fresh auth"));

    await waitFor(() => {
      expect(screen.getByText("Stripe payment element")).toBeTruthy();
    });
    expect(
      screen.queryByText("Security confirmation was canceled."),
    ).toBeNull();
    expect(createSetupIntent).toHaveBeenCalledTimes(2);
  });

  it("shows a retryable state when fresh auth is canceled while adding a payment method", async () => {
    const freshAuthError: any = new Error("fresh auth is required");
    freshAuthError.code = "fresh_auth_required";
    jest.mocked(createSetupIntent).mockRejectedValueOnce(freshAuthError);
    mockRunFreshAuthAction = jest.fn(async (fn: () => Promise<void>) => {
      try {
        await fn();
        return true;
      } catch (err: any) {
        if (err?.code !== "fresh_auth_required") {
          throw err;
        }
        mockFreshAuthOpen = true;
        return false;
      }
    });

    render(<AddPaymentMethodButton />);

    fireEvent.click(screen.getByText(/Add Payment Method/));
    await waitFor(() => {
      expect(screen.getByText("Confirm security action")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Cancel fresh auth"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Adding a payment method requires security confirmation.",
        ),
      ).toBeTruthy();
    });
    expect(screen.getByText("Confirm security action")).toBeTruthy();
  });
});
