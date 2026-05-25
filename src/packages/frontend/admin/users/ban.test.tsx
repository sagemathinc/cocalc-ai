/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { Ban } from "./ban";
import { webapp_client } from "../../webapp-client";

jest.mock("@cocalc/frontend/app-framework", () => ({
  Component: React.Component,
}));

jest.mock("antd", () => ({
  Alert: ({ message, description }: any) => (
    <div>
      {message}
      {description}
    </div>
  ),
  Button: ({ children, danger, ...props }: any) => (
    <button data-danger={danger ? "true" : undefined} {...props}>
      {children}
    </button>
  ),
  Input: {
    TextArea: ({ value, onChange, placeholder }: any) => (
      <textarea
        aria-label="ban reason"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
      />
    ),
  },
  Modal: ({ children, open, onOk, okButtonProps }: any) =>
    open ? (
      <div role="dialog">
        {children}
        <button onClick={onOk} disabled={okButtonProps?.disabled}>
          Confirm ban
        </button>
      </div>
    ) : null,
  Popconfirm: ({ children, description, onConfirm }: any) => (
    <span>
      {children}
      <span>{description}</span>
      <button onClick={onConfirm}>Confirm unban</button>
    </span>
  ),
  Space: ({ children }: any) => <div>{children}</div>,
  Typography: {
    Paragraph: ({ children }: any) => <p>{children}</p>,
    Text: ({ children }: any) => <code>{children}</code>,
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  ErrorDisplay: ({ error }: any) => <div>{error}</div>,
}));

jest.mock("../../webapp-client", () => ({
  webapp_client: {
    admin_client: {
      admin_ban_user: jest.fn(),
      admin_quarantine_billing_resources: jest.fn(),
    },
  },
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: ({ open, onSuccess }: any) =>
    open ? (
      <button data-testid="fresh-auth-modal" onClick={onSuccess}>
        Verify fresh auth
      </button>
    ) : null,
  isFreshAuthRequiredError: (err: any) =>
    err?.code === "fresh_auth_required" ||
    `${err?.message ?? err}`.includes("fresh auth"),
}));

describe("Ban", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("opens fresh auth and retries stale-session ban requests", async () => {
    const adminBanUser = jest.mocked(webapp_client.admin_client.admin_ban_user);
    adminBanUser
      .mockRejectedValueOnce(
        Object.assign(new Error("fresh auth is required"), {
          code: "fresh_auth_required",
        }),
      )
      .mockResolvedValueOnce(undefined);

    render(<Ban account_id="subject-1" banned={false} name="Target User" />);

    fireEvent.click(screen.getByRole("button", { name: /Ban User/i }));
    expect(
      screen.getByText(/blocks future equivalent signups/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Future account creation or email changes/i),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("ban reason"), {
      target: { value: "spam campaign" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm ban" }));

    await waitFor(() => {
      expect(screen.getByTestId("fresh-auth-modal")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("fresh-auth-modal"));

    await waitFor(() => {
      expect(adminBanUser).toHaveBeenCalledTimes(2);
      expect(adminBanUser).toHaveBeenLastCalledWith(
        "subject-1",
        true,
        "spam campaign",
      );
    });
  });

  it("confirms that unban only removes the ban from this account", async () => {
    const adminBanUser = jest.mocked(webapp_client.admin_client.admin_ban_user);
    adminBanUser.mockResolvedValueOnce(undefined);

    render(<Ban account_id="subject-1" banned={true} name="Target User" />);

    expect(
      screen.getByText(/Unbanning is intentionally per account/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm unban" }));

    await waitFor(() => {
      expect(adminBanUser).toHaveBeenCalledWith("subject-1", false, undefined);
    });
  });

  it("requires a reason and fresh auth before quarantining billing/resources", async () => {
    const quarantine = jest.mocked(
      webapp_client.admin_client.admin_quarantine_billing_resources,
    );
    quarantine
      .mockRejectedValueOnce(
        Object.assign(new Error("fresh auth is required"), {
          code: "fresh_auth_required",
        }),
      )
      .mockResolvedValueOnce({
        local_subscriptions_canceled: 2,
        payment_intents_canceled: 1,
        payment_methods_detached: 1,
        hosts_stop_requested: 1,
        host_ids: ["host-1"],
        errors: [],
      });

    render(<Ban account_id="subject-1" banned={true} name="Target User" />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /Quarantine Billing\/Resources/i,
      }),
    );
    expect(screen.getByRole("button", { name: "Confirm ban" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("ban reason"), {
      target: { value: "suspected stolen card" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm ban" }));

    await waitFor(() => {
      expect(screen.getByTestId("fresh-auth-modal")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("fresh-auth-modal"));

    await waitFor(() => {
      expect(quarantine).toHaveBeenCalledTimes(2);
      expect(quarantine).toHaveBeenLastCalledWith(
        "subject-1",
        "suspected stolen card",
      );
      expect(
        screen.getByText(/Billing\/resource quarantine completed/i),
      ).toBeInTheDocument();
    });
  });
});
