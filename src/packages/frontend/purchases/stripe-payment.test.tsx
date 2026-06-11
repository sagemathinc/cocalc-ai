/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import StripePayment from "./stripe-payment";

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
  PaymentElement: () => null,
  useElements: () => null,
  useStripe: () => null,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => false,
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction: (fn: () => Promise<void>) => fn(),
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
});
