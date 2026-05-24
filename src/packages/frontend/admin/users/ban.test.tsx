/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { Ban } from "./ban";
import { webapp_client } from "../../webapp-client";

jest.mock("@cocalc/frontend/app-framework", () => ({
  Component: React.Component,
}));

jest.mock("antd", () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  Popconfirm: ({ children, onConfirm }: any) => (
    <span>
      {children}
      <button onClick={onConfirm}>Confirm ban</button>
    </span>
  ),
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

    fireEvent.click(screen.getByRole("button", { name: "Confirm ban" }));

    await waitFor(() => {
      expect(screen.getByTestId("fresh-auth-modal")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("fresh-auth-modal"));

    await waitFor(() => {
      expect(adminBanUser).toHaveBeenCalledTimes(2);
      expect(adminBanUser).toHaveBeenLastCalledWith("subject-1", true);
    });
  });
});
