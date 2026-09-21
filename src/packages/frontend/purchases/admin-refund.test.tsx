/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import AdminRefund, { isRefundable } from "./admin-refund";
import { adminCreateRefund } from "./api";

const mockValidateFields = jest.fn();
const mockResetFields = jest.fn();

jest.mock("antd", () => {
  const Form = ({ children }: { children?: ReactNode }) => (
    <form>{children}</form>
  );
  Form.Item = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  Form.useForm = () => [
    {
      resetFields: (...args: any[]) => mockResetFields(...args),
      validateFields: (...args: any[]) => mockValidateFields(...args),
    },
  ];
  const Select = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  Select.Option = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );

  return {
    Button: ({ children, onClick }: any) => (
      <button onClick={onClick} type="button">
        {children}
      </button>
    ),
    Divider: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Form,
    Input: { TextArea: () => <textarea /> },
    Modal: ({ children, onCancel, onOk, okText, open, title }: any) =>
      open ? (
        <section>
          <h2>{title}</h2>
          {children}
          <button onClick={onOk} type="button">
            {okText}
          </button>
          <button onClick={onCancel} type="button">
            Cancel
          </button>
        </section>
      ) : null,
    Select,
  };
});

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction: async (action: () => Promise<void>) => await action(),
  }),
}));

jest.mock("@cocalc/frontend/components/error", () => ({
  __esModule: true,
  default: ({ error }: { error?: string }) =>
    error ? <div>{error}</div> : null,
}));

jest.mock("@cocalc/frontend/components/icon", () => ({
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
}));

jest.mock("./stripe-payment", () => ({
  BigSpin: () => <div>loading</div>,
}));

jest.mock("./api", () => ({
  adminCreateRefund: jest.fn(),
}));

describe("AdminRefund", () => {
  beforeEach(() => {
    jest
      .mocked(adminCreateRefund)
      .mockReset()
      .mockResolvedValue(undefined as any);
    mockResetFields.mockReset();
    mockValidateFields.mockReset().mockResolvedValue({
      notes: "Duplicate membership charge",
      reason: "duplicate",
    });
  });

  it("excludes refunds and transfers from generic purchase refunds", () => {
    expect(isRefundable("credit", -24)).toBe(true);
    expect(isRefundable("membership", 24)).toBe(true);
    expect(isRefundable("dedicated-host", 1)).toBe(true);
    expect(isRefundable("refund", -24)).toBe(false);
    expect(isRefundable("credit-transfer", -24)).toBe(false);
    expect(isRefundable("credit-transfer", 24)).toBe(false);
    expect(isRefundable("membership", null)).toBe(false);
  });

  it("submits the selected reason and notes for a membership refund", async () => {
    const refresh = jest.fn();
    render(
      <AdminRefund
        purchase_id={521}
        service="membership"
        cost={24}
        subscription_id={149}
        refresh={refresh}
      />,
    );

    fireEvent.click(screen.getByText("Admin Refund"));
    expect(screen.getByText("Other")).toBeTruthy();
    expect(
      screen.getByText(/exact subscription will be canceled and expire/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Stripe payment will not be changed/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Refund"));

    await waitFor(() => {
      expect(adminCreateRefund).toHaveBeenCalledWith({
        purchase_id: 521,
        reason: "duplicate",
        notes: "Duplicate membership charge",
      });
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  it("does not describe a membership package as a subscription", () => {
    render(
      <AdminRefund
        purchase_id={600}
        service="membership"
        cost={30}
        membership_package
      />,
    );

    fireEvent.click(screen.getByText("Admin Refund"));
    expect(screen.getByText(/package will expire immediately/i)).toBeTruthy();
    expect(
      screen.getByText(/refund that credit transaction separately/i),
    ).toBeTruthy();
    expect(screen.queryByText(/exact subscription/i)).toBeNull();
  });
});
