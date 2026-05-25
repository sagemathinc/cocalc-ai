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
});
